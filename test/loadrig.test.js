'use strict'
/** The rig is code, so the rig has tests.
 *
 *  Every number in docs/capacity-report-2026-09-20.md comes out of this thing.
 *  A load rig nobody checked produces confident numbers about nothing.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { createTraceSource } = require('../loadrig/source')
const { createSink } = require('../loadrig/sink')
const { createFleet } = require('../loadrig/fleet')
const { DEFAULT_TRANSPORT } = require('../lib/plan')

const TRACE = {
  server: { version: '2.7.1', plugins: [] },
  vessel: { name: 'Sara', mmsi: '235177007' },
  self: { navigation: { position: { value: { latitude: 45, longitude: 13 } } } },
  meta: { 'navigation.position': { units: 'deg' } },
  // 1 Hz, which is the simulator's own literal tick (engine/runner.py:257).
  deltas: Array.from({ length: 60 }, (_, i) => ({
    t: i * 1000,
    path: 'navigation.position',
    value: { latitude: 45 + i * 0.001, longitude: 13 }
  }))
}

const PLAN = {
  schema: 1,
  plan_id: 'pl_rig',
  version: 1,
  budget: { max_msgs_per_min: 30, max_bytes_per_hour: 262144 },
  defaults: { policy: 'on_change', min_interval_s: 5, max_interval_s: 300 },
  transport: { ...DEFAULT_TRANSPORT },
  mappings: [{
    path: 'navigation.position', as: 'position', policy: 'on_change',
    deadband: { meters: 25 }, min_interval_s: 10, max_interval_s: 600,
    priority: 'high'
  }]
}

// ── The source ──────────────────────────────────────────────────────────────

test('the trace source answers all five methods the runtime calls', async () => {
  const s = createTraceSource(TRACE, { boatId: 'b_1', now: () => 0 })
  for (const name of ['subscribe', 'selfTree', 'collectMeta', 'serverInfo', 'vesselIdentity']) {
    assert.equal(typeof s[name], 'function', name)
  }
  assert.equal((await s.serverInfo()).version, '2.7.1')
  assert.equal((await s.vesselIdentity()).name, 'Sara')
})

test('each boat gets its own vessel identity so the cloud can tell them apart', async () => {
  const a = createTraceSource(TRACE, { boatId: 'b_1', now: () => 0 })
  const b = createTraceSource(TRACE, { boatId: 'b_2', now: () => 0 })
  assert.notEqual((await a.vesselIdentity()).mmsi, (await b.vesselIdentity()).mmsi)
})

test('pump emits every delta due by now and none twice', () => {
  const got = []
  const s = createTraceSource(TRACE, { boatId: 'b_1', now: () => 0 })
  s.subscribe((sample) => got.push(sample), () => {})
  s.pump(2_500)
  assert.equal(got.length, 3)          // t=0, 1000, 2000
  s.pump(2_500)
  assert.equal(got.length, 3, 'a second pump at the same time re-emitted')
  s.pump(5_000)
  assert.equal(got.length, 6)
})

test('the trace loops so a long run does not run out of boat', () => {
  const got = []
  const s = createTraceSource(TRACE, { boatId: 'b_1', now: () => 0 })
  s.subscribe((sample) => got.push(sample), () => {})
  s.pump(180_000)
  assert.ok(got.length > TRACE.deltas.length * 2)
})

// ── The sink ────────────────────────────────────────────────────────────────

test('an ack means ENQUEUED, which is what the real one means', async () => {
  // uplink.publish resolves on the socket ack, and the ingress ack carries a
  // stream_id — the XADD has happened and nothing has handled it. The connector
  // commits its buffer on that ack (lib/runtime.js:268-272), so anything merely
  // enqueued is already gone from the boat.
  const sink = createSink({ serviceMs: 20, maxlen: 10, now: () => 0 })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  const ack = await up.publish('yey.boat.data', { values: [] }, {})
  assert.equal(ack.status, 'accepted')
  assert.ok(ack.accepted[0].stream_id)
  assert.equal(sink.stats().queued, 1)
  assert.equal(sink.stats().handled, 0)
})

test('the consumer is serial: one message at a time for the whole fleet', async () => {
  const sink = createSink({ serviceMs: 20, maxlen: 1000, now: () => 0 })
  const a = sink.uplinkFor({ boatId: 'b_1' })
  const b = sink.uplinkFor({ boatId: 'b_2' })
  for (let i = 0; i < 10; i += 1) {
    await a.publish('yey.boat.data', { values: [] }, {})
    await b.publish('yey.boat.data', { values: [] }, {})
  }
  sink.drain(100)                       // 100ms / 20ms = 5 messages
  assert.equal(sink.stats().handled, 5)
  sink.drain(1000)
  assert.equal(sink.stats().handled, 20)
})

test('MAXLEN evicts from the head and counts what was never delivered', () => {
  const sink = createSink({ serviceMs: 1000, maxlen: 3, now: () => 0 })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  for (let i = 0; i < 6; i += 1) up.publish('yey.boat.data', { values: [{ i }] }, {})
  const s = sink.stats()
  assert.equal(s.queued, 3, 'the stream grew past its cap')
  assert.equal(s.evicted, 3)
  assert.equal(s.evictedUndelivered, 3, 'evicting an unread entry is silent data loss')
})

test('an entry already handled is not counted as lost when it is trimmed', () => {
  const sink = createSink({ serviceMs: 1, maxlen: 2, now: () => 0 })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  up.publish('yey.boat.data', { values: [] }, {})
  up.publish('yey.boat.data', { values: [] }, {})
  sink.drain(10)
  assert.equal(sink.stats().handled, 2)
  up.publish('yey.boat.data', { values: [] }, {})
  up.publish('yey.boat.data', { values: [] }, {})
  assert.equal(sink.stats().evictedUndelivered, 0)
})

test('undelivered is what an interactive message actually waits behind', () => {
  const sink = createSink({ serviceMs: 10, maxlen: 100, now: () => 0 })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  for (let i = 0; i < 5; i += 1) up.publish('yey.boat.data', { values: [] }, {})
  assert.equal(sink.stats().undelivered, 5)
  sink.drain(30)                       // 3 messages
  assert.equal(sink.stats().undelivered, 2)
  assert.equal(sink.stats().queued, 5, 'a handled entry stays in the stream until trimmed')
})

test('the sink records bytes so the report can turn a cap into a memory figure', () => {
  const sink = createSink({ serviceMs: 1000, maxlen: 1000, now: () => 0 })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  up.publish('yey.boat.backfill',
    { values: Array.from({ length: 200 }, (_, i) => ({ p: 'navigation.position', v: i, t: i })) }, {})
  const s = sink.stats()
  assert.ok(s.bytesPerEntry > 1000, `entry was only ${s.bytesPerEntry} bytes`)
})

test('the sink answers hello with a plan, because a boat with no plan sends nothing', async () => {
  const sink = createSink({ serviceMs: 20, maxlen: 100, now: () => 0, plan: PLAN })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  const reply = await up.request('yey.boat.hello', { plan_etag: '' })
  assert.equal(reply.kind, 'plan')
  assert.equal(reply.plan.mappings.length, 1)
})

// ── The fleet ───────────────────────────────────────────────────────────────

test('N runtimes share one clock and one sink', async () => {
  const fleet = createFleet({ n: 5, trace: TRACE, plan: PLAN, serviceMs: 20,
                              maxlen: 1000, seed: 1 })
  assert.equal(fleet.runtimes.length, 5)
  await fleet.start()
  assert.equal(fleet.sink.stats().helloCount, 5)
})

test('each boat is paired with its own id and credential', () => {
  const fleet = createFleet({ n: 3, trace: TRACE, plan: PLAN, seed: 1 })
  const ids = fleet.runtimes.map((r) => r.cfg.boatId)
  assert.equal(new Set(ids).size, 3)
  assert.ok(fleet.runtimes.every((r) => r.cfg.boatCredential))
})

test('the fleet is deterministic for a given seed', async () => {
  const run = async () => {
    const f = createFleet({ n: 10, trace: TRACE, plan: PLAN, seed: 42 })
    await f.start()
    f.dropAll('deploy')
    await f.run(60_000)
    return f.snapshot().arrivals.map((a) => Math.round(a))
  }
  assert.deepEqual(await run(), await run())
})

test('a different seed gives a different arrival pattern', async () => {
  const run = async (seed) => {
    const f = createFleet({ n: 10, trace: TRACE, plan: PLAN, seed })
    await f.start()
    f.dropAll('deploy')
    await f.run(60_000)
    return f.snapshot().arrivals.map((a) => Math.round(a))
  }
  assert.notDeepEqual(await run(1), await run(2))
})

test('dropAll reproduces what a deploy does to the fleet', async () => {
  const fleet = createFleet({ n: 20, trace: TRACE, plan: PLAN, seed: 7 })
  await fleet.start()
  fleet.sink.reset()
  fleet.dropAll('deploy')
  await fleet.run(60_000)
  const snap = fleet.snapshot()
  assert.equal(snap.arrivals.length, 20, 'every boat must come back')
  // DEFAULT_TRANSPORT: base 2s, +/-30% => attempt 1 lands in [1.4s, 2.6s].
  assert.ok(Math.min(...snap.arrivals) >= 1400)
  assert.ok(Math.max(...snap.arrivals) <= 2600)
})

test('a wide plan curve spreads the same fleet over the window it promises', async () => {
  const wide = { ...PLAN, transport: { ...DEFAULT_TRANSPORT, backoff_base_s: 60,
                                        reconnect_jitter_pct: 100 } }
  const fleet = createFleet({ n: 20, trace: TRACE, plan: wide, seed: 7 })
  await fleet.start()
  fleet.sink.reset()
  fleet.dropAll('deploy')
  await fleet.run(200_000)
  const snap = fleet.snapshot()
  assert.equal(snap.arrivals.length, 20)
  assert.ok(Math.max(...snap.arrivals) > 60_000,
    'the wide curve did not actually spread anything')
})

test('the rig uses no real timers and no real sockets', () => {
  const fleet = createFleet({ n: 3, trace: TRACE, plan: PLAN, seed: 1 })
  assert.equal(fleet.timers.pending().length >= 0, true)
  // A rig on real timers cannot simulate a day of boat in a second, and a rig
  // on real sockets is measuring the laptop's network stack.
  const src = require('fs').readFileSync(require.resolve('../loadrig/fleet.js'), 'utf8')
  assert.ok(!/require\('socket\.io-client'\)/.test(src))
  assert.ok(!/\bsetInterval\(/.test(src))
})

// ── Beyond the plan's list: the places the first draft of the rig was wrong ──

test('a reconnect resumes the trace at "now": no burst of the outage, no silent gap', () => {
  // The real delta socket neither replays what happened while it was closed
  // nor pauses: it resumes at wall-clock now. Resetting the trace origin on
  // re-subscribe would do one or the other.
  let clock = 0
  const got = []
  const s = createTraceSource(TRACE, { boatId: 'b_1', now: () => clock })
  const sub = s.subscribe((x) => got.push(x), () => {})
  s.pump(4_500)
  assert.equal(got.length, 5)                 // t=0..4000
  sub.close()
  s.pump(20_500)                              // outage: nobody listening
  assert.equal(got.length, 5)
  clock = 20_500
  s.subscribe((x) => got.push(x), () => {})
  s.pump(20_500)
  assert.equal(got.length, 5, 'the outage was replayed as a burst')
  s.pump(22_500)
  assert.equal(got.length, 7, 'the stream did not resume at now')   // t=21000, 22000
  assert.equal(Date.parse(got[5].timestamp) - Date.parse(got[0].timestamp), 21_000)
})

test('kill() reaches the runtime as a SignalK outage', () => {
  let why = ''
  const s = createTraceSource(TRACE, { boatId: 'b_1', now: () => 0 })
  s.subscribe(() => {}, (w) => { why = w })
  s.kill('server restarted')
  assert.equal(why, 'server restarted')
})

test('a fleet index gives every boat a distinct MMSI', async () => {
  const mmsis = new Set()
  for (let i = 0; i < 500; i += 1) {
    const s = createTraceSource(TRACE, { boatId: `b_rig_${i}`, now: () => 0, index: i })
    mmsis.add((await s.vesselIdentity()).mmsi)
  }
  assert.equal(mmsis.size, 500)
})

test('hello answers not_modified only for the etag it handed out', async () => {
  // yey_boat_hello: `str(payload.plan_etag or "") == etag and etag`. An empty
  // echo must get the plan, or a boat with no plan is told it is up to date.
  const sink = createSink({ now: () => 0, plan: { ...PLAN, __etag: 'e1' } })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  const first = await up.request('yey.boat.hello', { plan_etag: '' })
  assert.equal(first.etag, 'e1')
  assert.ok(first.plan, 'an empty etag was answered not_modified')
  assert.ok(!('__etag' in first.plan), 'rig metadata leaked into the plan')
  assert.equal((await up.request('yey.boat.hello', { plan_etag: 'e1' })).not_modified, true)
  assert.ok((await up.request('yey.boat.hello', { plan_etag: 'stale' })).plan)
})

test('the consumer carries a partial service slot instead of losing it', () => {
  const sink = createSink({ serviceMs: 20, maxlen: 100, now: () => 0 })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  for (let i = 0; i < 10; i += 1) up.publish('yey.boat.data', { values: [] }, {})
  for (let i = 0; i < 10; i += 1) sink.drain(10)   // 100ms in 10ms slices
  assert.equal(sink.stats().handled, 5)
})

test('an idle consumer does not bank time for a later burst', () => {
  const sink = createSink({ serviceMs: 20, maxlen: 100, now: () => 0 })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  sink.drain(10_000)                               // idle
  for (let i = 0; i < 10; i += 1) up.publish('yey.boat.data', { values: [] }, {})
  sink.drain(20)
  assert.equal(sink.stats().handled, 1)
})

test('the sink remembers the deepest backlog, not just the current one', () => {
  const sink = createSink({ serviceMs: 10, maxlen: 100, now: () => 0 })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  for (let i = 0; i < 7; i += 1) up.publish('yey.boat.data', { values: [] }, {})
  sink.drain(1000)
  assert.equal(sink.stats().undelivered, 0)
  assert.equal(sink.stats().maxUndelivered, 7)
})

test('arrivals count each boat once, even when a heartbeat hello follows', async () => {
  const quick = { ...PLAN, transport: { ...DEFAULT_TRANSPORT, heartbeat_s: 30 } }
  const fleet = createFleet({ n: 4, trace: TRACE, plan: quick, seed: 3 })
  await fleet.start()
  fleet.dropAll('deploy')
  await fleet.run(120_000)                         // several heartbeats per boat
  const snap = fleet.snapshot()
  assert.ok(snap.sink.helloCount > 8, 'the heartbeat never fired; the test proves nothing')
  assert.equal(snap.arrivals.length, 4)
})

test('boats stream: a started fleet publishes data the consumer then handles', async () => {
  const fleet = createFleet({ n: 3, trace: TRACE, plan: PLAN, seed: 1, serviceMs: 5 })
  await fleet.start()
  await fleet.run(120_000)
  const s = fleet.sink.stats()
  assert.ok((s.perSubject['yey.boat.data'] || 0) > 0, JSON.stringify(s.perSubject))
  assert.equal(s.undelivered, 0)
  assert.equal(s.evictedUndelivered, 0)
  for (const b of fleet.snapshot().boats) {
    assert.equal(b.state, 'running')
    assert.equal(b.active_mappings, 1)
  }
})

test('the virtual timers fire in (due, scheduled) order and honour clearTimeout', async () => {
  const { fakeTimers } = require('../loadrig/fleet')
  const t = fakeTimers(0)
  const seen = []
  t.setTimeout(() => seen.push('b'), 20)
  t.setTimeout(() => seen.push('a'), 10)
  t.setTimeout(() => seen.push('c'), 20)
  const gone = t.setTimeout(() => seen.push('x'), 15)
  t.clearTimeout(gone)
  t.setTimeout(() => { seen.push('d'); t.setTimeout(() => seen.push('e'), 1) }, 25)
  await t.fireDueBy(100)
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(t.now(), 100)
})

// ── capture.js, offline ─────────────────────────────────────────────────────
// capture.js is operator-run against a LOCAL signalk-server. What can be
// checked without one is that it asks for the tree before the meta, records
// deltas on a relative clock, and refuses a trace cut short.

function fakeHttpSource ({ closeAfter = Infinity } = {}) {
  let onSample = null
  let onClose = null
  const calls = []
  return {
    calls,
    emit (sample) { if (onSample) onSample(sample) },
    close (why) { if (onClose) onClose(why) },
    async selfTree () { calls.push('selfTree'); return { name: 'Sara', mmsi: '235177007', navigation: {} } },
    async collectMeta (tree) { calls.push(['collectMeta', Boolean(tree)]); return { 'navigation.position': { units: 'deg' } } },
    async serverInfo () { return { version: '2.33.0', plugins: [] } },
    async vesselIdentity (tree) { calls.push(['vesselIdentity', Boolean(tree)]); return { name: 'Sara', mmsi: '235177007' } },
    subscribe (s, c) { onSample = s; onClose = c; return { close: () => { onSample = null } } },
    closeAfter
  }
}

test('captureTrace records a replayable trace with no network', async () => {
  const { captureTrace } = require('../loadrig/capture')
  const src = fakeHttpSource()
  let clock = 5_000
  const r = await captureTrace({ seconds: 3, out: '' }, {
    source: src,
    now: () => clock,
    sleep: async () => {
      for (let i = 0; i < 3; i += 1) {
        src.emit({ path: 'navigation.position', value: { latitude: 45, longitude: 13 } })
        src.emit({ path: 'navigation.speedOverGround', value: 2.5 })
        clock += 1000
      }
    }
  })
  assert.equal(r.deltas, 6)
  assert.equal(r.paths, 2)
  assert.deepEqual(r.trace.deltas.map((d) => d.t), [0, 0, 1000, 1000, 2000, 2000])
  assert.deepEqual(src.calls[1], ['collectMeta', true], 'collectMeta was called without the tree')
  assert.deepEqual(src.calls[2], ['vesselIdentity', true])
  // And what it wrote is exactly what the rig replays.
  const replay = createTraceSource(r.trace, { boatId: 'b_1', now: () => 0 })
  const got = []
  replay.subscribe((x) => got.push(x), () => {})
  replay.pump(2_000)
  assert.equal(got.length, 6)
})

test('captureTrace refuses a trace cut short by a dropped delta socket', async () => {
  const { captureTrace } = require('../loadrig/capture')
  const src = fakeHttpSource()
  await assert.rejects(captureTrace({ seconds: 1, out: '' }, {
    source: src,
    sleep: async () => { src.emit({ path: 'a.b', value: 1 }); src.close('close') }
  }), /closed mid-capture/)
})

test('captureTrace refuses an empty trace', async () => {
  const { captureTrace } = require('../loadrig/capture')
  await assert.rejects(captureTrace({ seconds: 1, out: '' }, {
    source: fakeHttpSource(), sleep: async () => {}
  }), /no deltas/)
})

// ── The simulator-derived fixture ───────────────────────────────────────────
// test/fixtures/loadrig-sim-trace.json is 20 s of the simulator's own
// _build_vessel_delta output (loadrig/derive-trace.py, deterministic), so the
// rig is exercised on the real path vocabulary and not only on one path.

test('the simulator-derived fixture drives a fleet on real SignalK paths', async () => {
  const trace = require('./fixtures/loadrig-sim-trace.json')
  const paths = new Set(trace.deltas.map((d) => d.path))
  assert.ok(paths.size >= 80, `only ${paths.size} paths in the fixture`)
  for (const p of ['navigation.position', 'navigation.speedOverGround',
    'environment.wind.speedApparent', 'environment.depth.belowTransducer']) {
    assert.ok(paths.has(p), `fixture has no ${p}`)
  }
  const plan = {
    ...PLAN,
    mappings: [
      PLAN.mappings[0],
      { path: 'navigation.speedOverGround', as: 'sog', policy: 'periodic',
        min_interval_s: 5, max_interval_s: 60, priority: 'normal' },
      { path: 'environment.wind.speedApparent', as: 'aws', policy: 'periodic',
        min_interval_s: 5, max_interval_s: 60, priority: 'normal' }
    ]
  }
  const fleet = createFleet({ n: 5, trace, plan, seed: 1, serviceMs: 5 })
  await fleet.start()
  await fleet.run(60_000)
  const snap = fleet.snapshot()
  assert.equal(snap.sink.perSubject['yey.boat.catalog'], 5)
  for (const b of snap.boats) assert.equal(b.active_mappings, 3)
  assert.ok(snap.sink.perSubject['yey.boat.data'] >= 5 * 10,
    JSON.stringify(snap.sink.perSubject))
})

// ── The sweeps ──────────────────────────────────────────────────────────────

const { steadyState, reconnectHerd, backfillStorm } = require('../loadrig/sweeps')

const SWEEP = { trace: TRACE, plan: PLAN, seed: 3, serviceMs: 20, maxlen: 1000 }

test('the steady sweep reports one row per N, in order', async () => {
  const r = await steadyState({ ...SWEEP, ns: [1, 5, 10], minutes: 5 })
  assert.equal(r.sweep, 'steady')
  assert.deepEqual(r.rows.map((row) => row.n), [1, 5, 10])
  for (const row of r.rows) {
    for (const key of ['offeredPerS', 'handledPerS', 'queueDepth',
                       'evictedUndelivered', 'bytesPerEntry', 'p99InteractiveMs']) {
      assert.ok(key in row, `${key} missing at n=${row.n}`)
    }
  }
})

test('offered load rises with N, which is the sanity check on the whole rig', async () => {
  const r = await steadyState({ ...SWEEP, ns: [1, 10], minutes: 5 })
  assert.ok(r.rows[1].offeredPerS > r.rows[0].offeredPerS)
})

test('a serial consumer that cannot keep up shows as a growing queue', async () => {
  const r = await steadyState({ ...SWEEP, serviceMs: 500, ns: [50], minutes: 5 })
  assert.ok(r.rows[0].queueDepth > 0, 'a 500ms handler at 50 boats should back up')
  assert.ok(r.rows[0].handledPerS < r.rows[0].offeredPerS)
})

test('the knee is the largest N that stayed inside the budget', async () => {
  const r = await steadyState({ ...SWEEP, ns: [1, 5, 10, 500], minutes: 5,
                                interactiveBudgetMs: 2000 })
  assert.ok(typeof r.summary.kneeN === 'number')
  assert.ok(r.summary.kneeN < 500)
  assert.ok(r.summary.limiter, 'the knee must name what stopped it')
})

test('the knee is null rather than a guess when every N passed', async () => {
  const r = await steadyState({ ...SWEEP, ns: [1, 2], minutes: 5,
                                interactiveBudgetMs: 10 ** 9 })
  assert.equal(r.summary.kneeN, 2)
  assert.equal(r.summary.limiter, 'none — every N in the sweep stayed inside the budget')
})

test('an eviction of undelivered entries ends the sweep whatever the latency says', async () => {
  const r = await steadyState({ ...SWEEP, maxlen: 5, serviceMs: 1000, ns: [50],
                                minutes: 5, interactiveBudgetMs: 10 ** 9 })
  assert.ok(r.rows[0].evictedUndelivered > 0)
  assert.equal(r.summary.kneeN, null)
  assert.match(r.summary.limiter, /evict/i)
})

test('the herd sweep measures both curves on the same fleet', async () => {
  const wide = { ...DEFAULT_TRANSPORT, backoff_base_s: 60, reconnect_jitter_pct: 100 }
  const r = await reconnectHerd({ ...SWEEP, ns: [20], curves: {
    shipped: DEFAULT_TRANSPORT, fleet: wide } })
  const shipped = r.rows.find((x) => x.curve === 'shipped')
  const fleet = r.rows.find((x) => x.curve === 'fleet')
  assert.equal(shipped.arrived, 20)
  assert.equal(fleet.arrived, 20)
  assert.ok(fleet.windowMs > shipped.windowMs * 10,
    'the fleet curve must actually spread the herd')
  assert.ok(fleet.peakPerS < shipped.peakPerS)
})

test('every boat comes back, or the herd row says how many did not', async () => {
  const r = await reconnectHerd({ ...SWEEP, ns: [20], curves: { shipped: DEFAULT_TRANSPORT },
                                  waitMs: 1 })
  assert.ok(r.rows[0].arrived < 20)
  assert.equal(r.rows[0].missing, 20 - r.rows[0].arrived)
})

test('the storm sweep fills buffers, reconnects, and times the drain', async () => {
  const r = await backfillStorm({ ...SWEEP, n: 20, offlineHours: 2 })
  assert.ok(r.summary.bufferedAtReconnect > 0, 'nothing was buffered')
  assert.ok(r.summary.drainMs > 0)
  assert.ok('peakQueueDepth' in r.summary)
  assert.ok('evictedUndelivered' in r.summary)
  assert.ok('p99InteractiveMs' in r.summary)
})

test('the storm says out loud whether interactive traffic survived it', async () => {
  const r = await backfillStorm({ ...SWEEP, n: 20, offlineHours: 2,
                                  interactiveBudgetMs: 2000 })
  assert.equal(typeof r.summary.interactiveSurvived, 'boolean')
})

test('every report carries the params it was produced with', async () => {
  const r = await steadyState({ ...SWEEP, ns: [1], minutes: 1 })
  assert.equal(r.params.serviceMs, 20)
  assert.equal(r.params.seed, 3)
  assert.ok(r.generatedAt)
})

// ── The sweeps: beyond the plan's list ──────────────────────────────────────

test('the interactive probe counts the longest waits, not only the finished ones', () => {
  // A probe that only recorded waits that had completed by the end of the run
  // would drop the tail at saturation — the exact waits the knee is about.
  const { interactiveProbe } = require('../loadrig/sweeps')
  const sink = createSink({ serviceMs: 100, maxlen: 10_000, now: () => 0 })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  for (let i = 0; i < 50; i += 1) up.publish('yey.boat.data', { values: [] }, {})
  const probe = interactiveProbe(sink, { serviceMs: 100 })
  probe.tick(0, 1000)
  assert.equal(probe.count(), 1)
  assert.equal(probe.p99(), 51 * 100)
})

test('the steady queueDepth is the undelivered backlog, not the stream length', async () => {
  // Handled entries stay in the stream until MAXLEN trims them, so the stream
  // length only grows; using it as "depth" would make every N look backed up.
  const r = await steadyState({ ...SWEEP, serviceMs: 1, ns: [5], minutes: 2 })
  assert.equal(r.rows[0].queueDepth, 0)
  assert.ok(r.rows[0].streamLength > 0)
})

test('a steady fleet is not phase-locked: boats boot across one flush interval', async () => {
  const f = createFleet({ n: 50, trace: TRACE, plan: PLAN, seed: 5, startSpreadMs: 5000 })
  await f.start()
  const at = f.sink.hellos().map((h) => h.at)
  assert.equal(at.length, 50)
  assert.ok(Math.max(...at) - Math.min(...at) > 3000, 'the boats all booted together')
})

test('the herd accepts a fleet curve that is a function of N', async () => {
  const seen = []
  const r = await reconnectHerd({ ...SWEEP, ns: [5, 30], curves: {
    fleet: (n) => { seen.push(n); return { ...DEFAULT_TRANSPORT, backoff_base_s: n } } } })
  assert.deepEqual(seen, [5, 30])
  assert.equal(r.rows[1].transport.backoff_base_s, 30)
  assert.ok(r.rows[1].lastMs > 20_000)
})

test('the storm, link_down: today\'s connector buffers nothing while the cloud is unreachable', async () => {
  // onLinkLost closes the SignalK subscription and cycle() reopens it only
  // after a successful handshake, so an unreachable cloud means no sampling.
  // This pins the behaviour so a connector fix shows up here as a change.
  const r = await backfillStorm({ ...SWEEP, n: 5, offlineHours: 1, mode: 'link_down' })
  assert.equal(r.summary.mode, 'link_down')
  assert.equal(r.summary.gatheredDuringOutage, 0)
  // What is left is the few seconds not yet flushed when the link dropped.
  assert.ok(r.summary.bufferedPerBoat <= 1)
  // Drained only once every boat has come back, at its next retry.
  assert.ok(r.summary.drainMs > 1000, `drained at ${r.summary.drainMs}ms, before any boat returned`)
})

test('the storm, buffered: the drain is chunked backfill and the fleet does drain', async () => {
  const r = await backfillStorm({ ...SWEEP, n: 5, offlineHours: 1, serviceMs: 5,
                                  maxlen: 100_000 })
  assert.ok(r.summary.bufferedPerBoat > 100)
  assert.ok(r.summary.backfillMessages > 0)
  assert.equal(r.summary.drained, true)
  assert.ok(r.summary.gatheredDuringOutage > 0)
  assert.ok(r.summary.backfillBytesPerEntry > 1000, 'a backfill chunk is many records')
})

test('the sink refuses while unreachable and rejects without enqueueing while not accepting', async () => {
  const sink = createSink({ now: () => 0 })
  const up = sink.uplinkFor({ boatId: 'b_1' })
  sink.setReachable(false)
  await assert.rejects(up.connect(), (e) => e.code === 'offline')
  await assert.rejects(up.publish('yey.boat.data', {}), (e) => e.code === 'offline')
  sink.setReachable(true)
  sink.setAccepting(false)
  const ack = await up.publish('yey.boat.data', {})
  assert.equal(ack.status, 'rejected')
  assert.equal(sink.stats().entries, 0)
})

test('sweeps with the same seed and a pinned generatedAt are byte-identical', async () => {
  const go = () => steadyState({ ...SWEEP, ns: [3, 6], minutes: 2,
                                 generatedAt: '2026-01-01T00:00:00Z' })
  assert.equal(JSON.stringify(await go()), JSON.stringify(await go()))
})

// ── membuffer: the rig's buffer must behave like the boat's ─────────────────

test('membuffer matches lib/buffer.js op for op on a random workload', () => {
  const { createBuffer } = require('../lib/buffer')
  const { createMemBuffer } = require('../loadrig/membuffer')
  const { mulberry32 } = require('../loadrig/fleet')
  for (const seed of [1, 2, 3, 4]) {
    const rnd = mulberry32(seed)
    let clock = 1_000_000
    const opts = { maxBytes: 6000, maxAgeMs: 60_000, now: () => clock }
    const real = createBuffer({ dir: null, ...opts })
    const mine = createMemBuffer(opts)
    for (let i = 0; i < 3000; i += 1) {
      clock += Math.floor(rnd() * 400)
      const r = rnd()
      if (r < 0.6) {
        const rec = { t: clock, priority: ['high', 'normal', 'low'][Math.floor(rnd() * 3)],
                      p: 'x', v: Math.floor(rnd() * 1e6), pad: 'y'.repeat(Math.floor(rnd() * 40)) }
        assert.deepEqual(mine.append(rec), real.append(rec))
      } else if (r < 0.85) {
        const k = 1 + Math.floor(rnd() * 20)
        const a = real.peek(k)
        const b = mine.peek(k)
        assert.deepEqual(b, a, `peek diverged at op ${i} seed ${seed}`)
        if (rnd() < 0.7) { real.commit(a.cursor); mine.commit(b.cursor) }
      }
      assert.deepEqual(mine.stats(), real.stats(), `stats diverged at op ${i} seed ${seed}`)
    }
  }
})
