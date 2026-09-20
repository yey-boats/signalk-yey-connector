'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { leafPaths, compactMeta, groupInstruments, buildCatalog, diffCatalogs,
        SKIP_KEYS, MAX_DISCOVER_PATHS, MAX_METADATA_PATHS } = require('../lib/discovery')

/** Shaped like a real vessels/self tree: leaves carry `value`, and each node also
 *  carries the structural keys signalk_meta._SKIP drops. */
const TREE = {
  navigation: {
    position: {
      value: { latitude: 45.1, longitude: 13.2 },
      $source: 'gps.1', timestamp: '2026-09-20T10:00:00Z',
      meta: { units: 'deg' }
    },
    speedOverGround: { value: 3.2, $source: 'gps.1', timestamp: 't' }
  },
  environment: {
    depth: { belowTransducer: { value: 18.4, $source: 'dep.1' } }
  },
  mmsi: '238123456',
  name: 'Sara'
}

test('leafPaths finds every value leaf as a dotted path', () => {
  const paths = leafPaths(TREE)
  assert.deepEqual(paths.sort(), [
    'environment.depth.belowTransducer',
    'navigation.position',
    'navigation.speedOverGround'
  ])
})

test('leafPaths never descends into a node that already has a value', () => {
  /* navigation.position.value is an OBJECT with latitude/longitude; descending
     would invent paths like navigation.position.latitude that no plan, and no
     SignalK subscription, can address. */
  assert.ok(!leafPaths(TREE).some((p) => p.includes('latitude')))
})

test('leafPaths skips the structural keys signalk_meta._SKIP drops', () => {
  for (const key of ['meta', '$source', 'timestamp', 'pgn', 'sentence',
                     'sentences', 'values']) {
    assert.ok(SKIP_KEYS.has(key), `${key} must be skipped`)
  }
  assert.ok(!leafPaths(TREE).some((p) => p.includes('$source')))
})

test('leafPaths ignores a scalar that is not a value node', () => {
  // `mmsi` and `name` are plain strings on the vessel, not value leaves.
  assert.ok(!leafPaths(TREE).includes('mmsi'))
})

test('leafPaths honours the ceiling', () => {
  const wide = { a: {} }
  for (let i = 0; i < 500; i++) wide.a[`p${i}`] = { value: i }
  assert.equal(leafPaths(wide, 10).length, 10)
  assert.equal(leafPaths(wide).length, MAX_METADATA_PATHS)
})

test('leafPaths tolerates rubbish', () => {
  assert.deepEqual(leafPaths(null), [])
  assert.deepEqual(leafPaths('nope'), [])
  assert.deepEqual(leafPaths({ a: null, b: 3 }), [])
})

test('compactMeta keeps the documented fields and lifts source to gear', () => {
  const out = compactMeta({
    description: 'GPS lat/lon fix', units: 'deg', timeout: 3,
    displayName: 'Position', intentDescription: 'where the boat is',
    source: { manufacturer: 'Rusty Boats', model: 'RB-SKYHOOK-3000', extra: 'x' },
    somethingElse: 'dropped'
  })
  assert.deepEqual(out, {
    description: 'GPS lat/lon fix', units: 'deg', displayName: 'Position',
    timeout: 3, intentDescription: 'where the boat is',
    gear: { manufacturer: 'Rusty Boats', model: 'RB-SKYHOOK-3000' }
  })
})

test('compactMeta drops empty values and a sourceless meta has no gear', () => {
  assert.deepEqual(compactMeta({ description: '', units: 'm' }), { units: 'm' })
  assert.deepEqual(compactMeta({ units: 'm', source: {} }), { units: 'm' })
  assert.deepEqual(compactMeta(null), {})
})

test('groupInstruments reproduces signalk_meta.instruments()', () => {
  const out = groupInstruments({
    'navigation.position': { description: 'GPS lat/lon fix',
      gear: { manufacturer: 'Rusty Boats', model: 'RB-SKYHOOK-3000' } },
    'navigation.speedOverGround': { description: 'GPS speed over ground',
      gear: { manufacturer: 'Rusty Boats', model: 'RB-SKYHOOK-3000' } },
    'navigation.headingTrue': { description: 'Fluxgate compass heading, true north',
      gear: { manufacturer: 'Rusty Boats', model: 'RB-POINTY-END-200' } },
    'environment.depth.belowTransducer': { units: 'm' }
  })
  assert.equal(out.device_count, 2)
  assert.equal(out.paths_without_gear, 1)
  assert.equal(out.total_paths, 4)
  const skyhook = out.instruments.find((d) => d.model === 'RB-SKYHOOK-3000')
  assert.deepEqual(skyhook.measures,
    ['GPS lat/lon fix', 'GPS speed over ground'])
  assert.equal(skyhook.paths.length, 2)
})

test('groupInstruments sorts devices stably so a digest diff means something', () => {
  const out = groupInstruments({
    a: { gear: { manufacturer: 'Zeta', model: 'Z1' } },
    b: { gear: { manufacturer: 'Alpha', model: 'A1' } }
  })
  assert.deepEqual(out.instruments.map((d) => d.manufacturer), ['Alpha', 'Zeta'])
})

test('groupInstruments de-duplicates a repeated description', () => {
  const out = groupInstruments({
    a: { description: 'depth', gear: { manufacturer: 'M', model: 'X' } },
    b: { description: 'depth', gear: { manufacturer: 'M', model: 'X' } }
  })
  assert.deepEqual(out.instruments[0].measures, ['depth'])
})

test('buildCatalog is the digest the cloud stores', () => {
  const cat = buildCatalog({
    tree: TREE,
    metaByPath: {
      'navigation.position': { units: 'deg', description: 'GPS lat/lon fix',
        gear: { manufacturer: 'Rusty Boats', model: 'RB-SKYHOOK-3000' } }
    },
    nowIso: '2026-09-20T12:00:00Z'
  })
  assert.equal(cat.generated_at, '2026-09-20T12:00:00Z')
  assert.equal(cat.path_count, 3)
  assert.equal(cat.paths['navigation.position'].units, 'deg')
  // A path with no meta still appears — "we see this but have no label for it"
  // is exactly the Available-not-Supported signal the spec wants.
  assert.ok('navigation.speedOverGround' in cat.paths)
  assert.equal(cat.instruments.device_count, 1)
})

test('diffCatalogs surfaces a newly wired sensor', () => {
  /* spec: "a new sensor wired in mid-season should surface as 'you can now
     enable engine temperature', not go unnoticed." */
  const before = { paths: { 'navigation.position': {} } }
  const after = { paths: { 'navigation.position': {}, 'propulsion.port.temperature': {} } }
  assert.deepEqual(diffCatalogs(before, after),
    { added: ['propulsion.port.temperature'], removed: [] })
})

test('diffCatalogs surfaces a transducer that stopped reporting', () => {
  const before = { paths: { a: {}, b: {} } }
  const after = { paths: { a: {} } }
  assert.deepEqual(diffCatalogs(before, after), { added: [], removed: ['b'] })
})

test('diffCatalogs against nothing reports everything as added', () => {
  assert.deepEqual(diffCatalogs(null, { paths: { a: {} } }),
    { added: ['a'], removed: [] })
})

// ── beyond the plan ──────────────────────────────────────────────────────────

test('the two ceilings are the ones signalk_limits ships', () => {
  /* signalk_limits._DEFAULT_DISCOVER_MAX_PATHS (:30) and
     _DEFAULT_METADATA_MAX_PATHS (:31). Two ceilings, two jobs: how many leaves we
     sweep metadata for, and how many paths a discovery answer may carry. */
  assert.equal(MAX_DISCOVER_PATHS, 250)
  assert.equal(MAX_METADATA_PATHS, 300)
})

test('buildCatalog respects the discover ceiling and says when it bit', () => {
  /* A chatty NMEA network must not be able to push the cloud a catalog larger than
     the cloud's own signalk_discover would have produced. */
  const wide = { a: {} }
  for (let i = 0; i < 400; i++) wide.a[`p${i}`] = { value: i }
  const cat = buildCatalog({ tree: wide, metaByPath: {}, nowIso: 'now' })
  assert.equal(cat.path_count, MAX_DISCOVER_PATHS)
  assert.equal(cat.max_paths, MAX_DISCOVER_PATHS)
  assert.equal(cat.truncated, true)
})

test('a catalog that fits is not reported as truncated', () => {
  const cat = buildCatalog({ tree: TREE, metaByPath: {}, nowIso: 'now' })
  assert.equal(cat.truncated, false)
  assert.equal(cat.path_count, 3)
})

test('buildCatalog takes a tighter ceiling than the default', () => {
  const cat = buildCatalog({ tree: TREE, metaByPath: {}, nowIso: 'now', maxPaths: 2 })
  assert.equal(cat.path_count, 2)
  assert.equal(cat.max_paths, 2)
  assert.equal(cat.truncated, true)
})

test('buildCatalog survives being handed nothing at all', () => {
  const cat = buildCatalog()
  assert.equal(cat.path_count, 0)
  assert.deepEqual(cat.paths, {})
  assert.equal(cat.instruments.device_count, 0)
  assert.equal(typeof cat.generated_at, 'string')
  assert.equal(cat.schema, 'yey.boat.catalog.v1')
})

test('groupInstruments orders like Python sorted(), not like localeCompare', () => {
  /* signalk_meta.instruments sorts on the (manufacturer, model) TUPLE, which is
     code-point order: 'Zeta' < 'alpha'. localeCompare reverses that pair, and the
     boat's digest and the cloud's view of it are supposed to render identically. */
  const out = groupInstruments({
    a: { gear: { manufacturer: 'alpha', model: 'A1' } },
    b: { gear: { manufacturer: 'Zeta', model: 'Z1' } },
    c: { gear: { manufacturer: 'Zeta', model: 'A9' } }
  })
  assert.deepEqual(out.instruments.map((d) => `${d.manufacturer}/${d.model}`),
    ['Zeta/A9', 'Zeta/Z1', 'alpha/A1'])
})

test('compactMeta keeps a zero timeout, which is a real value', () => {
  // Python drops only None and "" (signalk_meta._compact :118).
  assert.deepEqual(compactMeta({ timeout: 0, units: 'm' }), { timeout: 0, units: 'm' })
})

test('compactMeta ignores a source that is not an object', () => {
  assert.deepEqual(compactMeta({ units: 'm', source: 'gps.1' }), { units: 'm' })
  assert.deepEqual(compactMeta({ units: 'm', source: ['gps.1'] }), { units: 'm' })
})

test('leafPaths falls back to the metadata ceiling when handed a nonsense one', () => {
  const wide = { a: {} }
  for (let i = 0; i < 400; i++) wide.a[`p${i}`] = { value: i }
  assert.equal(leafPaths(wide, 0).length, MAX_METADATA_PATHS)
  assert.equal(leafPaths(wide, -5).length, MAX_METADATA_PATHS)
  assert.equal(leafPaths(wide, 'lots').length, MAX_METADATA_PATHS)
})

test('leafPaths does not walk into an array node', () => {
  /* notifications and some vendor trees carry arrays; an array index is not a
     SignalK path segment. */
  assert.deepEqual(leafPaths({ alarms: [{ value: 1 }, { value: 2 }] }), [])
})

test('diffCatalogs orders its answer deterministically', () => {
  const d = diffCatalogs({ paths: {} },
    { paths: { 'z.b': {}, 'a.c': {}, 'm.q': {} } })
  assert.deepEqual(d.added, ['a.c', 'm.q', 'z.b'])
})
