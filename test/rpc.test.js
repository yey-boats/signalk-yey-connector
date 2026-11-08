'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const {
  createRpcServer, authorize, mappingCovers, REFUSAL, REQUEST_EVENT, REPLY_SUBJECT,
  REQUEST_SCHEMA, REPLY_SCHEMA, LIMITS
} = require('../lib/rpc')
const { applyPlan, normalizeOnRequest, etagOf } = require('../lib/plan')
const { createUplink, MIN_REDIAL_MS } = require('../lib/uplink')
const { DEFAULT_TRANSPORT } = require('../lib/plan')
const { createRuntime } = require('../lib/runtime')

const TREE = {
  navigation: {
    position: { value: { latitude: -17.5, longitude: -149.6 }, timestamp: '2026-11-07T10:00:00Z', $source: 'sim.gps' },
    speedOverGround: { value: 3.1, timestamp: '2026-11-07T10:00:01Z' },
    speedThroughWater: { value: 2.9, timestamp: '2026-11-07T10:00:01Z' }
  },
  environment: {
    water: { temperature: { value: 299.1, timestamp: '2026-11-07T10:00:02Z', meta: { units: 'K' } } },
    depth: { belowTransducer: { value: 12.3, timestamp: '2026-11-07T10:00:02Z' } }
  }
}

const POLICY = {
  consent: ['navigation', 'environment.water', 'environment.depth.belowTransducer'],
  deny: ['navigation.speedThroughWater'],
  mappings: [{ path: 'navigation.position' }],
  onRequest: ['navigation', 'environment.water']
}

let seq = 0
function req (op, args = {}, extra = {}) {
  seq += 1
  return {
    type: REQUEST_EVENT,
    data: {
      schema: REQUEST_SCHEMA,
      id: `rpc_${String(seq).padStart(24, '0')}`,
      boat_id: 'b_1',
      op,
      args,
      deadline_ms: 0,
      ...extra
    }
  }
}

function server (opts = {}) {
  const sent = []
  let clock = opts.clock || 1_000_000
  const rpc = createRpcServer({
    app: opts.app || {},
    getSource: () => ({
      selfTree: async () => opts.tree || TREE,
      metaFor: async (p) => (p === 'environment.water.temperature'
        ? { description: 'Sea water temperature', units: 'K' } : {}),
      collectMeta: async () => ({})
    }),
    policy: () => opts.policy || POLICY,
    getCatalog: () => opts.catalog || null,
    publish: async (subject, payload, o) => {
      if (opts.publishFails) throw Object.assign(new Error('down'), { code: 'not_connected' })
      sent.push({ subject, payload, opts: o })
      return { status: 'accepted' }
    },
    boatId: () => 'b_1',
    now: () => clock,
    temporal: opts.temporal,
    limits: opts.limits,
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer
  })
  return { rpc, sent, advance: (ms) => { clock += ms } }
}

// ── the authorization rule ───────────────────────────────────────────────────

test('the local deny list wins over consent, mappings and on_request', () => {
  const policy = { ...POLICY, mappings: [{ path: 'navigation.speedThroughWater' }] }
  assert.equal(authorize('navigation.speedThroughWater', policy), REFUSAL.DENIED_LOCALLY)
})

test('a denied descendant blocks a read of its ancestor', () => {
  // navigation is consented and on request, but a read of the whole branch
  // would carry the denied leaf.
  assert.equal(authorize('navigation', POLICY), REFUSAL.DENIED_LOCALLY)
})

test('a path outside the owner consent is refused even when the plan names it', () => {
  const policy = { ...POLICY, onRequest: ['electrical'] }
  assert.equal(authorize('electrical.batteries.house.voltage', policy), REFUSAL.OUTSIDE_CONSENT)
})

test('a consented path the plan neither streams nor offers on request is refused', () => {
  assert.equal(authorize('environment.depth.belowTransducer', POLICY), REFUSAL.NOT_ON_REQUEST)
})

test('streamed and on-request paths are answerable, whole-segment', () => {
  assert.equal(authorize('navigation.position', POLICY), '')
  assert.equal(authorize('environment.water.temperature', POLICY), '')
  // environment.waterfall is not under environment.water
  assert.equal(authorize('environment.waterfall', { ...POLICY, consent: ['environment'] }),
    REFUSAL.NOT_ON_REQUEST)
})

test('no consent at all answers nothing', () => {
  assert.equal(authorize('navigation.position', { ...POLICY, consent: [] }), REFUSAL.OUTSIDE_CONSENT)
})

test('mappingCovers understands the one wildcard form', () => {
  assert.ok(mappingCovers('propulsion.*.temperature', 'propulsion.main.temperature'))
  assert.ok(!mappingCovers('propulsion.*.temperature', 'propulsion.main.oil.temperature'))
  assert.ok(mappingCovers('a.b', 'a.b'))
  assert.ok(!mappingCovers('a.b', 'a.b.c'))
})

// ── get / meta / catalog ─────────────────────────────────────────────────────

test('get answers a live value from the SignalK tree, correlated by id', async () => {
  const s = server()
  const r = req('get', { path: 'environment.water.temperature' })
  const reply = await s.rpc.handle(r)
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].subject, REPLY_SUBJECT)
  assert.equal(s.sent[0].opts.idempotencyKey, `rpc:${r.data.id}`)
  assert.deepEqual(reply, {
    schema: REPLY_SCHEMA, id: r.data.id, op: 'get', ok: true,
    result: { path: 'environment.water.temperature', value: 299.1, timestamp: '2026-11-07T10:00:02Z' }
  })
})

test('get carries $source and object values through', async () => {
  const s = server()
  const reply = await s.rpc.handle(req('get', { path: 'navigation.position' }))
  assert.equal(reply.ok, true)
  assert.deepEqual(reply.result.value, { latitude: -17.5, longitude: -149.6 })
  assert.equal(reply.result.$source, 'sim.gps')
})

test('get refuses with a reason and never reads a refused path', async () => {
  let reads = 0
  const sent = []
  const rpc = createRpcServer({
    getSource: () => ({ selfTree: async () => { reads += 1; return TREE } }),
    policy: () => POLICY,
    publish: async (subject, payload) => { sent.push(payload) },
    now: () => 1
  })
  for (const [p, why] of [
    ['navigation.speedThroughWater', REFUSAL.DENIED_LOCALLY],
    ['electrical.batteries.house.voltage', REFUSAL.OUTSIDE_CONSENT],
    ['environment.depth.belowTransducer', REFUSAL.NOT_ON_REQUEST]
  ]) {
    const reply = await rpc.handle(req('get', { path: p }))
    assert.equal(reply.ok, false)
    assert.equal(reply.error, why, p)
    assert.equal(reply.result, undefined)
  }
  assert.equal(reads, 0, 'a refused path must not even be read')
})

test('get of a missing leaf is no_data, of a branch is bad_request', async () => {
  const s = server({ policy: { ...POLICY, consent: ['environment'], onRequest: ['environment'], deny: [] } })
  assert.equal((await s.rpc.handle(req('get', { path: 'environment.wind.speedTrue' }))).error, REFUSAL.NO_DATA)
  const branch = await s.rpc.handle(req('get', { path: 'environment.water' }))
  assert.equal(branch.error, REFUSAL.BAD_REQUEST)
  assert.equal(branch.detail, 'not_a_leaf')
})

test('malformed paths are refused before anything is read', async () => {
  const s = server()
  for (const p of ['', 'navigation..position', 'navigation.*', '../etc', 'a'.repeat(300), 42]) {
    const reply = await s.rpc.handle(req('get', { path: p }))
    assert.equal(reply.error, REFUSAL.BAD_REQUEST, String(p))
  }
})

test('meta merges the server metadata with the inline meta', async () => {
  const s = server()
  const reply = await s.rpc.handle(req('meta', { path: 'environment.water.temperature' }))
  assert.equal(reply.ok, true)
  assert.deepEqual(reply.result.meta, { description: 'Sea water temperature', units: 'K' })
})

test('catalog never names a denied path', async () => {
  const s = server({
    catalog: {
      schema: 'yey.boat.catalog.v1',
      generated_at: 'x',
      paths: { 'navigation.position': { units: '' }, 'navigation.speedThroughWater': { units: 'm/s' } }
    }
  })
  const reply = await s.rpc.handle(req('catalog'))
  assert.equal(reply.ok, true)
  assert.deepEqual(Object.keys(reply.result.catalog.paths), ['navigation.position'])
  assert.equal(reply.result.catalog.path_count, 1)
})

test('catalog without a stored one walks the tree', async () => {
  const s = server({ policy: { ...POLICY, deny: [] } })
  const reply = await s.rpc.handle(req('catalog'))
  assert.ok(reply.result.catalog.paths['environment.water.temperature'])
})

// ── writes stay refused ──────────────────────────────────────────────────────

test('writes and controls are refused as not_permitted, whatever the path', async () => {
  const s = server()
  for (const op of ['write', 'set', 'control', 'actuate']) {
    const reply = await s.rpc.handle(req(op, { path: 'navigation.position', value: 1 }))
    assert.equal(reply.error, REFUSAL.NOT_PERMITTED, op)
  }
  // `put` is remote steering (test/remote-steering.test.js): off by default.
  const put = await s.rpc.handle(req('put', { path: 'navigation.position', value: 1 }))
  assert.equal(put.error, REFUSAL.REMOTE_STEERING_OFF)
  assert.equal((await s.rpc.handle(req('reboot'))).error, REFUSAL.UNSUPPORTED)
})

// ── history ──────────────────────────────────────────────────────────────────

test('history without a History API on the server is unsupported', async () => {
  const s = server({ app: {} })
  const reply = await s.rpc.handle(req('history', { path: 'navigation.position', since: '2026-11-07T00:00:00Z' }))
  assert.equal(reply.error, REFUSAL.UNSUPPORTED)
  assert.equal(reply.detail, 'no_history_api')
})

test('history with no provider registered is unsupported', async () => {
  const s = server({ app: { getHistoryApi: () => Promise.reject(new Error('No history api provider configured')) } })
  const reply = await s.rpc.handle(req('history', { path: 'navigation.position', since: '2026-11-07T00:00:00Z' }))
  assert.equal(reply.error, REFUSAL.UNSUPPORTED)
  assert.equal(reply.detail, 'no_history_provider')
})

const FAKE_TEMPORAL = {
  Instant: {
    from: (text) => {
      const ms = Date.parse(text)
      if (Number.isNaN(ms)) throw new RangeError('bad instant')
      return { iso: new Date(ms).toISOString(), toJSON () { return this.iso } }
    }
  }
}

test('history asks the in-process provider with Temporal instants and seconds', async () => {
  let asked = null
  const api = {
    getValues: async (q) => {
      asked = q
      return {
        context: 'vessels.self',
        range: { from: q.from, to: q.to },
        values: [{ path: 'environment.water.temperature', method: 'average' }],
        data: [['2026-11-07T00:00:00Z', 299], ['2026-11-07T01:00:00Z', 300]]
      }
    }
  }
  const s = server({ app: { getHistoryApi: async () => api }, temporal: FAKE_TEMPORAL })
  const reply = await s.rpc.handle(req('history', {
    path: 'environment.water.temperature', since: '2026-11-07T00:00:00Z',
    until: '2026-11-07T02:00:00Z', bucket: '1h', agg: 'avg'
  }))
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(asked.context, 'vessels.self')
  assert.equal(asked.resolution, 3600)
  assert.deepEqual(asked.pathSpecs, [{ path: 'environment.water.temperature', aggregate: 'average', parameter: [] }])
  assert.equal(asked.from.iso, '2026-11-07T00:00:00.000Z')
  assert.equal(reply.result.data.length, 2)
  assert.deepEqual(reply.result.range, { from: '2026-11-07T00:00:00.000Z', to: '2026-11-07T02:00:00.000Z' })
  assert.equal(reply.result.truncated, false)
})

test('history refuses an unknown aggregate, a bad time and a bad bucket', async () => {
  const api = { getValues: async () => ({ data: [] }) }
  const s = server({ app: { getHistoryApi: async () => api }, temporal: FAKE_TEMPORAL })
  const base = { path: 'navigation.position', since: '2026-11-07T00:00:00Z' }
  assert.equal((await s.rpc.handle(req('history', { ...base, agg: 'sum' }))).detail, 'agg')
  assert.equal((await s.rpc.handle(req('history', { ...base, since: 'yesterday' }))).detail, 'time')
  assert.equal((await s.rpc.handle(req('history', { ...base, bucket: '5 minutes' }))).detail, 'bucket')
})

test('a long history is trimmed to fit the reply cap, keeping the newest rows', async () => {
  const data = Array.from({ length: 1500 }, (_, i) => [`2026-11-07T00:${String(i % 60).padStart(2, '0')}:00Z`, i + 0.123456789])
  const api = { getValues: async () => ({ context: 'vessels.self', range: {}, values: [], data }) }
  const s = server({ app: { getHistoryApi: async () => api }, temporal: FAKE_TEMPORAL, limits: { max_reply_bytes: 8 * 1024 } })
  const reply = await s.rpc.handle(req('history', { path: 'navigation.position', since: '2026-11-07T00:00:00Z' }))
  assert.equal(reply.ok, true)
  assert.equal(reply.result.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 8 * 1024)
  assert.equal(reply.result.data.at(-1)[1], 1499.123456789, 'the newest row survives')
})

// ── limits, correlation, timeouts ────────────────────────────────────────────

test('a reply over the size cap becomes too_large rather than a huge message', async () => {
  const tree = { navigation: { position: { value: 'x'.repeat(5000) } } }
  const s = server({ tree, limits: { max_reply_bytes: 1024 } })
  const reply = await s.rpc.handle(req('get', { path: 'navigation.position' }))
  assert.equal(reply.error, REFUSAL.TOO_LARGE)
})

test('requests past the per-minute budget are answered rate_limited', async () => {
  const s = server({ limits: { max_per_min: 3 } })
  const out = []
  for (let i = 0; i < 5; i++) out.push(await s.rpc.handle(req('get', { path: 'navigation.position' })))
  assert.deepEqual(out.map((r) => r.ok ? 'ok' : r.error),
    ['ok', 'ok', 'ok', REFUSAL.RATE_LIMITED, REFUSAL.RATE_LIMITED])
  s.advance(61_000)
  assert.equal((await s.rpc.handle(req('get', { path: 'navigation.position' }))).ok, true)
})

test('too many requests in flight are answered busy', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const sent = []
  const rpc = createRpcServer({
    getSource: () => ({ selfTree: async () => { await gate; return TREE } }),
    policy: () => POLICY,
    publish: async (s, p) => { sent.push(p) },
    now: () => 1,
    limits: { max_in_flight: 1 }
  })
  const first = rpc.handle(req('get', { path: 'navigation.position' }))
  const second = await rpc.handle(req('get', { path: 'navigation.position' }))
  assert.equal(second.error, REFUSAL.BUSY)
  release()
  assert.equal((await first).ok, true)
})

test('a handler that hangs is answered timeout', async () => {
  const timers = []
  const rpc = createRpcServer({
    getSource: () => ({ selfTree: () => new Promise(() => {}) }),
    policy: () => POLICY,
    publish: async () => {},
    now: () => 1,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {}
  })
  const pending = rpc.handle(req('get', { path: 'navigation.position' }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, LIMITS.handler_timeout_ms)
  timers[0].fn()
  assert.equal((await pending).error, REFUSAL.TIMEOUT)
})

test('the handler budget never outlives the cloud deadline', async () => {
  const timers = []
  const rpc = createRpcServer({
    getSource: () => ({ selfTree: () => new Promise(() => {}) }),
    policy: () => POLICY,
    publish: async () => {},
    now: () => 10_000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return 1 },
    clearTimer: () => {}
  })
  const pending = rpc.handle(req('get', { path: 'navigation.position' }, { deadline_ms: 11_000 }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers[0].ms, 1000)
  timers[0].fn()
  await pending
})

test('expired, duplicate, foreign and malformed requests are dropped silently', async () => {
  const s = server({ clock: 50_000 })
  assert.equal(await s.rpc.handle(req('get', { path: 'navigation.position' }, { deadline_ms: 49_000 })), null)
  assert.equal(await s.rpc.handle(req('get', { path: 'navigation.position' }, { boat_id: 'b_other' })), null)
  assert.equal(await s.rpc.handle(req('get', { path: 'navigation.position' }, { schema: 'nope' })), null)
  assert.equal(await s.rpc.handle(req('get', { path: 'navigation.position' }, { id: 'not-an-id' })), null)
  assert.equal(await s.rpc.handle({ type: 'kdcube.data_bus.result', data: {} }), null)
  const once = req('get', { path: 'navigation.position' })
  assert.equal((await s.rpc.handle(once)).ok, true)
  assert.equal(await s.rpc.handle(once), null, 'the same id is answered once')
  assert.equal(s.sent.length, 1)
  // Five dropped; the result event was simply not ours and is not counted.
  assert.equal(s.rpc.stats().dropped, 5)
})

test('a reply that cannot be published is counted, not thrown', async () => {
  const s = server({ publishFails: true })
  const reply = await s.rpc.handle(req('get', { path: 'navigation.position' }))
  assert.equal(reply.ok, true)
  assert.equal(s.rpc.stats().dropped, 1)
})

// ── the plan's on_request list ───────────────────────────────────────────────

const PLAN = {
  schema: 1, plan_id: 'pl_1', version: 3,
  mappings: [{ path: 'navigation.position', as: 'position' }]
}

test('on_request is clamped to consent and by a denied ancestor', () => {
  const out = normalizeOnRequest(
    ['navigation', 'electrical', 'environment.water', 'environment.water.salinity', '', 7, 'propulsion.*'],
    { consent: ['navigation', 'environment'], deny: ['environment.water'] })
  assert.deepEqual(out, ['navigation'])
})

test('a denied descendant does not drop the on_request entry (each read is re-checked)', () => {
  const out = normalizeOnRequest(['navigation'], { consent: ['navigation'], deny: ['navigation.speedThroughWater'] })
  assert.deepEqual(out, ['navigation'])
})

test('a plan without on_request applies and hashes exactly as before', () => {
  const plain = applyPlan(PLAN, { consent: ['navigation'] })
  assert.equal(plain.on_request, undefined)
  const { on_request: _, ...rest } = plain
  assert.equal(plain.etag, etagOf({
    schema: rest.schema, plan_id: rest.plan_id, version: rest.version, transport: rest.transport,
    budget: rest.budget, defaults: rest.defaults, mappings: rest.mappings
  }))
})

test('a plan with on_request carries the clamped list into the applied plan', () => {
  const applied = applyPlan({ ...PLAN, on_request: ['navigation', 'electrical'] }, { consent: ['navigation'] })
  assert.deepEqual(applied.on_request, ['navigation'])
  assert.notEqual(applied.etag, applyPlan(PLAN, { consent: ['navigation'] }).etag)
})

// ── the uplink half ──────────────────────────────────────────────────────────

function fakeIo () {
  const sockets = []
  const io = (origin, opts) => {
    const handlers = {}
    const socket = {
      on: (event, fn) => { handlers[event] = fn },
      emit: (event, data, cb) => { if (cb) cb({ status: 'accepted', accepted: [], rejected: [] }) },
      close: () => { socket.closed = true },
      fire: (event, data) => handlers[event] && handlers[event](data)
    }
    sockets.push(socket)
    return socket
  }
  return { io, sockets }
}

const CFG = { cloudOrigin: 'https://x', tenant: 'home', project: 'demo',
              bundleId: 'signalk@2026-06-05', boatId: 'b_1', boatCredential: 'bk_1' }

test('pushed chat_service events reach the listener for their type', async () => {
  const { io, sockets } = fakeIo()
  const timers = []
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT, deps: {
    io,
    callPublicOp: async () => ({ ok: true, federated_token: 't', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    uplinkSetTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    uplinkClearTimeout: () => {}
  } })
  const got = []
  u.onEvent(REQUEST_EVENT, (env) => got.push(env))
  u.onEvent(REQUEST_EVENT, () => { throw new Error('a bad listener') })
  await u.connect()
  sockets[0].fire('chat_service', { type: REQUEST_EVENT, data: { id: 'rpc_1' } })
  sockets[0].fire('chat_service', { type: 'something.else', data: {} })
  assert.equal(got.length, 1)
  assert.equal(got[0].data.id, 'rpc_1')
})

test('the uplink redials before the token (and so the live route) expires', async () => {
  const { io } = fakeIo()
  const timers = []
  let clock = 1_000_000_000_000
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT, deps: {
    io,
    now: () => clock,
    callPublicOp: async () => ({ ok: true, federated_token: 't', expires_at: Math.floor(clock / 1000) + 3600 }),
    uplinkSetTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    uplinkClearTimeout: () => {}
  } })
  const lost = []
  u.setOnLost((why) => lost.push(why))
  await u.connect()
  assert.equal(timers.length, 1)
  // 80% of a one-hour token.
  assert.equal(timers[0].ms, 2880 * 1000)
  timers[0].fn()
  assert.deepEqual(lost, ['token_refresh'])
})

test('a very short token never turns the redial into a loop', async () => {
  const { io } = fakeIo()
  const timers = []
  const clock = 1_000_000_000_000
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT, deps: {
    io,
    now: () => clock,
    callPublicOp: async () => ({ ok: true, federated_token: 't', expires_at: Math.floor(clock / 1000) + 5 }),
    uplinkSetTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    uplinkClearTimeout: () => {}
  } })
  await u.connect()
  assert.equal(timers[0].ms, MIN_REDIAL_MS)
})

test('a deliberate close cancels the redial and reports nothing', async () => {
  const { io } = fakeIo()
  const timers = []
  const cleared = []
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT, deps: {
    io,
    callPublicOp: async () => ({ ok: true, federated_token: 't', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    uplinkSetTimeout: (fn, ms) => { timers.push({ fn, ms }); return 'h1' },
    uplinkClearTimeout: (h) => cleared.push(h)
  } })
  const lost = []
  u.setOnLost((why) => lost.push(why))
  await u.connect()
  u.close()
  assert.deepEqual(cleared, ['h1'])
  timers[0].fn()
  assert.deepEqual(lost, [])
})

// ── the runtime wiring ───────────────────────────────────────────────────────

function runtimeHarness ({ plan, consent, deny = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-rpc-'))
  const published = []
  const listeners = {}
  const uplink = {
    connect: async () => {},
    close: () => {},
    setOnLost: () => {},
    onEvent: (type, fn) => { listeners[type] = fn },
    state: () => ({ connected: true }),
    publish: async (subject, payload, o) => {
      published.push({ subject, payload, opts: o })
      return { status: 'accepted', accepted: [{}], rejected: [] }
    },
    request: async () => ({ kind: 'plan', plan, etag: 'e1' })
  }
  const runtime = createRuntime({
    app: { debug: () => {}, getDataDirPath: () => dir },
    version: '0.1.0',
    options: { enabled: true, advanced: { deny } },
    deps: {
      createUplink: () => uplink,
      now: () => 1_000_000,
      source: {
        subscribe: () => ({ close: () => {} }),
        selfTree: async () => TREE,
        collectMeta: async () => ({}),
        serverInfo: async () => ({ version: '2.37.0', plugins: [] }),
        vesselIdentity: async () => ({ name: 'Sara', mmsi: '' })
      }
    }
  })
  runtime.setConsent(consent)
  return { runtime, published, push: (env) => listeners[REQUEST_EVENT](env) }
}

async function settle () {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('the runtime answers an on-request path from SignalK with the running plan', async () => {
  const h = runtimeHarness({
    plan: { ...PLAN, on_request: ['environment.water'] },
    consent: ['navigation.position', 'environment.water']
  })
  await h.runtime.handshake()
  assert.deepEqual(h.runtime.snapshot().on_request, ['environment.water'])
  const r = req('get', { path: 'environment.water.temperature' })
  h.push(r)
  await settle()
  const reply = h.published.find((p) => p.subject === REPLY_SUBJECT)
  assert.ok(reply, 'no reply was published')
  assert.equal(reply.payload.id, r.data.id)
  assert.equal(reply.payload.result.value, 299.1)
  assert.equal(h.runtime.snapshot().rpc.served, 1)
})

test('the runtime refuses a consented path the plan does not offer', async () => {
  const h = runtimeHarness({ plan: PLAN, consent: ['navigation.position', 'environment.water'] })
  await h.runtime.handshake()
  h.push(req('get', { path: 'environment.water.temperature' }))
  await settle()
  const reply = h.published.find((p) => p.subject === REPLY_SUBJECT)
  assert.equal(reply.payload.error, REFUSAL.NOT_ON_REQUEST)
})

test('the runtime deny list wins over the plan on_request list', async () => {
  const h = runtimeHarness({
    plan: { ...PLAN, on_request: ['environment'] },
    consent: ['navigation.position', 'environment'],
    deny: ['environment.water.temperature']
  })
  await h.runtime.handshake()
  h.push(req('get', { path: 'environment.water.temperature' }))
  await settle()
  const reply = h.published.find((p) => p.subject === REPLY_SUBJECT)
  assert.equal(reply.payload.error, REFUSAL.DENIED_LOCALLY)
})

test('a consent narrowed after the plan narrows what is answered at once', async () => {
  const h = runtimeHarness({
    plan: { ...PLAN, on_request: ['environment.water'] },
    consent: ['navigation.position', 'environment.water']
  })
  await h.runtime.handshake()
  h.runtime.setConsent(['navigation.position'])
  h.push(req('get', { path: 'environment.water.temperature' }))
  await settle()
  const reply = h.published.find((p) => p.subject === REPLY_SUBJECT)
  assert.equal(reply.payload.error, REFUSAL.OUTSIDE_CONSENT)
})
