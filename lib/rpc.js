'use strict'

/**
 * Cloud -> boat queries: `yey.boat.request` in, `yey.boat.reply` out.
 *
 * The link is outbound-only. Nothing listens on the boat: the request arrives
 * as a `chat_service` event on the SAME Socket.IO connection the uplink already
 * holds (the cloud pushes it to this boat's live Data Bus session, which only
 * a socket admitted with this boat's own federated token can be in), and the
 * answer goes back as an ordinary Data Bus publish on subject `yey.boat.reply`,
 * correlated by `id`.
 *
 * What may be answered is decided HERE, on the boat, every time, whatever the
 * cloud asked:
 *
 *   1. the owner's local deny list ALWAYS wins (`denied_locally`);
 *   2. the path must be inside the owner's consent (`outside_consent`);
 *   3. and the plan must either stream it or list it under `on_request`
 *      (`not_on_request`) — the cloud names what it may query, the boat checks
 *      that the name is inside what the owner agreed to;
 *   4. generic writes and controls (`write`, `set`, `control`, `actuate`) are
 *      refused outright (`not_permitted`).
 *
 * The one inbound control is `put`, remote steering. Its rules live in ONE
 * place, lib/steering-policy.js (#28); this module only calls it, in this
 * order, on the boat, every time:
 *
 *   a. the owner's own plugin option `remote_steering` must be on — it is off by
 *      default and the cloud cannot flip it (`remote_steering_off`);
 *   b. the envelope: boat_id required and ours, deadline_ms required, not past
 *      and not too far ahead, the id never seen before — remembered on disk,
 *      so a replay is dropped across restarts (`bad_request` with the reason
 *      in `detail`, or dropped unanswered: expired / duplicate / foreign_boat);
 *   c. the path must be on the steering allowlist (exact paths, the autopilot
 *      and nothing else) (`not_permitted`);
 *   d. the owner's local deny list still wins (`denied_locally`);
 *   e. the value must pass the path's validator: mode enum, radians in range,
 *      adjustHeading within ±150° (`bad_request`, `detail` says why);
 *   f. a stricter rate of its own, 12 puts a minute (`rate_limited`);
 *   g. then the boat's own SignalK server executes it (`app.putSelfPath`), and
 *      whatever autopilot plugin registered the path decides. No handler →
 *      `no_handler`; the handler said no → `signalk_refused`. On a timeout the
 *      reply carries the path's current value (`readback`), and the late
 *      outcome is still audited (`after_timeout`).
 *
 * The policy is published by `capabilities` (remote_steering.policy, versioned).
 *
 * Puts do not consult consent / plan / on_request: those govern data LEAVING
 * the boat. The cloud side additionally requires the owner to enable steering
 * there; both switches are needed. Every put, accepted or refused, leaves a
 * local trail (app.debug and the plugin status line).
 *
 * Every answer is bounded: a request rate per minute, a cap on requests in
 * flight, a handler timeout, a reply size cap (history is trimmed to fit and
 * says `truncated`), and a request past its deadline is dropped because the
 * cloud has already stopped waiting for it.
 *
 * Every collaborator is injected (app, source, policy, publish, clock), so the
 * whole module is testable with no SignalK server and no socket.
 */

const { coveredBy, deniedBy } = require('./plan')
const { compactMeta, buildCatalog } = require('./discovery')
const steeringPolicy = require('./steering-policy')

const REQUEST_EVENT = 'yey.boat.request'
const REPLY_SUBJECT = 'yey.boat.reply'
const REQUEST_SCHEMA = 'yey.boat.request.v1'
const REPLY_SCHEMA = 'yey.boat.reply.v1'

const OPS = Object.freeze(['get', 'meta', 'history', 'catalog', 'capabilities', 'put'])
// Named so a refusal is `not_permitted` rather than `unsupported`: the boat
// understands the request and declines it. `put` is NOT here: it is the gated
// remote-steering op (opPut).
const WRITE_OPS = Object.freeze(['write', 'set', 'control', 'actuate'])

// The steering allowlist, as published by `capabilities`: owned by
// lib/steering-policy.js, exact paths only.
const STEERING_PATHS = steeringPolicy.PATHS
const isSteeringPath = steeringPolicy.isSteeringPath
const MAX_PUT_STRING = 32

// The closed refusal vocabulary. The cloud maps these onto its own Value
// reasons; anything outside this list is a programming error.
const REFUSAL = Object.freeze({
  DENIED_LOCALLY: 'denied_locally',
  OUTSIDE_CONSENT: 'outside_consent',
  NOT_ON_REQUEST: 'not_on_request',
  NOT_PERMITTED: 'not_permitted',
  UNSUPPORTED: 'unsupported',
  NO_DATA: 'no_data',
  BAD_REQUEST: 'bad_request',
  RATE_LIMITED: 'rate_limited',
  BUSY: 'busy',
  TOO_LARGE: 'too_large',
  TIMEOUT: 'timeout',
  INTERNAL: 'internal',
  // Remote steering (op `put`).
  REMOTE_STEERING_OFF: 'remote_steering_off',
  NO_HANDLER: 'no_handler',
  SIGNALK_REFUSED: 'signalk_refused'
})

const LIMITS = Object.freeze({
  // Comfortably under the platform's per-message bound, and small enough that a
  // reply over a marina link is one round trip, not a download.
  max_reply_bytes: 64 * 1024,
  max_per_min: 30,
  // Remote steering has its own, stricter rate (on top of max_per_min).
  max_puts_per_min: 12,
  max_in_flight: 4,
  // The cloud waits at most 5 s (spec "Read path"); answering later is wasted.
  handler_timeout_ms: 4500,
  // Audit records for puts that were NOT accepted (refused, dropped), per
  // minute. Beyond this they are counted and written as one `suppressed`
  // record per window, so a flood from the cloud cannot rotate the accepted
  // records out of the size-capped log. Accepted puts (already at most
  // max_puts_per_min) and timeouts are never suppressed.
  max_audit_refusals_per_min: 30,
  max_history_rows: 2000,
  max_path_len: 256,
  seen_ids: 256
})

// One dotted SignalK path, no wildcards, no empty segments.
const PATH_RE = /^[A-Za-z0-9_$:-]+(\.[A-Za-z0-9_$:-]+)*$/
// boat_rpc.new_id(): "rpc_" + 24 hex.
const ID_RE = /^rpc_[0-9a-f]{8,64}$/

// The History API aggregates we pass through. avg/average are the cloud's
// user-facing keys (signalk_limits._DEFAULT_AGGS).
const AGGREGATES = Object.freeze({
  avg: 'average', average: 'average', min: 'min', max: 'max', first: 'first', last: 'last'
})
const UNIT_SECONDS = Object.freeze({ s: 1, m: 60, h: 3600, d: 86400 })

function nodeAt (tree, path) {
  return String(path).split('.').reduce((node, key) =>
    (node && typeof node === 'object') ? node[key] : undefined, tree)
}

function byteLength (value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Does a mapping's path (exact, or the one `*` form the plan allows) cover a
 *  concrete path? Same matching as runtime.mappingFor. */
function mappingCovers (mappingPath, path) {
  const m = String(mappingPath || '')
  if (!m) return false
  if (m === path) return true
  if (!m.includes('*')) return false
  const rx = new RegExp(`^${m.split('*').map((s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+')}$`)
  return rx.test(path)
}

/**
 * '' when this path may be answered, else the refusal reason.
 * Deny first, then consent, then "does the cloud's plan name it at all".
 */
function authorize (path, policy) {
  const p = policy || {}
  if (deniedBy(path, p.deny || [])) return REFUSAL.DENIED_LOCALLY
  if (!coveredBy(path, p.consent || [])) return REFUSAL.OUTSIDE_CONSENT
  const mapped = (p.mappings || []).some((m) => mappingCovers(m && m.path, path))
  if (!mapped && !coveredBy(path, p.onRequest || [])) return REFUSAL.NOT_ON_REQUEST
  return ''
}

/** `require('@js-temporal/polyfill')` from the SERVER's dependency tree.
 *  The in-process History API takes Temporal instants; signalk-server ships the
 *  polyfill, the plugin does not, so resolve it where the server lives. */
function loadTemporal () {
  if (globalThis.Temporal && globalThis.Temporal.Instant) return globalThis.Temporal
  const tries = [
    () => require('@js-temporal/polyfill'),
    () => require.main && require.main.require('@js-temporal/polyfill'),
    () => {
      const { createRequire } = require('node:module')
      return createRequire(require.resolve('signalk-server/package.json'))('@js-temporal/polyfill')
    }
  ]
  for (const attempt of tries) {
    try {
      const mod = attempt()
      if (mod && mod.Temporal && mod.Temporal.Instant) return mod.Temporal
    } catch { /* next */ }
  }
  return null
}

/** boolean, finite number, or a short string — nothing structured. What the
 *  trail may show; the policy decides what may be PUT. */
function isPutScalar (value) {
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= MAX_PUT_STRING
  return false
}

/**
 * Map one signalk-server put reply ({state, statusCode, message}) onto
 * '' (still pending), or a final outcome. signalk-server normalises handler
 * SUCCESS/FAILURE to COMPLETED + 200/502, but an older server or a plugin's
 * direct callback may still hand us the raw states, so both are read.
 */
function putOutcome (reply, path, value) {
  if (reply instanceof Error) {
    return fail(REFUSAL.SIGNALK_REFUSED, reply.message || 'error')
  }
  const r = reply && typeof reply === 'object' ? reply : {}
  const state = String(r.state || '')
  const code = Number(r.statusCode) || 0
  const message = typeof r.message === 'string' ? r.message : ''
  if (state === 'PENDING' && (!code || code === 202)) return ''
  if (state === 'SUCCESS' || ((state === 'COMPLETED' || !state) && code >= 200 && code < 300)) {
    return { ok: true, result: { path, value, state: 'COMPLETED', statusCode: code || 200 } }
  }
  if (code === 405 || /not supported|no handler/i.test(message)) {
    return fail(REFUSAL.NO_HANDLER, message || `statusCode ${code || 405}`)
  }
  if (!state && !code) return ''
  const detail = [code ? `statusCode ${code}` : state, message].filter(Boolean).join(': ')
  return fail(REFUSAL.SIGNALK_REFUSED, detail || 'failed')
}

function fail (reason, detail) {
  const out = { ok: false, error: reason }
  if (detail) out.detail = String(detail).slice(0, 120)
  return out
}

function createRpcServer ({
  app, getSource, policy, getCatalog, publish, now = Date.now, debug = () => {},
  temporal, limits = {}, setTimer, clearTimer, boatId,
  remoteSteering = false, version = '', setStatus = () => {},
  // The persistent steering audit (lib/steering-audit.js record): called once
  // per put, whatever happened to it. Best effort: it can never change the put.
  audit = () => {},
  // lib/steering-policy.js createSteeringPolicy; the runtime passes one backed
  // by the plugin data dir. Without one the replay ids live in memory only.
  steeringPolicy: injectedPolicy
} = {}) {
  const lim = { ...LIMITS, ...limits }
  const steering = injectedPolicy || steeringPolicy.createSteeringPolicy({
    now, boatId, debug, putsPerMin: lim.max_puts_per_min
  })
  const arm = setTimer || ((fn, ms) => setTimeout(fn, ms))
  const disarm = clearTimer || ((h) => clearTimeout(h))
  const recent = []           // timestamps of accepted requests, last minute
  let lastPut = ''            // the last steering trail line
  // Set when a put's deadline does not fit this boat's clock (#39, #36
  // review): with deadlines at most 15 s ahead, a boat clock ~10 s off
  // refuses every put, `standby` included. Cleared by the next accepted put.
  let clockProblem = null

  /** Puts refused `deadline_too_far` or dropped `expired`: most likely the
   *  boat's clock, so say that, with roughly how far off it looks. */
  function noteClock (verdict, deadline, t) {
    const reason = verdict.refuse === 'deadline_too_far' ? 'deadline_too_far'
      : (verdict.drop === 'expired' ? 'expired' : '')
    if (!reason) return
    const ahead = Math.round((deadline - t) / 1000)
    // A put's deadline may legitimately be up to MAX_DEADLINE_AHEAD_MS ahead:
    // only the excess is clock offset (#41).
    const s = reason === 'deadline_too_far'
      ? Math.round(Math.max(0, deadline - t - steeringPolicy.MAX_DEADLINE_AHEAD_MS) / 1000)
      : Math.round(Math.abs(deadline - t) / 1000)
    const text = reason === 'deadline_too_far'
      ? `Remote steering commands are refused: their deadline is ${ahead} s ahead of this boat's clock. ` +
        `The boat clock looks about ${s} s slow; check its time sync (NTP or GPS time).`
      : `Remote steering commands arrive past their deadline (${s} s by this boat's clock). ` +
        'The boat clock may be fast (check its time sync, NTP or GPS time), or the link is very slow.'
    clockProblem = { reason, at: new Date(t).toISOString(), offset_s: s, text }
    if (reason === 'expired') {
      // Dropped puts get no trail line; the status still has to say it.
      debug(`yey connector: ${text}`)
      try { setStatus(text) } catch { /* status is best effort */ }
    }
  }
  const seen = []             // last request ids, for dedupe
  let inFlight = 0
  const counters = { served: 0, refused: 0, dropped: 0, last_op: '', last_at: 0, last_error: '' }

  const currentPolicy = () => {
    try { return (typeof policy === 'function' ? policy() : policy) || {} } catch { return {} }
  }
  const source = () => (typeof getSource === 'function' ? getSource() : getSource)

  function rateRoom (t) {
    while (recent.length && t - recent[0] >= 60000) recent.shift()
    return recent.length < lim.max_per_min
  }
  function admitRate (t) {
    if (!rateRoom(t)) return false
    recent.push(t)
    return true
  }

  // The owner's switch, read fresh every time (a getter in production).
  const steeringOn = () => {
    try { return (typeof remoteSteering === 'function' ? remoteSteering() : remoteSteering) === true } catch { return false }
  }

  function remember (id) {
    if (seen.includes(id)) return false
    seen.push(id)
    while (seen.length > lim.seen_ids) seen.shift()
    return true
  }

  function checkPath (args) {
    const raw = (args || {}).path
    const path = typeof raw === 'string' ? raw.trim() : ''
    if (!path || path.length > lim.max_path_len || !PATH_RE.test(path)) {
      return { error: fail(REFUSAL.BAD_REQUEST, 'path') }
    }
    const refusal = authorize(path, currentPolicy())
    if (refusal) return { error: fail(refusal) }
    return { path }
  }

  async function opGet (args) {
    const { path, error } = checkPath(args)
    if (error) return error
    const tree = await source().selfTree()
    const node = nodeAt(tree, path)
    if (node === undefined || node === null) return fail(REFUSAL.NO_DATA)
    if (typeof node !== 'object' || Array.isArray(node) || !('value' in node)) {
      // A branch would carry every child under it, consented or not; ask for
      // the leaves by name instead.
      return fail(REFUSAL.BAD_REQUEST, 'not_a_leaf')
    }
    const out = { path, value: node.value, timestamp: String(node.timestamp || '') }
    if (node.$source) out.$source = String(node.$source)
    return { ok: true, result: out }
  }

  async function opMeta (args) {
    const { path, error } = checkPath(args)
    if (error) return error
    const src = source()
    let meta = {}
    try { meta = (src.metaFor ? await src.metaFor(path) : {}) || {} } catch { meta = {} }
    const node = nodeAt(await src.selfTree(), path)
    const inline = node && typeof node === 'object' ? compactMeta(node.meta) : {}
    const merged = { ...meta, ...inline }
    if (!Object.keys(merged).length && (node === undefined || node === null)) {
      return fail(REFUSAL.NO_DATA)
    }
    return { ok: true, result: { path, meta: merged } }
  }

  async function opCatalog () {
    let catalog = typeof getCatalog === 'function' ? getCatalog() : null
    if (!catalog || typeof catalog !== 'object' || !catalog.paths) {
      const src = source()
      const tree = await src.selfTree()
      const metaByPath = src.collectMeta ? await src.collectMeta(tree) : {}
      catalog = buildCatalog({ tree, metaByPath, nowIso: new Date(now()).toISOString() })
    }
    // The deny list wins here too: a denied path is not even named.
    const deny = currentPolicy().deny || []
    const paths = {}
    for (const [path, meta] of Object.entries(catalog.paths || {})) {
      if (!deniedBy(path, deny)) paths[path] = meta
    }
    return {
      ok: true,
      result: {
        catalog: {
          schema: catalog.schema || 'yey.boat.catalog.v1',
          generated_at: String(catalog.generated_at || ''),
          path_count: Object.keys(paths).length,
          truncated: Boolean(catalog.truncated),
          paths
        }
      }
    }
  }

  async function opHistory (args) {
    const { path, error } = checkPath(args)
    if (error) return error
    const a = args || {}
    if (!app || typeof app.getHistoryApi !== 'function') {
      return fail(REFUSAL.UNSUPPORTED, 'no_history_api')
    }
    let api
    try { api = await app.getHistoryApi() } catch { return fail(REFUSAL.UNSUPPORTED, 'no_history_provider') }
    if (!api || typeof api.getValues !== 'function') return fail(REFUSAL.UNSUPPORTED, 'no_history_provider')
    const T = temporal || loadTemporal()
    if (!T) return fail(REFUSAL.UNSUPPORTED, 'no_temporal')

    const aggregate = AGGREGATES[String(a.agg || 'avg')]
    if (!aggregate) return fail(REFUSAL.BAD_REQUEST, 'agg')
    const query = {
      context: 'vessels.self',
      pathSpecs: [{ path, aggregate, parameter: [] }]
    }
    try {
      query.from = T.Instant.from(String(a.since || ''))
      if (a.until) query.to = T.Instant.from(String(a.until))
    } catch {
      return fail(REFUSAL.BAD_REQUEST, 'time')
    }
    if (a.bucket) {
      const m = /^(\d+)([smhd])$/.exec(String(a.bucket))
      if (!m) return fail(REFUSAL.BAD_REQUEST, 'bucket')
      query.resolution = Number(m[1]) * UNIT_SECONDS[m[2]]
    }
    const res = await api.getValues(query)
    const data = Array.isArray(res && res.data) ? res.data : []
    let rows = data.slice(-lim.max_history_rows)
    const result = {
      path,
      context: String((res && res.context) || 'vessels.self'),
      range: res && res.range ? JSON.parse(JSON.stringify(res.range)) : {},
      values: Array.isArray(res && res.values) ? res.values : [],
      data: rows,
      truncated: data.length > rows.length
    }
    // Trim to fit the reply cap rather than refusing a long window outright:
    // the OLDEST rows go (a question is usually about the recent past), and
    // the reply says so.
    while (byteLength(result) > lim.max_reply_bytes - 512 && rows.length > 1) {
      rows = rows.slice(-Math.floor(rows.length / 2))
      result.data = rows
      result.truncated = true
    }
    return { ok: true, result }
  }

  function opCapabilities () {
    return {
      ok: true,
      result: {
        remote_steering: {
          enabled: steeringOn(),
          paths: [...STEERING_PATHS],
          policy_version: steeringPolicy.POLICY_VERSION,
          policy: steering.describe()
        },
        connector_version: String(version || '')
      }
    }
  }

  /** Execute one SignalK PUT on this server; resolves with a final outcome.
   *  putSelfPath returns a Promise of the first reply (signalk-server >= 2) and
   *  calls the callback on every update of the request; a PENDING reply means
   *  "wait for the callback". The handler timeout in handle() bounds the wait. */
  function execPut (path, value) {
    if (!app || typeof app.putSelfPath !== 'function') {
      return Promise.resolve(fail(REFUSAL.NO_HANDLER, 'no_put_api'))
    }
    return new Promise((resolve) => {
      let done = false
      const settle = (reply) => {
        if (done) return
        let outcome
        try {
          outcome = putOutcome(reply, path, value)
        } catch (err) {
          // An unreadable reply is a final failure, never a put left pending
          // forever (it would then never be audited after a timeout, #35).
          outcome = fail(REFUSAL.SIGNALK_REFUSED, `unreadable reply: ${(err && err.message) || 'error'}`)
        }
        if (outcome) { done = true; resolve(outcome) }
      }
      const onUpdate = (reply) => {
        debug(`yey connector: remote steering ${path} update ` +
          `${(reply && (reply.state || reply.message)) || ''} ${(reply && reply.statusCode) || ''}`.trim())
        settle(reply)
      }
      let returned
      try {
        returned = app.putSelfPath(path, value, onUpdate)
      } catch (err) {
        done = true
        resolve(fail(REFUSAL.SIGNALK_REFUSED, (err && err.message) || 'threw'))
        return
      }
      if (returned && typeof returned.then === 'function') {
        returned.then(settle, (err) => {
          if (done) return
          done = true
          resolve(fail(REFUSAL.SIGNALK_REFUSED, (err && err.message) || 'rejected'))
        })
      } else if (returned && typeof returned === 'object') {
        settle(returned)
      }
      // else: an older server returned nothing; the callback decides.
    })
  }

  /** Every rule is the policy's (lib/steering-policy.js); the envelope was
   *  checked by handle() through the same policy before this runs. */
  async function opPut (args) {
    const a = args || {}
    if (!steeringOn()) return fail(REFUSAL.REMOTE_STEERING_OFF)
    const raw = a.path
    const path = typeof raw === 'string' ? raw.trim() : ''
    if (!path || path.length > lim.max_path_len || !PATH_RE.test(path)) {
      return fail(REFUSAL.BAD_REQUEST, 'path')
    }
    if (!steering.isSteeringPath(path)) return fail(REFUSAL.NOT_PERMITTED)
    if (deniedBy(path, currentPolicy().deny || [])) return fail(REFUSAL.DENIED_LOCALLY)
    if (!('value' in a)) return fail(REFUSAL.BAD_REQUEST, 'value_missing')
    const bad = steering.validateValue(path, a.value)
    if (bad) return fail(REFUSAL.BAD_REQUEST, bad)
    if (!steering.admitRate()) return fail(REFUSAL.RATE_LIMITED)
    return execPut(path, a.value)
  }

  /** After a put timed out: what the path holds now, so the cloud can tell
   *  "did not happen" from "happened late". Bounded; never throws. */
  async function readback (path) {
    const p = typeof path === 'string' ? path.trim() : ''
    if (!steering.isSteeringPath(p) || p.includes('.actions.')) return null
    let timer = null
    try {
      const tree = await Promise.race([
        Promise.resolve(source().selfTree()),
        new Promise((resolve) => { timer = arm(() => resolve(null), 250) })
      ])
      const node = nodeAt(tree, p)
      if (!node || typeof node !== 'object' || !('value' in node)) return null
      const v = node.value
      const scalar = v === null || typeof v === 'boolean' || typeof v === 'string' ||
        (typeof v === 'number' && Number.isFinite(v))
      return scalar ? { path: p, value: v } : null
    } catch {
      return null
    } finally {
      if (timer) disarm(timer)
    }
  }

  /** The local trail: every put, accepted or refused. Never the args beyond a
   *  steering path and a short scalar — nothing secret travels in a put. */
  function trailPut (args, outcome, id) {
    const a = args || {}
    const path = typeof a.path === 'string' ? a.path.trim().slice(0, 80) : '?'
    const v = a.value
    const shown = (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      ? String(v)
      : (typeof v === 'string' ? v.slice(0, MAX_PUT_STRING) : (v === undefined ? '' : typeof v))
    const hhmm = new Date(now()).toISOString().slice(11, 16)
    const error = (outcome && outcome.error) || 'internal'
    const verdict = outcome && outcome.ok ? 'accepted'
      : (error === REFUSAL.TIMEOUT ? 'timed out (may still complete)' : `refused (${error})`)
    if (outcome && outcome.ok) clockProblem = null
    lastPut = `Remote steering: ${path}=${shown} ${verdict} ${hhmm}`
    if (!(outcome && outcome.ok) && outcome && outcome.detail === 'deadline_too_far' && clockProblem) {
      lastPut += ` — ${clockProblem.text}`
    }
    debug(`yey connector: ${lastPut}` +
      (outcome && !outcome.ok && outcome.detail ? ` — ${outcome.detail}` : ''))
    try { setStatus(lastPut) } catch { /* status is best effort */ }
    const ok = Boolean(outcome && outcome.ok)
    auditPut(id, a, ok ? 'accepted' : (error === REFUSAL.TIMEOUT ? 'timeout' : 'refused'),
      ok ? null : error, ok ? null : outcome && outcome.detail)
  }

  // The refusal cap: a fixed one-minute window opened by the first
  // non-accepted record, a count of the records written in it, and a count of
  // the ones suppressed, flushed as one record when the window ends (by a timer,
  // or by the next put, whichever comes first).
  const NEVER_SUPPRESSED = ['accepted', 'timeout', 'auto_off']
  const auditWindow = { start: 0, written: 0, suppressed: 0, timer: null }

  function writeAudit (entry) {
    try { audit(entry) } catch { /* the audit is best effort */ }
  }

  function flushSuppressed () {
    if (auditWindow.timer) { try { disarm(auditWindow.timer) } catch { /* gone */ } auditWindow.timer = null }
    if (auditWindow.suppressed > 0) {
      writeAudit({ path: null, outcome: 'suppressed', detail: `n=${auditWindow.suppressed}` })
    }
    auditWindow.start = 0
    auditWindow.written = 0
    auditWindow.suppressed = 0
  }

  function auditPut (id, args, outcome, error, detail) {
    const t = now()
    if (auditWindow.start && t - auditWindow.start >= 60000) flushSuppressed()
    if (!NEVER_SUPPRESSED.includes(outcome)) {
      if (!auditWindow.start) auditWindow.start = t
      if (auditWindow.written >= lim.max_audit_refusals_per_min) {
        auditWindow.suppressed += 1
        if (!auditWindow.timer) {
          try {
            auditWindow.timer = arm(() => { auditWindow.timer = null; flushSuppressed() },
              Math.max(1000, auditWindow.start + 60000 - t))
            if (auditWindow.timer && typeof auditWindow.timer.unref === 'function') auditWindow.timer.unref()
          } catch { auditWindow.timer = null }
        }
        return
      }
      auditWindow.written += 1
    }
    const a = args || {}
    const entry = { request_id: id, path: typeof a.path === 'string' ? a.path.trim() : null, value: a.value, outcome }
    if (error) entry.error = error
    if (detail) entry.detail = detail
    writeAudit(entry)
  }

  async function dispatch (op, args) {
    if (WRITE_OPS.includes(op)) return fail(REFUSAL.NOT_PERMITTED)
    if (op === 'put') return opPut(args)
    if (op === 'capabilities') return opCapabilities(args)
    if (op === 'get') return opGet(args)
    if (op === 'meta') return opMeta(args)
    if (op === 'catalog') return opCatalog(args)
    if (op === 'history') return opHistory(args)
    return fail(REFUSAL.UNSUPPORTED, 'op')
  }

  async function answer (id, op, outcome) {
    let payload = { schema: REPLY_SCHEMA, id, op, ...outcome }
    if (byteLength(payload) > lim.max_reply_bytes) {
      payload = { schema: REPLY_SCHEMA, id, op, ...fail(REFUSAL.TOO_LARGE) }
    }
    if (payload.ok) counters.served += 1
    else { counters.refused += 1; counters.last_error = payload.error }
    try {
      // Idempotency key derived from the id: a retried publish of the same
      // answer is the same message, never a second one.
      await publish(REPLY_SUBJECT, payload, { idempotencyKey: `rpc:${id}` })
    } catch (err) {
      counters.dropped += 1
      debug(`yey connector: rpc reply ${id} not sent (${(err && err.code) || (err && err.message)})`)
    }
    return payload
  }

  /**
   * Handle one `chat_service` envelope. Resolves with the reply that was sent,
   * or null when the envelope was not ours or was dropped.
   */
  async function handle (envelope) {
    const env = envelope || {}
    if (String(env.type || '') !== REQUEST_EVENT) return null
    const data = env.data && typeof env.data === 'object' ? env.data : {}
    const id = String(data.id || '')
    const op = String(data.op || '')
    const args = data.args && typeof data.args === 'object' ? data.args : {}
    // A put that is dropped unanswered is still an attempt: audit it.
    const drop = (why) => {
      counters.dropped += 1
      if (op === 'put') auditPut(id, args, 'dropped', why)
      return null
    }
    if (data.schema !== REQUEST_SCHEMA) return drop('bad_schema')
    if (!ID_RE.test(id)) return drop('bad_id')
    const t = now()
    const deadline = Number(data.deadline_ms) || 0
    // Every put leaves a local trail, whatever happened to it.
    const reply = (outcome) => {
      if (op === 'put') trailPut(args, outcome, id)
      return answer(id, op, outcome)
    }
    if (op === 'put') {
      // Switch first: while it is off nothing else is looked at (and nothing
      // is written to the replay store).
      if (!steeringOn()) {
        counters.last_op = op
        counters.last_at = t
        if (!admitRate(t)) return reply(fail(REFUSAL.RATE_LIMITED))
        return reply(fail(REFUSAL.REMOTE_STEERING_OFF))
      }
      // boat_id, deadline_ms and replay: the policy's. The request rate is
      // admitted BEFORE the id is recorded, so a flood of distinct ids holds
      // at most max_per_min ids per minute in the store, never all of it, and
      // a standby after the flood still gets through (#35).
      const req = { id, boat_id: data.boat_id, deadline_ms: data.deadline_ms }
      let verdict = steering.inspectRequest(req)
      if (verdict.drop) {
        // Only a put the rate would admit names the clock (#41): a flood of
        // stale queued puts after an outage is not a clock problem. Peek, do
        // not consume: dropped puts must not use up the rate.
        if (rateRoom(t)) noteClock(verdict, deadline, t)
        return drop(verdict.drop)
      }
      counters.last_op = op
      counters.last_at = t
      if (!admitRate(t)) return reply(fail(REFUSAL.RATE_LIMITED))
      noteClock(verdict, deadline, t)
      if (!verdict.refuse) {
        verdict = steering.recordRequest(req)
        if (verdict.drop) return drop(verdict.drop)
      }
      if (verdict.refuse) {
        return reply(fail(verdict.refuse === 'replay_store_full' ? REFUSAL.BUSY : REFUSAL.BAD_REQUEST, verdict.refuse))
      }
    } else {
      // Belt and braces: only this boat's socket can be in the room, but a
      // request naming another boat is not ours to answer.
      const me = typeof boatId === 'function' ? boatId() : boatId
      if (data.boat_id && me && String(data.boat_id) !== String(me)) return drop('foreign_boat')
      // The cloud has stopped waiting: an answer now is traffic nobody reads.
      if (deadline && t > deadline) return drop('expired')
      if (!remember(id)) return drop('duplicate')
    }

    if (op !== 'put') {
      counters.last_op = op
      counters.last_at = t
      if (!admitRate(t)) return reply(fail(REFUSAL.RATE_LIMITED))
    }
    if (inFlight >= lim.max_in_flight) return reply(fail(REFUSAL.BUSY))

    inFlight += 1
    let timer = null
    const budget = Math.max(1, Math.min(lim.handler_timeout_ms, deadline ? deadline - t : lim.handler_timeout_ms))
    try {
      const work = dispatch(op, args)
      let outcome = await Promise.race([
        work,
        new Promise((resolve) => { timer = arm(() => resolve(fail(REFUSAL.TIMEOUT)), budget) })
      ])
      if (op === 'put' && outcome && outcome.error === REFUSAL.TIMEOUT) {
        // The put may still complete: audit what it finally did, and tell the
        // cloud what the path holds now.
        work.then((late) => {
          if (!late || late.error === REFUSAL.TIMEOUT) return
          auditPut(id, args, late.ok ? 'accepted' : 'refused', late.ok ? null : late.error,
            late.ok ? 'after_timeout' : `after_timeout${late.detail ? `: ${late.detail}` : ''}`)
        }, (err) => {
          // A put that fails after its timeout is audited too (#35).
          auditPut(id, args, 'refused', REFUSAL.INTERNAL,
            `after_timeout: ${String((err && err.message) || 'rejected').slice(0, 80)}`)
        })
        const rb = await readback(args.path)
        if (rb) outcome = { ...outcome, readback: rb }
      }
      return await reply(outcome)
    } catch (err) {
      debug(`yey connector: rpc ${op} failed (${err && err.message})`)
      return reply(fail(REFUSAL.INTERNAL))
    } finally {
      if (timer) disarm(timer)
      inFlight -= 1
    }
  }

  function stats () {
    return {
      served: counters.served,
      refused: counters.refused,
      dropped: counters.dropped,
      in_flight: inFlight,
      last_op: counters.last_op,
      last_error: counters.last_error,
      remote_steering: steeringOn(),
      last_put: lastPut,
      clock_problem: clockProblem,
      last_request_at: counters.last_at ? new Date(counters.last_at).toISOString() : ''
    }
  }

  /** Plugin stop: write a pending suppressed count now (it would otherwise
   *  wait for a timer that dies with the process) and disarm that timer. */
  function stop () {
    flushSuppressed()
  }

  return { handle, stats, stop, authorize: (path) => authorize(path, currentPolicy()) }
}

module.exports = {
  REQUEST_EVENT, REPLY_SUBJECT, REQUEST_SCHEMA, REPLY_SCHEMA, OPS, WRITE_OPS,
  REFUSAL, LIMITS, STEERING_PATHS, authorize, mappingCovers, loadTemporal,
  isSteeringPath, isPutScalar, putOutcome, createRpcServer
}
