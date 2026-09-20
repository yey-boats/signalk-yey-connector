'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { applyPlan, normalizeTransport, normalizeBudget, coveredBy, literalHead,
        canonicalJson, etagOf, toInt, REJECT_REASONS,
        DEFAULT_TRANSPORT, TRANSPORT_BOUNDS, DEFAULT_BUDGET } = require('../lib/plan')

const CONSENT = ['navigation.position', 'environment.wind.speedApparent', 'notifications']

function plan (overrides = {}) {
  return {
    plan_id: 'pl_1', version: 12, schema: 1,
    budget: { max_msgs_per_min: 30, max_bytes_per_hour: 262144 },
    defaults: { policy: 'on_change', min_interval_s: 5, max_interval_s: 300 },
    mappings: [
      { path: 'navigation.position', as: 'position', policy: 'on_change',
        deadband: { meters: 25 }, min_interval_s: 10, max_interval_s: 600,
        priority: 'high' }
    ],
    ...overrides
  }
}

test('a well-formed plan applies whole', () => {
  const out = applyPlan(plan(), { consent: CONSENT, deny: [] })
  assert.equal(out.ok, true)
  assert.equal(out.version, 12)
  assert.equal(out.mappings.length, 1)
  assert.deepEqual(out.rejected, [])
})

test('unknown keys are IGNORED, never fatal', () => {
  /* spec "Must-ignore": this is what lets the cloud add an optional field
     without waiting for every boat to update. */
  const out = applyPlan(plan({
    future_top_level: { anything: true },
    mappings: [{ path: 'navigation.position', as: 'position', policy: 'on_change',
                 future_mapping_key: 42 }]
  }), { consent: CONSENT, deny: [] })
  assert.equal(out.ok, true)
  assert.equal(out.mappings.length, 1)
  assert.equal(out.mappings[0].future_mapping_key, undefined)
})

test('a mapping using an unsupported policy is rejected BY NAME, the rest applies', () => {
  const out = applyPlan(plan({ mappings: [
    { path: 'navigation.position', as: 'position', policy: 'on_change' },
    { path: 'environment.wind.speedApparent', as: 'wind', policy: 'window',
      window_s: 60, aggs: ['avg', 'max'] }
  ] }), { consent: CONSENT, deny: [] })
  assert.equal(out.mappings.length, 1)
  assert.equal(out.mappings[0].as, 'position')
  assert.deepEqual(out.rejected, [
    { path: 'environment.wind.speedApparent', as: 'wind', reason: 'unsupported_policy',
      detail: 'window' }
  ])
})

test('an explicit requires the connector lacks rejects only that mapping', () => {
  const out = applyPlan(plan({ mappings: [
    { path: 'navigation.position', as: 'position', policy: 'on_change' },
    { path: 'environment.wind.speedApparent', as: 'wind', policy: 'on_change',
      requires: ['window'] }
  ] }), { consent: CONSENT, deny: [] })
  assert.equal(out.mappings.length, 1)
  assert.equal(out.rejected[0].reason, 'unsupported_requires')
  assert.equal(out.rejected[0].detail, 'window')
})

test('a requires the connector DOES have is satisfied', () => {
  const out = applyPlan(plan({ mappings: [
    { path: 'navigation.position', as: 'position', policy: 'on_change',
      requires: ['on_change', 'round'] }
  ] }), { consent: CONSENT, deny: [] })
  assert.equal(out.mappings.length, 1)
  assert.deepEqual(out.rejected, [])
})

test('a mapping outside consent is refused even though the cloud signed the plan', () => {
  const out = applyPlan(plan({ mappings: [
    { path: 'propulsion.port.temperature', as: 'engine_temp', policy: 'on_change' }
  ] }), { consent: CONSENT, deny: [] })
  assert.equal(out.mappings.length, 0)
  assert.equal(out.rejected[0].reason, 'outside_consent')
})

test('the local deny list beats an otherwise allowed mapping', () => {
  /* spec "The boat can veto": no cloud-side bug or compromise can override the
     owner's own hardware. */
  const out = applyPlan(plan(), { consent: CONSENT, deny: ['navigation.position'] })
  assert.equal(out.mappings.length, 0)
  assert.equal(out.rejected[0].reason, 'denied_locally')
})

test('deny matches whole segments, not string prefixes', () => {
  const allowed = applyPlan(plan(), { consent: CONSENT, deny: ['navigation.pos'] })
  assert.equal(allowed.mappings.length, 1, 'a partial segment must not deny')
  const denied = applyPlan(plan(), { consent: CONSENT, deny: ['navigation'] })
  assert.equal(denied.mappings.length, 0, 'an ancestor segment must deny the subtree')
})

test('denying a DESCENDANT denies the mapping that would carry it', () => {
  /* navigation.position is object-valued: there is no way to send it with the
     longitude removed, so the owner's veto takes the whole mapping. Over-denying
     is the only safe direction for a list whose job is "this never leaves". */
  const out = applyPlan(plan(), { consent: CONSENT, deny: ['navigation.position.longitude'] })
  assert.equal(out.mappings.length, 0)
  assert.equal(out.rejected[0].reason, 'denied_locally')
})

test('deny is reported as denied_locally even for a path consent never allowed', () => {
  // The reason the BOAT gives is its own veto, whatever the cloud thought.
  const out = applyPlan(plan({ mappings: [
    { path: 'propulsion.port.temperature', as: 'engine_temp', policy: 'on_change' }
  ] }), { consent: CONSENT, deny: ['propulsion'] })
  assert.equal(out.rejected[0].reason, 'denied_locally')
})

test('consent matches whole segments too', () => {
  assert.equal(coveredBy('notifications.mob', CONSENT), true)
  assert.equal(coveredBy('navigation.positionAccuracy', CONSENT), false)
  assert.equal(coveredBy('navigation', CONSENT), false)
})

test('a wildcard mapping is judged on the literal part before the wildcard', () => {
  const out = applyPlan(plan({ mappings: [
    { path: 'notifications.*', as: 'alerts', policy: 'on_change' },
    { path: 'propulsion.*.temperature', as: 'engine_temp', policy: 'on_change' }
  ] }), { consent: CONSENT, deny: [] })
  assert.deepEqual(out.mappings.map((m) => m.as), ['alerts'])
  assert.equal(out.rejected[0].reason, 'outside_consent')
})

test('literalHead strips the wildcard and the dot that led to it', () => {
  assert.equal(literalHead('propulsion.*.temperature'), 'propulsion')
  assert.equal(literalHead('notifications.*'), 'notifications')
  assert.equal(literalHead('navigation.position'), 'navigation.position')
  assert.equal(literalHead('*'), '')
})

test('a mapping with no path is rejected rather than silently carried', () => {
  const out = applyPlan(plan({ mappings: [{ as: 'nothing', policy: 'on_change' }] }),
    { consent: CONSENT, deny: [] })
  assert.equal(out.rejected[0].reason, 'bad_mapping')
})

test('rubbish in the mappings array is rejected, not thrown on', () => {
  const out = applyPlan(plan({ mappings: [null, 'navigation.position', 42, []] }),
    { consent: CONSENT, deny: [] })
  assert.equal(out.ok, true)
  assert.equal(out.mappings.length, 0)
  assert.deepEqual(out.rejected.map((r) => r.reason),
    ['bad_mapping', 'bad_mapping', 'bad_mapping', 'bad_mapping'])
})

test('every rejection uses the closed vocabulary', () => {
  /* REJECT_REASONS is what the plugin page words a rejection from; a reason
     outside it would render as unknown text. applyPlan builds its rejections
     from the same constants, so this is a real check, not a restatement. */
  const out = applyPlan(plan({ mappings: [
    { as: 'no_path' },
    { path: 'environment.wind.speedApparent', as: 'wind', policy: 'window' },
    { path: 'environment.wind.speedApparent', as: 'wind', requires: ['on_event'] },
    { path: 'propulsion.port.temperature', as: 'engine' },
    { path: 'navigation.position', as: 'position' }
  ] }), { consent: CONSENT, deny: ['navigation.position'] })
  assert.equal(out.rejected.length, 5)
  for (const r of out.rejected) assert.ok(REJECT_REASONS.includes(r.reason), r.reason)
  assert.deepEqual(new Set(out.rejected.map((r) => r.reason)), new Set([
    'bad_mapping', 'unsupported_policy', 'unsupported_requires',
    'outside_consent', 'denied_locally'
  ]))
})

test('mappings beyond the declared limit are rejected, not truncated silently', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({
    path: 'navigation.position', as: `p${i}`, policy: 'on_change'
  }))
  const out = applyPlan(plan({ mappings: many }), { consent: CONSENT, deny: [] })
  assert.equal(out.mappings.length, 200)
  assert.equal(out.rejected.length, 50)
  assert.equal(out.rejected[0].reason, 'over_max_mappings')
})

test('a plan whose schema is newer than this connector is refused whole', () => {
  const out = applyPlan(plan({ schema: 7 }), { consent: CONSENT, deny: [] })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'unsupported_schema')
  assert.equal(out.mappings.length, 0)
})

test('a plan with no readable schema at all is refused whole', () => {
  for (const bad of [undefined, null, 'one', {}, true]) {
    const out = applyPlan(plan({ schema: bad }), { consent: CONSENT, deny: [] })
    assert.equal(out.ok, false, `schema ${JSON.stringify(bad)} must not apply`)
    assert.equal(out.reason, 'unsupported_schema')
  }
})

test('rubbish in place of a plan is refused without throwing', () => {
  for (const bad of [null, undefined, 'plan', 42, []]) {
    const out = applyPlan(bad, { consent: CONSENT, deny: [] })
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'bad_plan')
  }
})

test('a refused plan still answers with safe defaults and a usable ack', () => {
  const out = applyPlan(null, { consent: CONSENT, deny: [] })
  assert.deepEqual(out.transport, DEFAULT_TRANSPORT)
  assert.deepEqual(out.budget, DEFAULT_BUDGET)
  assert.deepEqual(out.ack(), { plan_id: '', version: 0, etag: '', accepted: 0, rejected: [] })
})

test('applyPlan defaults its options, so a caller cannot forget consent', () => {
  // Missing consent means NOTHING is consented, never everything.
  const out = applyPlan(plan())
  assert.equal(out.ok, true)
  assert.equal(out.mappings.length, 0)
  assert.equal(out.rejected[0].reason, 'outside_consent')
})

test('transport defaults are present when the plan omits the block', () => {
  const out = applyPlan(plan(), { consent: CONSENT, deny: [] })
  assert.deepEqual(out.transport, DEFAULT_TRANSPORT)
})

test('the client-side transport defaults are safe on their own', () => {
  /* A boat that reconnects before it has ever seen a plan must still back off
     exponentially with jitter, never spin in a tight retry loop. */
  assert.ok(DEFAULT_TRANSPORT.backoff_base_s >= 1)
  assert.ok(DEFAULT_TRANSPORT.backoff_ceiling_s >= 60)
  assert.ok(DEFAULT_TRANSPORT.reconnect_jitter_pct > 0)
  for (const [key, [lo, hi]] of Object.entries(TRANSPORT_BOUNDS)) {
    assert.ok(DEFAULT_TRANSPORT[key] >= lo && DEFAULT_TRANSPORT[key] <= hi,
      `${key} default is outside its own bounds`)
  }
})

test('transport controls from the plan are clamped, never trusted raw', () => {
  const out = applyPlan(plan({ transport: {
    backoff_base_s: 0, backoff_ceiling_s: 10 ** 9, reconnect_jitter_pct: -5,
    heartbeat_s: 1, backfill_chunk_msgs: 100000, quiet_mode: true,
    quiet_interval_multiplier: 0, unknown_future_knob: 'ignored'
  } }), { consent: CONSENT, deny: [] })
  const t = out.transport
  assert.equal(t.backoff_base_s, TRANSPORT_BOUNDS.backoff_base_s[0])
  assert.equal(t.backoff_ceiling_s, TRANSPORT_BOUNDS.backoff_ceiling_s[1])
  assert.equal(t.reconnect_jitter_pct, 0)
  assert.equal(t.heartbeat_s, TRANSPORT_BOUNDS.heartbeat_s[0])
  assert.equal(t.backfill_chunk_msgs, TRANSPORT_BOUNDS.backfill_chunk_msgs[1])
  assert.equal(t.quiet_mode, true)
  assert.equal(t.quiet_interval_multiplier, TRANSPORT_BOUNDS.quiet_interval_multiplier[0])
  assert.equal(t.unknown_future_knob, undefined)
})

test('a transport value that is not a number falls back to the default', () => {
  /* Mirrors boat_plan._as_int, which refuses bool ("" and None too) rather than
     reading `true` as 1. Number() in JS accepts all three, and every acceptance
     is a silent divergence between the two halves of one contract. */
  for (const bad of [true, false, '', null, [], {}, 'lots', '0x10', NaN, Infinity]) {
    const t = normalizeTransport({ heartbeat_s: bad })
    assert.equal(t.heartbeat_s, DEFAULT_TRANSPORT.heartbeat_s,
      `heartbeat_s: ${JSON.stringify(bad)} must not be read as a number`)
  }
  assert.equal(normalizeTransport({ heartbeat_s: '600.7' }).heartbeat_s, 600,
    'a decimal string truncates, exactly as int(float(x)) does')
})

test('toInt mirrors the cloud int() for the values a plan can carry', () => {
  assert.equal(toInt(30), 30)
  assert.equal(toInt(30.7), 30)
  assert.equal(toInt(-30.7), -30)
  assert.equal(toInt('30.7'), 30)
  assert.equal(toInt(' 30 '), 30)
  assert.equal(toInt('1e3'), 1000)
  for (const bad of [true, false, null, undefined, '', 'x', '0x10', [], {}, NaN, Infinity]) {
    assert.equal(toInt(bad), null, `${JSON.stringify(bad)} is not an int`)
  }
})

test('backfill_chunk_msgs can never exceed the platform package ceiling', () => {
  /* policy.py:38-45 — a registered actor may send at most 200 messages per
     data_bus.publish package; a larger chunk is simply rejected by ingress. */
  assert.ok(TRANSPORT_BOUNDS.backfill_chunk_msgs[1] <= 200)
})

test('quiet mode is a plan field, so a fleet can be calmed without a release', () => {
  const out = applyPlan(plan({ transport: { quiet_mode: true } }),
    { consent: CONSENT, deny: [] })
  assert.equal(out.transport.quiet_mode, true)
  assert.equal(normalizeTransport({}).quiet_mode, false)
})

test('budget is clamped and defaulted', () => {
  assert.deepEqual(normalizeBudget(undefined), DEFAULT_BUDGET)
  assert.equal(normalizeBudget({ max_msgs_per_min: 0 }).max_msgs_per_min, 1)
  assert.equal(normalizeBudget({ max_msgs_per_min: 'lots' }).max_msgs_per_min,
    DEFAULT_BUDGET.max_msgs_per_min)
})

test('the budget has a floor but no ceiling, matching the cloud half', () => {
  /* boat_plan.normalize_budget is floor-only on purpose: the platform already
     caps a registered actor far above this, and a second lower ceiling invented
     on the boat would diverge without protecting anything. */
  assert.equal(normalizeBudget({ max_msgs_per_min: -5 }).max_msgs_per_min, 1)
  assert.equal(normalizeBudget({ max_bytes_per_hour: 10 ** 9 }).max_bytes_per_hour, 10 ** 9)
})

test('the etag is content-derived and stable across key order', () => {
  const a = applyPlan(plan(), { consent: CONSENT, deny: [] })
  const reordered = Object.fromEntries(Object.entries(plan()).reverse())
  const b = applyPlan(reordered, { consent: CONSENT, deny: [] })
  assert.equal(a.etag, b.etag)
  const c = applyPlan(plan({ version: 13 }), { consent: CONSENT, deny: [] })
  assert.notEqual(a.etag, c.etag)
})

test('the etag ignores plan_id, which is random on every cloud rebuild', () => {
  const a = applyPlan(plan({ plan_id: 'pl_aaaaaaaa' }), { consent: CONSENT, deny: [] })
  const b = applyPlan(plan({ plan_id: 'pl_bbbbbbbb' }), { consent: CONSENT, deny: [] })
  assert.equal(a.etag, b.etag)
})

test('the etag changes when a NESTED value changes, not just a top-level one', () => {
  /* The bug this pins: JSON.stringify(body, Object.keys(body).sort()) treats the
     replacer array as a property allow-list at every depth, so every nested
     object and every mapping hashes as {} and only schema/version count. Two
     plans at the same version with different mappings would then share an etag —
     and share a plan_ack.etag cloud-side. */
  const base = applyPlan(plan(), { consent: CONSENT, deny: [] })

  const otherPath = applyPlan(plan({ mappings: [
    { path: 'environment.wind.speedApparent', as: 'wind', policy: 'on_change' }
  ] }), { consent: CONSENT, deny: [] })
  assert.notEqual(base.etag, otherPath.etag, 'a different mapping must change the etag')

  const otherCadence = applyPlan(plan({ mappings: [
    { path: 'navigation.position', as: 'position', policy: 'on_change',
      deadband: { meters: 25 }, min_interval_s: 60, max_interval_s: 600,
      priority: 'high' }
  ] }), { consent: CONSENT, deny: [] })
  assert.notEqual(base.etag, otherCadence.etag, 'a cadence change must change the etag')

  const otherTransport = applyPlan(plan({ transport: { heartbeat_s: 900 } }),
    { consent: CONSENT, deny: [] })
  assert.notEqual(base.etag, otherTransport.etag, 'a transport change must change the etag')

  const otherBudget = applyPlan(plan({ budget: { max_msgs_per_min: 31 } }),
    { consent: CONSENT, deny: [] })
  assert.notEqual(base.etag, otherBudget.etag, 'a budget change must change the etag')
})

test('the replacer-array shortcut really does blank nested objects', () => {
  /* Executable proof of the defect the comment in lib/plan.js warns about, so
     nobody "simplifies" canonicalJson back into it. */
  const doc = { schema: 1, transport: { backoff_base_s: 2 }, mappings: [{ path: 'x' }] }
  // The tempting one-liner: sort the top-level keys and hand them to the
  // replacer. It emits them in that order, and blanks every nested object.
  assert.equal(JSON.stringify(doc, Object.keys(doc).sort()),
    '{"mappings":[{}],"schema":1,"transport":{}}')
  assert.equal(canonicalJson(doc),
    '{"mappings":[{"path":"x"}],"schema":1,"transport":{"backoff_base_s":2}}')
})

test('canonicalJson sorts keys at every depth and keeps array order', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
    '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}')
})

test('two boats that clamp the SAME plan differently get different etags', () => {
  /* The etag is over the plan as APPLIED, so a boat whose deny list removed a
     mapping does not claim to be running the same thing as one that did not. */
  const open = applyPlan(plan(), { consent: CONSENT, deny: [] })
  const denied = applyPlan(plan(), { consent: CONSENT, deny: ['navigation.position'] })
  assert.notEqual(open.etag, denied.etag)
})

test('the ack payload names what was refused and why', () => {
  const out = applyPlan(plan({ mappings: [
    { path: 'navigation.position', as: 'position', policy: 'on_change' },
    { path: 'environment.wind.speedApparent', as: 'wind', policy: 'window' }
  ] }), { consent: CONSENT, deny: [] })
  assert.deepEqual(out.ack(), {
    plan_id: 'pl_1', version: 12, etag: out.etag, accepted: 1,
    rejected: [{ path: 'environment.wind.speedApparent', as: 'wind',
                 reason: 'unsupported_policy', detail: 'window' }]
  })
})

// ── The cross-repo etag contract ─────────────────────────────────────────────
// boat_plan.plan_etag is
//   sha256(json.dumps(body, sort_keys=True, separators=(",",":"),
//                     default=str).encode()).hexdigest()[:32]
// with the top-level plan_id popped. The digests below were produced by RUNNING
// that function (bundles/signalk@2026-06-05/boat_plan.py) over these exact
// documents. If either side's canonical form drifts, these fail loudly here
// instead of quietly turning every plan_ack into a mismatch on the fleet.

const CONTRACT_DOC = {
  schema: 1,
  plan_id: 'pl_0123456789abcdef',
  version: 12,
  boat_id: 'bk_contract_boat',
  budget: { max_msgs_per_min: 30, max_bytes_per_hour: 262144 },
  transport: {
    backoff_base_s: 2,
    backoff_ceiling_s: 300,
    reconnect_jitter_pct: 30,
    heartbeat_s: 300,
    backfill_chunk_msgs: 100,
    backfill_chunk_interval_s: 5,
    quiet_mode: false,
    quiet_interval_multiplier: 4
  },
  defaults: { policy: 'on_change', min_interval_s: 5, max_interval_s: 300 },
  mappings: [
    { path: 'navigation.position', as: 'position', policy: 'on_change',
      min_interval_s: 10, max_interval_s: 600, priority: 'high',
      deadband: { meters: 25 } },
    { path: 'environment.wind.speedApparent', as: 'wind_speedApparent',
      policy: 'on_change', min_interval_s: 10, max_interval_s: 600,
      priority: 'normal', deadband: { pct: 2 }, round: 2, quantity: 'speed' }
  ]
}

const CONTRACT_CANONICAL = '{"boat_id":"bk_contract_boat","budget":{"max_bytes_per_hour":262144,"max_msgs_per_min":30},"defaults":{"max_interval_s":300,"min_interval_s":5,"policy":"on_change"},"mappings":[{"as":"position","deadband":{"meters":25},"max_interval_s":600,"min_interval_s":10,"path":"navigation.position","policy":"on_change","priority":"high"},{"as":"wind_speedApparent","deadband":{"pct":2},"max_interval_s":600,"min_interval_s":10,"path":"environment.wind.speedApparent","policy":"on_change","priority":"normal","quantity":"speed","round":2}],"schema":1,"transport":{"backfill_chunk_interval_s":5,"backfill_chunk_msgs":100,"backoff_base_s":2,"backoff_ceiling_s":300,"heartbeat_s":300,"quiet_interval_multiplier":4,"quiet_mode":false,"reconnect_jitter_pct":30},"version":12}'

const CONTRACT_ETAG = 'ac38cbd892104f49a05c994ca0f8fc80'

test('canonicalJson reproduces the cloud half byte for byte', () => {
  const body = { ...CONTRACT_DOC }
  delete body.plan_id
  assert.equal(canonicalJson(body), CONTRACT_CANONICAL)
})

test('etagOf agrees with boat_plan.plan_etag on a pinned document', () => {
  assert.equal(etagOf(CONTRACT_DOC), CONTRACT_ETAG)
})

test('the pinned digest is the sha256 of the pinned canonical text', () => {
  // Belt and braces: if someone edits one constant they must edit both.
  const crypto = require('node:crypto')
  assert.equal(
    crypto.createHash('sha256').update(CONTRACT_CANONICAL, 'utf8').digest('hex').slice(0, 32),
    CONTRACT_ETAG)
})

test('non-ASCII is escaped exactly as Python ensure_ascii escapes it', () => {
  /* A vessel name is the likeliest non-ASCII field to reach a plan document.
     JSON.stringify leaves it raw, json.dumps escapes it — different bytes, a
     different digest, and every boat with an accent in its name permanently
     disagreeing with the cloud about which plan it is running. */
  const doc = { schema: 1, plan_id: 'pl_drop_me', version: 1, vessel_name: 'Sørøya ☃', mappings: [] }
  const body = { ...doc }
  delete body.plan_id
  // The expected text is built from escape-sequence pieces on purpose: written
  // as one literal it is far too easy to "tidy" the backslashes away, and the
  // test would then assert the raw UTF-8 the cloud never produces.
  const BS = '\\'
  assert.equal(canonicalJson(body),
    `{"mappings":[],"schema":1,"version":1,"vessel_name":"S${BS}u00f8r${BS}u00f8ya ${BS}u2603"}`)
  assert.equal(etagOf(doc), 'e85c8e94a7293819ce9d2f2b2c328f8b')
})
