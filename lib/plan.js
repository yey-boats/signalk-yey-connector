'use strict'

/**
 * The plan interpreter: "the plan is data, the vocabulary is code".
 *
 * Everything here is pure — no clock, no filesystem, no socket — because this is
 * the module that runs on UNTRUSTED input. The plan arrives from the cloud, and
 * the connector re-checks consent, the deny list, the budget and every transport
 * control the cloud has already checked (spec "defence in depth"): a cloud-side
 * bug or a compromised account must not be able to widen what leaves the boat or
 * turn the owner's cellular link into a bill.
 *
 * Boundaries here deliberately mirror `boat_plan.py` in the cloud bundle. They
 * are two implementations of ONE contract on two release cycles;
 * test/contract.test.js (cross-repo) and the pinned digests in test/plan.test.js
 * are what keep them honest.
 */

const crypto = require('node:crypto')
const {
  POLICIES, TRANSFORMS, LIMITS, PLAN_SCHEMA_MIN, PLAN_SCHEMA_MAX
} = require('./hello')

// The closed rejection vocabulary. It is NOT decoration: applyPlan words every
// rejection out of REASON, REJECT_REASONS is derived from it, and the plugin
// page renders a rejection by looking the code up rather than parsing prose.
// (The plan as written declared REJECT_REASONS and then never used it; deriving
// the list from the constants the code actually emits is what stops the two
// drifting apart.)
const REASON = Object.freeze({
  BAD_MAPPING: 'bad_mapping',
  UNSUPPORTED_POLICY: 'unsupported_policy',
  UNSUPPORTED_REQUIRES: 'unsupported_requires',
  OUTSIDE_CONSENT: 'outside_consent',
  DENIED_LOCALLY: 'denied_locally',
  OVER_MAX_MAPPINGS: 'over_max_mappings'
})
const REJECT_REASONS = Object.freeze(Object.values(REASON))

// Bounds mirror boat_plan.TRANSPORT_BOUNDS. Transport controls are PLAN fields
// on purpose: a plan reaches a fleet in seconds, a connector release on someone
// else's boat may never arrive at all.
const TRANSPORT_BOUNDS = Object.freeze({
  backoff_base_s: [1, 60],
  backoff_ceiling_s: [5, 3600],
  reconnect_jitter_pct: [0, 100],
  heartbeat_s: [30, 3600],
  // policy.py:38-45 — a `registered` actor may send at most 200 messages per
  // data_bus.publish package; a larger chunk is simply rejected by ingress.
  backfill_chunk_msgs: [1, 200],
  backfill_chunk_interval_s: [1, 600],
  quiet_interval_multiplier: [1, 60]
})

// Safe ALONE: a boat that reconnects before it has ever seen a plan still backs
// off exponentially with jitter, never in a tight retry loop.
const DEFAULT_TRANSPORT = Object.freeze({
  backoff_base_s: 2,
  backoff_ceiling_s: 300,
  reconnect_jitter_pct: 30,
  heartbeat_s: 300,
  backfill_chunk_msgs: 100,
  backfill_chunk_interval_s: 5,
  quiet_mode: false,
  quiet_interval_multiplier: 4
})

const DEFAULT_BUDGET = Object.freeze({ max_msgs_per_min: 30, max_bytes_per_hour: 262144 })

const DEFAULT_DEFAULTS = Object.freeze({
  policy: 'on_change', min_interval_s: 5, max_interval_s: 300
})

// An interval is seconds; a day is a generous ceiling and keeps a typo of
// 10 ** 12 from becoming "never again".
const MAX_INTERVAL_S = 86400
const PRIORITIES = ['high', 'normal', 'low']

/** Whole-segment containment. A plain startsWith would let
 *  `navigation.positionAccuracy` through on a consent of `navigation.position` —
 *  a different path, and exactly the silent widening consent exists to stop. */
function coveredBy (path, allow) {
  const p = String(path == null ? '' : path).trim()
  if (!p) return false
  for (const entry of allow || []) {
    const e = String(entry == null ? '' : entry).trim()
    if (!e) continue
    if (p === e || p.startsWith(`${e}.`)) return true
  }
  return false
}

/** The literal head of a path: everything before the first wildcard.
 *  'propulsion.*.temperature' -> 'propulsion'. Consent and deny are both judged
 *  on the head, which is conservative in both directions: a wildcard can never
 *  reach outside the consented subtree, and a denied ancestor blocks it. */
function literalHead (path) {
  const p = String(path == null ? '' : path)
  const star = p.indexOf('*')
  const head = star === -1 ? p : p.slice(0, star)
  return head.replace(/\.+$/, '')
}

/** The owner's veto, cutting both ways round: a denied ANCESTOR blocks the whole
 *  subtree, and a denied DESCENDANT blocks a mapping that would carry it. The
 *  second half matters because an object-valued path (navigation.position) and a
 *  wildcard cannot have one leaf stripped out of them — over-denying is the only
 *  safe direction for a list whose entire job is "this never leaves my boat". */
function deniedBy (head, deny) {
  for (const entry of deny || []) {
    const d = String(entry == null ? '' : entry).trim()
    if (!d) continue
    if (coveredBy(head, [d]) || coveredBy(d, [head])) return true
  }
  return false
}

/** int(value) the way boat_plan._as_int does it, returning null instead of None.
 *
 *  Mirroring it matters more than it looks. Plain Number() in JS accepts things
 *  Python's int()/float() refuse, and each acceptance is a silent divergence
 *  between the two halves of one contract:
 *    Number(true) === 1     but bool is refused cloud-side (it is an int subclass
 *                           there, so `heartbeat_s: true` must mean "garbage",
 *                           not "1 second clamped to 30")
 *    Number('') === 0       int('') raises
 *    Number(null) === 0     int(None) raises
 *    Number([]) === 0       int([]) raises
 *    Number('0x10') === 16  int('0x10') raises
 *  So: numbers and plain decimal strings only, truncated toward zero exactly as
 *  int(float(x)) truncates. */
function toInt (value) {
  if (typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null
    const n = Number(text)
    return Number.isFinite(n) ? Math.trunc(n) : null
  }
  return null
}

function clampInt (value, [lo, hi], fallback) {
  const n = toInt(value)
  if (n === null) return fallback
  return Math.max(lo, Math.min(hi, n))
}

/** Clamp a transport block into the v1 schema. Unknown keys are IGNORED — the
 *  must-ignore rule is what lets the cloud add a control before every boat can
 *  parse it (spec "Must-ignore"). */
function normalizeTransport (raw) {
  const out = { ...DEFAULT_TRANSPORT }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, bounds] of Object.entries(TRANSPORT_BOUNDS)) {
    if (key in raw) out[key] = clampInt(raw[key], bounds, DEFAULT_TRANSPORT[key])
  }
  if ('quiet_mode' in raw) out.quiet_mode = Boolean(raw.quiet_mode)
  return out
}

/** Floor-only, matching boat_plan.normalize_budget. No ceiling on purpose: the
 *  platform already caps a `registered` actor far above anything a plan would
 *  ask for, and a second, lower ceiling invented here would diverge from the
 *  cloud half without protecting anything the platform does not already refuse. */
function normalizeBudget (raw) {
  const out = { ...DEFAULT_BUDGET }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of Object.keys(DEFAULT_BUDGET)) {
    if (key in raw) {
      out[key] = clampInt(raw[key], [1, Number.MAX_SAFE_INTEGER], DEFAULT_BUDGET[key])
    }
  }
  return out
}

function normalizeDefaults (raw) {
  const out = { ...DEFAULT_DEFAULTS }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  if (POLICIES.includes(raw.policy)) out.policy = raw.policy
  out.min_interval_s = clampInt(raw.min_interval_s, [LIMITS.min_interval_s, MAX_INTERVAL_S],
    DEFAULT_DEFAULTS.min_interval_s)
  out.max_interval_s = clampInt(raw.max_interval_s, [LIMITS.min_interval_s, MAX_INTERVAL_S],
    DEFAULT_DEFAULTS.max_interval_s)
  return out
}

/** Copy ONLY the keys this connector understands. Unknown keys are dropped
 *  rather than carried, so nothing downstream can act on a field it has not been
 *  taught to bound (spec "Must-ignore"). */
function projectMapping (raw, defaults) {
  const path = String(raw.path)
  const m = {
    path,
    as: String(raw.as || literalHead(path).split('.').filter(Boolean).pop() || path),
    policy: POLICIES.includes(raw.policy) ? raw.policy : defaults.policy,
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'normal',
    min_interval_s: clampInt(raw.min_interval_s, [LIMITS.min_interval_s, MAX_INTERVAL_S],
      defaults.min_interval_s),
    max_interval_s: clampInt(raw.max_interval_s, [LIMITS.min_interval_s, MAX_INTERVAL_S],
      defaults.max_interval_s)
  }
  if (raw.deadband && typeof raw.deadband === 'object' && !Array.isArray(raw.deadband)) {
    const d = {}
    for (const key of ['abs', 'pct', 'meters']) {
      const n = Number(raw.deadband[key])
      if (typeof raw.deadband[key] !== 'boolean' && raw.deadband[key] !== null &&
          raw.deadband[key] !== '' && Number.isFinite(n)) d[key] = n
    }
    m.deadband = d
  }
  const round = toInt(raw.round)
  if (round !== null) m.round = Math.max(0, Math.min(12, round))
  if (typeof raw.quantity === 'string' && raw.quantity) m.quantity = raw.quantity
  const interval = toInt(raw.interval_s)
  if (interval !== null) {
    m.interval_s = Math.max(LIMITS.min_interval_s, Math.min(MAX_INTERVAL_S, interval))
  }
  return m
}

// Python's json.dumps(..., ensure_ascii=True) escapes everything outside the
// printable ASCII range; JSON.stringify does not. The two halves must produce
// byte-identical canonical text, so we escape it here.
const NON_ASCII = /[\u007f-￿]/g

function jsonString (text) {
  return JSON.stringify(text).replace(NON_ASCII,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Deterministic JSON: object keys sorted at EVERY depth, arrays kept in order,
 *  non-ASCII escaped. Byte-for-byte what
 *  `json.dumps(obj, sort_keys=True, separators=(",", ":"))` produces in
 *  boat_plan.plan_etag — that cross-repo agreement IS the contract, and
 *  test/plan.test.js pins both the canonical text and the digest.
 *
 *  Do NOT reach for `JSON.stringify(body, Object.keys(body).sort())`. A replacer
 *  ARRAY is a property ALLOW-LIST applied at every depth, not a key order: it
 *  keeps only the named keys and blanks every nested object, so two plans with
 *  the same `version` and completely different mappings hash identically.
 *    const doc = {schema:1, transport:{backoff_base_s:2}, mappings:[{path:'x'}]}
 *    JSON.stringify(doc, Object.keys(doc).sort())
 *    -> {"mappings":[{}],"schema":1,"transport":{}}
 *  (test/plan.test.js runs that line, so the warning cannot rot.)
 *
 *  Known, accepted divergence: a float that happens to be integral serializes as
 *  `2.0` in Python and `2` here. It cannot arise from a plan that crossed the
 *  wire (JSON.parse gives a JS number either way) and the cloud builds every
 *  control as an int, so it is documented rather than worked around. */
function canonicalJson (value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return `{${keys.map((k) => `${jsonString(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  if (typeof value === 'string') return jsonString(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return 'null'
}

/** sha256 over the canonical document minus the top-level `plan_id`, truncated
 *  to 32 hex characters — the same algorithm as boat_plan.plan_etag, so feeding
 *  both halves the same document yields the same string.
 *
 *  `plan_id` is excluded because it is freshly random on every cloud rebuild;
 *  including it would change the etag on every rebuild and defeat the whole
 *  mechanism. The exclusion is ONE key, at the TOP LEVEL, applied ONCE — it is
 *  not a recursive key filter.
 *
 *  Note which document each side hashes: the cloud hashes the plan it BUILT,
 *  the connector hashes the plan it is ACTUALLY RUNNING (projected, consent- and
 *  deny-clamped). Those differ whenever a boat rejected something, which is the
 *  point — the ack reports the local etag so a divergence is visible, while the
 *  heartbeat echoes the cloud's etag verbatim. */
function etagOf (plan) {
  const body = { ...(plan || {}) }
  delete body.plan_id
  return crypto.createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex').slice(0, 32)
}

/** The paths the cloud may QUERY on demand (lib/rpc.js) without streaming
 *  them: the plan's `on_request` list, clamped exactly like a mapping — inside
 *  consent, and not under a denied ancestor. A denied DESCENDANT does not drop
 *  the entry here (each request is re-checked against the deny list, both
 *  ways round, before anything is read); a denied ancestor does, because then
 *  nothing under it could ever be answered. No wildcards: on_request names
 *  subtrees by prefix, which is already what consent does. Returns undefined
 *  when the plan has no such key. */
function normalizeOnRequest (raw, { consent = [], deny = [] } = {}) {
  if (!Array.isArray(raw)) return undefined
  const out = []
  for (const entry of raw.slice(0, LIMITS.max_mappings)) {
    if (typeof entry !== 'string') continue
    const p = entry.trim()
    if (!p || p.includes('*') || out.includes(p)) continue
    if ((deny || []).some((d) => coveredBy(p, [d]))) continue
    if (!coveredBy(p, consent)) continue
    out.push(p)
  }
  return out
}

/**
 * Validate, clamp and project a plan.
 *
 * Returns `{ ok, plan_id, version, schema, etag, transport, budget, defaults,
 * mappings, rejected, ack() }`, and on a plan it cannot read at all
 * `{ ok: false, reason }` with everything else at its safe default. It never
 * throws: a plan is remote input.
 */
function applyPlan (plan, { consent = [], deny = [] } = {}) {
  const base = () => ({
    ok: false,
    plan_id: '',
    version: 0,
    schema: 0,
    transport: { ...DEFAULT_TRANSPORT },
    budget: { ...DEFAULT_BUDGET },
    defaults: { ...DEFAULT_DEFAULTS },
    mappings: [],
    rejected: [],
    etag: '',
    ack: () => ({ plan_id: '', version: 0, etag: '', accepted: 0, rejected: [] })
  })

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ...base(), reason: 'bad_plan' }
  }
  const schema = toInt(plan.schema)
  if (schema === null || schema < PLAN_SCHEMA_MIN || schema > PLAN_SCHEMA_MAX) {
    // Refusing the WHOLE plan is right here while rejecting per mapping is right
    // below: an unreadable schema means we cannot know what the fields mean.
    return { ...base(), reason: 'unsupported_schema', schema: schema === null ? 0 : schema }
  }

  const defaults = normalizeDefaults(plan.defaults)
  const rejected = []
  const mappings = []
  const raws = Array.isArray(plan.mappings) ? plan.mappings : []

  for (const raw of raws) {
    const isObject = Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
    const note = (reason, detail) => {
      /* istanbul ignore next — a reason outside the closed vocabulary is a
         programming error, and the page would render it as unknown text. */
      if (!REJECT_REASONS.includes(reason)) throw new Error(`unknown reject reason: ${reason}`)
      rejected.push({
        path: isObject ? (raw.path ?? null) : null,
        as: isObject ? (raw.as ?? null) : null,
        reason,
        ...(detail === undefined ? {} : { detail })
      })
    }

    if (!isObject || !String(raw.path == null ? '' : raw.path).trim()) {
      note(REASON.BAD_MAPPING); continue
    }
    if (mappings.length >= LIMITS.max_mappings) { note(REASON.OVER_MAX_MAPPINGS); continue }
    if (raw.policy !== undefined && !POLICIES.includes(raw.policy)) {
      note(REASON.UNSUPPORTED_POLICY, String(raw.policy)); continue
    }
    const requires = Array.isArray(raw.requires) ? raw.requires.map(String) : []
    const missing = requires.find((r) => !POLICIES.includes(r) && !TRANSFORMS.includes(r))
    if (missing !== undefined) { note(REASON.UNSUPPORTED_REQUIRES, missing); continue }

    const head = literalHead(raw.path)
    // Deny is checked BEFORE consent: the owner's own veto is the reason the
    // boat gives, whatever the cloud thinks it agreed.
    if (deniedBy(head, deny)) { note(REASON.DENIED_LOCALLY); continue }
    if (!coveredBy(head, consent)) { note(REASON.OUTSIDE_CONSENT); continue }

    mappings.push(projectMapping(raw, defaults))
  }

  const normalized = {
    schema,
    plan_id: String(plan.plan_id == null ? '' : plan.plan_id),
    version: toInt(plan.version) === null ? 0 : toInt(plan.version),
    transport: normalizeTransport(plan.transport),
    budget: normalizeBudget(plan.budget),
    defaults,
    mappings,
    // Only when the plan carries the key: an absent key stays absent (undefined
    // is skipped by canonicalJson), so a plan from a cloud that predates
    // on_request hashes exactly as it always did.
    on_request: normalizeOnRequest(plan.on_request, { consent, deny })
  }
  const etag = etagOf(normalized)

  return {
    ok: true,
    ...normalized,
    etag,
    rejected,
    ack: () => ({
      plan_id: normalized.plan_id,
      version: normalized.version,
      etag,
      accepted: mappings.length,
      rejected
    })
  }
}

module.exports = {
  REASON,
  REJECT_REASONS,
  TRANSPORT_BOUNDS,
  DEFAULT_TRANSPORT,
  DEFAULT_BUDGET,
  DEFAULT_DEFAULTS,
  MAX_INTERVAL_S,
  coveredBy,
  literalHead,
  deniedBy,
  toInt,
  normalizeTransport,
  normalizeBudget,
  normalizeDefaults,
  normalizeOnRequest,
  applyPlan,
  canonicalJson,
  etagOf
}
