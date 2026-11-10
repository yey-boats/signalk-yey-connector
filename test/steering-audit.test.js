'use strict'
/**
 * #22: the persistent steering audit log (lib/steering-audit.js), the hook in
 * lib/rpc.js that feeds it every put, and the remote_steering auto-off.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createSteeringAudit, AUDIT_FILE } = require('../lib/steering-audit')
const { createRpcServer, REFUSAL, REQUEST_EVENT, REQUEST_SCHEMA } = require('../lib/rpc')
const { createRuntime } = require('../lib/runtime')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yey-audit-'))
const readLines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const T0 = Date.UTC(2026, 10, 10, 9, 0, 0)

// ── the log itself ───────────────────────────────────────────────────────────

test('audit: one JSON line per record, in the data dir, owner-only (0600)', () => {
  const dir = tmp()
  const audit = createSteeringAudit({ dir, now: () => T0 })
  audit.record({ request_id: 'rpc_1', path: 'steering.autopilot.state', value: 'auto', outcome: 'accepted' })
  audit.record({ request_id: 'rpc_2', path: 'steering.autopilot.state', value: 'standby', outcome: 'refused', error: 'rate_limited' })
  const file = path.join(dir, AUDIT_FILE)
  assert.equal(audit.file, file)
  const lines = readLines(file)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0], { t: new Date(T0).toISOString(), request_id: 'rpc_1',
    path: 'steering.autopilot.state', value: 'auto', outcome: 'accepted' })
  assert.equal(lines[1].error, 'rate_limited')
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('audit: a file left with a wider mode is tightened on the next write', () => {
  if (process.platform === 'win32') return
  const dir = tmp()
  const file = path.join(dir, AUDIT_FILE)
  fs.writeFileSync(file, '', { mode: 0o644 })
  fs.chmodSync(file, 0o644)
  createSteeringAudit({ dir }).record({ path: 'p', outcome: 'accepted' })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('audit: size-capped rotation keeps `keep` old files and drops the oldest', () => {
  const dir = tmp()
  const audit = createSteeringAudit({ dir, now: () => T0, maxBytes: 1000, keep: 2 })
  for (let i = 0; i < 60; i++) audit.record({ request_id: `rpc_${i}`, path: 'steering.autopilot.state', value: 'auto', outcome: 'accepted' })
  const names = fs.readdirSync(dir).sort()
  assert.deepEqual(names, [AUDIT_FILE, `${AUDIT_FILE}.1`, `${AUDIT_FILE}.2`])
  for (const n of names) {
    assert.ok(fs.statSync(path.join(dir, n)).size <= 1000, n)
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, n)).mode & 0o777, 0o600, n)
  }
  // The newest record is in the live file; recent() reads across the rotation.
  assert.equal(readLines(path.join(dir, AUDIT_FILE)).pop().request_id, 'rpc_59')
  const recent = audit.recent(8)
  assert.equal(recent.length, 8)
  assert.deepEqual(recent.map((r) => r.request_id), Array.from({ length: 8 }, (_, i) => `rpc_${52 + i}`))
})

test('audit: values are scalars only, strings capped; no data dir keeps a memory tail', () => {
  const audit = createSteeringAudit({ dir: null, now: () => T0 })
  assert.equal(audit.file, null)
  audit.record({ path: 'p', value: { nested: 'object' }, outcome: 'refused', error: 'bad_request' })
  audit.record({ path: 'p', value: 'x'.repeat(500), outcome: 'refused', error: 'bad_request' })
  const [a, b] = audit.recent(5)
  assert.equal(a.value, 'object')
  assert.ok(b.value.length <= 64)
})

test('audit: a write that fails never throws into the caller', () => {
  const audit = createSteeringAudit({ dir: path.join(tmp(), 'missing', 'deeper'), now: () => T0 })
  assert.doesNotThrow(() => audit.record({ path: 'p', outcome: 'accepted' }))
})

// ── the hook in rpc.js ───────────────────────────────────────────────────────

let seq = 0
function put (pathName, value, extra = {}) {
  seq += 1
  return { type: REQUEST_EVENT,
    data: { schema: REQUEST_SCHEMA, id: `rpc_${String(seq).padStart(24, 'b')}`, boat_id: 'b_1',
      op: 'put', args: { path: pathName, value }, deadline_ms: 0, ...extra } }
}

function rpcWith ({ steering = true, clock = T0 } = {}) {
  const records = []
  const rpc = createRpcServer({
    app: { putSelfPath: () => Promise.resolve({ state: 'COMPLETED', statusCode: 200 }) },
    publish: async () => {},
    boatId: () => 'b_1',
    now: () => clock,
    remoteSteering: () => steering,
    audit: (entry) => records.push(entry)
  })
  return { rpc, records }
}

test('rpc: every put is audited with request id, path, value and outcome — refusals too', async () => {
  const { rpc, records } = rpcWith()
  const ok = put('steering.autopilot.state', 'auto')
  await rpc.handle(ok)
  await rpc.handle(put('steering.rudderAngle', 0.1))
  assert.deepEqual(records[0], { request_id: ok.data.id, path: 'steering.autopilot.state', value: 'auto',
    outcome: 'accepted' })
  assert.equal(records[1].outcome, 'refused')
  assert.equal(records[1].error, REFUSAL.NOT_PERMITTED)
  assert.equal(records[1].path, 'steering.rudderAngle')
})

test('rpc: a put refused because the switch is off is audited', async () => {
  const { rpc, records } = rpcWith({ steering: false })
  await rpc.handle(put('steering.autopilot.state', 'auto'))
  assert.equal(records.length, 1)
  assert.equal(records[0].error, REFUSAL.REMOTE_STEERING_OFF)
})

test('rpc: reads are not audited, and an audit sink that throws changes nothing', async () => {
  const { rpc, records } = rpcWith()
  await rpc.handle({ ...put('x', 1), data: { ...put('x', 1).data, op: 'capabilities', args: {} } })
  assert.equal(records.length, 0)
  const loud = createRpcServer({
    app: { putSelfPath: () => Promise.resolve({ state: 'COMPLETED', statusCode: 200 }) },
    publish: async () => {}, now: () => T0, remoteSteering: true,
    audit: () => { throw new Error('disk full') }
  })
  assert.equal((await loud.handle(put('steering.autopilot.state', 'auto'))).ok, true)
})

// ── the runtime: file in the data dir, auto-off ──────────────────────────────

function runtimeWith ({ dir = tmp(), options = {}, clock }) {
  const saved = []
  const statuses = []
  const timers = []
  let captured
  const runtime = createRuntime({
    app: {
      debug: () => {},
      getDataDirPath: () => dir,
      setPluginStatus: (m) => statuses.push(m),
      savePluginOptions: (o, cb) => { saved.push(o); if (cb) cb(null) },
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
  return { runtime, dir, saved, statuses, timers, rpcOpts: () => captured }
}

test('runtime: puts land in the audit file in the plugin data dir, shown in the snapshot', async () => {
  const clock = { t: T0 }
  const h = runtimeWith({ options: { remote_steering: true }, clock })
  const env = put('steering.autopilot.state', 'auto')
  h.rpcOpts().audit({ request_id: env.data.id, path: 'steering.autopilot.state', value: 'auto', outcome: 'accepted' })
  const lines = readLines(path.join(h.dir, AUDIT_FILE))
  assert.equal(lines[0].request_id, env.data.id)
  assert.equal(h.runtime.snapshot().steering_log[0].request_id, env.data.id)
})

test('runtime: auto-off is off by default (0 hours)', () => {
  const clock = { t: T0 }
  const h = runtimeWith({ options: { remote_steering: true }, clock })
  clock.t += 1000 * 3600 * 1000
  assert.equal(h.rpcOpts().remoteSteering(), true)
  assert.equal(h.runtime.snapshot().remote_steering_auto_off.hours, 0)
  assert.equal(h.saved.length, 0)
})

test('runtime: remote_steering_auto_off_hours turns the switch off after N hours, audited and reported', () => {
  const clock = { t: T0 }
  const h = runtimeWith({ options: { remote_steering: true, remote_steering_auto_off_hours: 2, connectionUrl: 'u' }, clock })
  const snap = h.runtime.snapshot().remote_steering_auto_off
  assert.equal(snap.hours, 2)
  assert.equal(snap.on_since, new Date(T0).toISOString())
  assert.equal(snap.off_at, new Date(T0 + 2 * 3600e3).toISOString())
  assert.ok(h.timers.length >= 1, 'a timer is armed')

  clock.t = T0 + 2 * 3600e3 - 1
  assert.equal(h.rpcOpts().remoteSteering(), true)
  clock.t = T0 + 2 * 3600e3
  h.timers[h.timers.length - 1].fn()
  assert.equal(h.rpcOpts().remoteSteering(), false)
  assert.equal(h.runtime.cfg.remoteSteering, false)
  // The owner's switch in the options file is off too, and nothing else changed.
  assert.deepEqual(h.saved.pop(), { remote_steering: false, remote_steering_auto_off_hours: 2, connectionUrl: 'u' })
  const after = h.runtime.snapshot().remote_steering_auto_off
  assert.equal(after.switched_off_at, new Date(clock.t).toISOString())
  assert.match(h.statuses.pop(), /switched off automatically after 2 h/)
  const last = readLines(path.join(h.dir, AUDIT_FILE)).pop()
  assert.equal(last.outcome, 'auto_off')
})

test('runtime: the deadline holds even if the timer never fires, and survives a restart', () => {
  const dir = tmp()
  const clock = { t: T0 }
  const options = { remote_steering: true, remote_steering_auto_off_hours: 1 }
  runtimeWith({ dir, options, clock })
  clock.t = T0 + 30 * 60e3
  // A restart (SignalK restarts the plugin on every settings save) keeps the
  // original on-since time instead of starting the clock again.
  const again = runtimeWith({ dir, options, clock })
  assert.equal(again.runtime.snapshot().remote_steering_auto_off.on_since, new Date(T0).toISOString())
  clock.t = T0 + 3600e3 + 1
  assert.equal(again.rpcOpts().remoteSteering(), false)   // checked on read, no timer needed
  assert.equal(again.saved.pop().remote_steering, false)
})

test('runtime: switching steering off forgets the on-since time', () => {
  const dir = tmp()
  const clock = { t: T0 }
  runtimeWith({ dir, options: { remote_steering: true, remote_steering_auto_off_hours: 1 }, clock })
  runtimeWith({ dir, options: { remote_steering: false, remote_steering_auto_off_hours: 1 }, clock })
  clock.t = T0 + 5 * 3600e3
  const on = runtimeWith({ dir, options: { remote_steering: true, remote_steering_auto_off_hours: 1 }, clock })
  assert.equal(on.runtime.snapshot().remote_steering_auto_off.on_since, new Date(clock.t).toISOString())
  assert.equal(on.rpcOpts().remoteSteering(), true)
})

test('the plugin schema offers remote_steering_auto_off_hours, default 0', () => {
  const prop = require('../index.js')({ debug: () => {} }).schema().properties.remote_steering_auto_off_hours
  assert.equal(prop.type, 'number')
  assert.equal(prop.default, 0)
})

test('rpc: a put dropped unanswered (expired or a duplicate id) is audited as dropped', async () => {
  const { rpc, records } = rpcWith()
  const env = put('steering.autopilot.state', 'auto')
  await rpc.handle(env)
  await rpc.handle(env)
  await rpc.handle(put('steering.autopilot.state', 'auto', { deadline_ms: T0 - 1 }))
  assert.deepEqual(records.map((r) => [r.outcome, r.error]),
    [['accepted', undefined], ['dropped', 'duplicate'], ['dropped', 'expired']])
})
