'use strict'

/**
 * The policy engine: given a mapping, the last thing we sent and a sample,
 * decide whether this one goes on the wire.
 *
 * Every function is pure and takes `nowMs` as a PARAMETER. A cadence engine
 * tested against a real `Date.now()` and real timers is tested by sleeping —
 * slow, flaky, and unable to test a 600-second heartbeat at all. Here a whole
 * day of cadence is a few integers.
 *
 * `priority` deliberately does NOT live here. It decides what gets dropped first
 * when the budget binds or the buffer fills (lib/budget.js), not whether a value
 * is interesting — keeping them apart is what stops a "shed low priority" change
 * from silently altering cadence.
 */

const EARTH_RADIUS_M = 6371008.8 // IUGG mean Earth radius

/** Great-circle distance in metres. A degree subtraction would under-report
 *  longitude movement by cos(latitude) — at 60°N by half — so a 25 m deadband on
 *  navigation.position would mean something different in the Baltic than in the
 *  Adriatic. */
function distanceMeters (a, b) {
  if (!isPosition(a) || !isPosition(b)) return Infinity
  const toRad = (deg) => (Number(deg) * Math.PI) / 180
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const dLat = lat2 - lat1
  const dLon = toRad(b.longitude) - toRad(a.longitude)
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

function isPosition (value) {
  return Boolean(value) && typeof value === 'object' &&
    Number.isFinite(Number(value.latitude)) && Number.isFinite(Number(value.longitude))
}

/** Structural equality for values with no magnitude (navigation.state, a
 *  notification object). Key ORDER must not count as a change: SignalK hands the
 *  same notification back with its keys in whatever order the producer emitted
 *  them, and a JSON.stringify comparison would call that a change and publish it
 *  every single time. */
function sameValue (a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => sameValue(v, b[i]))
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]))
  }
  return false
}

/**
 * Is the step from `prev` to `next` big enough to be worth a message?
 *
 * With no previous value the answer is always yes — the first sample of a
 * mapping is news by definition.
 */
function exceedsDeadband (deadband, prev, next) {
  if (prev === undefined || prev === null) return true
  const d = deadband || {}

  if (d.meters !== undefined) {
    // A position that stopped being a position (a source dropped out, a path
    // changed shape) is a change, not a zero-metre move.
    if (!isPosition(prev) || !isPosition(next)) return !sameValue(prev, next)
    return distanceMeters(prev, next) >= Number(d.meters)
  }
  if (typeof prev !== 'number' || typeof next !== 'number' ||
      !Number.isFinite(prev) || !Number.isFinite(next)) {
    return !sameValue(prev, next)
  }
  const delta = Math.abs(next - prev)
  if (d.abs !== undefined) return delta >= Number(d.abs)
  if (d.pct !== undefined) {
    // A previous value of zero has no meaningful percentage: any change counts.
    if (prev === 0) return delta > 0
    return (delta / Math.abs(prev)) * 100 >= Number(d.pct)
  }
  return delta > 0
}

/** An interval from the mapping, stretched by fleet quiet mode.
 *
 *  Quiet mode is a PLAN field, which is the whole point: it reduces cadence
 *  across every boat at once, in seconds, without anyone shipping connector code
 *  to a boat in the middle of an ocean. */
function effectiveIntervalS (mapping, key, transport) {
  const base = Number((mapping || {})[key])
  if (!Number.isFinite(base) || base <= 0) return 0
  const t = transport || {}
  const multiplier = t.quiet_mode ? Math.max(1, Number(t.quiet_interval_multiplier) || 1) : 1
  return base * multiplier
}

/** The `round` transform: fewer decimals on the wire, and nothing else touched.
 *  A position is an object, so its members are rounded individually. */
function applyRound (mapping, value) {
  const digits = Number((mapping || {}).round)
  if (!Number.isFinite(digits)) return value
  const factor = 10 ** digits
  const round1 = (n) => Math.round(n * factor) / factor
  if (typeof value === 'number') return Number.isFinite(value) ? round1(value) : value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = typeof v === 'number' ? round1(v) : v
    return out
  }
  return value
}

/**
 * The decision. `{ emit, reason }`, where `reason` is one of
 * off | no_value | first | periodic | min_interval | heartbeat | change |
 * deadband — a closed vocabulary the status screen can word without parsing
 * prose.
 */
function decide ({ mapping, state, sample, nowMs, transport } = {}) {
  const m = mapping || {}
  const s = state || {}
  const value = (sample || {}).value

  if (m.policy === 'off') return { emit: false, reason: 'off' }
  if (value === undefined || value === null) return { emit: false, reason: 'no_value' }
  // NaN and Infinity reach here from a sensor that lost its fix. They are not
  // values, they survive JSON as `null`, and the deadband arithmetic below would
  // silently swallow them instead.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { emit: false, reason: 'no_value' }
  }
  if (s.lastEmitMs === undefined || s.lastEmitMs === null) return { emit: true, reason: 'first' }

  const sinceMs = Number(nowMs) - Number(s.lastEmitMs)

  if (m.policy === 'periodic') {
    const interval = effectiveIntervalS(m, 'interval_s', transport) ||
      effectiveIntervalS(m, 'min_interval_s', transport)
    return sinceMs >= interval * 1000
      ? { emit: true, reason: 'periodic' }
      : { emit: false, reason: 'min_interval' }
  }

  // on_change. The heartbeat is tested FIRST so a mapping whose min_interval
  // exceeds its max_interval degrades to a heartbeat rather than going silent —
  // a plan typo must not become a data outage.
  const maxInterval = effectiveIntervalS(m, 'max_interval_s', transport)
  if (maxInterval > 0 && sinceMs >= maxInterval * 1000) {
    return { emit: true, reason: 'heartbeat' }
  }
  const minInterval = effectiveIntervalS(m, 'min_interval_s', transport)
  if (minInterval > 0 && sinceMs < minInterval * 1000) {
    return { emit: false, reason: 'min_interval' }
  }
  return exceedsDeadband(m.deadband, s.lastValue, value)
    ? { emit: true, reason: 'change' }
    : { emit: false, reason: 'deadband' }
}

module.exports = {
  EARTH_RADIUS_M, distanceMeters, isPosition, sameValue,
  exceedsDeadband, effectiveIntervalS, applyRound, decide
}
