'use strict'
/** The three sweeps that can be run without an environment.
 *
 *  What a laptop CANNOT answer is p99 agent-turn latency, CPU credits, and what
 *  a deploy does to a real fleet. Those are the operator's, in
 *  docs/capacity-operator-runbook.md, and nothing here pretends otherwise.
 *
 *  What it CAN answer is the component the fleet contributes to a turn: how
 *  long an interactive Data Bus message waits behind boat traffic on the ONE
 *  stream per bundle (data_bus_stream_key has no subject in it) drained by the
 *  ONE serial consumer (worker.py: count=1, _process_claim awaited inline).
 *
 *  knee_local = the largest N at which the p99 interactive queue wait stays
 *  under interactiveBudgetMs AND no undelivered entry is evicted. It is a lower
 *  bound on the real knee's CAUSE and an upper bound on the fleet size that is
 *  safe; the real p99 comes from the operator's staging run.
 */
const { createFleet } = require('./fleet')

/** Nearest-rank percentile. */
function percentile (values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

/** A Mini App turn every `everyMs`, on the Mini App's own subject
 *  (`signalk.databus`), on the same stream, behind the same serial consumer.
 *
 *  Its wait is known the moment it is enqueued: the consumer is strictly FIFO,
 *  so it is (entries ahead of it not yet handled + itself) x serviceMs. It is
 *  recorded THEN — waiting for it to complete before counting it would drop
 *  exactly the longest waits at the end of a run, which are the ones that
 *  matter at saturation. */
function interactiveProbe (sink, { everyMs = 1000, serviceMs }) {
  const waits = []
  const up = sink.uplinkFor({ boatId: 'miniapp' })
  let owedMs = 0
  return {
    tick (nowMs, stepMs) {
      owedMs += stepMs
      while (owedMs >= everyMs) {
        owedMs -= everyMs
        const ahead = sink.stats().undelivered
        up.publish('signalk.databus', { t: nowMs })
        waits.push((ahead + 1) * serviceMs)
      }
    },
    count: () => waits.length,
    waits: () => waits.slice(),
    p50: () => percentile(waits, 50),
    p99: () => percentile(waits, 99),
    max: () => (waits.length ? Math.max(...waits) : 0)
  }
}

const round3 = (x) => +Number(x).toFixed(3)

/** Where the rig's input came from, so a number can be traced to its trace. */
function traceInfo (trace) {
  const deltas = (trace && trace.deltas) || []
  return {
    provenance: (trace && trace.provenance) || 'capture',
    capturedAt: (trace && trace.capturedAt) || null,
    seconds: (trace && trace.seconds) || null,
    deltas: deltas.length,
    paths: new Set(deltas.map((d) => d.path)).size
  }
}

function planInfo (plan) {
  return {
    mappings: ((plan && plan.mappings) || []).length,
    budget: (plan && plan.budget) || null,
    transport: (plan && plan.transport) || null
  }
}

// lib/budget.js: the byte budget is per hour, opened at the boat's first admit.
const STEADY_SPREAD_MS = 3_600_000

const stamp = (generatedAt) => generatedAt || new Date().toISOString()

async function steadyState ({ ns = [10, 25, 50, 100, 200, 400], minutes = 30,
                             trace, plan, seed = 1, serviceMs = 20,
                             maxlen = 50000, interactiveBudgetMs = 2000,
                             drainStepMs = 1000, startSpreadMs = null,
                             generatedAt = null } = {}) {
  // A steady fleet is not phase-locked. Every periodic thing on a boat is
  // phased from that boat's own start: the flush tick (backfill_chunk_interval_s),
  // the heartbeat, and — the longest — lib/budget.js's per-minute message
  // window and per-HOUR byte window, both opened at the boat's first admit.
  // Boot N boats within a few seconds and they burst together at the top of
  // every budget minute and fall silent together at the end of every budget
  // hour, forever; a real fleet boots over days. So boot across the longest
  // window (one hour). That hour is warm-up and is not measured.
  // startSpreadMs: 0 reproduces the phase-locked worst case.
  const spread = startSpreadMs === null ? STEADY_SPREAD_MS : startSpreadMs
  const rows = []
  for (const n of ns) {
    const fleet = createFleet({ n, trace, plan, seed, serviceMs, maxlen, drainStepMs,
                                memBuffer: true, startSpreadMs: spread })
    await fleet.start()
    fleet.sink.reset()
    const probe = interactiveProbe(fleet.sink, { serviceMs })
    const totalMs = minutes * 60_000
    let depth = 0
    for (let elapsed = 0; elapsed < totalMs; elapsed += drainStepMs) {
      await fleet.run(drainStepMs)
      // Sampled BEFORE the probe adds its own message: this is the backlog a
      // turn arriving now would find.
      depth = fleet.sink.stats().undelivered
      probe.tick(fleet.timers.now(), drainStepMs)
    }
    const s = fleet.sink.stats()
    const secs = totalMs / 1000
    const boatEntries = s.entries - probe.count()
    rows.push({
      n,
      // Boat traffic only; the probe's own 1/s is in totalOfferedPerS.
      offeredPerS: round3(boatEntries / secs),
      totalOfferedPerS: round3(s.entries / secs),
      capacityPerS: round3(1000 / serviceMs),
      handledPerS: round3(s.handled / secs),
      utilisation: round3((s.entries / secs) / (1000 / serviceMs)),
      // Undelivered backlog at the end of the run: what the next turn waits behind.
      queueDepth: depth,
      maxQueueDepth: s.maxUndelivered,
      // Entries in the stream, handled or not — what MAXLEN counts.
      streamLength: s.queued,
      streamBytes: s.streamBytes,
      peakStreamBytes: s.peakStreamBytes,
      evicted: s.evicted,
      evictedUndelivered: s.evictedUndelivered,
      bytesPerEntry: s.bytesPerEntry,
      bytesTotal: s.bytesTotal,
      perSubject: s.perSubject,
      p50InteractiveMs: probe.p50(),
      p99InteractiveMs: probe.p99(),
      maxInteractiveMs: probe.max()
    })
  }
  // The knee is the largest N that stayed inside the budget AND lost nothing.
  let kneeN = null
  let limiter = 'none — every N in the sweep stayed inside the budget'
  for (const row of rows) {
    if (row.evictedUndelivered > 0) {
      limiter = `stream eviction of undelivered entries at n=${row.n} ` +
                `(MAXLEN ${maxlen} reached; entries deleted before the consumer read them)`
      break
    }
    if (row.p99InteractiveMs > interactiveBudgetMs) {
      limiter = `interactive queue wait at n=${row.n}: p99 ${row.p99InteractiveMs}ms ` +
                `exceeds the ${interactiveBudgetMs}ms budget, behind a serial consumer ` +
                `at ${serviceMs}ms/message`
      break
    }
    kneeN = row.n
  }
  return {
    sweep: 'steady',
    generatedAt: stamp(generatedAt),
    params: { ns, minutes, seed, serviceMs, maxlen, interactiveBudgetMs, drainStepMs,
              startSpreadMs: spread, probeEveryMs: 1000,
              trace: traceInfo(trace), plan: planInfo(plan) },
    rows,
    summary: { kneeN, limiter, interactiveBudgetMs, serviceMs }
  }
}

/** One curve per name; a curve is a transport block, or a function of N that
 *  returns one (boat_capacity.transport_for_fleet is a function of N). */
function curveAt (curve, n) {
  return typeof curve === 'function' ? curve(n) : curve
}

async function reconnectHerd ({ ns = [50, 100, 250, 500], curves = {}, trace, plan,
                               seed = 1, serviceMs = 20, maxlen = 50000,
                               waitMs = 900_000, drainStepMs = 1000,
                               generatedAt = null } = {}) {
  const rows = []
  for (const n of ns) {
    for (const [name, curve] of Object.entries(curves)) {
      const transport = curveAt(curve, n)
      const fleet = createFleet({
        n, trace, plan: { ...plan, transport, __etag: `e_${name}` },
        seed, serviceMs, maxlen, drainStepMs, memBuffer: true
      })
      await fleet.start()
      fleet.sink.reset()
      fleet.dropAll('deploy')
      await fleet.run(waitMs)
      const snap = fleet.snapshot()
      const arrivals = snap.arrivals
      const firstMs = arrivals.length ? Math.min(...arrivals) : null
      const lastMs = arrivals.length ? Math.max(...arrivals) : null
      const windowMs = arrivals.length ? lastMs - firstMs : 0
      // Busiest one-second bucket, which is what the box actually feels.
      const buckets = new Map()
      for (const a of arrivals) {
        const k = Math.floor(a / 1000)
        buckets.set(k, (buckets.get(k) || 0) + 1)
      }
      const peak = buckets.size ? Math.max(...buckets.values()) : 0
      rows.push({
        n,
        curve: name,
        transport,
        arrived: arrivals.length,
        missing: n - arrivals.length,
        firstMs,
        lastMs,
        windowMs,
        // Arrivals over the window they actually landed in.
        meanPerS: windowMs > 0 ? round3(arrivals.length / (windowMs / 1000)) : null,
        peakPerS: peak,
        // Each reconnect also fires one REST signalk_boat_token_claim before the
        // socket (lib/uplink.js connect -> claimToken), so peakPerS bounds two
        // rates: socket.io handshakes AND HTTP requests.
        peakHttpPerS: peak,
        // What the reconnect itself pushed onto the stream (catalog + backlog).
        peakQueueDepth: snap.sink.maxUndelivered,
        evictedUndelivered: snap.sink.evictedUndelivered
      })
    }
  }
  const worst = rows.slice().sort((a, b) => b.peakPerS - a.peakPerS)[0] || {}
  return {
    sweep: 'herd',
    generatedAt: stamp(generatedAt),
    params: { ns, seed, serviceMs, maxlen, waitMs, drainStepMs,
              curves: Object.keys(curves), trace: traceInfo(trace),
              plan: { mappings: ((plan && plan.mappings) || []).length } },
    rows,
    summary: {
      worstPeakPerS: Math.max(0, ...rows.map((r) => r.peakPerS)),
      worstCurve: worst.curve || null,
      worstN: worst.n || null
    }
  }
}

/** The backfill storm: the whole fleet comes back at once with full buffers.
 *
 *  mode 'buffered' (default) — the storm the spec asks about. Boats stay
 *    connected while ingress refuses every package, so the real runtime keeps
 *    sampling and every record stays in its (real-semantics) buffer; then the
 *    fleet drops and reconnects, as after an outage, and drains.
 *  mode 'link_down' — what TODAY's connector does in a real outage: the cloud
 *    is unreachable, the runtime sits in its reconnect loop, and — because
 *    onLinkLost closes the SignalK subscription and cycle() only reopens it
 *    after a successful handshake — it buffers nothing. Measured so the report
 *    can state that as a number rather than as a reading of the code.
 */
async function backfillStorm ({ n = 250, offlineHours = 24, trace, plan, seed = 1,
                               serviceMs = 20, maxlen = 50000,
                               interactiveBudgetMs = 2000, drainStepMs = 1000,
                               drainLimitHours = 6, mode = 'buffered',
                               startSpreadMs = null, generatedAt = null } = {}) {
  const transport = (plan && plan.transport) || {}
  const chunk = Number(transport.backfill_chunk_msgs) || 100
  const spread = startSpreadMs === null ? STEADY_SPREAD_MS : startSpreadMs
  const fleet = createFleet({ n, trace, plan, seed, serviceMs, maxlen, drainStepMs,
                              memBuffer: true, startSpreadMs: spread })
  await fleet.start()

  const offlineMs = offlineHours * 3_600_000
  // Records not yet flushed when the outage starts (at most a few seconds' worth).
  const bufferedAtOutage = fleet.buffered()
  if (mode === 'link_down') {
    fleet.sink.setReachable(false)
    fleet.dropAll('offline')
    await fleet.run(offlineMs)
    fleet.sink.setReachable(true)
  } else {
    fleet.sink.setAccepting(false)
    await fleet.run(offlineMs)
    fleet.sink.setAccepting(true)
  }
  const bufferedAtReconnect = fleet.buffered()
  // What the outage itself added: records sampled while the cloud was away.
  const gatheredDuringOutage = bufferedAtReconnect - bufferedAtOutage
  const maxBoatBufferedAtReconnect = fleet.maxBuffered()
  const shedDuringOutage = fleet.snapshot().boats
    .reduce((sum, b) => sum + (b.buffer_dropped || 0), 0)
  fleet.sink.reset()
  // 'buffered': the outage ends the way a deploy does — every socket drops and
  // the fleet redials through its backoff curve. 'link_down': the boats are
  // already in their reconnect loop and return at their next retry.
  if (mode !== 'link_down') fleet.dropAll('outage over')
  const probe = interactiveProbe(fleet.sink, { serviceMs })
  const reconnectAt = fleet.timers.now()
  let drainMs = null
  let peakBuffered = bufferedAtReconnect
  const limitMs = drainLimitHours * 3_600_000
  for (let elapsed = 0; elapsed < limitMs; elapsed += drainStepMs) {
    await fleet.run(drainStepMs)
    const s = fleet.sink.stats()
    // Drained = every boat is back to streaming (nothing beyond one chunk left
    // in any buffer, so flush sends yey.boat.data, not backfill) AND the
    // consumer has caught up with everything enqueued. The stream LENGTH never
    // returns to zero — handled entries stay until MAXLEN trims them — so it
    // is the undelivered count that has to.
    // Checked before the probe adds this step's own message.
    // And every boat is back on the air: an empty buffer on a boat still in
    // its reconnect loop is not a drained storm.
    if (fleet.maxBuffered() <= chunk && s.undelivered === 0 && fleet.allRunning()) {
      drainMs = fleet.timers.now() - reconnectAt
      break
    }
    peakBuffered = Math.max(peakBuffered, fleet.buffered())
    probe.tick(fleet.timers.now(), drainStepMs)
  }
  const s = fleet.sink.stats()
  const p99 = probe.p99()
  const backfill = s.perSubject['yey.boat.backfill'] || 0
  return {
    sweep: 'storm',
    generatedAt: stamp(generatedAt),
    params: { n, offlineHours, seed, serviceMs, maxlen, interactiveBudgetMs,
              drainLimitHours, drainStepMs, mode, startSpreadMs: spread,
              trace: traceInfo(trace), plan: planInfo(plan) },
    rows: [],
    summary: {
      mode,
      bufferedAtOutage,
      gatheredDuringOutage,
      bufferedAtReconnect,
      bufferedPerBoat: n ? Math.round(bufferedAtReconnect / n) : 0,
      maxBoatBufferedAtReconnect,
      peakBuffered,
      shedDuringOutage,
      drainMs: drainMs === null ? limitMs : drainMs,
      drained: drainMs !== null,
      // Deepest undelivered backlog on the stream during the drain.
      peakQueueDepth: s.maxUndelivered,
      peakStreamLength: Math.min(maxlen, s.entries),
      peakStreamBytes: s.peakStreamBytes,
      peakBytes: s.bytesTotal,
      bytesPerEntry: s.bytesPerEntry,
      // Mean size of one backfill entry: the figure that turns MAXLEN into a
      // Redis memory number during a storm.
      backfillBytesPerEntry: backfill
        ? Math.round((s.bytesBySubject['yey.boat.backfill'] || 0) / backfill) : 0,
      backfillMessages: backfill,
      evicted: s.evicted,
      evictedUndelivered: s.evictedUndelivered,
      handled: s.handled,
      p99InteractiveMs: p99,
      maxInteractiveMs: probe.max(),
      interactiveSurvived: p99 <= interactiveBudgetMs && s.evictedUndelivered === 0
    }
  }
}

module.exports = { steadyState, reconnectHerd, backfillStorm, percentile, interactiveProbe }
