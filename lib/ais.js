'use strict'

/**
 * AIS relay: the OTHER vessels this boat's own SignalK server sees.
 *
 * Off unless the active plan carries a mapping for the consent item `ais`
 * (yey.boats plans it only when the owner's consent list names `ais`), and the
 * local deny list can still veto it: applyPlan drops the mapping on
 * `deny: ["ais"]` before it ever reaches here.
 *
 * Each target is sent as ONE record on yey.boat.data, apart from the boat's own
 * values:
 *
 *   { p: 'ais', n: 'ais', v: { mmsi, values: { <signalk path>: value, ... } } }
 *
 * carrying the target's full current state, so a record is idempotent and the
 * cloud never has to merge partial updates. A target is re-sent no more often
 * than the mapping's min_interval_s, only when something changed, and at least
 * every max_interval_s while it is still being heard (so the cloud can tell a
 * target that is still there from one that went away).
 */

const AIS_PATH = 'ais'
// What the cloud renders for a target (signalk_ais.target_from_wire). Anything
// else in a vessel context is never collected.
const TRACKED_PATHS = [
  'navigation.position',
  'navigation.courseOverGroundTrue',
  'navigation.speedOverGround',
  'name',
  'design.aisShipType'
]
const MAX_TARGETS = 200
const FORGET_AFTER_MS = 15 * 60 * 1000

function mmsiOf (context) {
  const m = /mmsi:(\d{1,12})$/.exec(String(context || ''))
  return m ? m[1] : ''
}

function aisMapping (plan) {
  const mappings = plan && Array.isArray(plan.mappings) ? plan.mappings : []
  return mappings.find((m) => m && m.path === AIS_PATH) || null
}

function sameJson (a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Collects vessel samples ({context, path, value}) and hands back the targets
 * that are due. `isSelf(context, mmsi)` excludes the boat itself — its own
 * position already travels as navigation.position under the plan.
 */
function createAisCollector ({ isSelf = () => false, maxTargets = MAX_TARGETS } = {}) {
  const targets = new Map()   // mmsi -> { values, changed, heardMs, lastEmitMs }

  function onSample (sample, nowMs) {
    if (!sample || !TRACKED_PATHS.includes(sample.path)) return
    const context = String(sample.context || '')
    if (!context || context === 'vessels.self') return
    const mmsi = mmsiOf(context)
    if (!mmsi || isSelf(context, mmsi)) return
    let t = targets.get(mmsi)
    if (!t) {
      if (targets.size >= maxTargets) return
      t = { values: {}, changed: false, heardMs: nowMs, lastEmitMs: 0 }
      targets.set(mmsi, t)
    }
    t.heardMs = nowMs
    if (!sameJson(t.values[sample.path], sample.value)) {
      t.values[sample.path] = sample.value
      t.changed = true
    }
  }

  /** Targets due now, as record values {mmsi, values}. */
  function drain (nowMs, mapping) {
    const minMs = Math.max(1, Number(mapping && mapping.min_interval_s) || 30) * 1000
    const maxMs = Math.max(minMs / 1000, Number(mapping && mapping.max_interval_s) || 300) * 1000
    const out = []
    for (const [mmsi, t] of targets) {
      if (nowMs - t.heardMs > FORGET_AFTER_MS) { targets.delete(mmsi); continue }
      const since = nowMs - t.lastEmitMs
      const hasPosition = Boolean(t.values['navigation.position'])
      if (!hasPosition) continue
      if ((t.changed && since >= minMs) || since >= maxMs) {
        out.push({ mmsi, values: { ...t.values } })
        t.lastEmitMs = nowMs
        t.changed = false
      }
    }
    return out
  }

  return { onSample, drain, size: () => targets.size }
}

module.exports = { AIS_PATH, TRACKED_PATHS, MAX_TARGETS, mmsiOf, aisMapping, createAisCollector }
