'use strict'

// ── lib/discovery.js ──
// A boat-side port of the cloud's `signalk_meta.py`: walk the SignalK `vessels/self`
// tree, compact each path's metadata, group it by the gear that produces it, and
// turn the result into the catalog digest the cloud stores.
//
// PURE on purpose. Nothing here opens a socket or reads a file: the tree and the
// per-path metadata are handed in, so the whole catalog pipeline is unit-testable
// with no boat, no signalk-server and no cloud. `lib/signalk-source.js` is the only
// thing that does I/O, and it consumes `leafPaths`/`compactMeta` from here.

// signalk_meta._SKIP (bundles/signalk@2026-06-05/signalk_meta.py:24) — these seven
// keys are structure, not data, and descending into them invents paths that no
// plan and no SignalK subscription can address.
const SKIP_KEYS = new Set([
  'meta', '$source', 'timestamp', 'pgn', 'sentence', 'sentences', 'values'
])

// signalk_limits._DEFAULT_DISCOVER_MAX_PATHS (:30) and _DEFAULT_METADATA_MAX_PATHS
// (:31), read cloud-side through discover_max_paths()/metadata_max_paths(). Two
// ceilings because they bound two different things, and the boat must respect both:
//
//   MAX_METADATA_PATHS (300) — how many leaves we will walk and sweep /meta for.
//   MAX_DISCOVER_PATHS (250) — how many paths a DISCOVERY answer may carry, which
//                              is what buildCatalog() produces.
//
// Cloud-side the discover ceiling is the tighter of the two, and a catalog that
// ignored it would let a chatty NMEA network push a digest through the Data Bus
// that the cloud's own discover tool would have refused to produce.
const MAX_DISCOVER_PATHS = 250
const MAX_METADATA_PATHS = 300

/** Resolve a caller-supplied ceiling: garbage (NaN, 0, negative, a string) falls
 *  back to the default rather than silently emptying or unbounding the walk. */
function resolveCeiling (value, fallback) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Every value-leaf as a dotted path — the port of signalk_meta._leaf_paths
 *  (signalk_meta.py:142-164). A node carrying `value` IS the leaf; its value may
 *  itself be an object (navigation.position is {latitude, longitude}) and is
 *  never descended into. */
function leafPaths (tree, maxPaths = MAX_METADATA_PATHS) {
  const out = []
  const limit = resolveCeiling(maxPaths, MAX_METADATA_PATHS)

  function walk (node, prefix) {
    if (out.length >= limit) return
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    if ('value' in node) {
      if (prefix) out.push(prefix)
      return
    }
    for (const [key, child] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue
      walk(child, prefix ? `${prefix}.${key}` : key)
      if (out.length >= limit) return
    }
  }

  walk(tree, '')
  return out
}

/** signalk_meta._compact (signalk_meta.py:112-125): keep the documented fields and
 *  lift source.{manufacturer,model} to `gear`.
 *
 *  The gear is the reason this exists. SignalK's value-tree GET returns a REDUCED
 *  inline meta with no `source` (signalk_meta.py:7-10) — manufacturer/model live
 *  only on the per-path `/meta` endpoint. A port fed the inline meta produces a
 *  catalog with no gear in it and every instrument grouped under "unknown". */
function compactMeta (meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {}
  const out = {}
  for (const key of ['description', 'units', 'displayName', 'timeout', 'intentDescription']) {
    const value = meta[key]
    // Mirrors Python's `not in (None, "")`: a timeout of 0 is a real value.
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  const src = meta.source
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    const gear = {}
    for (const key of ['manufacturer', 'model']) if (src[key]) gear[key] = src[key]
    if (Object.keys(gear).length) out.gear = gear
  }
  return out
}

/** Code-point ordering, which is what Python's `sorted()` does over a tuple of
 *  strings (signalk_meta.instruments :241). `localeCompare` would put 'alpha'
 *  before 'Zeta' where the cloud puts 'Zeta' first, and the boat's digest and the
 *  cloud's view of it are supposed to render identically. */
function byCodePoint (a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** signalk_meta.instruments (signalk_meta.py:223-244) — the same output keys, so
 *  the boat's digest renders through the cloud's existing view unchanged. */
function groupInstruments (metaByPath) {
  const byGear = new Map()
  let noGear = 0
  const entries = Object.entries(metaByPath || {})

  for (const [path, meta] of entries) {
    const gear = (meta || {}).gear
    if (!gear) { noGear += 1; continue }
    const manufacturer = gear.manufacturer || '?'
    const model = gear.model || '?'
    const key = `${manufacturer}\u0000${model}`
    if (!byGear.has(key)) byGear.set(key, { manufacturer, model, measures: [], paths: [] })
    const slot = byGear.get(key)
    slot.paths.push(path)
    const desc = (meta || {}).description
    if (desc && !slot.measures.includes(desc)) slot.measures.push(desc)
  }

  const devices = [...byGear.values()].sort((a, b) =>
    byCodePoint(a.manufacturer, b.manufacturer) || byCodePoint(a.model, b.model))

  return {
    device_count: devices.length,
    instruments: devices,
    paths_without_gear: noGear,
    total_paths: entries.length
  }
}

/**
 * The catalog digest the cloud stores: every path this boat can see, with whatever
 * label we have for it, plus the instrument inventory.
 *
 * A path with no metadata still appears — "we see this but have no label for it" is
 * exactly the Available-not-Supported signal the spec wants, and it is what lets a
 * sensor wired in mid-season surface as an offer.
 *
 * The path list is bounded by the DISCOVER ceiling (see MAX_DISCOVER_PATHS), and
 * says so with `truncated` rather than quietly shipping a short catalog that would
 * read as "those sensors went away" in the next diff. `instruments` is grouped over
 * the whole metadata sweep, exactly as signalk_meta.instruments() is cloud-side.
 */
function buildCatalog ({ tree, metaByPath, nowIso, maxPaths = MAX_DISCOVER_PATHS } = {}) {
  const limit = resolveCeiling(maxPaths, MAX_DISCOVER_PATHS)
  // Walk one past the ceiling so "did we hit it?" is a fact, not a guess.
  const walked = leafPaths(tree, limit + 1)
  const truncated = walked.length > limit
  const paths = {}
  for (const path of walked.slice(0, limit)) paths[path] = (metaByPath || {})[path] || {}
  return {
    schema: 'yey.boat.catalog.v1',
    generated_at: String(nowIso || new Date().toISOString()),
    path_count: Object.keys(paths).length,
    max_paths: limit,
    truncated,
    paths,
    instruments: groupInstruments(metaByPath || {})
  }
}

/** Snapshot-and-diff, the same move signalk_topics.py makes cloud-side: a sensor
 *  wired in mid-season should surface as an offer, not go unnoticed. */
function diffCatalogs (previous, next) {
  const before = new Set(Object.keys(((previous || {}).paths) || {}))
  const after = new Set(Object.keys(((next || {}).paths) || {}))
  return {
    added: [...after].filter((p) => !before.has(p)).sort(byCodePoint),
    removed: [...before].filter((p) => !after.has(p)).sort(byCodePoint)
  }
}

module.exports = {
  SKIP_KEYS, MAX_DISCOVER_PATHS, MAX_METADATA_PATHS,
  leafPaths, compactMeta, groupInstruments, buildCatalog, diffCatalogs
}
