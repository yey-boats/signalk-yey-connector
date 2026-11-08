'use strict'
/**
 * Remote steering: op `put` and op `capabilities` (lib/rpc.js). Injected fake
 * app, no SignalK server, no socket.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createRpcServer, REFUSAL, REQUEST_EVENT, REQUEST_SCHEMA, REPLY_SCHEMA, REPLY_SUBJECT,
  STEERING_PATHS, LIMITS, isSteeringPath, isPutScalar, putOutcome
} = require('../lib/rpc')
const pkg = require('../package.json')

let seq = 0
function req (op, args = {}, extra = {}) {
  seq += 1
  return {
    type: REQUEST_EVENT,
    data: {
      schema: REQUEST_SCHEMA,
      id: `rpc_${String(seq).padStart(24, 'a')}`,
      boat_id: 'b_1',
      op,
      args,
      deadline_ms: 0,
      ...extra
    }
  }
}

/** A fake app whose putSelfPath does what `behave` says. */
function fakeApp (behave = () => Promise.resolve({ state: 'COMPLETED', statusCode: 200 })) {
  const calls = []
  const statuses = []
  const debugs = []
  return {
    calls,
    statuses,
    debugs,
    putSelfPath: (path, value, cb) => { calls.push({ path, value }); return behave(path, value, cb) },
    setPluginStatus: (msg) => statuses.push(msg),
    debug: (msg) => debugs.push(msg)
  }
}

function server (opts = {}) {
  const sent = []
  let clock = opts.clock || Date.UTC(2026, 10, 8, 12, 3, 0)
  const app = opts.app || fakeApp()
  const rpc = createRpcServer({
    app,
    getSource: () => ({ selfTree: async () => ({}) }),
    policy: () => opts.policy || { consent: [], deny: [], mappings: [], onRequest: [] },
    publish: async (subject, payload, o) => { sent.push({ subject, payload, opts: o }) },
    boatId: () => 'b_1',
    now: () => clock,
    limits: opts.limits,
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer,
    remoteSteering: 'remoteSteering' in opts ? opts.remoteSteering : true,
    version: pkg.version,
    setStatus: (msg) => app.setPluginStatus(msg),
    debug: (msg) => app.debug(msg)
  })
  return { rpc, sent, app, advance: (ms) => { clock += ms } }
}

const put = (path, value) => req('put', { path, value })

// ── the switch ───────────────────────────────────────────────────────────────

test('remote steering is off by default', async () => {
  const app = fakeApp()
  const rpc = createRpcServer({ app, publish: async () => {}, now: () => 1 })
  const r = await rpc.handle(put('steering.autopilot.state', 'auto'))
  assert.equal(r.ok, false)
  assert.equal(r.error, REFUSAL.REMOTE_STEERING_OFF)
  assert.equal(app.calls.length, 0)
})

test('the switch is checked before anything else, even a bad path', async () => {
  const { rpc, app } = server({ remoteSteering: false })
  assert.equal((await rpc.handle(put('electrical.switches.x.state', true))).error, REFUSAL.REMOTE_STEERING_OFF)
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'auto'))).error, REFUSAL.REMOTE_STEERING_OFF)
  assert.equal(app.calls.length, 0)
})

test('only exactly true turns it on; the getter is read fresh each time', async () => {
  let on = 'true'
  const { rpc, app } = server({ remoteSteering: () => on })
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'auto'))).error, REFUSAL.REMOTE_STEERING_OFF)
  on = true
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'auto'))).ok, true)
  on = false
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'auto'))).error, REFUSAL.REMOTE_STEERING_OFF)
  assert.equal(app.calls.length, 1)
})

// ── the allowlist ────────────────────────────────────────────────────────────

test('allowlisted autopilot paths are executed via putSelfPath', async () => {
  const { rpc, app, sent } = server()
  const r = await rpc.handle(put('steering.autopilot.state', 'auto'))
  assert.equal(r.ok, true)
  assert.deepEqual(r.result, { path: 'steering.autopilot.state', value: 'auto', state: 'COMPLETED', statusCode: 200 })
  assert.deepEqual(app.calls, [{ path: 'steering.autopilot.state', value: 'auto' }])
  assert.equal(sent[0].subject, REPLY_SUBJECT)
  assert.equal(sent[0].payload.schema, REPLY_SCHEMA)
  assert.equal(sent[0].payload.op, 'put')
  for (const [p, v] of [
    ['steering.autopilot.target.headingTrue', 1.57],
    ['steering.autopilot.target.windAngleApparent', -0.7],
    ['steering.autopilot.actions.adjustHeading', -10],
    ['steering.autopilot.actions.tack', 'port'],
    ['steering.autopilot.actions.advanceMode', true]
  ]) {
    assert.equal((await rpc.handle(put(p, v))).ok, true, p)
  }
})

test('allowlist edge cases are refused not_permitted without executing', async () => {
  const { rpc, app } = server()
  for (const p of [
    'steering.autopilot.actions.a.b',
    'steering.autopilotx',
    'steering.autopilotx.state',
    'steering.autopilot',
    'steering.autopilot.actions',
    'steering.autopilot.target',
    'steering.autopilot.target.headingMagnetic',
    'steering.rudderAngle',
    'electrical.switches.x.state',
    'vessels.self.steering.autopilot.state'
  ]) {
    const r = await rpc.handle(put(p, true))
    assert.equal(r.error, REFUSAL.NOT_PERMITTED, p)
  }
  assert.equal(app.calls.length, 0)
})

test('a malformed path is bad_request', async () => {
  const { rpc } = server()
  for (const p of ['', 'steering.autopilot.actions.*', 'steering..autopilot', 42, undefined]) {
    assert.equal((await rpc.handle(req('put', { path: p, value: true }))).error, REFUSAL.BAD_REQUEST, String(p))
  }
})

test('isSteeringPath matches the published patterns', () => {
  assert.deepEqual([...STEERING_PATHS], [
    'steering.autopilot.state',
    'steering.autopilot.target.headingTrue',
    'steering.autopilot.target.windAngleApparent',
    'steering.autopilot.actions.*'
  ])
  assert.equal(isSteeringPath('steering.autopilot.actions.adjustHeading'), true)
  assert.equal(isSteeringPath('steering.autopilot.actions.'), false)
  assert.equal(isSteeringPath('steering.autopilot.actions.a.b'), false)
})

// ── the deny list ────────────────────────────────────────────────────────────

test('the local deny list beats the switch', async () => {
  const { rpc, app } = server({ policy: { deny: ['steering.autopilot'] } })
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'auto'))).error, REFUSAL.DENIED_LOCALLY)
  assert.equal((await rpc.handle(put('steering.autopilot.actions.tack', 'port'))).error, REFUSAL.DENIED_LOCALLY)
  assert.equal(app.calls.length, 0)
})

test('an exact deny entry refuses just that path', async () => {
  const { rpc } = server({ policy: { deny: ['steering.autopilot.actions.tack'] } })
  assert.equal((await rpc.handle(put('steering.autopilot.actions.tack', 'port'))).error, REFUSAL.DENIED_LOCALLY)
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'auto'))).ok, true)
})

test('puts ignore consent / plan / on_request', async () => {
  const { rpc } = server({ policy: { consent: [], mappings: [], onRequest: [], deny: [] } })
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'standby'))).ok, true)
})

// ── value validation ─────────────────────────────────────────────────────────

test('only JSON scalars are accepted as values', async () => {
  const { rpc, app } = server({ limits: { max_puts_per_min: 100 } })
  for (const v of [null, {}, [], [1], { value: 1 }, NaN, Infinity, 'x'.repeat(33)]) {
    const r = await rpc.handle(put('steering.autopilot.state', v))
    assert.equal(r.error, REFUSAL.BAD_REQUEST, JSON.stringify(v))
    assert.equal(r.detail, 'value')
  }
  assert.equal((await rpc.handle(req('put', { path: 'steering.autopilot.state' }))).error, REFUSAL.BAD_REQUEST)
  assert.equal(app.calls.length, 0)
  for (const v of [true, false, 0, -10, 3.14, '', 'auto', 'x'.repeat(32)]) {
    assert.equal((await rpc.handle(put('steering.autopilot.state', v))).ok, true, JSON.stringify(v))
  }
  assert.equal(isPutScalar('x'.repeat(32)), true)
  assert.equal(isPutScalar('x'.repeat(33)), false)
})

// ── rate limit ───────────────────────────────────────────────────────────────

test('puts have their own 12/min limit, below the read limit', async () => {
  assert.equal(LIMITS.max_puts_per_min, 12)
  const { rpc, app, advance } = server()
  for (let i = 0; i < 12; i++) {
    assert.equal((await rpc.handle(put('steering.autopilot.actions.adjustHeading', 1))).ok, true, `put ${i}`)
  }
  assert.equal((await rpc.handle(put('steering.autopilot.actions.adjustHeading', 1))).error, REFUSAL.RATE_LIMITED)
  assert.equal(app.calls.length, 12)
  // Reads are untouched by the put limit.
  assert.equal((await rpc.handle(req('capabilities'))).ok, true)
  advance(60_000)
  assert.equal((await rpc.handle(put('steering.autopilot.actions.adjustHeading', 1))).ok, true)
})

test('refused puts do not use up the put quota', async () => {
  const { rpc } = server()
  for (let i = 0; i < 20; i++) await rpc.handle(put('electrical.switches.x.state', true))
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'auto'))).ok, true)
})

// ── putSelfPath result mapping ───────────────────────────────────────────────

test('COMPLETED 200 returned synchronously (no promise) is success', async () => {
  const { rpc } = server({ app: fakeApp(() => ({ state: 'COMPLETED', statusCode: 200 })) })
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'auto'))).ok, true)
})

test('PENDING then the callback with COMPLETED 200 is success', async () => {
  let later
  const app = fakeApp((path, value, cb) => {
    later = () => cb({ state: 'COMPLETED', statusCode: 200 })
    return Promise.resolve({ state: 'PENDING', statusCode: 202 })
  })
  const { rpc } = server({ app })
  const pending = rpc.handle(put('steering.autopilot.state', 'auto'))
  await new Promise((resolve) => setImmediate(resolve))
  later()
  const r = await pending
  assert.equal(r.ok, true)
  assert.equal(r.result.statusCode, 200)
})

test('PENDING then a callback FAILURE is signalk_refused', async () => {
  let later
  const app = fakeApp((path, value, cb) => {
    later = () => cb({ state: 'FAILURE', message: 'pilot offline' })
    return Promise.resolve({ state: 'PENDING' })
  })
  const { rpc } = server({ app })
  const pending = rpc.handle(put('steering.autopilot.state', 'auto'))
  await new Promise((resolve) => setImmediate(resolve))
  later()
  const r = await pending
  assert.equal(r.error, REFUSAL.SIGNALK_REFUSED)
  assert.match(r.detail, /pilot offline/)
})

test('an older server that returns nothing: the callback decides', async () => {
  const app = fakeApp((path, value, cb) => { setImmediate(() => cb({ state: 'COMPLETED', statusCode: 200 })) })
  const { rpc } = server({ app })
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'auto'))).ok, true)
})

test('405 (no handler registered) is no_handler', async () => {
  const app = fakeApp(() => Promise.resolve({
    state: 'COMPLETED', statusCode: 405, message: 'PUT not supported for steering.autopilot.state'
  }))
  const { rpc } = server({ app })
  const r = await rpc.handle(put('steering.autopilot.state', 'auto'))
  assert.equal(r.error, REFUSAL.NO_HANDLER)
  assert.match(r.detail, /not supported/)
})

test('500 is signalk_refused with the status code and message in detail', async () => {
  const app = fakeApp(() => Promise.resolve({ state: 'COMPLETED', statusCode: 500, message: 'boom' }))
  const { rpc } = server({ app })
  const r = await rpc.handle(put('steering.autopilot.state', 'auto'))
  assert.equal(r.error, REFUSAL.SIGNALK_REFUSED)
  assert.equal(r.detail, 'statusCode 500: boom')
})

test('400 / 403 / 502 are signalk_refused', async () => {
  for (const code of [400, 403, 502]) {
    const { rpc } = server({ app: fakeApp(() => Promise.resolve({ state: 'COMPLETED', statusCode: code })) })
    const r = await rpc.handle(put('steering.autopilot.state', 'auto'))
    assert.equal(r.error, REFUSAL.SIGNALK_REFUSED, String(code))
    assert.equal(r.detail, `statusCode ${code}`)
  }
})

test('putSelfPath throwing is signalk_refused', async () => {
  const app = fakeApp(() => { throw new Error('kaput') })
  const { rpc } = server({ app })
  const r = await rpc.handle(put('steering.autopilot.state', 'auto'))
  assert.equal(r.error, REFUSAL.SIGNALK_REFUSED)
  assert.equal(r.detail, 'kaput')
})

test('putSelfPath rejecting is signalk_refused', async () => {
  const app = fakeApp(() => Promise.reject(new Error('nope')))
  const { rpc } = server({ app })
  const r = await rpc.handle(put('steering.autopilot.state', 'auto'))
  assert.equal(r.error, REFUSAL.SIGNALK_REFUSED)
  assert.equal(r.detail, 'nope')
})

test('no putSelfPath on the app is no_handler', async () => {
  const app = fakeApp()
  delete app.putSelfPath
  const { rpc } = server({ app })
  assert.equal((await rpc.handle(put('steering.autopilot.state', 'auto'))).error, REFUSAL.NO_HANDLER)
})

test('PENDING with no callback in time is timeout, and the trail says so', async () => {
  const timers = []
  const app = fakeApp(() => Promise.resolve({ state: 'PENDING' }))
  const { rpc } = server({
    app,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {}
  })
  const pending = rpc.handle(put('steering.autopilot.state', 'auto'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers[0].ms, LIMITS.handler_timeout_ms)
  timers[0].fn()
  assert.equal((await pending).error, REFUSAL.TIMEOUT)
  assert.match(app.statuses.at(-1), /timed out/)
})

test('putOutcome mapping table', () => {
  const p = 'steering.autopilot.state'
  assert.equal(putOutcome({ state: 'PENDING' }, p, 1), '')
  assert.equal(putOutcome({ state: 'PENDING', statusCode: 202 }, p, 1), '')
  assert.equal(putOutcome({ state: 'COMPLETED', statusCode: 202 }, p, 1).ok, true)
  assert.equal(putOutcome({ state: 'SUCCESS' }, p, 1).ok, true)
  assert.equal(putOutcome({ state: 'COMPLETED', statusCode: 404 }, p, 1).error, REFUSAL.SIGNALK_REFUSED)
  assert.equal(putOutcome(new Error('x'), p, 1).error, REFUSAL.SIGNALK_REFUSED)
})

// ── local trail ──────────────────────────────────────────────────────────────

test('every put leaves a status line and a debug line, accepted or refused', async () => {
  const { rpc, app } = server()
  await rpc.handle(put('steering.autopilot.state', 'auto'))
  assert.equal(app.statuses.at(-1), 'Remote steering: steering.autopilot.state=auto accepted 12:03')
  await rpc.handle(put('electrical.switches.x.state', true))
  assert.equal(app.statuses.at(-1), 'Remote steering: electrical.switches.x.state=true refused (not_permitted) 12:03')
  await rpc.handle(put('steering.autopilot.state', { evil: 'x' }))
  assert.match(app.statuses.at(-1), /=object refused \(bad_request\)/)
  assert.equal(app.statuses.length, 3)
  assert.equal(app.debugs.filter((d) => d.includes('Remote steering:')).length, 3)
  assert.equal(rpc.stats().last_put, app.statuses.at(-1))
})

test('reads leave no steering trail', async () => {
  const { rpc, app } = server()
  await rpc.handle(req('capabilities'))
  assert.equal(app.statuses.length, 0)
})

// ── capabilities ─────────────────────────────────────────────────────────────

test('capabilities reflects the option and names the allowlist', async () => {
  for (const on of [true, false]) {
    const { rpc } = server({ remoteSteering: on })
    const r = await rpc.handle(req('capabilities', {}))
    assert.deepEqual(r, {
      schema: REPLY_SCHEMA,
      id: r.id,
      op: 'capabilities',
      ok: true,
      result: {
        remote_steering: { enabled: on, paths: [...STEERING_PATHS] },
        connector_version: pkg.version
      }
    })
  }
})

test('capabilities is rate-limited like reads', async () => {
  const { rpc } = server({ limits: { max_per_min: 2 } })
  assert.equal((await rpc.handle(req('capabilities'))).ok, true)
  assert.equal((await rpc.handle(req('capabilities'))).ok, true)
  assert.equal((await rpc.handle(req('capabilities'))).error, REFUSAL.RATE_LIMITED)
})

// ── generic writes stay refused ──────────────────────────────────────────────

test('write / set / control / actuate are still not_permitted, even with steering on', async () => {
  const { rpc, app } = server()
  for (const op of ['write', 'set', 'control', 'actuate']) {
    const r = await rpc.handle(req(op, { path: 'steering.autopilot.state', value: 'auto' }))
    assert.equal(r.error, REFUSAL.NOT_PERMITTED, op)
  }
  assert.equal(app.calls.length, 0)
})

// ── runtime wiring ───────────────────────────────────────────────────────────

test('the runtime passes the remote_steering option (default off) into the rpc server', () => {
  const os = require('node:os')
  const fs = require('node:fs')
  const path = require('node:path')
  const { createRuntime } = require('../lib/runtime')
  const realRpc = require('../lib/rpc').createRpcServer
  for (const [options, expected] of [
    [{}, false],
    [{ remote_steering: 'true' }, false],
    [{ remote_steering: true }, true]
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-steer-'))
    const statuses = []
    let captured
    const runtime = createRuntime({
      app: { debug: () => {}, getDataDirPath: () => dir, setPluginStatus: (m) => statuses.push(m) },
      version: '9.9.9',
      options,
      deps: {
        createRpcServer: (o) => { captured = o; return realRpc(o) },
        source: { subscribe: () => ({ close: () => {} }), selfTree: async () => ({}) }
      }
    })
    assert.equal(captured.remoteSteering(), expected)
    assert.equal(captured.version, '9.9.9')
    assert.equal(runtime.cfg.remoteSteering, expected)
    captured.setStatus('Remote steering: x')
    assert.deepEqual(statuses, ['Remote steering: x'])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the plugin schema offers remote_steering, default false', () => {
  const plugin = require('../index.js')({ debug: () => {} })
  const prop = plugin.schema().properties.remote_steering
  assert.equal(prop.type, 'boolean')
  assert.equal(prop.default, false)
  assert.match(prop.title, /remote steering/i)
  assert.match(prop.description, /Telegram/)
})
