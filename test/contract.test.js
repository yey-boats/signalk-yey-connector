'use strict'
// The cross-repo half of the plan schema: lib/plan.js mirrors boat_plan.py on a
// different release cycle, and neither suite can see a divergence alone. Set
// YEY_BUNDLE_PATH to a navigator checkout to enable (CI's cross-repo-contract job
// does). The policy vocabulary and the etag have their own checks in
// test/hello.test.js and test/plan.test.js.
//
// It reads the PYTHON SOURCE TEXT rather than importing anything: the two repos
// are on independent release cycles and there is no shared artefact yet (the
// spec's open item "where the plan schema lives", midl the candidate). Parsing
// the literal is the only check available, which is why the `"key": (lo, hi)`
// spelling on the Python side is load-bearing formatting (boat_plan.py says so).
//
// Y7 depends on these tables agreeing: the fleet-scaled transport curve the
// cloud pushes is clamped by the cloud's bounds and then re-clamped by ours, so
// a bound that exists or differs on one side only silently changes the herd.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { TRANSPORT_BOUNDS, DEFAULT_TRANSPORT, DEFAULT_BUDGET, applyPlan } = require('../lib/plan')

// A navigator-tg-bot checkout (the CI and hello.test.js convention). A path to
// the bundle directory itself is accepted too, so a hand run cannot fail on
// which of the two spellings the operator happened to type.
const BUNDLE = process.env.YEY_BUNDLE_PATH
const PLAN_PY = BUNDLE
  ? [path.join(BUNDLE, 'bundles/signalk@2026-06-05/boat_plan.py'),
     path.join(BUNDLE, 'boat_plan.py')].find((p) => fs.existsSync(p)) || null
  : null

function planSource () {
  return fs.readFileSync(PLAN_PY, 'utf8')
}

/** The body of one top-level `NAME...= {` dict literal, up to its first `}`.
 *  The tables are flat, so the first closing brace ends them. */
function dictBody (src, name) {
  const m = src.match(new RegExp(`^${name}\\b[^=\\n]*=\\s*\\{([^}]*)\\}`, 'm'))
  assert.ok(m, `boat_plan.py has no ${name} dict literal`)
  return m[1]
}

/** Parse `"key": (lo, hi),` pairs out of the TRANSPORT_BOUNDS literal. */
function pyBounds (src) {
  const out = {}
  for (const m of dictBody(src, 'TRANSPORT_BOUNDS').matchAll(/"([a-z_]+)":\s*\((\d+),\s*(\d+)\)/g)) {
    out[m[1]] = [Number(m[2]), Number(m[3])]
  }
  return out
}

/** Parse `"key": value,` pairs out of a flat dict literal. Python True/False
 *  become JS booleans; everything else must be an integer. An entry of any
 *  other shape is a failure, not a skip: an unparsed key is an unchecked key. */
function pyScalars (src, name) {
  const out = {}
  for (const line of dictBody(src, name).split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = t.match(/^"([a-z_]+)":\s*(True|False|\d+),?$/)
    assert.ok(m, `${name}: cannot parse entry ${JSON.stringify(t)}`)
    out[m[1]] = m[2] === 'True' ? true : m[2] === 'False' ? false : Number(m[2])
  }
  return out
}

test('YEY_BUNDLE_PATH, when set, points at a bundle with boat_plan.py', { skip: !BUNDLE }, () => {
  // A contract test that passes because the other half was not found is worse
  // than no test at all: set-but-wrong is a failure, unset is a visible skip.
  assert.ok(PLAN_PY, `no boat_plan.py under ${BUNDLE} (tried bundles/signalk@2026-06-05/ and the path itself)`)
})

test('transport bounds and defaults match boat_plan.py', { skip: !BUNDLE }, () => {
  const src = planSource()
  for (const [key, [lo, hi]] of Object.entries(TRANSPORT_BOUNDS)) {
    const m = src.match(new RegExp(`"${key}":\\s*\\((\\d+),\\s*(\\d+)\\)`))
    assert.ok(m, `boat_plan.TRANSPORT_BOUNDS has no ${key}`)
    assert.equal(Number(m[1]), lo, `${key} floor differs`)
    assert.equal(Number(m[2]), hi, `${key} ceiling differs`)
  }
  for (const [key, value] of Object.entries(DEFAULT_TRANSPORT)) {
    const expected = typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value)
    assert.ok(src.includes(`"${key}": ${expected}`),
      `boat_plan.DEFAULT_TRANSPORT["${key}"] is not ${expected}`)
  }
  for (const [key, value] of Object.entries(DEFAULT_BUDGET)) {
    assert.ok(src.includes(`"${key}": ${value}`),
      `boat_plan.DEFAULT_BUDGET["${key}"] is not ${value}`)
  }
})

test('the two TRANSPORT_BOUNDS tables have the same keys and the same bounds, both directions',
  { skip: !BUNDLE }, () => {
    // The test above walks OUR keys only; a bound the cloud added and we did
    // not would pass it. This one compares the parsed tables whole.
    const py = pyBounds(planSource())
    assert.deepEqual(Object.keys(py).sort(), Object.keys(TRANSPORT_BOUNDS).sort(),
      'a bounded transport key exists on one side only')
    for (const [key, [lo, hi]] of Object.entries(py)) {
      assert.deepEqual(TRANSPORT_BOUNDS[key], [lo, hi], `bounds differ for ${key}`)
    }
  })

test('the two DEFAULT_TRANSPORT tables are identical', { skip: !BUNDLE }, () => {
  assert.deepEqual(pyScalars(planSource(), 'DEFAULT_TRANSPORT'), { ...DEFAULT_TRANSPORT })
})

test('the two DEFAULT_BUDGET tables are identical', { skip: !BUNDLE }, () => {
  assert.deepEqual(pyScalars(planSource(), 'DEFAULT_BUDGET'), { ...DEFAULT_BUDGET })
})

test('quiet_mode is the one unbounded key, on both sides', { skip: !BUNDLE }, () => {
  const src = planSource()
  assert.ok(!('quiet_mode' in TRANSPORT_BOUNDS), 'quiet_mode must not be in the bounds table')
  assert.ok(!('quiet_mode' in pyBounds(src)), 'quiet_mode must not be in the Python bounds table')
  assert.equal(DEFAULT_TRANSPORT.quiet_mode, false)
  assert.equal(pyScalars(src, 'DEFAULT_TRANSPORT').quiet_mode, false)
  const unbounded = Object.keys(DEFAULT_TRANSPORT).filter((k) => !(k in TRANSPORT_BOUNDS))
  assert.deepEqual(unbounded, ['quiet_mode'])
})

test('every bounded key has a default inside its own bounds', () => {
  for (const [key, [lo, hi]] of Object.entries(TRANSPORT_BOUNDS)) {
    const v = DEFAULT_TRANSPORT[key]
    assert.equal(typeof v, 'number', `${key} has no numeric default`)
    assert.ok(v >= lo && v <= hi, `default ${key}=${v} is outside [${lo}, ${hi}]`)
  }
})

test('backfill_chunk_msgs cannot exceed what the cloud ingress admits', () => {
  // policy.py:38-45 — at most 200 messages per package for a registered actor.
  // A plan asking for more does not get more data through; it gets the whole
  // package rejected, and lib/runtime.js re-sends the same chunk next tick.
  assert.equal(TRANSPORT_BOUNDS.backfill_chunk_msgs[1], 200)
})

test('the connector rejects a schema the cloud would emit as newer', () => {
  // PLAN_SCHEMA is 1 on both sides today; this is the guard for the day it is not.
  assert.equal(applyPlan({ schema: 2, mappings: [] }, { consent: [], deny: [] }).ok, false)
})
