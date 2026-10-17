import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-safe-tui-lease-'))
process.env.USERPROFILE = home
process.env.HOME = home
const lease = await import(`../lib/session-lease.js?test=${Date.now()}`)
const id = 'session-11111111-1111-1111-1111-111111111111'
const leaseFile = join(home, '.dsh', 'safe-tui', 'leases', `${id}.json`)

test('claim is exclusive and release makes it reusable', async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const first = lease.tryAcquireSessionLease(id, 'web')
  assert.ok(first)
  assert.equal(lease.tryAcquireSessionLease(id, 'console'), null)
  assert.equal(lease.inspectSessionLease(id)?.owner, 'web')
  lease.releaseSessionLease(first)
  assert.equal(lease.inspectSessionLease(id), null)
  const second = lease.tryAcquireSessionLease(id, 'console')
  assert.ok(second)
  assert.equal(lease.inspectSessionLease(id)?.owner, 'console')
  lease.releaseSessionLease(second)
})

test('same process and owner can rejoin a live lease', async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const first = lease.tryAcquireSessionLease(id, 'web')
  const second = lease.tryAcquireSessionLease(id, 'web')
  assert.ok(first)
  assert.ok(second)
  assert.equal(first.token, second.token)
  lease.releaseSessionLease(second)
  assert.equal(lease.inspectSessionLease(id), null)
  lease.releaseSessionLease(first)
})

test('waits for a lease to be released', async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const first = lease.tryAcquireSessionLease(id, 'web')
  assert.ok(first)
  setTimeout(() => lease.releaseSessionLease(first), 100)
  const second = await lease.acquireSessionLease(id, 'console', { waitMs: 2000, pollMs: 50 })
  assert.ok(second)
  assert.equal(second.owner, 'console')
  lease.releaseSessionLease(second)
})

test('stale pid/heartbeat leases are reclaimed', async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, '.dsh', 'safe-tui', 'leases'), { recursive: true })
  writeFileSync(leaseFile, JSON.stringify({
    sessionId: id,
    owner: 'web',
    token: 'stale',
    pid: 999999,
    startedAt: 0,
    heartbeat: 0,
  }))
  assert.equal(lease.inspectSessionLease(id), null)
  assert.equal(existsSync(leaseFile), false)
  const claimed = lease.tryAcquireSessionLease(id, 'console')
  assert.ok(claimed)
  lease.releaseSessionLease(claimed)
})

test('force release only clears this process owner', async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const claimed = lease.tryAcquireSessionLease(id, 'web')
  assert.ok(claimed)
  assert.equal(lease.forceReleaseSessionLease(id, 'console'), false)
  assert.ok(lease.inspectSessionLease(id))
  assert.equal(lease.forceReleaseSessionLease(id, 'web'), true)
  assert.equal(lease.inspectSessionLease(id), null)
})
