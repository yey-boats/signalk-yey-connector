'use strict'
/**
 * #39: auto-off must fail closed. When the time remote steering was switched
 * on cannot be kept on disk (read-only or missing data dir), a restart would
 * start the auto-off clock again, or turn steering back on after auto-off
 * fired. So remote steering stays off on start, and the status says why.
 *
 * Also from the #36 review: puts refused as `deadline_too_far` or dropped as
 * `expired` name a likely boat clock problem.
 *
 * The read-only tests need a non-root POSIX user (root writes anyway); run
 *   docker run --rm -u 1000:1000 -v "$PWD":/w -w /w node:22 npm test
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createRpcServer, REQUEST_EVENT, REQUEST_SCHEMA } = require('../lib/rpc')
const { createRuntime } = require('../lib/runtime')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yey-failclosed-'))
const T0 = Date.UTC(2026, 10, 10, 9, 0, 0)
const H = 3600e3
const nonRoot = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0)

function runtimeWith ({ dir, options, clock, saveFails = false }) {
  const saved = []
  const statuses = []
  const timers = []
  let captured
  const runtime = createRuntime({
    app: {
      debug: () => {},
      getDataDirPath: () => dir,
      setPluginStatus: (m) => statuses.push(m),
      savePluginOptions: (o, cb) => {
        if (saveFails) { if (cb) cb(new Error('EROFS')); return }
        saved.push(o); if (cb) cb(null)
      },
      putSelfPath: () => Promise.resolve({ state: 'COMPLETED', statusCode: 200 })
    },
    version: '9.9.9',
    options,
    deps: {
      now: () => clock.t,
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
      clearTimeout: () => {},
      createRpcServer: (o) => { captured = o; return require('../lib/rpc').createRpcServer(o) },
      source: { subscribe: () => ({ close: () => {} }), selfTree: async () => ({}) }
    }
  })
  return { runtime, saved, statuses, timers, rpcOpts: () => captured }
}

function readOnly (dir, fn) {
  fs.chmodSync(dir, 0o500)
  try { return fn() } finally { fs.chmodSync(dir, 0o700) }
}

const ON = { remote_steering: true, remote_steering_auto_off_hours: 2 }

test('read-only data dir + auto-off: remote steering stays off on start, and says why', { skip: !nonRoot && 'needs a non-root POSIX user' }, () => {
  const dir = tmp()
  const clock = { t: T0 }
  readOnly(dir, () => {
    const h = runtimeWith({ dir, options: ON, clock })
    assert.equal(h.rpcOpts().remoteSteering(), false)
    const snap = h.runtime.snapshot()
    assert.equal(snap.remote_steering, false)
    assert.equal(snap.remote_steering_auto_off.problem, 'not_durable')
    assert.match(snap.remote_steering_auto_off.problem_text, /cannot be saved/)
    assert.match(h.statuses.join('\n'), /Remote steering is off: .*cannot be saved/)
    // The owner's switch is left alone: it is the data dir that needs fixing.
    assert.equal(h.saved.length, 0)
  })
})

test('read-only data dir: a restart at 1.5 h does not restart the clock (steering never comes on)', { skip: !nonRoot && 'needs a non-root POSIX user' }, () => {
  const dir = tmp()
  const clock = { t: T0 }
  readOnly(dir, () => {
    runtimeWith({ dir, options: ON, clock })
    clock.t = T0 + 1.5 * H
    const again = runtimeWith({ dir, options: ON, clock })
    clock.t = T0 + 3 * H
    assert.equal(again.rpcOpts().remoteSteering(), false)
  })
})

test('data dir goes read-only after auto-off fired and the options save failed: a restart keeps steering off', { skip: !nonRoot && 'needs a non-root POSIX user' }, () => {
  const dir = tmp()
  const clock = { t: T0 }
  const first = runtimeWith({ dir, options: ON, clock })
  assert.equal(first.rpcOpts().remoteSteering(), true)  // writable: the start time is on disk
  readOnly(dir, () => {
    clock.t = T0 + 2 * H
    const h = runtimeWith({ dir, options: ON, clock, saveFails: true })
    assert.equal(h.rpcOpts().remoteSteering(), false)    // auto-off fires
    clock.t = T0 + 2.5 * H
    const again = runtimeWith({ dir, options: ON, clock, saveFails: true })
    assert.equal(again.rpcOpts().remoteSteering(), false)
    clock.t = T0 + 10 * H
    assert.equal(again.rpcOpts().remoteSteering(), false)
  })
})

test('no data dir + auto-off: remote steering stays off on start', () => {
  const clock = { t: T0 }
  const h = runtimeWith({ dir: null, options: ON, clock })
  assert.equal(h.rpcOpts().remoteSteering(), false)
  assert.equal(h.runtime.snapshot().remote_steering_auto_off.problem, 'not_durable')
})

test('read-only data dir without auto-off: remote steering still comes on (nothing to keep)', { skip: !nonRoot && 'needs a non-root POSIX user' }, () => {
  const dir = tmp()
  const clock = { t: T0 }
  readOnly(dir, () => {
    const h = runtimeWith({ dir, options: { remote_steering: true }, clock })
    assert.equal(h.rpcOpts().remoteSteering(), true)
    assert.equal(h.runtime.snapshot().remote_steering_auto_off.problem, '')
  })
})

test('writable data dir + auto-off: steering on, no problem reported', () => {
  const clock = { t: T0 }
  const h = runtimeWith({ dir: tmp(), options: ON, clock })
  assert.equal(h.rpcOpts().remoteSteering(), true)
  assert.equal(h.runtime.snapshot().remote_steering_auto_off.problem, '')
})

// ── boat clock (#36 review) ──────────────────────────────────────────────────

let seq = 0
function put (deadline) {
  seq += 1
  return { type: REQUEST_EVENT,
    data: { schema: REQUEST_SCHEMA, id: `rpc_${String(seq).padStart(24, 'c')}`, boat_id: 'b_1',
      op: 'put', args: { path: 'steering.autopilot.state', value: 'standby' }, deadline_ms: deadline } }
}

function rpcWith () {
  const statuses = []
  const rpc = createRpcServer({
    app: { putSelfPath: () => Promise.resolve({ state: 'COMPLETED', statusCode: 200 }) },
    publish: async () => {},
    boatId: () => 'b_1',
    now: () => T0,
    remoteSteering: () => true,
    setStatus: (m) => statuses.push(m),
    audit: () => {}
  })
  return { rpc, statuses }
}

test('a put refused as deadline_too_far names a likely slow boat clock', async () => {
  const { rpc, statuses } = rpcWith()
  await rpc.handle(put(T0 + 40_000))
  const c = rpc.stats().clock_problem
  assert.equal(c.reason, 'deadline_too_far')
  assert.match(c.text, /boat clock .*about 40 s slow/i)
  assert.match(statuses.pop(), /clock/i)
})

test('a put dropped as expired names a likely fast boat clock', async () => {
  const { rpc, statuses } = rpcWith()
  await rpc.handle(put(T0 - 30_000))
  const c = rpc.stats().clock_problem
  assert.equal(c.reason, 'expired')
  assert.match(c.text, /boat clock .*fast/i)
  assert.match(statuses.pop(), /clock/i)
})

test('an accepted put clears the clock problem', async () => {
  const { rpc } = rpcWith()
  await rpc.handle(put(T0 + 40_000))
  assert.ok(rpc.stats().clock_problem)
  await rpc.handle(put(T0 + 4000))
  assert.equal(rpc.stats().clock_problem, null)
})
