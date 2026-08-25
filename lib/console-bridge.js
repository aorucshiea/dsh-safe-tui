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
const clients = new Set()

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
 * Replaying the whole scrollback makes xterm fill its history with duplicated
 * full-screen redraws; reconnecting only needs the current screen.
 */
function lastScreenFrame() {
  if (!scrollback) return '';
  const marker = '\x1b[2J';
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

  term = pty.spawn(shell, command, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: homeDir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...(session ? { DSH_SAFE_CONSOLE_WAIT: '1' } : {}),
    },
  })

  term.onData((data) => {
    scrollback = (scrollback + data).slice(-SCROLLBACK_LIMIT)
    broadcast({ type: 'output', data })
  })

  term.onExit(() => {
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
      attach(String(message.session ?? ''))
      return
    }
    if (message?.type === 'input') {
      try { term?.write(String(message.data ?? '')) } catch { /* ignore */ }
      return
    }
    if (message?.type === 'resize') {
      const cols = Math.max(2, Math.floor(Number(message.cols) || 80))
      const rows = Math.max(1, Math.floor(Number(message.rows) || 24))
      try { term?.resize(cols, rows) } catch { /* ignore */ }
      return
    }
  })

  client.on('close', () => {
    clients.delete(client)
  })

  client.on('error', () => {
    clients.delete(client)
  })
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
