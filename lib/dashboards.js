'use strict'

/**
 * yey.boats dashboards on the boat, behind a yey.boats login.
 *
 * The boat's pairing token is NOT enough to read them, and nothing here is on
 * SignalK's resources API: a guest with SignalK read access (boat Wi-Fi) must
 * never reach them. Someone on board proves a yey.boats login instead:
 *
 *   linkStart()  -> the cloud hands out a short code + verify_url; a person who
 *                   is signed in to yey.boats (owner or crew) approves it there
 *   linkPoll()   -> once approved, the cloud hands the boat a GRANT for that
 *                   user; it is stored in the connector's private state file
 *   list()/get() -> read that user's dashboards with the grant
 *   unlink()     -> give the grant back
 *
 * Other plugins reach this in-process only, as `app.yeyDashboards` (index.js).
 * All of it goes over the paired uplink, subject `yey.boat.dashboards`.
 *
 * At most ONE grant is held. It is never logged and never shown: status shows
 * {linked, user_label, expires_at} and nothing more. Re-pairing or unpairing
 * the boat forgets the grant and any pending link.
 */

const crypto = require('node:crypto')

const SUBJECT = 'yey.boat.dashboards'
const LIST_CACHE_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
// The key in the connector's state file (lib/state.js: 0600, atomic writes).
const STATE_KEY = 'dashboards_grant'

function fail (code, message) {
  const err = new Error(message || code)
  err.code = code
  return err
}

/** A cloud refusal (ERROR_EVENT -> err.code / err.message, lib/uplink.js
 *  settle()) as an Error another plugin can read: the code is kept, the
 *  message says where it came from. */
function cloudError (err) {
  const code = String((err && err.code) || 'handler_error')
  const detail = String((err && err.message) || '')
  return fail(code, `yey.boats: ${detail && detail !== code ? `${code}: ${detail}` : code}`)
}

/** A result body that reports an error instead of raising one (defensive: the
 *  contract sends errors as ERROR_EVENT, but a handler may reply {ok:false}). */
function replyError (reply) {
  if (!reply || typeof reply !== 'object') return fail('bad_reply', 'yey.boats: empty reply')
  if (reply.ok === false || reply.error) {
    const e = reply.error
    const code = String((e && typeof e === 'object' ? e.code : e) || 'handler_error')
    const message = e && typeof e === 'object' ? e.message : reply.message
    return cloudError({ code, message })
  }
  return null
}

function str (v) { return v == null ? '' : String(v) }

/** An ISO time `seconds` from now, or '' for a missing/bad number. */
function isoIn (nowMs, seconds) {
  const s = Number(seconds)
  return Number.isFinite(s) && s > 0 ? new Date(nowMs + s * 1000).toISOString() : ''
}

/** True when `iso` is a real time at or before now. '' never expires. */
function past (iso, nowMs) {
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t <= nowMs : true // unreadable: treat as expired
}

function summary (d) {
  return {
    id: str(d.id),
    title: str(d.title || d.id),
    targetClass: str(d.targetClass),
    updatedAt: str(d.updatedAt)
  }
}

/**
 * @param {object} o
 * @param {(subject, payload, opts) => Promise<object>} o.request  uplink.request
 * @param {() => boolean} o.isConnected  paired, running AND the socket is up
 * @param {{read, patch}} o.state  lib/state.js: where the grant persists
 */
function createDashboards ({ request, isConnected, state, now = Date.now,
  cacheMs = LIST_CACHE_MS, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let pending = null // { link_id, code, verify_url, expires_at }
  let cache = null // { key, at, value }
  // Bumped by reset(): an answer to a request sent before a re-pair or unpair
  // is dropped rather than stored against the new pairing.
  let generation = 0

  function readGrant () {
    const g = (state.read() || {})[STATE_KEY]
    return g && typeof g === 'object' && typeof g.grant === 'string' && g.grant ? g : null
  }
  function writeGrant (g) {
    state.patch({ [STATE_KEY]: g || null })
    cache = null
  }
  function grantKey (grant) {
    return crypto.createHash('sha256').update(grant).digest('hex')
  }

  async function ask (payload) {
    if (!isConnected()) throw fail('not_connected', 'not connected to yey.boats')
    let reply
    try {
      reply = await request(SUBJECT, payload, {
        // idempotency="required" on the handler. A read must never be
        // de-duplicated into silence, so every call gets its own key.
        idempotencyKey: `dash_${payload.op}_${now()}_${crypto.randomBytes(6).toString('hex')}`,
        timeoutMs
      })
    } catch (err) {
      throw cloudError(err)
    }
    const bad = replyError(reply)
    if (bad) throw bad
    return reply
  }

  /** The grant to use now, or a rejection: not_connected, then not_linked. */
  function usableGrant () {
    if (!isConnected()) throw fail('not_connected', 'not connected to yey.boats')
    const g = readGrant()
    if (!g) throw fail('not_linked', 'no yey.boats login is linked on this boat')
    if (past(g.expires_at, now())) {
      writeGrant(null)
      throw fail('not_linked', 'the yey.boats login linked on this boat has expired')
    }
    return g
  }

  /** A grant the cloud no longer honours is forgotten here too. */
  async function withGrant (g, payload) {
    const gen = generation
    try {
      return await ask({ ...payload, grant: g.grant })
    } catch (err) {
      if (err.code === 'grant_invalid' && gen === generation) {
        const held = readGrant()
        if (held && held.grant === g.grant) writeGrant(null)
      }
      throw err
    }
  }

  function pendingView () {
    if (!pending) return null
    if (past(pending.expires_at, now())) { pending = null; return null }
    return { code: pending.code, verify_url: pending.verify_url, expires_at: pending.expires_at }
  }

  async function linkStart () {
    const gen = generation
    const reply = await ask({ op: 'link_start' })
    if (reply.kind !== 'link' || !reply.link_id || !reply.code) {
      throw fail('bad_reply', 'yey.boats: unexpected reply to link_start')
    }
    const next = {
      link_id: str(reply.link_id),
      code: str(reply.code),
      verify_url: str(reply.verify_url),
      expires_at: isoIn(now(), reply.expires_in)
    }
    if (gen !== generation) throw fail('not_connected', 'the boat was re-paired; start again')
    pending = next
    return { code: next.code, verify_url: next.verify_url, expires_at: next.expires_at }
  }

  async function linkPoll () {
    if (!pending) throw fail('no_pending_link', 'no link is waiting; call linkStart() first')
    if (past(pending.expires_at, now())) { pending = null; return { status: 'expired' } }
    const gen = generation
    const asked = pending
    const reply = await ask({ op: 'link_poll', link_id: asked.link_id })
    const status = str(reply.status)
    if (reply.kind !== 'link_status' ||
        !['pending', 'approved', 'rejected', 'expired'].includes(status)) {
      throw fail('bad_reply', 'yey.boats: unexpected reply to link_poll')
    }
    // Re-paired, or another linkStart(), while this was in flight.
    if (gen !== generation || pending !== asked) {
      throw fail('no_pending_link', 'this link was replaced; poll the new one')
    }
    if (status === 'pending') return { status }
    pending = null
    if (status !== 'approved') return { status }
    if (typeof reply.grant !== 'string' || !reply.grant) {
      throw fail('bad_reply', 'yey.boats: approved without a grant')
    }
    const g = { grant: reply.grant, user_label: str(reply.user_label), expires_at: str(reply.expires_at) }
    writeGrant(g) // replaces any earlier one: at most one grant
    return { status, user_label: g.user_label, expires_at: g.expires_at }
  }

  async function list () {
    const g = usableGrant()
    const key = grantKey(g.grant)
    if (cache && cache.key === key && now() - cache.at < cacheMs) return clone(cache.value)
    const gen = generation
    const reply = await withGrant(g, { op: 'list' })
    if (reply.kind !== 'dashboards' || !Array.isArray(reply.dashboards)) {
      throw fail('bad_reply', 'yey.boats: unexpected reply to dashboards list')
    }
    const value = {
      dashboards: reply.dashboards.filter((d) => d && typeof d === 'object' && d.id).map(summary),
      user_label: str(reply.user_label || g.user_label)
    }
    const current = readGrant()
    if (gen === generation && current && current.grant === g.grant) {
      cache = { key, at: now(), value }
      if (value.user_label && value.user_label !== current.user_label) {
        state.patch({ [STATE_KEY]: { ...current, user_label: value.user_label } })
      }
    }
    return clone(value)
  }

  async function get (id) {
    const wanted = str(id)
    if (!wanted) throw fail('bad_request', 'a dashboard id is required')
    const g = usableGrant()
    const reply = await withGrant(g, { op: 'get', id: wanted })
    const d = reply.dashboard
    if (reply.kind !== 'dashboard' || !d || typeof d !== 'object') {
      throw fail('bad_reply', 'yey.boats: unexpected reply to dashboards get')
    }
    return { ...summary({ ...d, id: d.id || wanted }), doc: d.doc === undefined ? null : d.doc }
  }

  async function unlink () {
    const g = readGrant()
    pending = null
    if (!g) return { linked: false }
    // Forgotten here first, whatever the cloud says.
    writeGrant(null)
    await ask({ op: 'unlink', grant: g.grant })
    return { linked: false }
  }

  function view () {
    const g = readGrant()
    const linked = Boolean(g) && !past(g.expires_at, now())
    return { linked, user_label: linked ? str(g.user_label) : '', expires_at: linked ? str(g.expires_at) : '' }
  }

  function snapshot () {
    return { connected: Boolean(isConnected()), ...view(), pending: pendingView() }
  }

  /** Unpair or re-pair: no grant, no pending link, no cache. */
  function reset () {
    generation++
    pending = null
    cache = null
    if (readGrant()) state.patch({ [STATE_KEY]: null })
  }

  /** /status: never the grant, never the link code. */
  function statusView () {
    const p = pendingView()
    return { ...view(), pending: p ? { expires_at: p.expires_at } : null }
  }

  const api = {
    state: async () => snapshot(),
    linkStart,
    linkPoll,
    list,
    get,
    unlink
  }

  return { api, reset, statusView }
}

function clone (value) {
  return { dashboards: value.dashboards.map((d) => ({ ...d })), user_label: value.user_label }
}

module.exports = { SUBJECT, LIST_CACHE_MS, STATE_KEY, createDashboards }
