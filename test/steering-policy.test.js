'use strict'
/**
 * The one autopilot command policy (#28, #21): lib/steering-policy.js on its
 * own, then through lib/rpc.js (op `put`, op `capabilities`), checked against
 * the fixture table of the six existing implementations.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createSteeringPolicy, validateValue, isSteeringPath, POLICY_VERSION, RULES, MODES,
  MAX_HEADING_STEP_DEG, REPLAY_FILE, describePolicy
} = require('../lib/steering-policy')
const { createRpcServer, REFUSAL, REQUEST_EVENT, REQUEST_SCHEMA } = require('../lib/rpc')
const FIXTURE = require('./fixtures/steering-implementations.json')

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0)
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yey-policy-'))

// ── the fixture table ────────────────────────────────────────────────────────

test('fixture: the table names all six implementations', () => {
  assert.deepEqual(FIXTURE.implementations.map((i) => i.id).sort(), [
    'cloud', 'connector-0.4', 'firmware', 'manager-bridge-removed', 'sim-autopilot-plugin', 'sim-command-listener'
  ])
  for (const impl of FIXTURE.implementations) {
    assert.ok(impl.repo && impl.ref && impl.files.length && impl.paths.length, impl.id)
  }
})

test('fixture: every command an implementation sends to an autopilot is accepted', () => {
  for (const e of FIXTURE.emits) {
    assert.equal(validateValue(e.path, e.value), '', `${e.from} ${e.path}=${JSON.stringify(e.value)}`)
  }
})

test('fixture: every must_refuse command is refused', () => {
  for (const e of FIXTURE.must_refuse) {
    const bad = !isSteeringPath(e.path) || validateValue(e.path, e.value) !== ''
    assert.ok(bad, `${e.path}=${JSON.stringify(e.value)} (${e.why})`)
  }
})

test('fixture: the action vocabulary is exactly what some implementation handles', () => {
  const actions = Object.keys(RULES).filter((p) => p.startsWith('steering.autopilot.actions.'))
    .map((p) => p.split('.').pop()).sort()
  assert.deepEqual(actions, ['adjustHeading', 'advanceMode', 'tack'])
})

test('fixture: the state enum is the union of the firmware, cloud and sim modes', () => {
  const union = new Set()
  for (const impl of FIXTURE.implementations) {
    for (const p of impl.paths) if (p.path === 'steering.autopilot.state' && Array.isArray(p.values)) p.values.forEach((v) => union.add(v))
  }
  assert.deepEqual([...MODES].sort(), [...union].sort())
})

// ── the allowlist ────────────────────────────────────────────────────────────

test('allowlist: exact paths only, no wildcard actions', () => {
  assert.deepEqual(Object.keys(RULES).sort(), [
    'steering.autopilot.actions.adjustHeading',
    'steering.autopilot.actions.advanceMode',
    'steering.autopilot.actions.tack',
    'steering.autopilot.state',
    'steering.autopilot.target.headingMagnetic',
    'steering.autopilot.target.headingTrue',
    'steering.autopilot.target.windAngleApparent'
  ])
  for (const p of ['steering.autopilot.actions.gybe', 'steering.autopilot.actions.anything',
    'steering.autopilot.actions.*', 'steering.rudderAngle', 'steering.autopilot.target']) {
    assert.equal(isSteeringPath(p), false, p)
  }
})

// ── per-path validators ──────────────────────────────────────────────────────

test('state: only the mode enum, lower-case strings', () => {
  for (const m of MODES) assert.equal(validateValue('steering.autopilot.state', m), '')
  for (const v of ['AUTO', 'Auto', 'compass', '', true, 1, null, '"auto"']) {
    assert.notEqual(validateValue('steering.autopilot.state', v), '', JSON.stringify(v))
  }
})

test('headingTrue / headingMagnetic: radians in [0, 2pi)', () => {
  for (const p of ['steering.autopilot.target.headingTrue', 'steering.autopilot.target.headingMagnetic']) {
    for (const v of [0, 1.5, 6.28]) assert.equal(validateValue(p, v), '', `${p}=${v}`)
    for (const v of [-0.0001, 2 * Math.PI, 7, 270, NaN, Infinity, '1.5', true, null]) {
      assert.notEqual(validateValue(p, v), '', `${p}=${v}`)
    }
  }
})

test('windAngleApparent: radians in [-pi, pi]', () => {
  const p = 'steering.autopilot.target.windAngleApparent'
  for (const v of [-Math.PI, -0.7, 0, Math.PI]) assert.equal(validateValue(p, v), '')
  for (const v of [-3.2, 3.2, 90, NaN, 'x']) assert.notEqual(validateValue(p, v), '', String(v))
})

test('adjustHeading: degrees, refused (not clamped) past the 150 degree manoeuvre bound', () => {
  assert.equal(MAX_HEADING_STEP_DEG, 150)
  const p = 'steering.autopilot.actions.adjustHeading'
  for (const v of [-150, -10, 1, 0.5, 150]) assert.equal(validateValue(p, v), '')
  for (const v of [150.5, -151, 360, NaN, '10', true]) assert.notEqual(validateValue(p, v), '', String(v))
})

test('tack: port, starboard or true; advanceMode: true only', () => {
  for (const v of ['port', 'starboard', true]) assert.equal(validateValue('steering.autopilot.actions.tack', v), '')
  for (const v of ['left', false, 1]) assert.notEqual(validateValue('steering.autopilot.actions.tack', v), '')
  assert.equal(validateValue('steering.autopilot.actions.advanceMode', true), '')
  for (const v of [false, 'auto', 1]) assert.notEqual(validateValue('steering.autopilot.actions.advanceMode', v), '')
})

// ── the request: boat_id, deadline_ms, replay ────────────────────────────────

function policy (opts = {}) {
  let clock = opts.clock || T0
  const p = createSteeringPolicy({ dir: opts.dir || null, now: () => clock, boatId: () => 'b_1', ...opts.extra })
  return { p, advance: (ms) => { clock += ms }, at: () => clock }
}

test('request: boat_id is required and must be this boat', () => {
  const { p } = policy()
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa01', deadline_ms: T0 + 4000 }), { refuse: 'boat_id_missing' })
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa02', boat_id: 'b_2', deadline_ms: T0 + 4000 }), { drop: 'foreign_boat' })
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa03', boat_id: 'b_1', deadline_ms: T0 + 4000 }), {})
})

test('request: an unknown own boat id refuses every put (fail closed)', () => {
  const p = createSteeringPolicy({ now: () => T0, boatId: () => '' })
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa04', boat_id: 'b_1', deadline_ms: T0 + 4000 }), { refuse: 'boat_id_unknown' })
})

test('request: deadline_ms is required, refused when stale or too far ahead', () => {
  const { p } = policy()
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa11', boat_id: 'b_1' }), { refuse: 'deadline_missing' })
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa12', boat_id: 'b_1', deadline_ms: 0 }), { refuse: 'deadline_missing' })
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa13', boat_id: 'b_1', deadline_ms: 'soon' }), { refuse: 'deadline_missing' })
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa14', boat_id: 'b_1', deadline_ms: T0 - 1 }), { drop: 'expired' })
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa15', boat_id: 'b_1', deadline_ms: T0 + 61_000 }), { refuse: 'deadline_too_far' })
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa16', boat_id: 'b_1', deadline_ms: T0 + 60_000 }), {})
})

test('request: a replayed id is dropped', () => {
  const { p } = policy()
  const r = { id: 'rpc_aaaaaaaa21', boat_id: 'b_1', deadline_ms: T0 + 4000 }
  assert.deepEqual(p.checkRequest(r), {})
  assert.deepEqual(p.checkRequest(r), { drop: 'duplicate' })
})

test('replay ids survive a restart, in a 0600 file in the data dir', () => {
  const dir = tmpdir()
  const a = policy({ dir })
  const r = { id: 'rpc_aaaaaaaa31', boat_id: 'b_1', deadline_ms: T0 + 4000 }
  assert.deepEqual(a.p.checkRequest(r), {})
  const file = path.join(dir, REPLAY_FILE)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const b = policy({ dir })           // a fresh process
  assert.deepEqual(b.p.checkRequest(r), { drop: 'duplicate' })
  assert.deepEqual(b.p.checkRequest({ ...r, id: 'rpc_aaaaaaaa32' }), {})
})

test('replay store re-tightens a loosened file mode on write', () => {
  const dir = tmpdir()
  const file = path.join(dir, REPLAY_FILE)
  fs.writeFileSync(file, JSON.stringify({ v: 1, ids: [] }), { mode: 0o644 })
  fs.chmodSync(file, 0o644)
  const { p } = policy({ dir })
  p.checkRequest({ id: 'rpc_aaaaaaaa33', boat_id: 'b_1', deadline_ms: T0 + 4000 })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('replay store: a corrupt file starts empty, never throws', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, REPLAY_FILE), '{nope', { mode: 0o600 })
  const { p } = policy({ dir })
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaaa34', boat_id: 'b_1', deadline_ms: T0 + 4000 }), {})
})

test('replay store is bounded: old entries expire, a full store refuses (fail closed)', () => {
  const { p, advance } = policy({ extra: { maxReplayIds: 3 } })
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(p.checkRequest({ id: `rpc_aaaaaaab${i}0`, boat_id: 'b_1', deadline_ms: T0 + 4000 }), {})
  }
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaab90', boat_id: 'b_1', deadline_ms: T0 + 4000 }), { refuse: 'replay_store_full' })
  // Past the deadline plus the retention, the old ids no longer need keeping.
  advance(4000 + 10 * 60_000 + 1)
  assert.deepEqual(p.checkRequest({ id: 'rpc_aaaaaaab91', boat_id: 'b_1', deadline_ms: T0 + 4000 + 10 * 60_000 + 5000 }), {})
  assert.equal(p.replaySize(), 1)
})

test('rate: 12 admitted puts a minute', () => {
  const { p, advance } = policy()
  for (let i = 0; i < 12; i++) assert.equal(p.admitRate(), true)
  assert.equal(p.admitRate(), false)
  advance(60_000)
  assert.equal(p.admitRate(), true)
})

// ── published ────────────────────────────────────────────────────────────────

test('describe: a versioned, JSON-safe policy document', () => {
  const d = describePolicy()
  assert.equal(d.version, POLICY_VERSION)
  assert.equal(d.schema, 'yey.steering.policy.v1')
  assert.deepEqual(Object.keys(d.paths).sort(), Object.keys(RULES).sort())
  assert.deepEqual(d.paths['steering.autopilot.state'].values, [...MODES])
  assert.equal(d.paths['steering.autopilot.target.headingTrue'].unit, 'rad')
  assert.equal(d.paths['steering.autopilot.actions.adjustHeading'].max, 150)
  assert.equal(d.max_heading_step_deg, 150)
  assert.equal(d.out_of_range, 'refuse')
  assert.equal(d.rate.puts_per_min, 12)
  assert.deepEqual(d.request, { boat_id: 'required', deadline_ms: 'required', max_deadline_ahead_ms: 60000, replay: 'persisted' })
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d)
})

// ── through rpc.js ───────────────────────────────────────────────────────────

let seq = 0
function env (args, data = {}) {
  seq += 1
  return {
    type: REQUEST_EVENT,
    data: { schema: REQUEST_SCHEMA, id: `rpc_${String(seq).padStart(24, 'c')}`, boat_id: 'b_1', op: 'put', args, deadline_ms: T0 + 4000, ...data }
  }
}

function rpcServer (opts = {}) {
  const calls = []
  const audits = []
  const rpc = createRpcServer({
    app: { putSelfPath: (p, v) => { calls.push({ p, v }); return Promise.resolve({ state: 'COMPLETED', statusCode: 200 }) } },
    getSource: () => ({ selfTree: async () => opts.tree || {} }),
    publish: async () => {},
    boatId: () => 'b_1',
    now: () => T0,
    remoteSteering: true,
    audit: (e) => audits.push(e),
    steeringPolicy: opts.steeringPolicy,
    ...opts.rpc
  })
  return { rpc, calls, audits }
}

test('rpc put: an out-of-range value is bad_request with the reason, audited, never executed', async () => {
  const { rpc, calls, audits } = rpcServer()
  const r = await rpc.handle(env({ path: 'steering.autopilot.target.headingTrue', value: 270 }))
  assert.equal(r.error, REFUSAL.BAD_REQUEST)
  assert.equal(r.detail, 'value_out_of_range')
  assert.equal(calls.length, 0)
  assert.equal(audits[0].outcome, 'refused')
  assert.equal(audits[0].detail, 'value_out_of_range')
})

test('rpc put: an action outside the vocabulary is not_permitted', async () => {
  const { rpc, calls } = rpcServer()
  assert.equal((await rpc.handle(env({ path: 'steering.autopilot.actions.gybe', value: true }))).error, REFUSAL.NOT_PERMITTED)
  assert.equal(calls.length, 0)
})

test('rpc put: a put with no deadline_ms is refused and audited', async () => {
  const { rpc, calls, audits } = rpcServer()
  const r = await rpc.handle(env({ path: 'steering.autopilot.state', value: 'auto' }, { deadline_ms: undefined }))
  assert.equal(r.error, REFUSAL.BAD_REQUEST)
  assert.equal(r.detail, 'deadline_missing')
  assert.equal(calls.length, 0)
  assert.equal(audits[0].detail, 'deadline_missing')
})

test('rpc put: a put with no boat_id is refused and audited', async () => {
  const { rpc, calls, audits } = rpcServer()
  const r = await rpc.handle(env({ path: 'steering.autopilot.state', value: 'auto' }, { boat_id: undefined }))
  assert.equal(r.error, REFUSAL.BAD_REQUEST)
  assert.equal(r.detail, 'boat_id_missing')
  assert.equal(calls.length, 0)
  assert.equal(audits[0].outcome, 'refused')
})

test('rpc: reads still answer without boat_id / deadline_ms (only puts require them)', async () => {
  const { rpc } = rpcServer()
  const r = await rpc.handle(env({}, { op: 'capabilities', boat_id: undefined, deadline_ms: undefined }))
  assert.equal(r.ok, true)
})

test('rpc put: a replayed put id is dropped across a restart', async () => {
  const dir = tmpdir()
  const e = env({ path: 'steering.autopilot.state', value: 'auto' })
  const first = rpcServer({ steeringPolicy: createSteeringPolicy({ dir, now: () => T0, boatId: () => 'b_1' }) })
  assert.equal((await first.rpc.handle(e)).ok, true)
  const second = rpcServer({ steeringPolicy: createSteeringPolicy({ dir, now: () => T0, boatId: () => 'b_1' }) })
  assert.equal(await second.rpc.handle(e), null)
  assert.equal(second.calls.length, 0)
  assert.deepEqual([second.audits[0].outcome, second.audits[0].error], ['dropped', 'duplicate'])
})

test('rpc capabilities: publishes the versioned policy next to the switch', async () => {
  const { rpc } = rpcServer()
  const r = await rpc.handle(env({}, { op: 'capabilities' }))
  const rs = r.result.remote_steering
  assert.equal(rs.enabled, true)
  assert.deepEqual(rs.paths, Object.keys(RULES))
  assert.deepEqual(rs.policy, describePolicy())
  assert.equal(rs.policy_version, POLICY_VERSION)
})

test('rpc put timeout: reads back the path and audits the late outcome', async () => {
  let finish
  const audits = []
  const timers = []
  const rpc = createRpcServer({
    app: { putSelfPath: (p, v, cb) => { finish = cb; return { state: 'PENDING', statusCode: 202 } } },
    getSource: () => ({ selfTree: async () => ({ steering: { autopilot: { state: { value: 'standby', timestamp: 't' } } } }) }),
    publish: async () => {},
    boatId: () => 'b_1',
    now: () => T0,
    remoteSteering: true,
    audit: (e) => audits.push(e),
    setTimer: (fn) => { timers.push(fn); return timers.length },
    clearTimer: () => {}
  })
  const pending = rpc.handle(env({ path: 'steering.autopilot.state', value: 'auto' }))
  await new Promise((resolve) => setImmediate(resolve))
  timers[0]()
  const r = await pending
  assert.equal(r.error, REFUSAL.TIMEOUT)
  assert.deepEqual(r.readback, { path: 'steering.autopilot.state', value: 'standby' })
  assert.equal(audits[0].outcome, 'timeout')
  finish({ state: 'COMPLETED', statusCode: 200 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(audits[1].outcome, 'accepted')
  assert.equal(audits[1].detail, 'after_timeout')
})
