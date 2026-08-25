/**
 * dsh-safe-tui / web console host.
 *
 * Serves the vendored xterm.js assets and a WebSocket that spawns a real
 * `dsh --profile safe` PTY process. This keeps the full Safe TUI working in a
 * browser tab without loading user Web plugins.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = join(__dirname, 'web-console', 'vendor')
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

function spawnSafeShell(ws, cols, rows) {
  const command = process.platform === 'win32'
    ? ['/c', 'dsh --profile safe']
    : ['-lc', 'dsh --profile safe']
  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'bash'
  const term = pty.spawn(shell, command, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: homeDir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  })

  term.onData((data) => {
    if (ws.readyState === 1) ws.send(data)
  })

  term.onExit(() => {
    try { ws.close() } catch { /* already closed */ }
  })

  ws.on('close', () => {
    try { term.kill() } catch { /* already killed */ }
  })

  ws.on('message', (raw) => {
    const text = String(raw)
    try {
      const message = JSON.parse(text)
      if (message?.type === 'input') {
        term.write(String(message.data ?? ''))
        return
      }
      if (message?.type === 'resize') {
        const cols = Math.max(2, Math.floor(Number(message.cols) || 80))
        const rows = Math.max(1, Math.floor(Number(message.rows) || 24))
        term.resize(cols, rows)
        return
      }
    } catch {
      // Plain text fallback: send raw input.
      term.write(text)
    }
  })
}

export function applyWebConsole(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer) return

  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (ws) => {
    ws.send('\x1b[?25h') // show cursor
    spawnSafeShell(ws, 80, 24)
  })

  ctx.effect(() => {
    for (const [path, asset] of Object.entries(STATIC_FILES)) {
      webServer.register({
        kind: 'exact',
        path,
        handler: (_req, res) => sendFile(res, asset.file, asset.type),
      })
    }
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
