'use strict'
// Runs against a real signalk-server fed by the simulator — the one place the
// connector's claims about SignalK's actual behaviour are checked against SignalK.
// test/e2e/README.md has the harness; test/e2e/run.sh drives it.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createHttpSource } = require('../../lib/signalk-source')
const { buildCatalog, diffCatalogs, leafPaths } = require('../../lib/discovery')
const { applyPlan } = require('../../lib/plan')
const { decide, applyRound } = require('../../lib/policies')
const { createBuffer } = require('../../lib/buffer')

const BASE = process.env.SIGNALK_E2E_URL
const TOKEN = process.env.SIGNALK_E2E_TOKEN
if (!BASE) {
  throw new Error(
    'SIGNALK_E2E_URL is not set. Start test/e2e/docker-compose.yml and set it. ' +
    'This suite fails rather than skips: a skipped read-path test is a green ' +
    'suite over a broken read path.')
}
if (!TOKEN) {
  throw new Error(
    'SIGNALK_E2E_TOKEN is not set. The compose runs tokensecurity (the simulator ' +
    'cannot start without an account to log into), so REST reads need a token. ' +
    'test/e2e/README.md has the login. Running without one would fail every test ' +
    'with Unauthorized and look like a connector bug.')
}

const source = createHttpSource({ baseUrl: BASE, token: TOKEN })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('the self tree has the paths the simulator publishes', async () => {
  const tree = await source.selfTree()
  assert.ok(tree.navigation, 'no navigation branch — is boat-sim running?')
  assert.ok(tree.navigation.position)
  assert.ok(tree.environment.wind)
})

test('per-path meta carries the source gear the catalog rests on', async () => {
  const meta = await source.metaFor('navigation.position')
  assert.equal(meta.units, 'deg')
  assert.equal(meta.gear.manufacturer, 'Rusty Boats')
  assert.match(meta.gear.model, /^RB-/)
})

test('collectMeta agrees with a /meta sweep of every path', async () => {
  // signalk_meta.py:7-10 says the inline meta omits `source`; signalk-server 2.33
  // carries it, and collectMeta then reads the tree instead of making N requests.
  // Whichever route it takes, the answer must be the per-path one.
  const tree = await source.selfTree()
  const viaCollect = await source.collectMeta(tree)
  const viaSweep = {}
  for (const p of leafPaths(tree)) {
    const meta = await source.metaFor(p)
    if (Object.keys(meta).length) viaSweep[p] = meta
  }
  assert.ok(Object.keys(viaSweep).length > 10, 'the simulator has published almost no meta')
  assert.deepEqual(viaCollect, viaSweep)
})

test('the catalog groups the simulator into recognisable instruments', async () => {
  const tree = await source.selfTree()
  const metaByPath = await source.collectMeta(tree)
  const catalog = buildCatalog({ tree, metaByPath, nowIso: new Date().toISOString() })
  assert.ok(catalog.path_count > 10, `only ${catalog.path_count} paths`)
  assert.ok(catalog.path_count <= catalog.max_paths, 'the discovery ceiling was not applied')
  assert.ok(catalog.instruments.device_count >= 3)
  const models = catalog.instruments.instruments.map((d) => d.model)
  assert.ok(models.some((m) => m.startsWith('RB-')), `no Rusty Boats gear in ${models}`)
})

test('a second catalog of an unchanged rig diffs to nothing removed', async () => {
  const tree = await source.selfTree()
  const metaByPath = await source.collectMeta(tree)
  const a = buildCatalog({ tree, metaByPath, nowIso: 'a' })
  const b = buildCatalog({ tree: await source.selfTree(), metaByPath, nowIso: 'b' })
  assert.deepEqual(diffCatalogs(a, b).removed, [])
})

test('the delta stream delivers live samples', async () => {
  const seen = []
  const sub = source.subscribe((s) => seen.push(s))
  await sleep(8000)
  sub.close()
  assert.ok(seen.length > 0, 'no deltas in 8s — is boat-sim publishing?')
  const pos = seen.find((s) => s.path === 'navigation.position')
  assert.ok(pos, `no position in ${[...new Set(seen.map((s) => s.path))].slice(0, 20)}`)
  assert.equal(typeof pos.value.latitude, 'number')
  assert.equal(typeof pos.value.longitude, 'number')
})

test('a plan drives the buffer end to end, at the cadence it asks for', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-e2e-'))
  const buffer = createBuffer({ dir })

  const applied = applyPlan({
    schema: 1,
    plan_id: 'pl_e2e',
    version: 1,
    budget: { max_msgs_per_min: 1000, max_bytes_per_hour: 10 ** 9 },
    defaults: { policy: 'on_change', min_interval_s: 1, max_interval_s: 60 },
    mappings: [
      { path: 'navigation.position', as: 'position', policy: 'on_change',
        deadband: { meters: 1 }, min_interval_s: 1, max_interval_s: 30,
        priority: 'high', round: 5 },
      { path: 'environment.wind.speedApparent', as: 'wind_speed_apparent',
        policy: 'periodic', interval_s: 2, priority: 'normal', round: 2 }
    ]
  }, { consent: ['navigation.position', 'environment.wind.speedApparent'], deny: [] })
  assert.equal(applied.ok, true)
  assert.deepEqual(applied.rejected, [])

  const emit = new Map()
  const sub = source.subscribe((sample) => {
    const mapping = applied.mappings.find((m) => m.path === sample.path)
    if (!mapping) return
    const nowMs = Date.now()
    const state = emit.get(sample.path) || {}
    if (!decide({ mapping, state, sample, nowMs, transport: applied.transport }).emit) return
    buffer.append({
      t: nowMs,
      priority: mapping.priority,
      n: mapping.as,
      p: sample.path,
      v: applyRound(mapping, sample.value),
      plan_id: applied.plan_id,
      plan_version: applied.version
    })
    emit.set(sample.path, { lastEmitMs: nowMs, lastValue: sample.value })
  })
  await sleep(12000)
  sub.close()

  const batch = buffer.peek(500)
  assert.ok(batch.records.length > 0, 'the plan produced nothing in 12s')
  const names = new Set(batch.records.map((r) => r.n))
  assert.ok(names.has('position'), 'the wire name `as` is not being used')

  // The periodic wind mapping asks for every 2s; 12s must not produce 60.
  const wind = batch.records.filter((r) => r.n === 'wind_speed_apparent')
  assert.ok(wind.length <= 7, `periodic cadence not honoured: ${wind.length} in 12s`)

  // round: 5 on a position must have actually shortened the payload.
  const pos = batch.records.find((r) => r.n === 'position')
  assert.ok((String(pos.v.latitude).split('.')[1] || '').length <= 5)

  // Ascending time across lanes, which is what backfill ordering depends on.
  const times = batch.records.map((r) => r.t)
  assert.deepEqual(times, [...times].sort((a, b) => a - b))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an off mapping really sends nothing', async () => {
  const applied = applyPlan({
    schema: 1,
    plan_id: 'pl_off',
    version: 1,
    mappings: [{ path: 'navigation.position', as: 'position', policy: 'off' }]
  }, { consent: ['navigation.position'], deny: [] })
  let delivered = 0
  const emitted = []
  const sub = source.subscribe((sample) => {
    const m = applied.mappings.find((x) => x.path === sample.path)
    if (!m) return
    delivered += 1
    if (decide({ mapping: m, state: {}, sample, nowMs: Date.now(),
      transport: applied.transport }).emit) emitted.push(sample)
  })
  await sleep(5000)
  sub.close()
  // Without this, a dead delta socket would make "sent nothing" pass vacuously.
  assert.ok(delivered > 0, 'no position samples arrived to be suppressed')
  assert.deepEqual(emitted, [])
})
