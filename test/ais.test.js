'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { createRuntime } = require('../lib/runtime')
const { DEFAULT_TRANSPORT } = require('../lib/plan')
const { createAisCollector, mmsiOf, aisMapping, AIS_PATH } = require('../lib/ais')
const { samplesOf } = require('../lib/signalk-source')

const POSITION = { path: 'navigation.position', as: 'position', policy: 'on_change',
                   min_interval_s: 0, max_interval_s: 600, priority: 'high' }
const AIS = { path: 'ais', as: 'ais', policy: 'periodic', min_interval_s: 30,
              max_interval_s: 300, priority: 'low' }
const OTHER = 'vessels.urn:mrn:imo:mmsi:538000111'
const SELF = 'vessels.urn:mrn:imo:mmsi:238123456'

function planV (version, mappings) {
  return {
    schema: 1, plan_id: 'pl_1', version,
    budget: { max_msgs_per_min: 1000, max_bytes_per_hour: 10 ** 9 },
    defaults: { policy: 'on_change', min_interval_s: 0, max_interval_s: 300 },
    transport: { ...DEFAULT_TRANSPORT },
    mappings
  }
}

function sample (context, p, value) {
  return { context, path: p, value, timestamp: '2026-11-07T10:00:00Z' }
}

// ── the collector ────────────────────────────────────────────────────────────

test('mmsiOf reads the MMSI off a vessel context, and nothing else', () => {
  assert.equal(mmsiOf(OTHER), '538000111')
  assert.equal(mmsiOf('vessels.urn:mrn:signalk:uuid:abc'), '')
  assert.equal(mmsiOf(''), '')
})

test('the collector leaves the boat itself out and keeps only tracked paths', () => {
  const c = createAisCollector({ isSelf: (ctx) => ctx === SELF })
  c.onSample(sample(SELF, 'navigation.position', { latitude: 1, longitude: 2 }), 0)
  c.onSample(sample('vessels.self', 'navigation.position', { latitude: 1, longitude: 2 }), 0)
  c.onSample(sample(OTHER, 'electrical.batteries.house.voltage', 12.6), 0)
  assert.equal(c.size(), 0, 'an untracked path does not start a target')
  c.onSample(sample(OTHER, 'name', 'TAPORO'), 0)
  assert.equal(c.size(), 1, 'only the other vessel is tracked')
  assert.deepEqual(c.drain(60_000, AIS), [], 'no position yet: nothing to draw, nothing sent')
})

test('a target is sent when due, with its full state, then not again until it changes', () => {
  const c = createAisCollector()
  c.onSample(sample(OTHER, 'navigation.position', { latitude: -17.5, longitude: -149.6 }), 0)
  c.onSample(sample(OTHER, 'name', 'TAPORO'), 0)
  const first = c.drain(30_000, AIS)
  assert.deepEqual(first, [{ mmsi: '538000111', values: {
    'navigation.position': { latitude: -17.5, longitude: -149.6 }, name: 'TAPORO' } }])
  assert.deepEqual(c.drain(31_000, AIS), [], 'unchanged and not yet max_interval: quiet')
  c.onSample(sample(OTHER, 'navigation.speedOverGround', 5), 40_000)
  assert.deepEqual(c.drain(45_000, AIS), [], 'changed, but within min_interval_s')
  assert.equal(c.drain(61_000, AIS).length, 1)
})

test('the delta flattener carries the vessel context to the collector', () => {
  const got = []
  samplesOf({ context: OTHER, updates: [{ timestamp: 't', values: [
    { path: 'name', value: 'TAPORO' }] }] }, (s) => got.push(s))
  assert.equal(got[0].context, OTHER)
})

test('aisMapping finds the consented item in an applied plan', () => {
  assert.equal(aisMapping({ mappings: [POSITION, AIS] }).path, AIS_PATH)
  assert.equal(aisMapping({ mappings: [POSITION] }), null)
  assert.equal(aisMapping(null), null)
})

// ── the runtime ──────────────────────────────────────────────────────────────

function harness ({ plan, consent, deny = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-ais-'))
  let clock = 1_000_000
  const published = []
  let vesselSink = null
  let vesselSubs = 0
  const uplink = {
    connect: async () => {},
    setOnLost: () => {},
    close: () => {},
    state: () => ({ connected: true }),
    publish: async (subject, payload) => {
      published.push({ subject, payload })
      return { status: 'accepted', accepted: [], rejected: [] }
    },
    request: async () => ({ kind: 'plan', plan, etag: `e${plan.version}` })
  }
  const source = {
    subscribe: () => ({ close: () => {} }),
    subscribeVessels: (onSample) => {
      vesselSubs += 1
      vesselSink = onSample
      return { close: () => { vesselSink = null } }
    },
    selfContext: () => SELF,
    selfTree: async () => ({}),
    collectMeta: async () => ({}),
    serverInfo: async () => ({ version: '2.7.1', plugins: [] }),
    vesselIdentity: async () => ({ name: 'Moana', mmsi: '238123456' })
  }
  const runtime = createRuntime({
    app: { debug: () => {}, getDataDirPath: () => dir },
    version: '0.1.0',
    options: { enabled: true, boatId: 'b_1', boatCredential: 'bk_1',
               advanced: { deny } },
    deps: {
      createUplink: () => uplink,
      source,
      now: () => clock,
      setTimeout: () => 1,
      clearTimeout: () => {},
      random: () => 0.5
    }
  })
  runtime.setConsent(consent)
  return { runtime, published, feed: (s) => vesselSink && vesselSink(s),
           vesselSubs: () => vesselSubs, advance: (ms) => { clock += ms } }
}

test('with the consented `ais` item the boat relays other vessels as p:"ais" records', async () => {
  const h = harness({ plan: planV(1, [POSITION, AIS]),
                      consent: ['navigation.position', 'ais'] })
  await h.runtime.start()
  assert.equal(h.vesselSubs(), 1, 'the vessels.* stream is open')
  h.feed(sample(OTHER, 'navigation.position', { latitude: -17.5, longitude: -149.6 }))
  h.feed(sample(SELF, 'navigation.position', { latitude: -17.6, longitude: -149.7 }))
  h.advance(31_000)
  await h.runtime.tick()
  const values = h.published.filter((p) => p.subject === 'yey.boat.data')
    .flatMap((p) => p.payload.values)
  const ais = values.filter((v) => v.p === 'ais')
  assert.equal(ais.length, 1, 'one target, and never the boat itself')
  assert.equal(ais[0].v.mmsi, '538000111')
  assert.deepEqual(ais[0].v.values['navigation.position'], { latitude: -17.5, longitude: -149.6 })
  assert.equal(h.runtime.snapshot().ais.relaying, true)
  h.runtime.stop()
})

test('the local deny list wins: `ais` denied means no vessels stream at all', async () => {
  const h = harness({ plan: planV(1, [POSITION, AIS]),
                      consent: ['navigation.position', 'ais'], deny: ['ais'] })
  await h.runtime.start()
  assert.equal(h.vesselSubs(), 0)
  assert.equal(h.runtime.snapshot().ais.relaying, false)
  const ack = h.published.find((p) => p.subject === 'yey.boat.plan_ack')
  assert.ok(ack.payload.rejected.some((r) => r.path === 'ais' && r.reason === 'denied_locally'))
  h.runtime.stop()
})

test('without consent for `ais` the plan item is refused and nothing is relayed', async () => {
  const h = harness({ plan: planV(1, [POSITION, AIS]), consent: ['navigation.position'] })
  await h.runtime.start()
  assert.equal(h.vesselSubs(), 0)
  const ack = h.published.find((p) => p.subject === 'yey.boat.plan_ack')
  assert.ok(ack.payload.rejected.some((r) => r.path === 'ais' && r.reason === 'outside_consent'))
  h.runtime.stop()
})

test('the in-process source subscribes vessels.* for the relayed paths only', () => {
  const { createAppSource } = require('../lib/signalk-source')
  const subs = []
  const app = {
    selfContext: SELF,
    signalk: { self: {} },
    subscriptionmanager: {
      subscribe: (command, unsubscribes, onError, onDelta) => {
        subs.push({ command, onDelta })
        unsubscribes.push(() => subs.pop())
      }
    }
  }
  const src = createAppSource({ app })
  const got = []
  const sub = src.subscribeVessels((s) => got.push(s))
  assert.equal(subs[0].command.context, 'vessels.*')
  assert.deepEqual(subs[0].command.subscribe.map((x) => x.path).sort(),
    ['design.aisShipType', 'name', 'navigation.courseOverGroundTrue',
     'navigation.position', 'navigation.speedOverGround'])
  subs[0].onDelta({ context: OTHER, updates: [{ timestamp: 't', values: [
    { path: 'name', value: 'TAPORO' }] }] })
  assert.equal(got[0].context, OTHER)
  assert.equal(src.selfContext(), SELF)
  sub.close()
  assert.equal(subs.length, 0)
})
