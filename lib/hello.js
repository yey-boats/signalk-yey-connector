'use strict'

/**
 * The capability handshake: what this connector can actually execute.
 *
 * This is a CONTRACT, not a constants file. The cloud answers a hello with the
 * newest plan that fits inside these declarations, and `lib/plan.js` rejects —
 * by name, individually, with the rest of the plan still applying — any mapping
 * that needs something absent here. Declaring a policy we do not implement would
 * make the `requires` mechanism decorative and the failure silent, which is
 * exactly what the spec's "partial execution is visible, never silent" rule
 * exists to stop.
 *
 * The cloud half of the same contract lives in
 * `bundles/signalk@2026-06-05/boat_plan.py`:
 *   - PLAN_SCHEMA = 1                                  -> PLAN_SCHEMA_MIN/MAX
 *   - DEFAULT_POLICIES = periodic, on_change, off      -> POLICIES
 *     (its comment names THIS list: "the v1 connector declares exactly these
 *      three (lib/hello.js POLICIES)")
 *   - PLAN_POLICIES additionally holds `window` and `on_event`, which the SCHEMA
 *     knows and this connector does not — so a plan using one is rejected per
 *     mapping rather than misread.
 * test/hello.test.js reads boat_plan.py and fails if either side gains a policy
 * alone (set YEY_BUNDLE_PATH; test/contract.test.js does the same for the
 * transport bounds).
 */

const PLAN_SCHEMA_MIN = 1
const PLAN_SCHEMA_MAX = 1

// Cadence policies. Exactly boat_plan.DEFAULT_POLICIES, in the same order.
const POLICIES = ['periodic', 'on_change', 'off']

// Per-mapping features a plan may name in `requires`. All three are things this
// connector really does: `round` is lib/policies.applyRound, `deadband` is
// lib/policies.exceedsDeadband (abs, pct and a metres deadband on a position),
// and `quantity` is carried through onto the wire by lib/plan.projectMapping so
// the cloud can label the value's units. Naming only `round` — as the plan drafted
// it — would have the connector reject a mapping asking for `requires: ["deadband"]`
// that it executes perfectly well, which is a silent loss of data dressed up as a
// capability check. Nothing goes in this list that no module implements.
const TRANSFORMS = ['round', 'deadband', 'quantity']

// The plugin's own schema (index.js) offers `bufferMegabytes`, default 50.
// This is the DEFAULT only — see buildHello: what gets advertised is the buffer
// the boat was actually configured with.
const DEFAULT_BUFFER_BYTES = 50 * 1024 * 1024

const LIMITS = {
  max_mappings: 200,
  min_interval_s: 1,
  buffer_bytes: DEFAULT_BUFFER_BYTES
}

// boat_pairing._HELLO_FIELD_MAX (bundles/signalk@2026-06-05/boat_pairing.py:32;
// HELLO_MAX_BYTES = 4096 is the line above it, :31). Clipping to the same width
// here means the plugin screen shows what the cloud actually stored. The 4096
// ceiling applies to the PROJECTED hello (connector_version, plan_schema,
// signalk.version, vessel.{name,mmsi}) — project_hello drops the plugin list
// before measuring, so the list below cannot push a pairing over it.
const FIELD_MAX = 128

// A boat with 200 plugins is interesting; sending all of them is not. The cloud
// stores none of this today (project_hello drops it) — it is here for the
// support conversation that starts "what else is running on that box".
const MAX_PLUGINS = 50

const clip = (value) => String(value == null ? '' : value).slice(0, FIELD_MAX)

/** The configured buffer size, or the default when the caller did not say.
 *  Anything unusable (0, negative, NaN, a string, a boolean) falls back rather
 *  than advertising a nonsense number the cloud would check a plan against. */
function bufferBytesOf (value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_BUFFER_BYTES
  }
  return Math.trunc(value)
}

/**
 * Build the hello document.
 *
 * `bufferBytes` is the buffer this boat is ACTUALLY running with (the runtime
 * sizes it from the owner's `bufferMegabytes` option). It is a parameter rather
 * than a constant because the cloud is told these are "real numbers a plan can
 * be checked against": a boat configured for 10 MB that reports the 50 MB
 * default is telling the cloud it can absorb five times the outage it can, and
 * the cloud sizes backfill against the answer.
 */
function buildHello ({ version, signalk, vessel, bufferBytes } = {}) {
  const sk = signalk || {}
  const v = vessel || {}
  return {
    schema: 'yey.connector.hello.v1',
    connector_version: clip(version),
    plan_schema: { min: PLAN_SCHEMA_MIN, max: PLAN_SCHEMA_MAX },
    policies: [...POLICIES],
    transforms: [...TRANSFORMS],
    limits: { ...LIMITS, buffer_bytes: bufferBytesOf(bufferBytes) },
    signalk: {
      version: clip(sk.version),
      plugins: (Array.isArray(sk.plugins) ? sk.plugins : []).slice(0, MAX_PLUGINS).map(clip)
    },
    vessel: { name: clip(v.name), mmsi: clip(v.mmsi) }
  }
}

module.exports = {
  PLAN_SCHEMA_MIN,
  PLAN_SCHEMA_MAX,
  POLICIES,
  TRANSFORMS,
  LIMITS,
  DEFAULT_BUFFER_BYTES,
  FIELD_MAX,
  MAX_PLUGINS,
  bufferBytesOf,
  buildHello
}
