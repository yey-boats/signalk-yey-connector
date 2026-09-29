'use strict'
/** N connector runtimes, one virtual clock, one cloud.
 *
 *  The clock is the reason this works at N=500 on a laptop: every runtime takes
 *  deps.now/setTimeout/clearTimeout (lib/runtime.js createRuntime), so a whole
 *  fleet-day runs in seconds and the result is deterministic. The fake-timer
 *  queue has the same contract as the one test/supervisor.test.js uses (fire in
 *  due order, ties in scheduling order); it is written here rather than
 *  imported because a rig that depends on a test file breaks the next time that
 *  test is tidied, and because at N=500 it has to be a heap, not a sort.
 */
const { createRuntime } = require('../lib/runtime')
const { createTraceSource } = require('./source')
const { createSink } = require('./sink')

/** Deterministic PRNG. Math.random would make every run unrepeatable, and an
 *  unrepeatable capacity number is an anecdote. */
function mulberry32 (seed) {
  let a = seed >>> 0
  return function random () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Virtual timers on a binary min-heap keyed (at, seq). Cancelled handles are
 *  removed from the live map and skipped lazily when they reach the top. */
function fakeTimers (startMs = 1_000_000) {
  let now = startMs
  let seq = 0
  const live = new Map()       // handle -> { at, fn }
  const heap = []              // [{ at, seq }]

  const less = (a, b) => a.at < b.at || (a.at === b.at && a.seq < b.seq)
  function push (node) {
    heap.push(node)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!less(heap[i], heap[p])) break
      ;[heap[i], heap[p]] = [heap[p], heap[i]]
      i = p
    }
  }
  function pop () {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && less(heap[l], heap[m])) m = l
        if (r < heap.length && less(heap[r], heap[m])) m = r
        if (m === i) break
        ;[heap[i], heap[m]] = [heap[m], heap[i]]
        i = m
      }
    }
    return top
  }
  /** The earliest timer still live, discarding cancelled ones on the way. */
  function peekLive () {
    while (heap.length && !live.has(heap[0].seq)) pop()
    return heap.length ? heap[0] : null
  }

  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const h = ++seq
      const at = now + Math.max(0, Number(ms) || 0)
      live.set(h, { at, fn })
      push({ at, seq: h })
      return h
    },
    clearTimeout: (h) => { live.delete(h) },
    pending: () => [...live.values()].map((e) => e.at - now),
    nextAt: () => { const top = peekLive(); return top ? top.at : null },
    /** Fire every timer due at or before `limit`, in order, awaiting each —
     *  including timers those callbacks schedule inside the window — then
     *  leave the clock at `limit`. */
    async fireDueBy (limit) {
      for (;;) {
        const top = peekLive()
        if (!top || top.at > limit) { now = Math.max(now, limit); return }
        pop()
        const entry = live.get(top.seq)
        live.delete(top.seq)
        now = entry.at
        await entry.fn()
      }
    }
  }
}

function createFleet ({ n = 10, trace, plan, serviceMs = 20, maxlen = 50000,
                        seed = 1, options = {}, drainStepMs = 1000 } = {}) {
  const timers = fakeTimers()
  const random = mulberry32(seed)
  const sink = createSink({ serviceMs, maxlen, now: timers.now, plan })
  const sources = []
  const uplinks = []
  let droppedAt = null
  let helloMark = 0            // index into sink.hellos() at the last drop

  const runtimes = Array.from({ length: n }, (_, i) => {
    const boatId = `b_rig_${String(i).padStart(5, '0')}`
    const source = createTraceSource(trace, { boatId, now: timers.now, index: i })
    sources.push(source)
    const uplink = sink.uplinkFor({ boatId })
    uplinks.push(uplink)
    const runtime = createRuntime({
      // getDataDirPath null keeps the buffer and the state file IN MEMORY.
      // buffer.append reads and rewrites whole lane files on every sample
      // (lib/buffer.js), so N runtimes on one disk would measure the laptop's
      // filesystem.
      app: { debug: () => {}, getDataDirPath: () => null },
      version: '0.1.0-loadrig',
      options: { enabled: true, boatId, boatCredential: `bk_${boatId}`, ...options },
      deps: {
        createUplink: () => uplink,
        source,
        now: timers.now,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        random,
        pairing: {
          requestClaim: async () => ({ ok: false }),
          pollClaim: async () => ({ ok: false }),
          redeemCode: async () => ({ ok: false })
        }
      }
    })
    // Without consent every mapping is rejected `outside_consent` and the rig
    // measures an empty plan very precisely.
    runtime.setConsent(((plan && plan.mappings) || []).map((m) => m.path))
    return runtime
  })

  /** Advance in drainStepMs slices: timers first, then the SignalK sources
   *  catch up to the new time, then the serial consumer gets its slice. */
  async function advanceTo (limit) {
    while (timers.now() < limit) {
      const from = timers.now()
      const step = Math.min(limit, from + drainStepMs)
      await timers.fireDueBy(step)
      for (const s of sources) s.pump(timers.now())
      sink.drain(step - from)
    }
  }

  /** Each boat's FIRST hello after the last drop, in ms from the drop. A later
   *  heartbeat hello (heartbeat_s) is the same boat again, not a new arrival. */
  function arrivals () {
    if (droppedAt === null) return []
    const seen = new Set()
    const out = []
    for (const h of sink.hellos().slice(helloMark)) {
      if (seen.has(h.boatId)) continue
      seen.add(h.boatId)
      out.push(h.at - droppedAt)
    }
    return out
  }

  return {
    timers,
    sink,
    runtimes,
    sources,
    async start () {
      for (const r of runtimes) await r.start()
      for (const s of sources) s.pump(timers.now())
    },
    /** What a deploy does: every socket drops at the same instant. */
    dropAll (why = 'deploy') {
      droppedAt = timers.now()
      helloMark = sink.hellos().length
      for (const u of uplinks) u.kill(why)
    },
    async run (ms) { await advanceTo(timers.now() + ms) },
    stop () { for (const r of runtimes) r.stop() },
    snapshot () {
      return {
        n,
        seed,
        now: timers.now(),
        droppedAt,
        arrivals: arrivals(),
        sink: sink.stats(),
        boats: runtimes.map((r) => r.snapshot())
      }
    }
  }
}

module.exports = { createFleet, fakeTimers, mulberry32 }
