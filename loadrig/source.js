'use strict'
/** A SignalK source that replays a captured trace, in virtual time.
 *
 *  The five-method interface is not invented here: it is exactly what
 *  test/runtime.test.js SOURCE_STUB stubs (subscribe, selfTree, collectMeta,
 *  serverInfo, vesselIdentity), which is the best available evidence that a
 *  source is substitutable without changing the runtime.
 *
 *  Trace shape (what loadrig/capture.js writes):
 *    { server, vessel, self, meta, deltas: [{ t, path, value }] }   t = ms from start
 */

/** Per-boat jitter so N boats are not one boat N times: identical values would
 *  make every on_change/deadband decision identical and the load artificially
 *  regular. Derived from the boat id, so it is deterministic. */
function offsetFor (boatId) {
  let h = 0
  for (const ch of String(boatId || '')) h = (h * 31 + ch.charCodeAt(0)) % 100000
  return h
}

/** One replayed sample. `value` and `timestamp` are computed on first read:
 *  lib/runtime.js onSample drops every path the plan does not map before it
 *  touches either, and at N=500 x ~90 paths x 1 Hz building them eagerly was
 *  ~90% of the rig's wall clock, spent on samples nobody looks at. */
class Sample {
  constructor (delta, at, started, shift) {
    this.path = delta.path
    this._d = delta
    this._at = at
    this._started = started
    this._shift = shift
    this._value = undefined
  }

  get value () {
    if (this._value === undefined) this._value = this._shift(this._d.value)
    return this._value
  }
  get timestamp () { return new Date(this._started + this._at).toISOString() }
}

function createTraceSource (trace, { boatId, now = Date.now, index = null } = {}) {
  const deltas = (trace && trace.deltas) || []
  const span = deltas.length ? deltas[deltas.length - 1].t + 1000 : 1000
  const seed = offsetFor(boatId)
  const wobble = (seed % 1000) / 100000        // up to 1% on every number
  let sink = null
  let closed = null
  let cursor = 0
  let loops = 0
  // The trace timeline starts at the FIRST subscribe and is never reset. A
  // reconnect re-subscribes; resetting the origin there would either replay the
  // whole outage as one burst or go silent for as long as the boat had run.
  // The real delta socket does neither: deltas during an outage are simply not
  // seen (pump advances past them with no subscriber), and the stream resumes
  // at wall-clock "now".
  let started = null

  function shift (value) {
    if (typeof value === 'number') return value * (1 + wobble)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = shift(v)
      return out
    }
    return value
  }

  return {
    subscribe (onSample, onClose) {
      sink = onSample
      closed = onClose
      if (started === null) started = now()
      const mine = onSample
      return { close: () => { if (sink === mine) { sink = null; closed = null } } }
    },
    /** Emit every delta due by `nowMs`. Idempotent for a given nowMs. Deltas
     *  that fall due while nobody is subscribed are skipped, not queued. */
    pump (nowMs) {
      if (started === null || !deltas.length) return
      const elapsed = nowMs - started
      for (;;) {
        const d = deltas[cursor]
        const at = loops * span + d.t
        if (at > elapsed) return
        if (sink) sink(new Sample(d, at, started, shift))
        cursor += 1
        if (cursor >= deltas.length) { cursor = 0; loops += 1 }
      }
    },
    /** The SignalK server went away (the delta socket closed under us). */
    kill (why) {
      const fn = closed
      sink = null
      closed = null
      if (fn) fn(why || 'trace closed')
    },
    async selfTree () { return (trace && trace.self) || {} },
    async collectMeta () { return (trace && trace.meta) || {} },
    async serverInfo () { return (trace && trace.server) || { version: '2.7.1', plugins: [] } },
    async vesselIdentity () {
      const base = (trace && trace.vessel) || { name: 'Sara', mmsi: '235177007' }
      // Distinct identity per boat: an MMSI collision across the fleet would
      // make the cloud's per-boat isolation untestable. A fleet passes its
      // index, which is collision-free; a lone source falls back to the hash.
      const step = Number.isInteger(index) ? index : offsetFor(boatId) % 9000
      // The name stays the trace's own: the MMSI is what tells boats apart.
      return { name: String(base.name || ''),
               mmsi: String(Number(base.mmsi || 0) + step + 1) }
    }
  }
}

module.exports = { createTraceSource, offsetFor }
