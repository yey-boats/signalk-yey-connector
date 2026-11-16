'use strict'

/**
 * The one autopilot command policy (#28, #21). Every remote-steering `put` the
 * cloud sends is checked HERE, on the boat, by this module and nothing else;
 * lib/rpc.js opPut only calls it. The same rules are published through the
 * `capabilities` op (describePolicy), versioned, so the cloud and the displays
 * can read the boat's rules instead of keeping their own copy.
 *
 * Derived from the six implementations in test/fixtures/steering-implementations.json
 * (firmware, cloud, connector 0.4, sim plugin, the removed manager bridge, the
 * Python sim). The rules:
 *
 *   paths     an exact allowlist. The action vocabulary is the actions some
 *             implementation actually sends or handles (adjustHeading, tack,
 *             advanceMode), plus advanceWaypoint, which the stock SignalK
 *             autopilot plugin (@signalk/signalk-autopilot) registers a PUT
 *             handler for with a documented value of 1 (#35); not "any
 *             segment".
 *   values    one validator per path: the mode enum, radians in [0, 2π) for a
 *             heading target, [-π, π] for a wind angle, degrees within ±150
 *             for adjustHeading, port|starboard|true for tack, true for
 *             advanceMode, 1 for advanceWaypoint. Out of range is REFUSED, never clamped: the cloud
 *             contract (navigator remote_steering.py) refuses an explicit step
 *             past 150° and clamps only the tack/gybe turn it computes itself,
 *             before sending; so a value past the bound reaching the boat is a
 *             bug (degrees as radians, a runaway argument), not a manoeuvre.
 *   rate      12 admitted puts a minute.
 *   request   boat_id REQUIRED, a string, and equal to this boat; deadline_ms
 *             REQUIRED, not past and at most 15 s ahead (the cloud sets it
 *             about 5 s ahead; a far-future deadline would let a stale put
 *             through, and outlive the replay window). The request rate is
 *             admitted BEFORE the id is recorded (rpc.js), so a flood cannot
 *             fill the store (#35); the request id is remembered until
 *             its deadline + 10 min, in a 0600 file in the plugin data dir, so
 *             a replay is dropped across restarts. The store is bounded; when
 *             it is full of live ids the put is refused (fail closed).
 *
 * The cloud (navigator boat_rpc.call) has sent boat_id and deadline_ms on every
 * request since the first boat RPC (8dc79de7), so both are required
 * unconditionally; no version negotiation is needed.
 */

const fsDefault = require('node:fs')
const { createRequestGuard, createRate } = require('./request-guard')

// 2: advanceWaypoint, deadline window 15 s, boat_id must be a string (#35).
const POLICY_VERSION = 2
const POLICY_SCHEMA = 'yey.steering.policy.v1'
const REPLAY_FILE = 'yey-steering-replay.json'

const TWO_PI = 2 * Math.PI
const MAX_HEADING_STEP_DEG = 150
// Every autopilot mode any implementation sends or handles (fixture table).
const MODES = Object.freeze(['standby', 'auto', 'wind', 'route', 'track', 'pretrack'])

const PUTS_PER_MIN = 12
const MAX_DEADLINE_AHEAD_MS = 15 * 1000
const REPLAY_RETENTION_MS = 10 * 60 * 1000
const MAX_REPLAY_IDS = 1024

const heading = (desc) => Object.freeze({ type: 'number', unit: 'rad', min: 0, max: TWO_PI, max_exclusive: true, desc })

/** The allowlist, path -> rule. Published as-is (JSON-safe). */
const RULES = Object.freeze({
  'steering.autopilot.state': Object.freeze({ type: 'enum', values: MODES, desc: 'autopilot mode' }),
  'steering.autopilot.target.headingTrue': heading('target heading, true'),
  'steering.autopilot.target.headingMagnetic': heading('target heading, magnetic'),
  'steering.autopilot.target.windAngleApparent': Object.freeze({
    type: 'number', unit: 'rad', min: -Math.PI, max: Math.PI, desc: 'target apparent wind angle, + starboard'
  }),
  'steering.autopilot.actions.adjustHeading': Object.freeze({
    type: 'number', unit: 'deg', min: -MAX_HEADING_STEP_DEG, max: MAX_HEADING_STEP_DEG, desc: 'relative heading change, + starboard'
  }),
  'steering.autopilot.actions.tack': Object.freeze({ type: 'enum', values: Object.freeze(['port', 'starboard', true]), desc: 'tack' }),
  'steering.autopilot.actions.advanceMode': Object.freeze({ type: 'enum', values: Object.freeze([true]), desc: 'next mode (trigger)' }),
  'steering.autopilot.actions.advanceWaypoint': Object.freeze({
    type: 'enum', values: Object.freeze([1]), desc: 'next waypoint (trigger; signalk-autopilot, route mode only)'
  })
})
const PATHS = Object.freeze(Object.keys(RULES))

function isSteeringPath (path) {
  return typeof path === 'string' && Object.prototype.hasOwnProperty.call(RULES, path)
}

/** '' when `value` is allowed at `path`, else why not. */
function validateValue (path, value) {
  const rule = isSteeringPath(path) ? RULES[path] : null
  if (!rule) return 'path_not_allowed'
  if (rule.type === 'enum') return rule.values.includes(value) ? '' : 'value_not_allowed'
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'value_type'
  if (value < rule.min || value > rule.max || (rule.max_exclusive && value >= rule.max)) return 'value_out_of_range'
  return ''
}

/** The policy as published by `capabilities`. */
function describePolicy () {
  const paths = {}
  for (const [p, r] of Object.entries(RULES)) paths[p] = { ...r, ...(r.values ? { values: [...r.values] } : {}) }
  return {
    schema: POLICY_SCHEMA,
    version: POLICY_VERSION,
    paths,
    max_heading_step_deg: MAX_HEADING_STEP_DEG,
    out_of_range: 'refuse',
    rate: { puts_per_min: PUTS_PER_MIN },
    request: { boat_id: 'required', deadline_ms: 'required', max_deadline_ahead_ms: MAX_DEADLINE_AHEAD_MS, replay: 'persisted' }
  }
}

function createSteeringPolicy ({
  dir = null, now = Date.now, boatId, fs = fsDefault, debug = () => {},
  putsPerMin = PUTS_PER_MIN, maxReplayIds = MAX_REPLAY_IDS
} = {}) {
  // The envelope and the replay memory (lib/request-guard.js), in this
  // policy's own file.
  const guard = createRequestGuard({
    dir, file: REPLAY_FILE, now, boatId, fs, debug, label: 'steering',
    maxDeadlineAheadMs: MAX_DEADLINE_AHEAD_MS, retentionMs: REPLAY_RETENTION_MS, maxIds: maxReplayIds
  })
  const admitRate = createRate({ now, perMin: putsPerMin })

  return {
    checkRequest: guard.checkRequest,
    inspectRequest: guard.inspectRequest,
    recordRequest: guard.recordRequest,
    admitRate,
    validateValue,
    isSteeringPath,
    describe: describePolicy,
    replaySize: guard.replaySize
  }
}

module.exports = {
  POLICY_VERSION, POLICY_SCHEMA, REPLAY_FILE, RULES, PATHS, MODES, MAX_HEADING_STEP_DEG,
  PUTS_PER_MIN, MAX_DEADLINE_AHEAD_MS, REPLAY_RETENTION_MS,
  isSteeringPath, validateValue, describePolicy, createSteeringPolicy
}
