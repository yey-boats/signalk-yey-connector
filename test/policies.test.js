'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { decide, exceedsDeadband, distanceMeters, effectiveIntervalS,
        applyRound, sameValue } = require('../lib/policies')
const { DEFAULT_TRANSPORT } = require('../lib/plan')

const T = DEFAULT_TRANSPORT
const QUIET = { ...DEFAULT_TRANSPORT, quiet_mode: true, quiet_interval_multiplier: 4 }

// Every test below hands `decide` an explicit nowMs and an explicit lastEmitMs.
// Nothing here reads a real clock, so a 600-second heartbeat is three integers
// rather than a ten-minute test.

test('distanceMeters is a real haversine, not a degree subtraction', () => {
  // 0.001 degree of latitude is ~111.19 m anywhere on the globe.
  const d = distanceMeters({ latitude: 45.0, longitude: 13.0 },
    { latitude: 45.001, longitude: 13.0 })
  assert.ok(Math.abs(d - 111.19) < 1.0, `expected ~111m, got ${d}`)
})

test('distanceMeters accounts for longitude convergence at latitude', () => {
  const equator = distanceMeters({ latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0.001 })
  const north = distanceMeters({ latitude: 60, longitude: 0 },
    { latitude: 60, longitude: 0.001 })
  assert.ok(north < equator * 0.55, 'a degree of longitude shrinks with cos(lat)')
})

test('distanceMeters refuses anything that is not a position', () => {
  assert.equal(distanceMeters(null, { latitude: 1, longitude: 1 }), Infinity)
  assert.equal(distanceMeters({ latitude: 1 }, { latitude: 1, longitude: 1 }), Infinity)
  assert.equal(distanceMeters(5, { latitude: 1, longitude: 1 }), Infinity)
})

test('exceedsDeadband: absolute', () => {
  assert.equal(exceedsDeadband({ abs: 0.5 }, 10, 10.4), false)
  assert.equal(exceedsDeadband({ abs: 0.5 }, 10, 10.6), true)
})

test('exceedsDeadband: percentage is relative to the previous value', () => {
  assert.equal(exceedsDeadband({ pct: 2 }, 100, 101), false)
  assert.equal(exceedsDeadband({ pct: 2 }, 100, 103), true)
  // A previous value of zero has no meaningful percentage — any change counts.
  assert.equal(exceedsDeadband({ pct: 2 }, 0, 0.0001), true)
})

test('exceedsDeadband: metres, on a position object', () => {
  const a = { latitude: 45.0, longitude: 13.0 }
  assert.equal(exceedsDeadband({ meters: 25 }, a, { latitude: 45.0001, longitude: 13.0 }), false)
  assert.equal(exceedsDeadband({ meters: 25 }, a, { latitude: 45.001, longitude: 13.0 }), true)
})

test('a metres deadband on something that stopped being a position is a change', () => {
  /* A source dropping out turns navigation.position into null-ish rubbish. A
     zero-metre move would suppress that forever; it is news. */
  const a = { latitude: 45.0, longitude: 13.0 }
  assert.equal(exceedsDeadband({ meters: 25 }, a, { latitude: 45.0 }), true)
  assert.equal(exceedsDeadband({ meters: 25 }, a, 'unavailable'), true)
  assert.equal(exceedsDeadband({ meters: 25 }, 'unavailable', 'unavailable'), false)
})

test('exceedsDeadband with no previous value is always true', () => {
  assert.equal(exceedsDeadband({ abs: 5 }, undefined, 1), true)
  assert.equal(exceedsDeadband({ meters: 25 }, null, { latitude: 1, longitude: 1 }), true)
})

test('exceedsDeadband with an empty deadband means every change counts', () => {
  assert.equal(exceedsDeadband({}, 10, 10), false)
  assert.equal(exceedsDeadband({}, 10, 10.0001), true)
  assert.equal(exceedsDeadband(undefined, 10, 10.0001), true)
})

test('exceedsDeadband on a non-numeric value compares by identity', () => {
  assert.equal(exceedsDeadband({ abs: 1 }, 'moored', 'moored'), false)
  assert.equal(exceedsDeadband({ abs: 1 }, 'moored', 'sailing'), true)
})

test('key order in an object value is not a change', () => {
  /* notifications.* is {state, message, method}; SignalK hands it back in
     whatever order the producer emitted. A JSON.stringify comparison would call
     that a change and republish an unchanged alarm on every single sample. */
  const prev = { state: 'alarm', message: 'MOB', method: ['visual', 'sound'] }
  const same = { method: ['visual', 'sound'], message: 'MOB', state: 'alarm' }
  assert.equal(sameValue(prev, same), true)
  assert.equal(exceedsDeadband({}, prev, same), false)
  assert.equal(exceedsDeadband({}, prev, { ...same, state: 'normal' }), true)
  assert.equal(exceedsDeadband({}, prev, { ...same, method: ['sound', 'visual'] }), true)
})

test('on_change emits the first sample', () => {
  const out = decide({ mapping: { policy: 'on_change', min_interval_s: 10,
    max_interval_s: 600, deadband: { abs: 1 } },
    state: {}, sample: { value: 5 }, nowMs: 1000, transport: T })
  assert.equal(out.emit, true)
  assert.equal(out.reason, 'first')
})

test('on_change suppresses a change inside the deadband', () => {
  const out = decide({ mapping: { policy: 'on_change', min_interval_s: 10,
    max_interval_s: 600, deadband: { abs: 1 } },
    state: { lastEmitMs: 0, lastValue: 5 }, sample: { value: 5.2 },
    nowMs: 20_000, transport: T })
  assert.equal(out.emit, false)
  assert.equal(out.reason, 'deadband')
})

test('on_change emits a change outside the deadband once min_interval has passed', () => {
  const out = decide({ mapping: { policy: 'on_change', min_interval_s: 10,
    max_interval_s: 600, deadband: { abs: 1 } },
    state: { lastEmitMs: 0, lastValue: 5 }, sample: { value: 9 },
    nowMs: 20_000, transport: T })
  assert.equal(out.emit, true)
  assert.equal(out.reason, 'change')
})

test('min_interval_s is a floor even for a huge change', () => {
  const out = decide({ mapping: { policy: 'on_change', min_interval_s: 10,
    max_interval_s: 600, deadband: { abs: 1 } },
    state: { lastEmitMs: 0, lastValue: 5 }, sample: { value: 5000 },
    nowMs: 3_000, transport: T })
  assert.equal(out.emit, false)
  assert.equal(out.reason, 'min_interval')
})

test('max_interval_s still heartbeats when nothing changed', () => {
  const out = decide({ mapping: { policy: 'on_change', min_interval_s: 10,
    max_interval_s: 600, deadband: { abs: 1 } },
    state: { lastEmitMs: 0, lastValue: 5 }, sample: { value: 5 },
    nowMs: 600_001, transport: T })
  assert.equal(out.emit, true)
  assert.equal(out.reason, 'heartbeat')
})

test('the heartbeat outranks the min_interval floor', () => {
  /* If it did not, a mapping whose min_interval exceeded its max_interval would
     go permanently silent — a plan typo becoming a data outage. */
  const out = decide({ mapping: { policy: 'on_change', min_interval_s: 900,
    max_interval_s: 600, deadband: { abs: 1 } },
    state: { lastEmitMs: 0, lastValue: 5 }, sample: { value: 5 },
    nowMs: 601_000, transport: T })
  assert.equal(out.emit, true)
  assert.equal(out.reason, 'heartbeat')
})

test('a mapping with no max_interval_s never heartbeats, and still honours the floor', () => {
  const m = { policy: 'on_change', min_interval_s: 10, deadband: { abs: 1 } }
  const state = { lastEmitMs: 0, lastValue: 5 }
  assert.equal(decide({ mapping: m, state, sample: { value: 5 },
    nowMs: 86_400_000, transport: T }).reason, 'deadband')
  assert.equal(decide({ mapping: m, state, sample: { value: 99 },
    nowMs: 5_000, transport: T }).reason, 'min_interval')
})

test('periodic emits on its interval and not between', () => {
  const m = { policy: 'periodic', interval_s: 60, min_interval_s: 5, max_interval_s: 300 }
  assert.equal(decide({ mapping: m, state: { lastEmitMs: 0 }, sample: { value: 1 },
    nowMs: 59_000, transport: T }).emit, false)
  assert.equal(decide({ mapping: m, state: { lastEmitMs: 0 }, sample: { value: 1 },
    nowMs: 60_000, transport: T }).emit, true)
})

test('periodic ignores the deadband — an unchanged value is still due', () => {
  const m = { policy: 'periodic', interval_s: 60, deadband: { abs: 1000 } }
  const out = decide({ mapping: m, state: { lastEmitMs: 0, lastValue: 1 },
    sample: { value: 1 }, nowMs: 60_000, transport: T })
  assert.equal(out.emit, true)
  assert.equal(out.reason, 'periodic')
})

test('periodic with no interval at all falls back to min_interval_s', () => {
  const m = { policy: 'periodic', min_interval_s: 30 }
  assert.equal(decide({ mapping: m, state: { lastEmitMs: 0 }, sample: { value: 1 },
    nowMs: 29_000, transport: T }).emit, false)
  assert.equal(decide({ mapping: m, state: { lastEmitMs: 0 }, sample: { value: 1 },
    nowMs: 30_000, transport: T }).emit, true)
})

test('off never emits, whatever happens', () => {
  const out = decide({ mapping: { policy: 'off' }, state: {},
    sample: { value: 12345 }, nowMs: 10 ** 9, transport: T })
  assert.equal(out.emit, false)
  assert.equal(out.reason, 'off')
})

test('a sample with no value never emits', () => {
  const out = decide({ mapping: { policy: 'on_change', min_interval_s: 1, max_interval_s: 10 },
    state: {}, sample: { value: undefined }, nowMs: 1000, transport: T })
  assert.equal(out.emit, false)
  assert.equal(out.reason, 'no_value')
})

test('NaN and Infinity are not values', () => {
  /* They survive JSON as `null`, and the deadband arithmetic would quietly
     swallow them (NaN >= x is false) instead of refusing them. */
  const m = { policy: 'on_change', min_interval_s: 1, max_interval_s: 10 }
  for (const value of [NaN, Infinity, -Infinity]) {
    const out = decide({ mapping: m, state: { lastEmitMs: 0, lastValue: 5 },
      sample: { value }, nowMs: 5_000, transport: T })
    assert.equal(out.emit, false)
    assert.equal(out.reason, 'no_value')
  }
})

test('decide never throws on a missing argument', () => {
  assert.equal(decide().emit, false)
  assert.equal(decide({}).reason, 'no_value')
})

test('quiet mode multiplies every interval without changing the plan', () => {
  /* spec "fleet-wide quiet mode that reduces cadence across every boat at once",
     pushed as a plan field so an incident is answered in seconds. */
  assert.equal(effectiveIntervalS({ min_interval_s: 10 }, 'min_interval_s', T), 10)
  assert.equal(effectiveIntervalS({ min_interval_s: 10 }, 'min_interval_s', QUIET), 40)
  const out = decide({ mapping: { policy: 'on_change', min_interval_s: 10,
    max_interval_s: 600, deadband: { abs: 1 } },
    state: { lastEmitMs: 0, lastValue: 5 }, sample: { value: 9 },
    nowMs: 20_000, transport: QUIET })
  assert.equal(out.emit, false, 'quiet mode raises the floor from 10s to 40s')
})

test('quiet mode stretches the heartbeat and the periodic interval too', () => {
  const beat = { policy: 'on_change', min_interval_s: 10, max_interval_s: 600,
    deadband: { abs: 1 } }
  assert.equal(decide({ mapping: beat, state: { lastEmitMs: 0, lastValue: 5 },
    sample: { value: 5 }, nowMs: 600_001, transport: QUIET }).emit, false)
  assert.equal(decide({ mapping: beat, state: { lastEmitMs: 0, lastValue: 5 },
    sample: { value: 5 }, nowMs: 2_400_001, transport: QUIET }).reason, 'heartbeat')
  const periodic = { policy: 'periodic', interval_s: 60 }
  assert.equal(decide({ mapping: periodic, state: { lastEmitMs: 0 }, sample: { value: 1 },
    nowMs: 60_000, transport: QUIET }).emit, false)
  assert.equal(decide({ mapping: periodic, state: { lastEmitMs: 0 }, sample: { value: 1 },
    nowMs: 240_000, transport: QUIET }).emit, true)
})

test('quiet mode with a missing multiplier changes nothing', () => {
  // The transport block is remote input here too; a half-filled one must not
  // multiply an interval by zero and turn quiet mode into a flood.
  assert.equal(effectiveIntervalS({ min_interval_s: 10 }, 'min_interval_s',
    { quiet_mode: true }), 10)
  assert.equal(effectiveIntervalS({ min_interval_s: 10 }, 'min_interval_s',
    { quiet_mode: true, quiet_interval_multiplier: 0 }), 10)
  assert.equal(effectiveIntervalS({ min_interval_s: 10 }, 'min_interval_s', undefined), 10)
  assert.equal(effectiveIntervalS({}, 'min_interval_s', T), 0)
})

test('applyRound rounds a number and leaves everything else alone', () => {
  assert.equal(applyRound({ round: 2 }, 3.14159), 3.14)
  assert.equal(applyRound({ round: 5 }, 45.1234567), 45.12346)
  assert.equal(applyRound({}, 3.14159), 3.14159)
  assert.equal(applyRound({ round: 2 }, 'moored'), 'moored')
})

test('applyRound rounds the members of a position object', () => {
  const out = applyRound({ round: 5 }, { latitude: 45.1234567, longitude: 13.7654321 })
  assert.deepEqual(out, { latitude: 45.12346, longitude: 13.76543 })
})

test('applyRound leaves non-numeric members of an object alone', () => {
  const out = applyRound({ round: 2 },
    { state: 'alarm', message: 'MOB', value: 1.23456 })
  assert.deepEqual(out, { state: 'alarm', message: 'MOB', value: 1.23 })
})
