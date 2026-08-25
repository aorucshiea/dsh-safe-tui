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

    webServer.register({
      kind: 'exact',
      path: '/console/api/handoff',
      handler: (_req, res) => {
        const body = JSON.stringify(currentHandoff() ?? { pending: false })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/console/api/handoff/ack',
      handler: (_req, res) => {
        clearHandoff()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"ok":true}')
      },
    })

    webServer.registerUpgrade({
      path: '/console/ws',
      handler: (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      },
    })

    return () => {
      try { wss.close() } catch { /* ignore */ }
    }
  }, 'dsh-safe-tui: web console')
}
