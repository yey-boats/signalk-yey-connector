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
 *   4. writes and controls are refused outright (`not_permitted`). There is no
 *      owner-approved write design yet, and remote control of a vessel is not
 *      something a query channel acquires by accident.
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

const REQUEST_EVENT = 'yey.boat.request'
const REPLY_SUBJECT = 'yey.boat.reply'
const REQUEST_SCHEMA = 'yey.boat.request.v1'
const REPLY_SCHEMA = 'yey.boat.reply.v1'

const OPS = Object.freeze(['get', 'meta', 'history', 'catalog'])
// Named so a refusal is `not_permitted` rather than `unsupported`: the boat
// understands the request and declines it.
const WRITE_OPS = Object.freeze(['write', 'put', 'set', 'control', 'actuate'])

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
  INTERNAL: 'internal'
})

const LIMITS = Object.freeze({
  // Comfortably under the platform's per-message bound, and small enough that a
  // reply over a marina link is one round trip, not a download.
  max_reply_bytes: 64 * 1024,
  max_per_min: 30,
  max_in_flight: 4,
  // The cloud waits at most 5 s (spec "Read path"); answering later is wasted.
  handler_timeout_ms: 4500,
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

function fail (reason, detail) {
  const out = { ok: false, error: reason }
  if (detail) out.detail = String(detail).slice(0, 120)
  return out
}

function createRpcServer ({
  app, getSource, policy, getCatalog, publish, now = Date.now, debug = () => {},
  temporal, limits = {}, setTimer, clearTimer, boatId
} = {}) {
  const lim = { ...LIMITS, ...limits }
  const arm = setTimer || ((fn, ms) => setTimeout(fn, ms))
  const disarm = clearTimer || ((h) => clearTimeout(h))
  const recent = []           // timestamps of accepted requests, last minute
  const seen = []             // last request ids, for dedupe
  let inFlight = 0
  const counters = { served: 0, refused: 0, dropped: 0, last_op: '', last_at: 0, last_error: '' }

  const currentPolicy = () => {
    try { return (typeof policy === 'function' ? policy() : policy) || {} } catch { return {} }
  }
  const source = () => (typeof getSource === 'function' ? getSource() : getSource)

  function admitRate (t) {
    while (recent.length && t - recent[0] >= 60000) recent.shift()
    if (recent.length >= lim.max_per_min) return false
    recent.push(t)
    return true
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

  async function dispatch (op, args) {
    if (WRITE_OPS.includes(op)) return fail(REFUSAL.NOT_PERMITTED)
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
    if (data.schema !== REQUEST_SCHEMA || !ID_RE.test(id)) { counters.dropped += 1; return null }
    // Belt and braces: only this boat's socket can be in the room, but a
    // request naming another boat is not ours to answer.
    const me = typeof boatId === 'function' ? boatId() : boatId
    if (data.boat_id && me && String(data.boat_id) !== String(me)) { counters.dropped += 1; return null }
    const t = now()
    const deadline = Number(data.deadline_ms) || 0
    // The cloud has stopped waiting: an answer now is traffic nobody reads.
    if (deadline && t > deadline) { counters.dropped += 1; return null }
    if (!remember(id)) { counters.dropped += 1; return null }

    const op = String(data.op || '')
    counters.last_op = op
    counters.last_at = t
    if (!admitRate(t)) return answer(id, op, fail(REFUSAL.RATE_LIMITED))
    if (inFlight >= lim.max_in_flight) return answer(id, op, fail(REFUSAL.BUSY))

    inFlight += 1
    let timer = null
    const budget = Math.max(1, Math.min(lim.handler_timeout_ms, deadline ? deadline - t : lim.handler_timeout_ms))
    try {
      const outcome = await Promise.race([
        dispatch(op, data.args && typeof data.args === 'object' ? data.args : {}),
        new Promise((resolve) => { timer = arm(() => resolve(fail(REFUSAL.TIMEOUT)), budget) })
      ])
      return await answer(id, op, outcome)
    } catch (err) {
      debug(`yey connector: rpc ${op} failed (${err && err.message})`)
      return answer(id, op, fail(REFUSAL.INTERNAL))
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
      last_request_at: counters.last_at ? new Date(counters.last_at).toISOString() : ''
    }
  }

  return { handle, stats, authorize: (path) => authorize(path, currentPolicy()) }
}

module.exports = {
  REQUEST_EVENT, REPLY_SUBJECT, REQUEST_SCHEMA, REPLY_SCHEMA, OPS, WRITE_OPS,
  REFUSAL, LIMITS, authorize, mappingCovers, loadTemporal, createRpcServer
}
