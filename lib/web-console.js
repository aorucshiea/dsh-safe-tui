/**
 * dsh-safe-tui / web console host.
 *
 * Serves the vendored xterm.js assets and a WebSocket that connects to a
 * detached Safe TUI console bridge. The bridge owns the real `dsh --profile
 * safe` PTY process, so the TUI survives Web server restarts and the browser
 * can reconnect to the same session after a restart.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = join(__dirname, 'web-console', 'vendor')
const BRIDGE_PATH = join(__dirname, 'console-bridge.js')
const STATIC_FILES = {
  '/console/xterm.js': { file: 'xterm.js', type: 'application/javascript; charset=utf-8' },
  '/console/xterm.css': { file: 'xterm.css', type: 'text/css; charset=utf-8' },
  '/console/addon-fit.js': { file: 'addon-fit.js', type: 'application/javascript; charset=utf-8' },
}

/** Standalone console page: no dependency on the dsh plugin graph, so it still
 *  works when the Web UI fails to load plugins. */
const STANDALONE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Safe Console</title>
<link rel="stylesheet" href="/console/xterm.css">
<style>
  html, body { margin: 0; height: 100%; background: #0e0e12; color: #d8d8dc;
    font: 13px/1.5 "JetBrains Mono", Consolas, monospace; }
  #bar { display: flex; align-items: center; gap: 12px; padding: 8px 14px;
    background: #14141a; border-bottom: 1px solid #2a2a30; font-size: 12px; }
  #dot { width: 8px; height: 8px; border-radius: 2px; background: #4ea1ff; }
  #status { color: #8a8a92; }
  #term { position: absolute; inset: 42px 0 0 0; padding: 6px 10px; }
</style>
</head>
<body>
<div id="bar"><span id="dot"></span><b>DSH Safe Console</b><span id="status">正在连接 Safe TUI…</span></div>
<div id="term"></div>
<script src="/console/xterm.js"></script>
<script src="/console/addon-fit.js"></script>
<script>
(function () {
  var SESSION = "__SESSION__";
  var status = document.getElementById("status");
  var term = new (window.DSHSafeTerminal || window.Terminal)({
    cursorBlink: true, fontSize: 13, lineHeight: 1.2, allowProposedApi: true, scrollback: 0,
    theme: { background: "#0e0e12", foreground: "#d8d8dc", cursor: "#4ea1ff" }
  });
  var fit = new (window.DSHSafeFitAddon || window.FitAddon)();
  term.loadAddon(fit);
  term.open(document.getElementById("term"));
  fit.fit();
  var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/console/ws"
    + (SESSION ? "?session=" + encodeURIComponent(SESSION) : "");
  var ws = null, timer = null;
  function connect() {
    ws = new WebSocket(url);
    ws.onopen = function () {
      status.textContent = SESSION ? "Safe TUI 已连接 · 同会话 " + SESSION : "Safe TUI 已连接";
      term.focus();
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      setTimeout(function () {
        fit.fit();
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }, 400);
    };
    ws.onmessage = function (ev) {
      var raw = ev.data;
      try {
        var m = JSON.parse(raw);
        if (m && m.type === "output" || m && m.type === "replay") { term.write(m.data || ""); return; }
        if (m && m.type === "status") { status.textContent = "Safe TUI 已连接" + (m.sessionId ? " · " + m.sessionId : ""); return; }
        if (m && m.type === "exit") { status.textContent = "Safe TUI 已退出"; return; }
      } catch (e) { /* raw */ }
      term.write(raw);
    };
    ws.onclose = function () { status.textContent = "连接断开，正在重连…"; retry(); };
    ws.onerror = function () { status.textContent = "连接失败，正在重试…"; };
  }
  function retry() { if (timer) return; timer = setTimeout(function () { timer = null; connect(); }, 1500); }
  term.onData(function (d) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "input", data: d })); });
  window.addEventListener("resize", function () {
    fit.fit();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  });
  connect();
})();
</script>
</body>
</html>`

function sendFile(res, file, type) {
  try {
    const body = readFileSync(join(VENDOR_DIR, file))
    res.writeHead(200, { 'content-type': type, 'content-length': body.byteLength, 'cache-control': 'no-cache' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || process.cwd()
}

function stateDir() {
  return join(homeDir(), '.dsh', 'safe-tui')
}

function bridgeStatePath() {
  return join(stateDir(), 'console-bridge.json')
}

function handoffPath() {
  return join(stateDir(), 'console-handoff.json')
}

export function requestHandoff(sessionId, note = '', direction = 'console') {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(handoffPath(), JSON.stringify({
      sessionId,
      note,
      direction,
      at: Date.now()
    }), 'utf8')
  } catch { /* best effort */ }
}

export function clearHandoff(sessionId) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(handoffPath(), JSON.stringify({
      sessionId: sessionId ?? '',
      note: '',
      direction: 'none',
      at: Date.now()
    }), 'utf8')
  } catch { /* best effort */ }
}

function currentHandoff() {
  try {
    if (!existsSync(handoffPath())) return null
    const body = JSON.parse(readFileSync(handoffPath(), 'utf8'))
    if (!body.sessionId) return null
    return body
  } catch {
    return null
  }
}

let lastBridgeSpawnAt = 0

function spawnBridge() {
  const now = Date.now()
  if (now - lastBridgeSpawnAt < 2000) return
  lastBridgeSpawnAt = now
  try {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        DSH_SAFE_CONSOLE_BRIDGE_STATE: bridgeStatePath(),
      },
    })
    child.unref()
  } catch { /* retry later */ }
}

function pingPort(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function ensureBridge() {
  const maxWait = 10_000
  const started = Date.now()

  for (;;) {
    const state = readBridgeState()
    if (state && state.port && await pingPort(state.port)) return state.port
    spawnBridge()
    await sleep(250)
    if (Date.now() - started > maxWait) {
      // Last chance: re-read once and use if whatever is left responds.
      const last = readBridgeState()
      if (last && last.port && await pingPort(last.port)) return last.port
      throw new Error('Safe TUI console bridge failed to start')
    }
  }
}

function readBridgeState() {
  try {
    if (!existsSync(bridgeStatePath())) return null
    return JSON.parse(readFileSync(bridgeStatePath(), 'utf8'))
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The console WebSocket drives a full `dsh --profile safe` shell, so the
 * upgrade endpoint must only be reachable from the local machine's own pages:
 * browsers always send Origin on cross-origin WebSockets (there is no CORS
 * preflight for WS), so a strict loopback Host/Origin gate closes the
 * drive-by vector. Non-browser local tools send no Origin and stay allowed.
 */
function loopbackHostOk(host) {
  const name = String(host || '').toLowerCase().split(':')[0] || ''
  return name === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(name) || name === '[::1]'
}

function loopbackOriginOk(origin) {
  if (!origin || origin === 'null') return true
  try {
    const name = new URL(origin).hostname.toLowerCase()
    return name === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(name) || name === '[::1]'
  } catch {
    return false
  }
}

function guardLocal(req) {
  return loopbackHostOk(req.headers.host) && loopbackOriginOk(req.headers.origin)
}

/**
 * Proxy one browser terminal socket to the detached console bridge.
 * @param ws - browser xterm WebSocket.
 * @param session - optional web session id to resume in the Safe TUI.
 */
async function proxyToBridge(ws, session) {
  let bridge
  try {
    const port = await ensureBridge()
    bridge = new WebSocket(`ws://127.0.0.1:${port}`)
  } catch (error) {
    try { ws.close(1011, String(error?.message ?? error)) } catch { /* ignore */ }
    return
  }

  bridge.on('open', () => {
    try {
      bridge.send(JSON.stringify({ type: 'attach', session: session || '' }))
    } catch { /* ignore */ }
  })

  bridge.on('message', (data) => {
    if (ws.readyState === 1) {
      try { ws.send(String(data)) } catch { /* ignore */ }
    }
  })

  bridge.on('close', () => {
    try { ws.close() } catch { /* ignore */ }
  })

  bridge.on('error', () => {
    try { ws.close(1011) } catch { /* ignore */ }
  })

  ws.on('message', (raw) => {
    if (bridge.readyState === 1) {
      try { bridge.send(String(raw)) } catch { /* ignore */ }
    }
  })

  ws.on('close', () => {
    try { bridge.close() } catch { /* ignore */ }
  })
}

export function applyWebConsole(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer) return

  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (ws, req) => {
    ws.send('\x1b[?25h') // show cursor
    let session = ''
    try {
      const url = new URL(req.url ?? '', 'http://localhost')
      session = url.searchParams.get('session') ?? ''
    } catch { /* ignore */ }
    proxyToBridge(ws, /^session-[0-9a-fA-F-]+$/.test(session) ? session : '')
  })

  ctx.effect(() => {
    for (const [path, asset] of Object.entries(STATIC_FILES)) {
      webServer.register({
        kind: 'exact',
        path,
        handler: (_req, res) => sendFile(res, asset.file, asset.type),
      })
    }

    // 2026-09-23: standalone console page. Works even when the dsh plugin
    // graph fails to boot ("Failed to load plugins"), so the Safe TUI is
    // always reachable for repairs: open http://127.0.0.1:<port>/console
    const standalonePage = (req, res) => {
      let session = ''
      try {
        session = new URL(req.url ?? '', 'http://localhost').searchParams.get('session') ?? ''
      } catch { /* ignore */ }
      const body = STANDALONE_HTML.replace('__SESSION__', /^session-[0-9a-fA-F-]+$/.test(session) ? session : '')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    webServer.register({ kind: 'exact', path: '/console', handler: standalonePage })
    webServer.register({ kind: 'exact', path: '/console/', handler: standalonePage })

    webServer.register({
      kind: 'exact',
      path: '/console/api/handoff',
      handler: (req, res) => {
        if (!guardLocal(req)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end('{"ok":false,"error":"forbidden origin"}')
          return
        }
        const body = JSON.stringify(currentHandoff() ?? { pending: false })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/console/api/handoff/ack',
      handler: (req, res) => {
        if (!guardLocal(req)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end('{"ok":false,"error":"forbidden origin"}')
          return
        }
        clearHandoff()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"ok":true}')
      },
    })

    webServer.registerUpgrade({
      path: '/console/ws',
      handler: (req, socket, head) => {
        if (!guardLocal(req)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      },
    })

    return () => {
      try { wss.close() } catch { /* ignore */ }
    }
  }, 'dsh-safe-tui: web console')
}
