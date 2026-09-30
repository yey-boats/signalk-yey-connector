'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { createRuntime } = require('../lib/runtime')
const { DEFAULT_TRANSPORT } = require('../lib/plan')

const CONSENT = ['navigation.position']
const POSITION = { path: 'navigation.position', as: 'position', policy: 'on_change',
                   min_interval_s: 0, max_interval_s: 600, priority: 'high' }

function planV (version, transport = {}) {
  return {
    schema: 1, plan_id: 'pl_1', version,
    budget: { max_msgs_per_min: 1000, max_bytes_per_hour: 10 ** 9 },
    defaults: { policy: 'on_change', min_interval_s: 0, max_interval_s: 300 },
    transport: { ...DEFAULT_TRANSPORT, ...transport },
    mappings: [POSITION]
  }
}

/** A deterministic clock + timer queue. Nothing here touches real time. */
function fakeTimers () {
  let now = 1_000_000
  let seq = 0
  const queue = new Map()          // handle -> {at, fn}
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const h = ++seq; queue.set(h, { at: now + ms, fn }); return h },
    clearTimeout: (h) => { queue.delete(h) },
    pending: () => [...queue.values()].map((e) => e.at - now),
    /** Advance to the next due timer and run it. Returns its delay, or null. */
    async fire () {
      const due = [...queue.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) return null
      const [handle, entry] = due
      const waited = entry.at - now
      now = entry.at
      queue.delete(handle)
      await entry.fn()
      await new Promise((r) => setImmediate(r))   // let the async body settle
      return waited
    },
    advance: (ms) => { now += ms }
  }
}

/**
 * A runtime wired to a scriptable cloud and a scriptable SignalK source.
 * `script` is consumed one entry per connect attempt: an Error means "this
 * connect fails", anything else is the plan the hello answers with.
 */
function harness ({ script = [], options = {}, plan = planV(1), plans = [],
                   consent = CONSENT } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-sup-'))
  const timers = fakeTimers()
  const events = []
  let connects = 0
  let sourceClose = null
  let subscriptions = 0
  let sampleSink = null

  let lostFn = null
  const uplink = {
    connect: async () => {
      connects += 1
      events.push('connect')
      const next = script.shift()
      if (next instanceof Error) throw next
    },
    setOnLost: (fn) => { lostFn = fn },
    close: () => { events.push('uplink.close') },
    state: () => ({ connected: true }),
    publish: async (subject) => {
      events.push(`publish:${subject}`)
      return { status: 'accepted', accepted: [], rejected: [] }
    },
    request: async (subject) => {
      events.push(`request:${subject}`)
      // `plans` scripts successive hellos; the last one keeps answering.
      if (plans.length) plan = plans.length > 1 ? plans.shift() : plans[0]
      return { kind: 'plan', plan, etag: `e${plan.version}` }
    }
  }

  const source = {
    subscribe: (onSample, onClose) => {
      subscriptions += 1
      sampleSink = onSample
      sourceClose = onClose
      events.push('subscribe')
      // A closed subscription delivers nothing: without this the fake would
      // keep feeding samples to a runtime that had stopped listening.
      return { close: () => { events.push('unsubscribe'); sourceClose = null; sampleSink = null } }
    },
    selfTree: async () => ({ navigation: { position: { value: { latitude: 45, longitude: 13 } } } }),
    collectMeta: async () => ({}),
    serverInfo: async () => ({ version: '2.7.1', plugins: [] }),
    vesselIdentity: async () => ({ name: 'Sara', mmsi: '238123456' })
  }

  const runtime = createRuntime({
    app: { debug: () => {}, getDataDirPath: () => dir },
    version: '0.1.0',
    options: { enabled: true, boatId: 'b_1', boatCredential: 'bk_1', ...options },
    deps: {
      createUplink: () => uplink,
      source,
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      random: () => 0.5          // no jitter, so delays are exact
    }
  })
  // Pairing normally supplies this; without it applyPlan refuses every mapping
  // as outside_consent and the sample tests below would pass for the wrong reason.
  runtime.setConsent(consent)

  return {
    runtime, timers, events, dir,
    connects: () => connects,
    subscriptions: () => subscriptions,
    sample: (s) => sampleSink && sampleSink(s),
    killSource: (why) => {
      const fn = sourceClose
      sourceClose = null
      sampleSink = null
      if (fn) fn(why)
    },
    /** What lib/uplink.js does on a socket 'disconnect' or 'connect_error'. */
    killSocket: (why) => lostFn && lostFn(why)
  }
}

test('start dials the cloud: connect, hello, subscribe, discover', async () => {
  const h = harness()
  await h.runtime.start()
  assert.deepEqual(h.events.filter((e) => e !== 'publish:yey.boat.plan_ack'), [
    'connect', 'request:yey.boat.hello', 'subscribe', 'publish:yey.boat.catalog'
  ])
  assert.equal(h.runtime.snapshot().state, 'running')
  assert.equal(h.runtime.snapshot().plan_version, 1)
  h.runtime.stop()
})

test('start on an unpaired plugin never dials, and says why', async () => {
  const h = harness({ options: { boatId: '', boatCredential: '' } })
  await h.runtime.start()
  assert.equal(h.connects(), 0)
  assert.equal(h.runtime.snapshot().state, 'unpaired')
  assert.equal(h.timers.pending().length, 0, 'an unpaired plugin must not hold a timer')
})

test('start with sending switched off never dials', async () => {
  const h = harness({ options: { enabled: false } })
  await h.runtime.start()
  assert.equal(h.connects(), 0)
  assert.equal(h.runtime.snapshot().state, 'disabled')
  assert.equal(h.timers.pending().length, 0)
})

test('a socket drop rejoins the retry curve without waiting for a publish to fail', async () => {
  /* The bug: lib/uplink.js recorded 'disconnect' and told nobody, so recovery
     began only when the next publish rejected with not_connected — and flush()
     returns early on an empty buffer, so an idle boat waited a whole
     heartbeat_s. Now the socket reports, and it lands on the SAME curve as a
     failed connect: backoff_base_s 2 at attempt 1, random 0.5 so no jitter. */
  const h = harness()
  await h.runtime.start()
  assert.equal(h.runtime.snapshot().state, 'running')
  h.killSocket('disconnect: transport close')
  assert.equal(h.runtime.snapshot().state, 'reconnecting')
  assert.deepEqual(h.timers.pending(), [2000], 'one curve, one timer')
  assert.match(h.runtime.snapshot().detail, /transport close/)
  h.runtime.stop()
})

test('a socket drop after stop() is ignored', async () => {
  // stop() closes the socket, which fires 'disconnect'. Re-arming a reconnect
  // there would make stop() mean nothing.
  const h = harness()
  await h.runtime.start()
  h.runtime.stop()
  h.killSocket('disconnect: io client disconnect')
  assert.equal(h.runtime.snapshot().state, 'stopped')
  assert.deepEqual(h.timers.pending(), [])
})

test('a tick timer is scheduled at the plan backfill interval and re-arms itself', async () => {
  const h = harness({ plan: planV(1, { backfill_chunk_interval_s: 7 }) })
  await h.runtime.start()
  assert.deepEqual(h.timers.pending(), [7000])
  assert.equal(await h.timers.fire(), 7000)
  assert.deepEqual(h.timers.pending(), [7000], 'the tick must re-arm, not fire once')
  h.runtime.stop()
})

test('quiet mode stretches the tick interval without a release', async () => {
  const h = harness({ plan: planV(1, {
    backfill_chunk_interval_s: 5, quiet_mode: true, quiet_interval_multiplier: 6 }) })
  await h.runtime.start()
  assert.deepEqual(h.timers.pending(), [30000])
  h.runtime.stop()
})

test('the heartbeat really goes out: enough ticks re-say hello', async () => {
  const h = harness({ plan: planV(1, {
    heartbeat_s: 30, backfill_chunk_interval_s: 10 }) })
  await h.runtime.start()
  const helloCount = () => h.events.filter((e) => e === 'request:yey.boat.hello').length
  assert.equal(helloCount(), 1)
  await h.timers.fire()              // t+10s — too early
  await h.timers.fire()              // t+20s — too early
  assert.equal(helloCount(), 1)
  await h.timers.fire()              // t+30s — heartbeat due
  assert.equal(helloCount(), 2, 'nothing schedules the heartbeat without the tick timer')
  h.runtime.stop()
})

test('buffered samples leave on the tick, with nobody calling flush by hand', async () => {
  const h = harness({ plan: planV(1, { backfill_chunk_interval_s: 5 }) })
  await h.runtime.start()
  h.sample({ path: 'navigation.position', value: { latitude: 45, longitude: 13 } })
  assert.equal(h.runtime.snapshot().buffered, 1)
  await h.timers.fire()
  assert.equal(h.runtime.snapshot().buffered, 0)
  assert.ok(h.events.includes('publish:yey.boat.data'))
  h.runtime.stop()
})

test('a failed connect retries on the plan backoff curve, not immediately', async () => {
  const boom = new Error('invalid_credential'); boom.code = 'invalid_credential'
  const h = harness({
    script: [boom, boom],
    plan: planV(1, { backoff_base_s: 2, backoff_ceiling_s: 300, reconnect_jitter_pct: 0 })
  })
  await h.runtime.start()
  assert.equal(h.connects(), 1)
  assert.match(h.runtime.snapshot().state, /reconnecting/)
  assert.equal(h.runtime.snapshot().retry_attempt, 1)
  // DEFAULT_TRANSPORT until a plan lands: base 2s -> 2s, then 4s.
  assert.deepEqual(h.timers.pending(), [2000])
  assert.equal(await h.timers.fire(), 2000)
  assert.equal(h.connects(), 2)
  assert.deepEqual(h.timers.pending(), [4000])
  assert.equal(await h.timers.fire(), 4000)
  assert.equal(h.connects(), 3, 'the third attempt is the one that succeeds')
  assert.equal(h.runtime.snapshot().state, 'running')
  assert.equal(h.runtime.snapshot().retry_attempt, 0, 'a success resets the curve')
  h.runtime.stop()
})

test('the backoff curve comes from the plan once a plan has landed', async () => {
  const h = harness({
    plan: planV(1, { backoff_base_s: 30, backoff_ceiling_s: 300, reconnect_jitter_pct: 0 })
  })
  await h.runtime.start()                       // plan lands, transport adopted
  h.killSource('ECONNRESET')                    // now break something
  assert.deepEqual(h.timers.pending(), [30000],
    'after a plan, the plan owns the curve — 30s, not the 2s default')
  h.runtime.stop()
})

test('a dead SignalK socket is retried through the same one loop', async () => {
  const h = harness()
  await h.runtime.start()
  assert.equal(h.subscriptions(), 1)
  h.killSource('ECONNRESET')
  assert.match(h.runtime.snapshot().detail, /signalk/)
  await h.timers.fire()
  assert.equal(h.subscriptions(), 2, 'the delta stream must be re-opened')
  assert.equal(h.runtime.snapshot().state, 'running')
  h.runtime.stop()
})

test('a throwing tick does not kill the loop, it reconnects', async () => {
  const h = harness()
  await h.runtime.start()
  h.runtime.__setPublish(async () => { const e = new Error('not_connected'); e.code = 'not_connected'; throw e })
  h.sample({ path: 'navigation.position', value: { latitude: 45, longitude: 13 } })
  await h.timers.fire()                          // the tick throws
  assert.match(h.runtime.snapshot().state, /reconnecting/)
  assert.deepEqual(h.timers.pending().length, 1, 'a retry must be armed')
  h.runtime.stop()
})

test('a reconnect never discards the buffer', async () => {
  const h = harness()
  await h.runtime.start()
  h.sample({ path: 'navigation.position', value: { latitude: 45, longitude: 13 } })
  h.killSource('ECONNRESET')
  assert.equal(h.runtime.snapshot().buffered, 1,
    'a reconnect must never discard what is waiting to go out')
  h.runtime.stop()
})

test('stop cancels every timer and unsubscribes', async () => {
  const h = harness()
  await h.runtime.start()
  h.runtime.stop()
  assert.deepEqual(h.timers.pending(), [])
  assert.ok(h.events.includes('unsubscribe'))
  assert.ok(h.events.includes('uplink.close'))
  assert.equal(h.runtime.snapshot().state, 'stopped')
})

test('stop during a backoff wait cancels the pending retry', async () => {
  const boom = new Error('invalid_credential'); boom.code = 'invalid_credential'
  const h = harness({ script: [boom] })
  await h.runtime.start()
  assert.equal(h.timers.pending().length, 1)
  h.runtime.stop()
  assert.deepEqual(h.timers.pending(), [])
  assert.equal(await h.timers.fire(), null)
  assert.equal(h.connects(), 1, 'a stopped plugin must not dial again')
})

test('start is idempotent — SignalK calling it twice must not double the loop', async () => {
  const h = harness()
  await h.runtime.start()
  await h.runtime.start()
  assert.equal(h.connects(), 1)
  assert.equal(h.timers.pending().length, 1)
  h.runtime.stop()
})

test('a restart after stop dials again rather than staying dead', async () => {
  // stop() clears `running`; if start() did not reset it the plugin would be
  // unrecoverable after a settings save, which is exactly when SignalK does this.
  const h = harness()
  await h.runtime.start()
  h.runtime.stop()
  await h.runtime.start()
  assert.equal(h.connects(), 2)
  assert.equal(h.runtime.snapshot().state, 'running')
  h.runtime.stop()
})

test('non-test code actually calls the loop', () => {
  const src = fs.readFileSync(require.resolve('../lib/runtime'), 'utf8')
  for (const call of ['uplink.connect()', 'await handshake()', 'await tick()',
                      'backoffDelayMs(', 'source.subscribe(onSample',
                      'uplink.setOnLost(onLinkLost)']) {
    assert.ok(src.includes(call), `lib/runtime.js never calls ${call}`)
  }
})

// ── Gathering through an outage ─────────────────────────────────────────────
// Spec "Offline buffer and backfill": the buffer "is what makes 'you were out
// of signal, here's your track' possible at all", and the Y2 plan's goal is a
// connector that "buffers-and-replays [values] across an outage". A transient
// loss of the CLOUD link therefore must not stop the SignalK subscription:
// samples keep flowing through the plan's policies and budget into the buffer,
// and the reconnect backfills them. What does stop gathering: stop/unpair, a
// credential the cloud refuses (revoked), a plan with nothing in it, and
// consent withdrawn locally.

const POS = (lat = 45) => ({ path: 'navigation.position', value: { latitude: lat, longitude: 13 } })
const unsubscribes = (h) => h.events.filter((e) => e === 'unsubscribe').length
const unreachable = () => { const e = new Error('fetch failed'); e.code = 'network_error'; return e }

test('a dropped cloud link keeps the SignalK subscription and keeps buffering', async () => {
  const h = harness()
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  assert.equal(unsubscribes(h), 0, 'a cloud outage must not close the SignalK stream')
  h.sample(POS(45)); h.timers.advance(1000); h.sample(POS(46))
  assert.equal(h.runtime.snapshot().buffered, 2)
  assert.equal(h.runtime.snapshot().gathering, true)
  h.runtime.stop()
})

test('a long outage keeps gathering across every failed retry, and the reconnect backfills it', async () => {
  const h = harness({ script: [undefined, unreachable(), unreachable(), unreachable()] })
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  for (let i = 0; i < 3; i += 1) {
    h.sample(POS(45 + i))
    await h.timers.fire()                    // a retry that fails
    assert.match(h.runtime.snapshot().state, /reconnecting/)
  }
  assert.equal(h.runtime.snapshot().buffered, 3, 'every sample of the outage is kept')
  await h.timers.fire()                      // the retry that succeeds
  assert.equal(h.runtime.snapshot().state, 'running')
  await h.timers.fire()                      // first tick after reconnect
  assert.equal(h.runtime.snapshot().buffered, 0)
  assert.ok(h.events.some((e) => e.startsWith('publish:yey.boat.')) &&
            h.events.includes('publish:yey.boat.data'))
  h.runtime.stop()
})

test('a reconnect does not open a second subscription', async () => {
  const h = harness()
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  await h.timers.fire()
  assert.equal(h.runtime.snapshot().state, 'running')
  assert.equal(h.subscriptions(), 1)
  assert.equal(unsubscribes(h), 0)
  h.runtime.stop()
})

test('a plugin that was never paired gathers nothing', async () => {
  const h = harness({ options: { boatId: '', boatCredential: '' } })
  await h.runtime.start()
  assert.equal(h.subscriptions(), 0)
  assert.equal(h.runtime.snapshot().gathering, false)
})

test('a boat that has never received a plan gathers nothing while it cannot connect', async () => {
  // No plan means no mapping, no policy and no budget to gather under. The plan
  // body is not persisted, so this is also the state after a restart offline.
  const h = harness({ script: [unreachable(), unreachable()] })
  await h.runtime.start()
  await h.timers.fire()
  assert.equal(h.subscriptions(), 0)
  assert.equal(h.runtime.snapshot().gathering, false)
  h.runtime.stop()
})

test('a revoked credential stops gathering, though the retry curve continues', async () => {
  const revoked = new Error('invalid_credential'); revoked.code = 'invalid_credential'
  const h = harness({ script: [undefined, revoked] })
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  h.sample(POS(45))
  await h.timers.fire()                      // the cloud refuses the credential
  assert.equal(unsubscribes(h), 1, 'a revoked boat must stop reading the boat')
  assert.equal(h.runtime.snapshot().gathering, false)
  h.sample(POS(46))
  assert.equal(h.runtime.snapshot().buffered, 1, 'nothing after the refusal is gathered')
  assert.equal(h.timers.pending().length, 1, 'the retry curve still runs')
  h.runtime.stop()
})

test('a plan withdrawn to no mappings stops gathering', async () => {
  const empty = { ...planV(2), mappings: [] }
  const h = harness({ plans: [planV(1), empty] })
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  await h.timers.fire()                      // reconnect: the cloud now plans nothing
  assert.equal(h.runtime.snapshot().active_mappings, 0)
  assert.equal(unsubscribes(h), 1)
  assert.equal(h.runtime.snapshot().gathering, false)
  h.runtime.stop()
})

test('a plan refused whole stops gathering', async () => {
  const future = { ...planV(2), schema: 99 }
  const h = harness({ plans: [planV(1), future] })
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  await h.timers.fire()
  assert.equal(h.runtime.snapshot().gathering, false)
  h.runtime.stop()
})

test('consent withdrawn while offline stops gathering what it no longer covers', async () => {
  const h = harness()
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  h.sample(POS(45))
  h.runtime.setConsent([])
  assert.equal(h.runtime.snapshot().active_mappings, 0)
  assert.equal(h.runtime.snapshot().gathering, false)
  h.sample(POS(46))
  assert.equal(h.runtime.snapshot().buffered, 1)
  h.runtime.stop()
})

test('a changed plan on reconnect applies to the same subscription', async () => {
  const SOG = { path: 'navigation.speedOverGround', as: 'sog', policy: 'periodic',
                min_interval_s: 0, max_interval_s: 600, priority: 'normal' }
  const v2 = { ...planV(2), mappings: [SOG] }
  const h = harness({ plans: [planV(1), v2],
                      consent: ['navigation.position', 'navigation.speedOverGround'] })
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  await h.timers.fire()
  assert.equal(h.runtime.snapshot().plan_version, 2)
  assert.equal(h.subscriptions(), 1, 'one stream, whatever the plan')
  h.sample(POS(45))
  h.sample({ path: 'navigation.speedOverGround', value: 2.5 })
  const snap = h.runtime.snapshot()
  assert.equal(snap.buffered, 1, 'only the new plan\'s path is gathered')
  h.runtime.stop()
})

test('a SignalK stream that dies during the outage is reopened on the next retry, once', async () => {
  const h = harness({ script: [undefined, unreachable(), unreachable()] })
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  h.killSource('ECONNRESET')
  assert.equal(h.runtime.snapshot().gathering, false)
  await h.timers.fire()                      // retry fails, but the stream is back
  assert.equal(h.subscriptions(), 2)
  assert.equal(h.runtime.snapshot().gathering, true)
  h.sample(POS(45))
  assert.equal(h.runtime.snapshot().buffered, 1)
  await h.timers.fire()                      // another failed retry: no third stream
  assert.equal(h.subscriptions(), 2)
  h.runtime.stop()
})

test('the buffer caps bound a long outage', async () => {
  const h = harness({ options: { bufferMegabytes: 1 } })
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  const pad = 'x'.repeat(4000)
  for (let i = 0; i < 400; i += 1) {
    h.timers.advance(1000)
    h.sample({ path: 'navigation.position', value: { latitude: 45 + i / 1000, longitude: 13, pad } })
  }
  const snap = h.runtime.snapshot()
  assert.ok(snap.buffer_bytes <= 1024 * 1024, `buffer grew to ${snap.buffer_bytes} bytes`)
  assert.ok(snap.buffer_dropped > 0, 'the byte cap never bound')
  // And the age cap: a day later, what was gathered before it is gone.
  h.timers.advance(25 * 3600 * 1000)
  h.sample(POS(50))
  assert.equal(h.runtime.snapshot().buffered, 1)
  h.runtime.stop()
})

test('stop ends gathering even mid-outage', async () => {
  const h = harness()
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  h.runtime.stop()
  assert.equal(unsubscribes(h), 1)
  assert.equal(h.runtime.snapshot().gathering, false)
})

test('unpair ends gathering even mid-outage', async () => {
  const h = harness()
  await h.runtime.start()
  h.killSocket('disconnect: transport close')
  await h.runtime.unpair()
  assert.equal(unsubscribes(h), 1)
  h.sample(POS(46))
  assert.equal(h.runtime.snapshot().buffered, 0)
})
