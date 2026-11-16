'use strict'
/**
 * Cloud dashboards: ops `displays` and `show_dashboard` (lib/rpc.js, rules in
 * lib/dashboard-policy.js), display provisioning contract v1 §1. A fake
 * Display Manager, no SignalK server, no socket.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { createRpcServer, REFUSAL, REQUEST_EVENT, REQUEST_SCHEMA, REPLY_SCHEMA, OPS, LIMITS } = require('../lib/rpc')
const dp = require('../lib/dashboard-policy')
const { createSteeringPolicy, REPLAY_FILE: STEERING_REPLAY_FILE } = require('../lib/steering-policy')
const { createUplink } = require('../lib/uplink')
const { DEFAULT_TRANSPORT } = require('../lib/plan')
const { createRuntime } = require('../lib/runtime')
const plugin = require('../index')

const T0 = Date.UTC(2026, 10, 16, 12, 3, 0)
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yey-cdash-'))

let seq = 0
function req (op, args = {}, extra = {}) {
  seq += 1
  return {
    type: REQUEST_EVENT,
    data: {
      schema: REQUEST_SCHEMA,
      id: `rpc_${seq.toString(16).padStart(24, 'c')}`,
      boat_id: 'b_1',
      op,
      args,
      deadline_ms: 0, // 0 = "20 s from the server's clock", as the cloud sends
      ...extra
    }
  }
}

const DOC = { midl: 1, screens: [{ id: 'dash', title: 'Wind history', widgets: [] }] }
function showArgs (over = {}, dash = {}) {
  return {
    display_ids: ['yey-d-28372f8a0290'],
    dashboard: { source_id: 'dsh_1', title: 'Wind history', updated_at: '2026-11-16T10:00:00Z', doc: DOC, screen: 'dash', ...dash },
    requested_by: "the boat's owner (Google account)",
    ...over
  }
}

const DISPLAYS = [{
  id: 'yey-d-28372f8a0290',
  name: 'Helm display',
  class: 'square-480',
  online: true,
  screen: { id: 'dash', title: 'Wind history', record: 'dash' },
  preset: { id: 'yey-wind-history', name: 'Wind history' },
  secret: 'not for the reply'
}]

/** A fake Display Manager; `show` decides what showDashboard does. */
function fakeDm ({ show, list, version = 1 } = {}) {
  const calls = []
  return {
    calls,
    version,
    listDisplays: list || (async () => DISPLAYS),
    showDashboard: async (r) => {
      calls.push(r)
      if (show) return show(r)
      return {
        preset: { id: 'yey-wind-history', name: 'Wind history', created: false },
        results: (r.displayIds === 'all' ? ['yey-d-28372f8a0290'] : r.displayIds).map((id) => ({ display_id: id, state: 'shown', screen: r.screen || 'dash' }))
      }
    }
  }
}

function server (opts = {}) {
  const sent = []
  const statuses = []
  const debugs = []
  let clock = opts.clock || T0
  const dm = 'dm' in opts ? opts.dm : fakeDm()
  const now = () => clock
  const rpc = createRpcServer({
    getSource: () => ({ selfTree: async () => ({}) }),
    policy: () => ({ consent: [], deny: [], mappings: [], onRequest: [] }),
    publish: async (subject, payload) => { sent.push({ subject, payload }) },
    boatId: () => 'b_1',
    now,
    limits: opts.limits,
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer,
    ...('cloudDashboards' in opts ? { cloudDashboards: opts.cloudDashboards } : {}),
    remoteSteering: true,
    steeringPolicy: opts.steeringPolicy,
    dashboardPolicy: opts.dashboardPolicy || dp.createDashboardPolicy({ dir: opts.dir || null, now, boatId: () => 'b_1' }),
    displayManager: () => dm,
    setStatus: (m) => statuses.push(m),
    debug: (m) => debugs.push(m)
  })
  const live = (env) => (env && env.data && env.data.deadline_ms === 0)
    ? { ...env, data: { ...env.data, deadline_ms: clock + 20000 } } : env
  return {
    rpc: { ...rpc, handle: (env) => rpc.handle(live(env)) },
    raw: rpc,
    sent,
    statuses,
    debugs,
    dm,
    advance: (ms) => { clock += ms },
    now
  }
}

const show = (over, dash, extra) => req('show_dashboard', showArgs(over, dash), extra)

// ── vocabulary ───────────────────────────────────────────────────────────────

test('the ops and refusals of contract v1 are in the closed vocabulary', () => {
  assert.ok(OPS.includes('displays'))
  assert.ok(OPS.includes('show_dashboard'))
  assert.equal(REFUSAL.CLOUD_DASHBOARDS_OFF, 'cloud_dashboards_off')
  assert.equal(REFUSAL.INVALID_DASHBOARD, 'invalid_dashboard')
  assert.equal(LIMITS.max_shows_per_min, 6)
  assert.equal(LIMITS.max_doc_bytes, 48 * 1024)
  assert.equal(LIMITS.show_timeout_ms, 15000)
  assert.equal(dp.DISPLAY_MANAGER_KEY, Symbol.for('yey-boats.display-manager'))
})

// ── rule 1: the switch, ON by default ───────────────────────────────────────

test('cloud dashboards are ON by default (no option given)', async () => {
  const { rpc } = server()
  const caps = await rpc.handle(req('capabilities'))
  assert.deepEqual(caps.result.cloud_dashboards, { enabled: true, version: 1, policy: dp.describePolicy() })
  const r = await rpc.handle(show())
  assert.equal(r.ok, true)
})

test('the plugin schema offers allow_cloud_dashboards, default true, clearly titled', () => {
  const schema = plugin({ debug: () => {} }).schema()
  const opt = schema.properties.allow_cloud_dashboards
  assert.equal(opt.type, 'boolean')
  assert.equal(opt.default, true)
  assert.equal(opt.title, 'Allow dashboards from yey.boats')
  assert.match(opt.description, /boat's owner put a dashboard on this boat's displays/)
})

test('the runtime reads allow_cloud_dashboards: on unless exactly false', async () => {
  for (const [options, want] of [[{}, true], [{ allow_cloud_dashboards: true }, true],
    [{ allow_cloud_dashboards: 'no' }, true], [{ allow_cloud_dashboards: false }, false]]) {
    const dir = tmpdir()
    const rt = createRuntime({ app: { debug: () => {}, getDataDirPath: () => dir }, options })
    assert.equal(rt.cfg.allowCloudDashboards, want, JSON.stringify(options))
    assert.equal(rt.snapshot().allow_cloud_dashboards, want)
    const caps = await rt.rpc.handle(req('capabilities', {}, { deadline_ms: Date.now() + 5000 }))
    assert.equal(caps.result.cloud_dashboards.enabled, want)
  }
})

test('switched off: cloud_dashboards_off, nothing else looked at, nothing remembered', async () => {
  const dir = tmpdir()
  const s = server({ cloudDashboards: false, dir })
  // Even a request with no boat_id is answered by the switch first.
  const r = await s.rpc.handle(show({}, {}, { boat_id: undefined }))
  assert.equal(r.ok, false)
  assert.equal(r.error, REFUSAL.CLOUD_DASHBOARDS_OFF)
  assert.equal(s.dm.calls.length, 0)
  assert.equal(fs.existsSync(path.join(dir, dp.REPLAY_FILE)), false)
  assert.match(s.statuses.at(-1), /^Dashboard from yey\.boats: "Wind history" on yey-d-28372f8a0290 refused \(cloud_dashboards_off\)/)
  const caps = await s.rpc.handle(req('capabilities'))
  assert.equal(caps.result.cloud_dashboards.enabled, false)
})

test('the switch is read fresh on every request', async () => {
  let on = true
  const s = server({ cloudDashboards: () => on })
  assert.equal((await s.rpc.handle(show())).ok, true)
  on = false
  assert.equal((await s.rpc.handle(show())).error, REFUSAL.CLOUD_DASHBOARDS_OFF)
  on = true
  assert.equal((await s.rpc.handle(show())).ok, true)
})

// ── rule 2: the envelope ─────────────────────────────────────────────────────

test('envelope: boat_id and deadline_ms are required, a far deadline is refused', async () => {
  const s = server()
  const cases = [
    [{ boat_id: undefined }, 'boat_id_missing'],
    [{ boat_id: 7 }, 'boat_id_type'],
    [{ deadline_ms: undefined }, 'deadline_missing'],
    [{ deadline_ms: T0 + dp.MAX_DEADLINE_AHEAD_MS + 1 }, 'deadline_too_far']
  ]
  for (const [extra, detail] of cases) {
    const r = await s.rpc.handle(show({}, {}, extra))
    assert.equal(r.error, REFUSAL.BAD_REQUEST, detail)
    assert.equal(r.detail, detail)
  }
  assert.equal(s.dm.calls.length, 0)
})

test('envelope: a 20 s deadline (the hand-off may take 15 s) is accepted', async () => {
  const s = server()
  const r = await s.rpc.handle(show({}, {}, { deadline_ms: T0 + 20000 }))
  assert.equal(r.ok, true)
})

test('envelope: expired, duplicate and foreign shows are dropped unanswered', async () => {
  const s = server()
  assert.equal(await s.rpc.handle(show({}, {}, { deadline_ms: T0 - 1 })), null)
  assert.equal(await s.rpc.handle(show({}, {}, { boat_id: 'b_other' })), null)
  const once = show()
  assert.equal((await s.rpc.handle(once)).ok, true)
  assert.equal(await s.rpc.handle(once), null)
  assert.equal(s.dm.calls.length, 1)
  assert.equal(s.sent.length, 1)
  assert.ok(s.debugs.some((d) => /dropped \(duplicate\)/.test(d)))
  assert.ok(s.debugs.some((d) => /dropped \(expired\)/.test(d)))
})

test('replay: a show id is remembered on disk (0600, its own file) across a restart', async () => {
  const dir = tmpdir()
  const env = show()
  const first = server({ dir })
  assert.equal((await first.rpc.handle(env)).ok, true)
  const file = path.join(dir, dp.REPLAY_FILE)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.notEqual(dp.REPLAY_FILE, STEERING_REPLAY_FILE)
  assert.equal(fs.existsSync(path.join(dir, STEERING_REPLAY_FILE)), false)
  const second = server({ dir })
  assert.equal(await second.rpc.handle(env), null)
  assert.equal(second.dm.calls.length, 0)
})

test('replay: an id expires from the store after its deadline + 10 min', () => {
  let clock = T0
  const p = dp.createDashboardPolicy({ now: () => clock, boatId: () => 'b_1' })
  const r = { id: 'rpc_aaaaaaaaaaaaaaaaaaaaaaaa', boat_id: 'b_1', deadline_ms: T0 + 20000 }
  assert.deepEqual(p.checkRequest(r), {})
  assert.deepEqual(p.inspectRequest({ ...r, deadline_ms: clock + 1000 }), { drop: 'duplicate' })
  clock = T0 + 20000 + 10 * 60 * 1000 + 1
  assert.deepEqual(p.inspectRequest({ ...r, deadline_ms: clock + 1000 }), {})
  assert.equal(p.replaySize(), 0)
})

test('replay: a store full of live ids refuses (busy, fail closed)', async () => {
  const p = dp.createDashboardPolicy({ now: () => T0, boatId: () => 'b_1', maxReplayIds: 1 })
  const s = server({ dashboardPolicy: p })
  assert.equal((await s.rpc.handle(show())).ok, true)
  const r = await s.rpc.handle(show())
  assert.equal(r.error, REFUSAL.BUSY)
  assert.equal(r.detail, 'replay_store_full')
})

// ── arguments ────────────────────────────────────────────────────────────────

test('malformed arguments are bad_request naming the field, before Display Manager', async () => {
  const s = server({ limits: { max_per_min: 100 } })
  const cases = [
    [{ display_ids: [] }, {}, 'display_ids'],
    [{ display_ids: 'yey-d-1' }, {}, 'display_ids'],
    [{ display_ids: [7] }, {}, 'display_ids'],
    [{ display_ids: ['all', 'yey-d-1'] }, {}, 'display_ids'],
    [{ display_ids: Array.from({ length: 33 }, (_, i) => `d${i}`) }, {}, 'display_ids'],
    [{ dashboard: 'x' }, {}, 'dashboard'],
    [{}, { source_id: '' }, 'dashboard.source_id'],
    [{}, { title: 5 }, 'dashboard.title'],
    [{}, { screen: '' }, 'dashboard.screen'],
    [{}, { doc: undefined }, 'dashboard.doc'],
    [{}, { doc: [1, 2] }, 'dashboard.doc'],
    [{}, { doc: '{"midl":1}' }, 'dashboard.doc']
  ]
  for (const [over, dash, detail] of cases) {
    const r = await s.rpc.handle(show(over, dash))
    assert.equal(r.error, REFUSAL.BAD_REQUEST, detail)
    assert.equal(r.detail, detail)
  }
  assert.equal(s.dm.calls.length, 0)
})

// ── rule 3: the 48 KiB doc cap, and a ~50 KiB request is carried ────────────

function docOfBytes (n) {
  const base = { midl: 1, screens: [{ id: 'dash', title: 'big', note: '' }] }
  const fill = n - Buffer.byteLength(JSON.stringify(base))
  base.screens[0].note = 'x'.repeat(fill)
  assert.equal(Buffer.byteLength(JSON.stringify(base)), n)
  return base
}

test('a doc of exactly 48 KiB is handed over; one byte more is too_large', async () => {
  const s = server()
  const ok = await s.rpc.handle(show({}, { doc: docOfBytes(48 * 1024) }))
  assert.equal(ok.ok, true)
  const big = await s.rpc.handle(show({}, { doc: docOfBytes(48 * 1024 + 1) }))
  assert.equal(big.error, REFUSAL.TOO_LARGE)
  assert.equal(big.detail, `doc ${48 * 1024 + 1} bytes > ${48 * 1024}`)
  assert.equal(s.dm.calls.length, 1)
})

test('the cap counts UTF-8 bytes, not characters', () => {
  const p = dp.createDashboardPolicy({})
  const doc = { t: 'ø'.repeat(30 * 1024) } // 60 KiB of bytes, 30 K characters
  assert.match(p.checkSize(doc), /^doc \d+ bytes > 49152$/)
})

test('a ~50 KiB request arrives over the uplink and is shown (no inbound cap below it)', async () => {
  // The Socket.IO client (engine.io-client over `ws`) sets no maxPayload of
  // its own, so ws's 100 MiB default applies; the uplink must not add one.
  const sockets = []
  let ioOpts = null
  const io = (origin, opts) => {
    ioOpts = opts
    const handlers = {}
    const socket = { on: (e, fn) => { handlers[e] = fn }, emit: () => {}, close: () => {}, fire: (e, d) => handlers[e] && handlers[e](d) }
    sockets.push(socket)
    return socket
  }
  const u = createUplink({
    cfg: { cloudOrigin: 'https://x', tenant: 't', project: 'p', bundleId: 'b', boatId: 'b_1', boatCredential: 'k' },
    transport: DEFAULT_TRANSPORT,
    deps: {
      io,
      callPublicOp: async () => ({ ok: true, federated_token: 't', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
      uplinkSetTimeout: () => 1,
      uplinkClearTimeout: () => {}
    }
  })
  assert.equal('maxPayload' in (ioOpts || {}), false)
  const s = server()
  const replies = []
  u.onEvent(REQUEST_EVENT, (env) => { replies.push(s.rpc.handle(env)) })
  await u.connect()
  assert.equal(ioOpts.maxPayload, undefined)
  const env = show({}, { doc: docOfBytes(47 * 1024) })
  const size = Buffer.byteLength(JSON.stringify(env))
  assert.ok(size > 47 * 1024 && size < 56 * 1024, `request is ${size} bytes`)
  sockets[0].fire('chat_service', env)
  const r = await replies[0]
  assert.equal(r.ok, true)
  assert.equal(s.dm.calls[0].doc.screens[0].note.length, env.data.args.dashboard.doc.screens[0].note.length)
})

// ── rule 4: 6 a minute, separate from steering ──────────────────────────────

test('rate: the 7th show in a minute is rate_limited; a minute later one goes through', async () => {
  const s = server()
  for (let i = 0; i < 6; i++) assert.equal((await s.rpc.handle(show())).ok, true, `show ${i + 1}`)
  const r = await s.rpc.handle(show())
  assert.equal(r.error, REFUSAL.RATE_LIMITED)
  assert.equal(s.dm.calls.length, 6)
  s.advance(60000)
  assert.equal((await s.rpc.handle(show())).ok, true)
})

test('rate: shows do not use up remote steering puts (separate counters)', async () => {
  const steeringPolicy = createSteeringPolicy({ now: () => T0, boatId: () => 'b_1' })
  const s = server({ steeringPolicy })
  for (let i = 0; i < 7; i++) await s.rpc.handle(show())
  // The steering rate is untouched by the dashboard flood.
  for (let i = 0; i < 12; i++) assert.equal(steeringPolicy.admitRate(), true)
})

test('rate: refused shows (bad args, too large) do not use up the show rate', async () => {
  const s = server()
  for (let i = 0; i < 6; i++) await s.rpc.handle(show({}, { doc: null }))
  for (let i = 0; i < 6; i++) assert.equal((await s.rpc.handle(show())).ok, true)
})

// ── rule 5: Display Manager present ─────────────────────────────────────────

test('no Display Manager: displays is available:false, show is unsupported', async () => {
  for (const dm of [undefined, null, {}, { version: 0, listDisplays () {}, showDashboard () {} }, { version: 1, listDisplays () {} }]) {
    const s = server({ dm })
    const d = await s.rpc.handle(req('displays'))
    assert.deepEqual(d.result, { available: false, reason: 'display_manager_missing', allow_cloud_dashboards: true, displays: [] })
    const r = await s.rpc.handle(show())
    assert.equal(r.error, REFUSAL.UNSUPPORTED)
    assert.equal(r.detail, 'display_manager_missing')
  }
})

test('the default Display Manager is the process-wide symbol, read fresh', async () => {
  const key = Symbol.for('yey-boats.display-manager')
  const rpc = createRpcServer({ publish: async () => {}, boatId: () => 'b_1', now: () => T0 })
  const handle = (env) => rpc.handle({ ...env, data: { ...env.data, deadline_ms: T0 + 20000 } })
  delete globalThis[key]
  assert.equal((await handle(req('displays'))).result.available, false)
  const dm = fakeDm()
  globalThis[key] = dm
  try {
    const d = await handle(req('displays'))
    assert.equal(d.result.available, true)
    assert.equal((await handle(show())).ok, true)
    assert.equal(dm.calls.length, 1)
  } finally {
    delete globalThis[key]
  }
})

// ── rule 6: the hand-off ────────────────────────────────────────────────────

test('happy path: the request is handed over normalised, per-display results come back', async () => {
  const s = server({
    dm: fakeDm({
      show: async (r) => ({
        preset: { id: 'yey-wind-history', name: 'Wind history', created: true, extra: 1 },
        results: [
          { display_id: r.displayIds[0], state: 'shown', screen: 'dash' },
          { display_id: r.displayIds[1], state: 'queued' },
          { display_id: r.displayIds[2], state: 'refused', error: 'class round-240 cannot show widget wind-history' },
          { display_id: r.displayIds[3], state: 'unknown_display' }
        ]
      })
    })
  })
  const ids = ['yey-d-1', 'yey-d-2', 'yey-d-3', 'yey-d-4']
  const r = await s.rpc.handle(show({ display_ids: ids }))
  assert.equal(r.schema, REPLY_SCHEMA)
  assert.equal(r.op, 'show_dashboard')
  assert.deepEqual(r.result, {
    preset: { id: 'yey-wind-history', name: 'Wind history', created: true },
    results: [
      { display_id: 'yey-d-1', state: 'shown', screen: 'dash' },
      { display_id: 'yey-d-2', state: 'queued' },
      { display_id: 'yey-d-3', state: 'refused', error: 'class round-240 cannot show widget wind-history' },
      { display_id: 'yey-d-4', state: 'unknown_display' }
    ]
  })
  assert.deepEqual(s.dm.calls[0], {
    sourceId: 'dsh_1',
    title: 'Wind history',
    updatedAt: '2026-11-16T10:00:00Z',
    doc: DOC,
    screen: 'dash',
    displayIds: ids,
    requestedBy: "the boat's owner (Google account)"
  })
  // The local trail: status line and debug, never the doc.
  const line = s.statuses.at(-1)
  assert.match(line, /^Dashboard from yey\.boats: "Wind history" on yey-d-1, yey-d-2, yey-d-3 \+1 accepted \(shown 1, queued 1, refused 1, unknown_display 1\), asked by the boat's owner/)
  assert.ok(s.debugs.some((d) => d.includes(line)))
  assert.equal(s.debugs.some((d) => d.includes('widgets')), false)
  assert.equal(s.raw.stats().last_dashboard, line)
  assert.equal(s.raw.stats().cloud_dashboards, true)
})

test('"all" is handed over as displayIds "all"; screen defaults to null', async () => {
  for (const ids of ['all', ['all']]) {
    const s = server()
    const r = await s.rpc.handle(show({ display_ids: ids }, { screen: undefined }))
    assert.equal(r.ok, true)
    assert.equal(s.dm.calls[0].displayIds, 'all')
    assert.equal(s.dm.calls[0].screen, null)
  }
})

test('Display Manager refusing the doc is invalid_dashboard with its message', async () => {
  const msg = 'screen "dash": unknown widget "windz" (line 3)'
  const s = server({ dm: fakeDm({ show: async () => { throw Object.assign(new Error(msg), { code: 'invalid_dashboard' }) } }) })
  const r = await s.rpc.handle(show())
  assert.equal(r.ok, false)
  assert.equal(r.error, REFUSAL.INVALID_DASHBOARD)
  assert.equal(r.detail, msg)
  assert.match(s.statuses.at(-1), /refused \(invalid_dashboard\)/)
})

test('any other Display Manager failure is internal, never a crash', async () => {
  const s = server({ dm: fakeDm({ show: async () => { throw new Error('disk full') } }) })
  const r = await s.rpc.handle(show())
  assert.equal(r.error, REFUSAL.INTERNAL)
  assert.equal(r.detail, 'display_manager: disk full')
  const odd = server({ dm: fakeDm({ show: async () => 'ok' }) })
  assert.equal((await odd.rpc.handle(show())).error, REFUSAL.INTERNAL)
})

test('a hand-off that hangs is answered timeout after 15 s, and its late outcome is trailed', async () => {
  const timers = []
  let finish
  const s = server({
    dm: fakeDm({ show: () => new Promise((resolve) => { finish = resolve }) }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {}
  })
  const pending = s.rpc.handle(show({}, {}, { deadline_ms: T0 + 25000 }))
  await new Promise((resolve) => setImmediate(resolve))
  const t = timers.find((x) => x.ms === 15000)
  assert.ok(t, `timers: ${timers.map((x) => x.ms)}`)
  t.fn()
  const r = await pending
  assert.equal(r.error, REFUSAL.TIMEOUT)
  assert.match(s.statuses.at(-1), /timed out \(may still complete\)/)
  finish({ preset: { id: 'p', name: 'P', created: false }, results: [{ display_id: 'yey-d-28372f8a0290', state: 'queued' }] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(s.statuses.at(-1), /finished after timeout \(queued 1\)/)
})

test('the hand-off budget never outlives the cloud deadline', async () => {
  const timers = []
  const s = server({
    dm: fakeDm({ show: () => new Promise(() => {}) }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {}
  })
  const pending = s.rpc.handle(show({}, {}, { deadline_ms: T0 + 8000 }))
  await new Promise((resolve) => setImmediate(resolve))
  const t = timers.find((x) => x.ms === 8000)
  assert.ok(t)
  t.fn()
  assert.equal((await pending).error, REFUSAL.TIMEOUT)
})

// ── displays (read) ─────────────────────────────────────────────────────────

test('displays lists what Display Manager has, in the contract shape only', async () => {
  const s = server()
  const r = await s.rpc.handle(req('displays'))
  assert.equal(r.ok, true)
  assert.deepEqual(r.result, {
    available: true,
    allow_cloud_dashboards: true,
    displays: [{
      id: 'yey-d-28372f8a0290',
      name: 'Helm display',
      class: 'square-480',
      online: true,
      screen: { id: 'dash', title: 'Wind history', record: 'dash' },
      preset: { id: 'yey-wind-history', name: 'Wind history' }
    }]
  })
})

test('displays is not gated by the switch; it reports it', async () => {
  const s = server({ cloudDashboards: false })
  const r = await s.rpc.handle(req('displays'))
  assert.equal(r.ok, true)
  assert.equal(r.result.available, true)
  assert.equal(r.result.allow_cloud_dashboards, false)
  assert.equal(r.result.displays.length, 1)
})

test('displays: nulls for no screen / preset, entries without an id skipped, a failure is internal', async () => {
  const s = server({ dm: fakeDm({ list: async () => [{ id: 'd1', name: 'Mast', online: 'yes' }, { name: 'no id' }, null] }) })
  const r = await s.rpc.handle(req('displays'))
  assert.deepEqual(r.result.displays, [{ id: 'd1', name: 'Mast', class: '', online: false, screen: null, preset: null }])
  const bad = server({ dm: fakeDm({ list: async () => { throw new Error('boom') } }) })
  const b = await bad.rpc.handle(req('displays'))
  assert.equal(b.error, REFUSAL.INTERNAL)
  assert.equal(b.detail, 'display_manager: boom')
})

test('displays is rate-limited like any read and needs no deadline', async () => {
  const s = server({ limits: { max_per_min: 2 } })
  assert.equal((await s.raw.handle(req('displays', {}, { deadline_ms: undefined }))).ok, true)
  assert.equal((await s.rpc.handle(req('displays'))).ok, true)
  assert.equal((await s.rpc.handle(req('displays'))).error, REFUSAL.RATE_LIMITED)
})
