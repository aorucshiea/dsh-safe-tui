/**
 * dsh-safe-tui / detached Safe TUI console bridge.
 *
 * This process owns the real `dsh --profile safe` PTY and a local WebSocket
 * server. It is intentionally detached from the Web server process: the TUI
 * keeps running while the Web server restarts, and a reconnecting browser
 * receives a scrollback replay so the same console session survives restarts.
 *
 * Protocol (JSON text frames):
 *   client -> bridge: {type:'attach', session?} | {type:'input', data} | {type:'resize', cols, rows}
 *   bridge -> client: {type:'replay', data} | {type:'output', data} | {type:'status', ...} | {type:'exit'}
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'

const BRIDGE_STATE = process.env.DSH_SAFE_CONSOLE_BRIDGE_STATE
  || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh', 'safe-tui', 'console-bridge.json')

const SCROLLBACK_LIMIT = 512 * 1024
const HOME = process.env.USERPROFILE || process.env.HOME || process.cwd()

let scrollback = ''
let currentSession = ''
let term = null
// Last terminal size reported by any client; used to spawn the PTY at the
// right size instead of a hardcoded 80x24 (see spawnSafeShell).
let lastSize = null
const clients = new Set()
let inputClient = null

function writeState() {
  try {
    mkdirSync(dirname(BRIDGE_STATE), { recursive: true })
    const raw = readBridgeState()
    writeFileSync(BRIDGE_STATE, JSON.stringify({
      pid: process.pid,
      port: raw?.port ?? 0,
      sessionId: currentSession || null,
      at: Date.now(),
    }), 'utf8')
  } catch { /* best effort */ }
}

function removeState() {
  try { rmSync(BRIDGE_STATE, { force: true }) } catch { /* ignore */ }
}

function readBridgeState() {
  try {
    if (!existsSync(BRIDGE_STATE)) return null
    return JSON.parse(readFileSync(BRIDGE_STATE, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Return only the last full TUI screen frame from the captured output.
 *
 * The TUI redraws the full screen on every event without an explicit clear
 * (only resize/overlay clears), so the bytes after the last `\x1b[2J` can still
 * contain many complete frames. The real start of every TUI frame is the
 * `\x1b[H` home sequence it writes before each render, so use the last one to
 * cut to the final on-screen frame only.
 */
function lastScreenFrame() {
  if (!scrollback) return '';
  const marker = '\x1b[H';
  const idx = scrollback.lastIndexOf(marker);
  const frame = idx >= 0 ? scrollback.slice(idx) : scrollback.slice(-131072);
  return '\x1b[2J\x1b[H' + frame;
}

function broadcast(payload) {
  const data = JSON.stringify(payload)
  for (const client of clients) {
    if (client.readyState === 1) {
      try { client.send(data) } catch { /* ignore */ }
    }
  }
}

function homeDir() {
  return HOME
}

function spawnSafeShell(session) {
  if (term) {
    try { term.kill() } catch { /* ignore */ }
    term = null
  }
  currentSession = session || ''
  scrollback = ''

  const command = process.platform === 'win32'
    ? ['/c', 'dsh', '--profile', 'safe', ...(session ? ['--resume', session] : [])]
    : ['-lc', `dsh --profile safe${session ? ` --resume ${session}` : ''}`]
  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'bash'

  // 2026-09-23: 用最近一次客户端上报的尺寸开 PTY。此前写死 80x24，而客户端
  // 的 resize 往往在 PTY 生成之前到达被丢弃，TUI 就一直按 80x24 绘制——表现为
  // 残缺框线、大片空白和终端自动上滚。
  const startCols = lastSize ? lastSize.cols : 80
  const startRows = lastSize ? lastSize.rows : 24

  let child
  try {
    child = pty.spawn(shell, command, {
      name: 'xterm-256color',
      cols: startCols,
      rows: startRows,
      cwd: homeDir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...(session ? { DSH_SAFE_CONSOLE_WAIT: '1' } : {}),
      },
    })
  } catch (error) {
    console.error('[safe-tui bridge] PTY spawn failed:', error)
    term = null
    writeState()
    broadcast({ type: 'exit' })
    return
  }
  term = child

  child.onData((data) => {
    if (term !== child) return
    scrollback = (scrollback + data).slice(-SCROLLBACK_LIMIT)
    broadcast({ type: 'output', data })
  })

  child.onExit(() => {
    // An old PTY can exit after attach() replaced it. Only the current child
    // may clear the bridge state or tell the browser the console exited.
    if (term !== child) return
    broadcast({ type: 'exit' })
    term = null
    writeState()
    if (clients.size === 0) {
      setTimeout(() => {
        if (term === null && clients.size === 0) shutdown()
      }, 2000)
    }
  })

  writeState()
}

function attach(session) {
  const wanted = session || ''
  if (term && currentSession === wanted) {
    writeState()
    return
  }
  spawnSafeShell(wanted)
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })

wss.on('listening', () => {
  const address = wss.address()
  try {
    mkdirSync(dirname(BRIDGE_STATE), { recursive: true })
    writeFileSync(BRIDGE_STATE, JSON.stringify({
      pid: process.pid,
      port: address.port,
      sessionId: currentSession || null,
      at: Date.now(),
    }), 'utf8')
  } catch { /* ignore */ }
})

wss.on('connection', (client) => {
  clients.add(client)
  if (inputClient === null) inputClient = client

  if (scrollback) {
    try { client.send(JSON.stringify({ type: 'replay', data: lastScreenFrame() })) } catch { /* ignore */ }
  }
  try {
    client.send(JSON.stringify({
      type: 'status',
      sessionId: currentSession || null,
      pid: process.pid,
    }))
  } catch { /* ignore */ }

  client.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (message?.type === 'attach') {
      inputClient = client
      attach(String(message.session ?? ''))
      return
    }
    if (message?.type === 'input') {
      if (inputClient !== client) return
      try { term?.write(String(message.data ?? '')) } catch { /* ignore */ }
      return
    }
    if (message?.type === 'resize') {
      if (inputClient !== client) return
      const cols = Math.max(2, Math.floor(Number(message.cols) || 80))
      const rows = Math.max(1, Math.floor(Number(message.rows) || 24))
      lastSize = { cols, rows }
      try { term?.resize(cols, rows) } catch { /* ignore */ }
      // Windows conpty 不会把 resize 传导给子进程的 stdout.columns（实测无
      // resize 事件）——用带内转义序列把新尺寸告诉 TUI（tui.js 解析）。
      try { term?.write(`\x1b|${cols};${rows}|R`) } catch { /* ignore */ }
      return
    }
  })

  const forgetClient = () => {
    clients.delete(client)
    if (inputClient === client) inputClient = clients.values().next().value ?? null
  }

  client.on('close', forgetClient)
  client.on('error', forgetClient)
})

function shutdown() {
  try { wss.close() } catch { /* ignore */ }
  if (term) {
    try { term.kill() } catch { /* ignore */ }
    term = null
  }
  removeState()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
