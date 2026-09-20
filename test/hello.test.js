'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { buildHello, POLICIES, TRANSFORMS, LIMITS, DEFAULT_BUFFER_BYTES,
        PLAN_SCHEMA_MIN, PLAN_SCHEMA_MAX } = require('../lib/hello')

test('hello carries every field the cloud reads', () => {
  const h = buildHello({
    version: '0.1.0',
    signalk: { version: '2.7.1', plugins: ['signalk-to-influxdb'] },
    vessel: { mmsi: '238123456', name: 'Sara' }
  })
  assert.equal(h.schema, 'yey.connector.hello.v1')
  assert.equal(h.connector_version, '0.1.0')
  assert.deepEqual(h.plan_schema, { min: PLAN_SCHEMA_MIN, max: PLAN_SCHEMA_MAX })
  assert.deepEqual(h.policies, POLICIES)
  assert.deepEqual(h.transforms, TRANSFORMS)
  assert.deepEqual(h.limits, LIMITS)
  assert.equal(h.signalk.version, '2.7.1')
  assert.equal(h.vessel.name, 'Sara')
})

test('the fields Y1 reads out of a hello are exactly where it looks for them', () => {
  /* boat_pairing.project_hello keeps connector_version, plan_schema.{min,max},
     signalk.version and vessel.{name,mmsi} and drops everything else;
     signalk_boat_pair and the claim-confirm op read plan_schema["max"]
     (entrypoint.py:4046-4047, :5051-5053). If any of those move, the confirm
     screen silently shows a blank boat. */
  const h = buildHello({ version: '1.2.3', signalk: { version: '2.7.1' },
                         vessel: { name: 'Sara', mmsi: '238123456' } })
  assert.equal(typeof h.connector_version, 'string')
  assert.equal(typeof h.plan_schema.max, 'number')
  assert.equal(typeof h.signalk.version, 'string')
  assert.equal(typeof h.vessel.name, 'string')
  assert.equal(typeof h.vessel.mmsi, 'string')
})

test('v1 declares exactly the three policies it implements', () => {
  assert.deepEqual(POLICIES, ['periodic', 'on_change', 'off'])
  assert.ok(!POLICIES.includes('window'))
  assert.ok(!POLICIES.includes('on_event'))
})

test('every declared policy is one the policy engine actually executes', () => {
  /* The list is a promise to the cloud. A policy named here that `decide` does
     not implement would fall through to the on_change branch and quietly run
     something else. */
  const { decide } = require('../lib/policies')
  const sample = { value: 5 }
  const state = { lastEmitMs: 0, lastValue: 1 }
  const transport = require('../lib/plan').DEFAULT_TRANSPORT
  const reasons = {
    periodic: 'periodic',
    on_change: 'change',
    off: 'off'
  }
  for (const policy of POLICIES) {
    const out = decide({
      mapping: { policy, interval_s: 60, min_interval_s: 10, max_interval_s: 600 },
      state,
      sample,
      nowMs: 120_000,
      transport
    })
    assert.equal(out.reason, reasons[policy], `policy ${policy} is not implemented`)
  }
})

test('every declared transform is one some module actually implements', () => {
  /* `requires: [x]` is rejected by lib/plan.js unless x is in POLICIES or
     TRANSFORMS, so anything named here must really work — otherwise the
     connector accepts a mapping it cannot honour. */
  const { applyRound, exceedsDeadband } = require('../lib/policies')
  const { applyPlan } = require('../lib/plan')
  assert.deepEqual(TRANSFORMS, ['round', 'deadband', 'quantity'])

  assert.equal(applyRound({ round: 2 }, 3.14159), 3.14)
  assert.equal(exceedsDeadband({ abs: 1 }, 10, 10.1), false)
  assert.equal(exceedsDeadband({ meters: 25 }, { latitude: 45, longitude: 13 },
    { latitude: 45.01, longitude: 13 }), true)

  const applied = applyPlan({
    schema: 1, plan_id: 'pl_t', version: 1,
    mappings: [{ path: 'environment.wind.speedApparent', as: 'wind',
                 policy: 'on_change', deadband: { pct: 2 }, round: 2,
                 quantity: 'speed', requires: TRANSFORMS }]
  }, { consent: ['environment.wind.speedApparent'], deny: [] })
  assert.deepEqual(applied.rejected, [], 'a mapping requiring our own transforms must apply')
  assert.deepEqual(applied.mappings[0].deadband, { pct: 2 })
  assert.equal(applied.mappings[0].round, 2)
  assert.equal(applied.mappings[0].quantity, 'speed')
})

test('hello survives a boat that knows nothing about itself', () => {
  const h = buildHello({ version: '0.1.0' })
  assert.equal(h.signalk.version, '')
  assert.deepEqual(h.vessel, { name: '', mmsi: '' })
  assert.equal(h.connector_version, '0.1.0')
})

test('buildHello survives being called with nothing at all', () => {
  const h = buildHello()
  assert.equal(h.connector_version, '')
  assert.deepEqual(h.signalk.plugins, [])
})

test('projected fields are clipped to the width the cloud stores', () => {
  /* boat_pairing._HELLO_FIELD_MAX is 128 (boat_pairing.py:32; HELLO_MAX_BYTES
     is the 4096 on :31). Clipping here too means what the plugin screen shows
     matches what the cloud stored. */
  const long = 'x'.repeat(500)
  const h = buildHello({ version: long, signalk: { version: long },
                         vessel: { name: long, mmsi: long } })
  for (const value of [h.connector_version, h.signalk.version, h.vessel.name, h.vessel.mmsi]) {
    assert.equal(value.length, 128)
  }
})

test('the projected hello stays inside the cloud 4096-byte ceiling', () => {
  /* project_hello raises "hello too large" above HELLO_MAX_BYTES, which would
     fail the pairing op. It measures the PROJECTION, so the plugin list is not
     in it — this pins that the fields which ARE projected cannot get there
     however long a boat's strings are. */
  const long = 'x'.repeat(5000)
  const h = buildHello({ version: long, signalk: { version: long, plugins: Array.from(
    { length: 200 }, () => long) }, vessel: { name: long, mmsi: long } })
  const projected = {
    connector_version: h.connector_version,
    plan_schema: h.plan_schema,
    signalk: { version: h.signalk.version },
    vessel: h.vessel
  }
  assert.ok(JSON.stringify(projected).length <= 4096,
    `projected hello is ${JSON.stringify(projected).length} bytes`)
})

test('limits are real numbers a plan can be checked against', () => {
  assert.ok(LIMITS.max_mappings > 0)
  assert.ok(LIMITS.min_interval_s >= 1)
  assert.ok(LIMITS.buffer_bytes > 0)
})

test('the advertised buffer is the one this boat is actually running', () => {
  /* The bug this pins (a recorded residual finding in the plan): LIMITS held a
     hard-coded 50 MiB that the cloud was told to size backfill against, while
     the runtime sized the real buffer from the owner's `bufferMegabytes`
     option. A boat configured for 10 MB told the cloud it had 50. */
  const h = buildHello({ version: '0.1.0', bufferBytes: 10 * 1024 * 1024 })
  assert.equal(h.limits.buffer_bytes, 10 * 1024 * 1024)
  assert.notEqual(h.limits.buffer_bytes, DEFAULT_BUFFER_BYTES)
})

test('an unusable buffer size falls back to the default, never to nonsense', () => {
  for (const bad of [undefined, null, 0, -1, NaN, Infinity, '10485760', true]) {
    assert.equal(buildHello({ version: '0.1.0', bufferBytes: bad }).limits.buffer_bytes,
      DEFAULT_BUFFER_BYTES, `bufferBytes ${JSON.stringify(bad)} must not be advertised`)
  }
})

test('the plugin list is reported but bounded', () => {
  const h = buildHello({
    version: '0.1.0',
    signalk: { version: '2.7.1', plugins: Array.from({ length: 200 }, (_, i) => `p${i}`) }
  })
  assert.ok(h.signalk.plugins.length <= 50)
})

test('mutating a hello cannot corrupt the module constants', () => {
  const h = buildHello({ version: '0.1.0' })
  h.policies.push('window')
  h.limits.max_mappings = 1
  assert.deepEqual(POLICIES, ['periodic', 'on_change', 'off'])
  assert.equal(LIMITS.max_mappings, 200)
})

// ── The cross-repo capability contract ───────────────────────────────────────
// A vocabulary mismatch here is invisible in every unit test on either side and
// fatal in production: the cloud sends a plan the boat cannot run, and the boat
// rejects mappings the cloud believes it accepted. Set YEY_BUNDLE_PATH to a
// navigator-tg-bot checkout to enable (same convention as test/contract.test.js).

const BUNDLE = process.env.YEY_BUNDLE_PATH

test('the policy vocabulary matches boat_plan.py', { skip: !BUNDLE }, () => {
  const src = fs.readFileSync(
    path.join(BUNDLE, 'bundles/signalk@2026-06-05/boat_plan.py'), 'utf8')

  const tuple = (name) => {
    const m = src.match(new RegExp(`^${name}\\s*(?::[^=]+)?=\\s*\\(([^)]*)\\)`, 'm'))
    assert.ok(m, `boat_plan.py has no ${name}`)
    return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }

  // What a plan BUILT by the cloud may use must be exactly what we declare —
  // otherwise the default plan is one every boat partially rejects on arrival.
  assert.deepEqual(tuple('DEFAULT_POLICIES'), POLICIES,
    'boat_plan.DEFAULT_POLICIES and lib/hello.POLICIES disagree')

  // The schema's wider vocabulary must be a SUPERSET: a policy we declare that
  // the schema does not know could never reach us in a plan.
  const schemaPolicies = tuple('PLAN_POLICIES')
  for (const policy of POLICIES) {
    assert.ok(schemaPolicies.includes(policy),
      `${policy} is not in boat_plan.PLAN_POLICIES`)
  }

  const schema = src.match(/^PLAN_SCHEMA\s*=\s*(\d+)/m)
  assert.ok(schema, 'boat_plan.py has no PLAN_SCHEMA')
  assert.ok(Number(schema[1]) >= PLAN_SCHEMA_MIN && Number(schema[1]) <= PLAN_SCHEMA_MAX,
    `the cloud builds schema ${schema[1]}, which this connector would refuse whole`)
})
