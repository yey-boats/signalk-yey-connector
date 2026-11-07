'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { createRuntime } = require('../lib/runtime')

const CONSENT = ['navigation.position', 'environment.wind.speedApparent']

function planV (version, mappings) {
  return {
    schema: 1, plan_id: 'pl_1', version,
    budget: { max_msgs_per_min: 1000, max_bytes_per_hour: 10 ** 9 },
    defaults: { policy: 'on_change', min_interval_s: 5, max_interval_s: 300 },
    transport: { heartbeat_s: 300, backfill_chunk_msgs: 50 },
    mappings
  }
}

const POSITION = {
  path: 'navigation.position', as: 'position', policy: 'on_change',
  deadband: { meters: 25 }, min_interval_s: 10, max_interval_s: 600, priority: 'high'
}

const SOURCE_STUB = {
  subscribe: () => ({ close: () => {} }),
  selfTree: async () => ({}),
  collectMeta: async () => ({}),
  serverInfo: async () => ({ version: '2.7.1', plugins: [] }),
  vesselIdentity: async () => ({ name: 'Sara', mmsi: '238123456' })
}

/** A runtime with every collaborator injected: no sockets, no clock, no cloud.
 *
 *  The fake cloud MODELS THE REAL COMPARISON: it answers not_modified only when
 *  the hello it received echoes the etag it last handed out. A harness that
 *  returned not_modified unconditionally would pass just as happily with the
 *  connector sending its own hash — which is the bug this shape exists to catch.
 */
function harness ({ replies = [], options = {},
                   dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-rt-')) } = {}) {
  const published = []
  const requests = []
  let clock = 1_000_000
  let servedEtag = ''

  const uplink = {
    connect: async () => {},
    close: () => {},
    // The supervisor registers its retry curve here. Stubbed from the start so
    // this harness keeps working — a fake that goes stale one task later is a
    // fake that hides the next bug.
    setOnLost: () => {},
    state: () => ({ connected: true }),
    publish: async (subject, payload) => {
      published.push({ subject, payload })
      return { schema: 'kdcube.data_bus.ingress.v1', status: 'accepted',
               accepted: [{ message_id: 'm', stream_id: '1-0' }], rejected: [] }
    },
    request: async (subject, payload) => {
      requests.push({ subject, payload })
      const next = replies.shift()
      if (next instanceof Error) throw next
      if (!next) return {}
      // The cloud half of yey_boat_hello, verbatim in shape:
      //   if str(payload.get("plan_etag") or "") == etag and etag: -> not_modified
      if (next.etag && String(payload.plan_etag || '') === String(next.etag)) {
        return { kind: 'plan', not_modified: true, etag: next.etag }
      }
      servedEtag = String(next.etag || '')
      return next
    }
  }

  const runtime = createRuntime({
    app: { debug: () => {}, getDataDirPath: () => dir },
    version: '0.1.0',
    options: { enabled: true, boatId: 'b_1', boatCredential: 'bk_1', ...options },
    deps: {
      createUplink: () => uplink,
      now: () => clock,
      source: { ...SOURCE_STUB }
    }
  })
  return { runtime, published, requests, dir, servedEtag: () => servedEtag,
           advance: (ms) => { clock += ms }, at: () => clock }
}

test('handshake sends hello and applies the plan it gets back', async () => {
  const h = harness({ replies: [{ kind: 'plan', plan: planV(12, [POSITION]), etag: 'e12' }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  assert.equal(h.requests[0].subject, 'yey.boat.hello')
  assert.equal(h.requests[0].payload.hello.schema, 'yey.connector.hello.v1')
  assert.equal(h.runtime.snapshot().plan_version, 12)
  assert.equal(h.runtime.snapshot().active_mappings, 1)
})

test('handshake echoes the CLOUD etag, not its own hash of the plan', async () => {
  /* The cloud compares payload.plan_etag against boat_plan.plan_etag(plan) — a
     Python sha256 over the RAW plan. lib/plan.etagOf is a JS sha256 over the
     PROJECTED, CLAMPED plan. Sending ours makes not_modified unreachable and
     every heartbeat re-applies and re-acks the plan. */
  const h = harness({ replies: [
    { kind: 'plan', plan: planV(12, [POSITION]), etag: 'e12' },
    { kind: 'plan', plan: planV(12, [POSITION]), etag: 'e12' }
  ] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()

  const snap = h.runtime.snapshot()
  assert.equal(snap.plan_etag, 'e12', 'the cloud etag must be stored verbatim')
  assert.notEqual(snap.plan_local_etag, 'e12',
    'the local content hash is a different value and must not be confused with it')

  await h.runtime.handshake()
  assert.equal(h.requests[1].payload.plan_etag, 'e12')
  assert.equal(h.runtime.snapshot().plan_version, 12, 'not_modified must not reset the plan')
  // One plan delivery, therefore exactly one ack — not one per heartbeat.
  assert.equal(h.published.filter((x) => x.subject === 'yey.boat.plan_ack').length, 1)
})

test('the local etag is a content hash of the WHOLE plan as applied', async () => {
  /* JSON.stringify(obj, ['a','b']) uses the replacer ARRAY as a property
     allow-list at EVERY depth, so two plans with the same top-level scalars and
     completely different mappings would hash identically. */
  const a = harness({ replies: [{ kind: 'plan', plan: planV(7, [POSITION]), etag: 'e7' }] })
  a.runtime.setConsent(CONSENT)
  await a.runtime.handshake()

  const b = harness({ replies: [{ kind: 'plan', etag: 'e7', plan: planV(7, [
    { ...POSITION, min_interval_s: 120 }]) }] })
  b.runtime.setConsent(CONSENT)
  await b.runtime.handshake()

  assert.notEqual(a.runtime.snapshot().plan_local_etag,
    b.runtime.snapshot().plan_local_etag,
    'a nested change must change the etag')
  assert.match(a.runtime.snapshot().plan_local_etag, /^[0-9a-f]{32}$/)
})

test('a restarted connector asks for the plan again, it does not claim to have one', async () => {
  /* Only plan_etag/plan_version are persisted, never the plan body. Echoing the
     stored etag on the first hello after a restart would get not_modified back
     and leave the boat running nothing at all. */
  const first = harness({ replies: [{ kind: 'plan', plan: planV(4, [POSITION]), etag: 'e4' }] })
  first.runtime.setConsent(CONSENT)
  await first.runtime.handshake()
  assert.equal(first.runtime.snapshot().plan_etag, 'e4')

  // Same data directory, fresh process — and no setConsent(), because consent
  // is in the state file too and must survive the restart on its own.
  const restarted = harness({
    replies: [{ kind: 'plan', plan: planV(4, [POSITION]), etag: 'e4' }],
    dir: first.dir
  })
  await restarted.runtime.handshake()
  assert.equal(restarted.requests[0].payload.plan_etag, '',
    'the first hello after a restart must ask for the plan, not claim to have it')
  assert.equal(restarted.runtime.snapshot().active_mappings, 1)
  assert.equal(restarted.runtime.snapshot().consent_source, 'pairing',
    'consent must come back from the state file, not be re-derived from the plan')
})

test('a refused plan is not remembered as running, so the next hello re-asks', async () => {
  const h = harness({ replies: [
    { kind: 'plan', plan: { ...planV(9, [POSITION]), schema: 99 }, etag: 'e9' },
    { kind: 'plan', plan: planV(10, [POSITION]), etag: 'e10' }
  ] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  assert.equal(h.runtime.snapshot().plan_etag, '')
  await h.runtime.handshake()
  assert.equal(h.requests[1].payload.plan_etag, '',
    'echoing e9 would make the cloud answer not_modified for a plan we refused')
  assert.equal(h.runtime.snapshot().plan_version, 10)
})

test('the ack carries both the cloud etag and our own hash of what we applied', async () => {
  const h = harness({ replies: [{ kind: 'plan', plan: planV(3, [POSITION]), etag: 'e3' }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  const ack = h.published.find((x) => x.subject === 'yey.boat.plan_ack')
  assert.equal(ack.payload.etag, 'e3')
  assert.equal(ack.payload.local_etag, h.runtime.snapshot().plan_local_etag)
  assert.notEqual(ack.payload.local_etag, ack.payload.etag)
})

test('hello carries the server version and the vessel identity, not blanks', async () => {
  /* boat_pairing.project_hello keeps connector_version, plan_schema.{min,max},
     signalk.version and vessel.{name,mmsi} (boat_pairing.py:94-134) and the Y1
     confirm screen renders those. An empty signalk/vessel block is a blank boat
     on the screen the user is asked to approve. */
  const h = harness({ replies: [{ kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  const hello = h.requests[0].payload.hello
  assert.equal(hello.signalk.version, '2.7.1')
  assert.equal(hello.vessel.name, 'Sara')
  assert.equal(hello.vessel.mmsi, '238123456')
  assert.equal(hello.connector_version, '0.1.0')
})

test('hello advertises the buffer this boat really has, not the default', async () => {
  /* LIMITS.buffer_bytes is sold to the cloud as "a real number a plan can be
     checked against", and the cloud sizes backfill against the answer. A boat
     configured for 10 MB that reports 50 is lying about five times the outage
     it can absorb. */
  const h = harness({
    options: { bufferMegabytes: 10 },
    replies: [{ kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' }]
  })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  assert.equal(h.requests[0].payload.hello.limits.buffer_bytes, 10 * 1024 * 1024)
})

test('a boat whose SignalK read fails still says hello, with empty blocks', async () => {
  const h = harness({ replies: [{ kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' }] })
  h.runtime.__setSource({
    ...SOURCE_STUB,
    serverInfo: async () => { throw new Error('ECONNREFUSED') },
    vesselIdentity: async () => { throw new Error('ECONNREFUSED') }
  })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  const hello = h.requests[0].payload.hello
  assert.equal(hello.signalk.version, '')
  assert.deepEqual(hello.vessel, { name: '', mmsi: '' })
})

test('the handshake acks what it refused, by name', async () => {
  const h = harness({ replies: [{ kind: 'plan', etag: 'e1', plan: planV(3, [
    POSITION,
    { path: 'environment.wind.speedApparent', as: 'wind', policy: 'window', window_s: 60 }
  ]) }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  const ack = h.published.find((p) => p.subject === 'yey.boat.plan_ack')
  assert.ok(ack, 'no plan_ack was published')
  assert.equal(ack.payload.accepted, 1)
  assert.equal(ack.payload.rejected[0].reason, 'unsupported_policy')
  assert.equal(ack.payload.rejected[0].detail, 'window')
  assert.equal(ack.payload.version, 3)
})

test('a plan pushed later replaces cadence in place, with no reconnect', async () => {
  const slow = { ...POSITION, min_interval_s: 600 }
  const h = harness({ replies: [
    { kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' },
    { kind: 'plan', plan: planV(2, [slow]), etag: 'e2' }
  ] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()

  h.runtime.onSample({ path: 'navigation.position',
    value: { latitude: 45, longitude: 13 } })          // first -> buffered
  h.advance(20_000)
  h.runtime.onSample({ path: 'navigation.position',
    value: { latitude: 45.01, longitude: 13 } })       // 20s > 10s floor -> buffered
  assert.equal(h.runtime.snapshot().buffered, 2)

  await h.runtime.handshake()                           // cadence 10s -> 600s
  assert.equal(h.runtime.snapshot().plan_version, 2)
  h.advance(20_000)
  h.runtime.onSample({ path: 'navigation.position',
    value: { latitude: 45.02, longitude: 13 } })
  assert.equal(h.runtime.snapshot().buffered, 2, 'the new floor must apply immediately')
})

test('a surviving mapping keeps its emit state across a plan change', async () => {
  const h = harness({ replies: [
    { kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' },
    { kind: 'plan', plan: planV(2, [POSITION]), etag: 'e2' }
  ] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  h.runtime.onSample({ path: 'navigation.position', value: { latitude: 45, longitude: 13 } })
  await h.runtime.handshake()
  h.advance(1000)
  h.runtime.onSample({ path: 'navigation.position', value: { latitude: 45.0001, longitude: 13 } })
  assert.equal(h.runtime.snapshot().buffered, 1,
    'a plan change must not reset lastEmit and re-emit everything')
})

test('a sample for a path with no mapping is ignored', async () => {
  const h = harness({ replies: [{ kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  h.runtime.onSample({ path: 'electrical.batteries.house.voltage', value: 12.6 })
  assert.equal(h.runtime.snapshot().buffered, 0)
})

test('a sample outside consent is ignored even if the plan asked for it', async () => {
  const h = harness({ replies: [{ kind: 'plan', etag: 'e1', plan: planV(1, [
    POSITION, { path: 'propulsion.port.temperature', as: 'temp', policy: 'on_change' }
  ]) }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  h.runtime.onSample({ path: 'propulsion.port.temperature', value: 85 })
  assert.equal(h.runtime.snapshot().buffered, 0)
})

test('the deny list beats the plan, locally and permanently', async () => {
  const h = harness({
    options: { deny: ['navigation.position'] },
    replies: [{ kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' }]
  })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  h.runtime.onSample({ path: 'navigation.position', value: { latitude: 45, longitude: 13 } })
  assert.equal(h.runtime.snapshot().buffered, 0)
  const ack = h.published.find((p) => p.subject === 'yey.boat.plan_ack')
  assert.equal(ack.payload.rejected[0].reason, 'denied_locally')
})

test('round is applied before buffering, so the wire carries the small number', async () => {
  const h = harness({ replies: [{ kind: 'plan', etag: 'e1', plan: planV(1, [
    { path: 'environment.wind.speedApparent', as: 'wind', policy: 'on_change',
      min_interval_s: 0, max_interval_s: 300, round: 2 }
  ]) }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  h.runtime.onSample({ path: 'environment.wind.speedApparent', value: 7.123456 })
  await h.runtime.flush()
  const data = h.published.find((p) => p.subject === 'yey.boat.data')
  assert.equal(data.payload.values[0].v, 7.12)
  assert.equal(data.payload.values[0].n, 'wind', 'the wire carries `as`, not the SignalK path')
})

test('flush publishes buffered values and releases them only on an accepted ack', async () => {
  const h = harness({ replies: [{ kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  h.runtime.onSample({ path: 'navigation.position', value: { latitude: 45, longitude: 13 } })
  assert.equal(h.runtime.snapshot().buffered, 1)
  await h.runtime.flush()
  assert.equal(h.runtime.snapshot().buffered, 0)
  const data = h.published.find((p) => p.subject === 'yey.boat.data')
  assert.equal(data.payload.plan_version, 1)
})

test('a rejected ack leaves the buffer intact for the next attempt', async () => {
  const h = harness({ replies: [{ kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  h.runtime.onSample({ path: 'navigation.position', value: { latitude: 45, longitude: 13 } })
  h.runtime.__setPublish(async () => ({ status: 'rejected', accepted: [], rejected: [
    { index: null, error: 'bundle is disabled' }] }))
  await h.runtime.flush()
  assert.equal(h.runtime.snapshot().buffered, 1, 'nothing may be released on a rejection')
})

test('a backlog is drained on the backfill subject, in chunks the plan sizes', async () => {
  const h = harness({ replies: [{ kind: 'plan', etag: 'e1',
    plan: { ...planV(1, [{ ...POSITION, min_interval_s: 0 }]),
            transport: { backfill_chunk_msgs: 2, heartbeat_s: 300 } } }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  for (let i = 0; i < 5; i++) {
    h.advance(1000)
    h.runtime.onSample({ path: 'navigation.position',
      value: { latitude: 45 + i * 0.01, longitude: 13 } })
  }
  assert.equal(h.runtime.snapshot().buffered, 5)
  await h.runtime.flush()
  const backfills = h.published.filter((p) => p.subject === 'yey.boat.backfill')
  assert.ok(backfills.length >= 1, 'a backlog must go out as backfill, not as live data')
  assert.ok(backfills[0].payload.values.length <= 2)
})

test('discover publishes a catalog and reports the diff', async () => {
  const h = harness({ replies: [{ kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' }] })
  h.runtime.__setSource({
    ...SOURCE_STUB,
    selfTree: async () => ({ navigation: { position: { value: { latitude: 45, longitude: 13 } } } }),
    collectMeta: async () => ({ 'navigation.position': { units: 'deg',
      gear: { manufacturer: 'Rusty Boats', model: 'RB-SKYHOOK-3000' } } })
  })
  await h.runtime.discover()
  const cat = h.published.find((p) => p.subject === 'yey.boat.catalog')
  assert.equal(cat.payload.catalog.path_count, 1)
  assert.equal(cat.payload.catalog.instruments.device_count, 1)
  assert.deepEqual(cat.payload.diff.added, ['navigation.position'])
})

test('tick re-says hello once the heartbeat has elapsed, and not before', async () => {
  const h = harness({ replies: [
    { kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' },
    { kind: 'plan', plan: planV(1, [POSITION]), etag: 'e1' }  // -> not_modified
  ] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  h.advance(299_000)
  await h.runtime.tick()
  assert.equal(h.requests.length, 1, 'too early for a heartbeat')
  h.advance(2_000)
  await h.runtime.tick()
  assert.equal(h.requests.length, 2)
})

test('a handshake failure leaves the previous plan running', async () => {
  const boom = new Error('reply_timeout'); boom.code = 'reply_timeout'
  const h = harness({ replies: [
    { kind: 'plan', plan: planV(5, [POSITION]), etag: 'e5' }, boom ] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  await h.runtime.handshake().catch(() => {})
  assert.equal(h.runtime.snapshot().plan_version, 5,
    'a failed handshake must not blank the plan the boat is running')
})

test('an unsupported plan schema is refused and reported without stopping the boat', async () => {
  const h = harness({ replies: [
    { kind: 'plan', plan: { ...planV(9, [POSITION]), schema: 99 }, etag: 'e9' }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  const snap = h.runtime.snapshot()
  assert.equal(snap.active_mappings, 0)
  assert.match(snap.plan_problem, /unsupported_schema/)
  const ack = h.published.find((p) => p.subject === 'yey.boat.plan_ack')
  assert.equal(ack.payload.accepted, 0)
})

test('snapshot carries what the connected screen renders', async () => {
  const h = harness({ replies: [{ kind: 'plan', plan: planV(4, [POSITION]), etag: 'e4' }] })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  const s = h.runtime.snapshot()
  for (const key of ['state', 'boat_id', 'plan_version', 'plan_etag', 'plan_local_etag',
                     'active_mappings', 'rejected', 'buffered', 'buffer_bytes', 'budget',
                     'connected', 'consent_source', 'version', 'pairing_status',
                     'retry_attempt']) {
    assert.ok(key in s, `snapshot is missing ${key}`)
  }
})

test('a path that appears after discovery triggers re-discovery and a re-plan', async () => {
  const h = harness({ replies: [
    { kind: 'plan', plan: planV(1, []), etag: 'e0' },
    { kind: 'plan', plan: planV(2, [POSITION]), etag: 'e1' }
  ] })
  let tree = { design: { length: { value: { overall: 11.6 } } } }
  h.runtime.__setSource({ ...SOURCE_STUB, selfTree: async () => tree, collectMeta: async () => ({}) })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  await h.runtime.discover()
  assert.equal(h.requests.length, 1)

  // The instruments come up: position appears in SignalK.
  tree = { ...tree, navigation: { position: { value: { latitude: -17.5, longitude: -149.6 } } } }
  h.runtime.onSample({ path: 'navigation.position', value: { latitude: -17.5, longitude: -149.6 },
                       timestamp: '2026-11-07T20:00:00Z' })
  await h.runtime.tick()
  assert.equal(h.requests.length, 1, 'rate-limited: not within a minute of the last discovery')

  h.advance(61_000)
  await h.runtime.tick()
  const catalogs = h.published.filter((p) => p.subject === 'yey.boat.catalog')
  assert.equal(catalogs.length, 2)
  assert.deepEqual(catalogs[1].payload.diff.added, ['navigation.position'])
  assert.equal(h.requests.length, 2, 'new paths -> hello again so the cloud re-plans')

  // Known paths do not keep re-discovering.
  h.runtime.onSample({ path: 'navigation.position', value: { latitude: -17.5, longitude: -149.6 },
                       timestamp: '2026-11-07T20:00:10Z' })
  h.advance(61_000)
  await h.runtime.tick()
  assert.equal(h.published.filter((p) => p.subject === 'yey.boat.catalog').length, 2)
})

test('with an empty plan (gathering off) the tree is still checked for new paths', async () => {
  const h = harness({ replies: [
    { kind: 'plan', plan: planV(1, []), etag: 'e0' },
    { kind: 'plan', plan: planV(2, [POSITION]), etag: 'e1' }
  ] })
  let tree = { design: { length: { value: { overall: 11.6 } } } }
  h.runtime.__setSource({ ...SOURCE_STUB, selfTree: async () => tree, collectMeta: async () => ({}) })
  h.runtime.setConsent(CONSENT)
  await h.runtime.handshake()
  await h.runtime.discover()
  tree = { ...tree, navigation: { position: { value: { latitude: -17.5, longitude: -149.6 } } } }
  h.advance(60_000)
  await h.runtime.tick()
  assert.equal(h.requests.length, 1, 'too early for a tree check')
  h.advance(61_000)
  await h.runtime.tick()
  assert.equal(h.published.filter((p) => p.subject === 'yey.boat.catalog').length, 2)
  assert.equal(h.requests.length, 2, 'new paths -> re-plan')
})
