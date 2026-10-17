/**
 * Cross-process session lease for dsh-safe-tui.
 *
 * DSH's session persistence only enforces single-writer ownership inside one
 * process. The Web host and a detached Safe TUI are different processes, so
 * opening the same session in both can corrupt the log. This small lease file
 * gives those two processes a shared, stale-safe ownership check.
 *
 * The lease is best-effort coordination, not a security boundary.
 */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || process.cwd()
const LEASE_DIR = join(HOME, '.dsh', 'safe-tui', 'leases')
const TTL_MS = 45_000
const HEARTBEAT_MS = 10_000
const SESSION_ID = /^session-[0-9a-fA-F-]+$/

const activeLeases = new Set()
let exitHooked = false

function ensureDir() {
  mkdirSync(LEASE_DIR, { recursive: true })
}

function leasePath(sessionId) {
  if (!SESSION_ID.test(String(sessionId ?? ''))) {
    throw new Error(`invalid session id for lease: ${String(sessionId)}`)
  }
  return join(LEASE_DIR, `${sessionId}.json`)
}

function readLeaseFile(file) {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function atomicWrite(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value), 'utf8')
  renameSync(tmp, file)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is not signalable by us.
    return error?.code === 'EPERM'
  }
}

function isStale(lease) {
  if (!lease || !pidAlive(Number(lease.pid))) return true
  const heartbeat = Number(lease.heartbeat ?? 0)
  return !Number.isFinite(heartbeat) || Date.now() - heartbeat > TTL_MS
}

function removeIfToken(file, token) {
  const current = readLeaseFile(file)
  if (current !== null && current.token !== token) return false
  try { rmSync(file, { force: true }) } catch { /* ignore */ }
  return true
}

function attachHeartbeat(file, lease) {
  const timer = setInterval(() => {
    try {
      const current = readLeaseFile(file)
      if (current === null || current.token !== lease.token) {
        clearInterval(timer)
        activeLeases.delete(lease)
        return
      }
      lease.heartbeat = Date.now()
      atomicWrite(file, lease)
    } catch { /* transient write race; next beat retries */ }
  }, HEARTBEAT_MS)
  timer.unref?.()
  lease._timer = timer
  activeLeases.add(lease)
}

function hookExit() {
  if (exitHooked) return
  exitHooked = true
  // Only the normal exit path is hooked here. Signal handling belongs to the
  // TUI/bridge, which must restore the terminal and kill the PTY; a stale lease
  // is reclaimed by PID death when a hard signal bypasses this hook.
  process.once('exit', () => releaseAllSessionLeases())
}

function tryClaim(sessionId, owner) {
  ensureDir()
  const file = leasePath(sessionId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = Date.now()
    const lease = {
      sessionId,
      owner,
      token: randomUUID(),
      pid: process.pid,
      startedAt: now,
      heartbeat: now,
    }
    let fd
    try {
      fd = openSync(file, 'wx')
      try { writeFileSync(fd, JSON.stringify(lease), 'utf8') } finally { closeSync(fd) }
      attachHeartbeat(file, lease)
      hookExit()
      return lease
    } catch (error) {
      try { if (fd !== undefined) closeSync(fd) } catch { /* ignore */ }
      if (error?.code !== 'EEXIST') throw error
      const existing = readLeaseFile(file)
      if (!isStale(existing)) {
        // A hot-reloaded plugin generation in the same process may still own
        // this lease. Join it instead of detaching a healthy live agent.
        if (Number(existing?.pid) === process.pid && existing?.owner === owner) {
          const shared = { ...existing, sessionId, owner }
          attachHeartbeat(file, shared)
          hookExit()
          return shared
        }
        return null
      }
      if (existing?.token !== undefined) removeIfToken(file, existing.token)
      else {
        try { rmSync(file, { force: true }) } catch { /* ignore */ }
      }
    }
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Acquire a lease for one session.
 * @param {string} sessionId
 * @param {'web'|'console'} owner
 * @param {{waitMs?: number, pollMs?: number, onWait?: (current: object|null) => void}} options
 * @returns {Promise<object|null>} the lease, or null when waitMs is 0 and busy
 */
export async function acquireSessionLease(sessionId, owner, options = {}) {
  const waitMs = Math.max(0, Number(options.waitMs) || 0)
  const pollMs = Math.max(100, Number(options.pollMs) || 250)
  const deadline = Date.now() + waitMs
  let announced = false
  for (;;) {
    const lease = tryClaim(sessionId, owner)
    if (lease !== null) return lease
    const current = inspectSessionLease(sessionId)
    if (Date.now() >= deadline) return null
    if (!announced) {
      announced = true
      try { options.onWait?.(current) } catch { /* ignore */ }
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

/** Release one lease if this process still owns it. */
export function releaseSessionLease(lease) {
  if (!lease) return
  if (lease._timer !== undefined) {
    clearInterval(lease._timer)
    lease._timer = undefined
  }
  activeLeases.delete(lease)
  try {
    const file = leasePath(lease.sessionId)
    removeIfToken(file, lease.token)
  } catch { /* invalid id: nothing to release */ }
}

/** Release every lease owned by this process (used on shutdown). */
export function releaseAllSessionLeases() {
  for (const lease of [...activeLeases]) releaseSessionLease(lease)
}

/** Current live lease, or null when absent/stale. */
export function inspectSessionLease(sessionId) {
  try {
    const file = leasePath(sessionId)
    const lease = readLeaseFile(file)
    if (lease === null) return null
    if (isStale(lease)) {
      removeIfToken(file, lease.token)
      return null
    }
    return lease
  } catch {
    return null
  }
}

/**
 * Release a lease only when it belongs to this process and the expected owner.
 * Used by handoff to make a Web session immediately available to the TUI.
 */
export function forceReleaseSessionLease(sessionId, owner = undefined) {
  try {
    const file = leasePath(sessionId)
    const lease = readLeaseFile(file)
    if (lease === null) return false
    if (Number(lease.pid) !== process.pid) return false
    if (owner !== undefined && lease.owner !== owner) return false
    return removeIfToken(file, lease.token)
  } catch {
    return false
  }
}
/** Synchronous claim for event listeners that must close the race immediately. */
export function tryAcquireSessionLease(sessionId, owner) {
  return tryClaim(sessionId, owner)
}
