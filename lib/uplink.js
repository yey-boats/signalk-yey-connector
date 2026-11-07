'use strict'

const crypto = require('node:crypto')
const { callPublicOp: defaultCall } = require('./cloud-client')

// vendor/.../apps/chat/sdk/runtime/data_bus/types.py:15
const INGRESS_SCHEMA = 'kdcube.data_bus.ingress.v1'
// vendor/.../apps/chat/sdk/runtime/data_bus/types.py:259-305
const RESULT_EVENT = 'kdcube.data_bus.result'
const ERROR_EVENT = 'kdcube.data_bus.error'
// Refresh is REACTIVE, at (re)connect only — there is deliberately no timer.
// The federated token is verified exactly once, at the socket handshake
// (vendor/…/apps/chat/ingress/socketio/chat.py:281); the verified session is then
// saved against the sid (`:376-389`) and nothing re-checks it per message. A live
// socket therefore outlives its own token, and a token that expires mid-session
// costs nothing. Refreshing on a timer while connected would buy nothing either:
// the new token cannot reach an already-authenticated socket without redialling,
// which is the exact cost a proactive refresh is meant to avoid.
// What this fraction buys is the reconnect: connect() re-claims once the token is
// past 80% of its life, so a reconnect after a long outage never dials with a
// token that is about to expire between the claim and the handshake.
//
// ONE timer exists anyway, for the cloud->boat direction (lib/rpc.js). The
// platform's live-session route — the only way the cloud can push a
// `yey.boat.request` to this socket — is leased no longer than the token that
// admitted it (vendor/…/sdk/runtime/data_bus/live_session_lease.py:27-33,
// lease_deadline = min(credential_expires_at, …)). A socket that outlives its
// token keeps PUBLISHING fine but silently stops being REACHABLE. So at the
// refresh point the uplink reports itself lost ('token_refresh'), and the
// supervisor's ordinary reconnect re-claims and re-registers. Uploads are not
// interrupted in any way that matters: the buffer carries through, as it does
// through any reconnect.
const TOKEN_REFRESH_FRACTION = 0.8
// Never redial sooner than this after a connect, whatever the token says: a
// cloud handing out very short tokens must not turn this into a dial loop.
const MIN_REDIAL_MS = 60 * 1000

function fail (code, message) {
  const err = new Error(message || code)
  err.code = code
  return err
}

/**
 * Jittered exponential backoff, entirely plan-controlled.
 *
 * Once this plugin is on customers' boats a backoff bug cannot be fixed by
 * shipping code — the fleet is offline half the year. So the curve comes from
 * the plan's transport block and an incident is answered by pushing a plan
 * (spec "Design consequence — transport controls belong in the plan").
 * The DEFAULTS must still be safe alone, for a boat that reconnects before it
 * has ever received a plan.
 */
function backoffDelayMs (attempt, transport, rand = Math.random) {
  const t = transport || {}
  const base = Math.max(1, Number(t.backoff_base_s) || 2)
  const ceiling = Math.max(base, Number(t.backoff_ceiling_s) || 300)
  const n = Math.max(1, Number(attempt) || 1)
  const raw = Math.min(ceiling, base * 2 ** (n - 1))
  const pct = Math.max(0, Math.min(100, Number(t.reconnect_jitter_pct) || 0)) / 100
  const factor = 1 + (rand() * 2 - 1) * pct
  return Math.max(0, Math.round(raw * 1000 * factor))
}

function newId (prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
}

/** kdcube.data_bus.ingress.v1 —
 *  vendor/…/app/ai-app/docs/service/comm/client-transport-protocols-README.md:246-268 */
function buildPackage ({ bundleId, subject, boatId, payload, idempotencyKey, messageId }) {
  return {
    schema: INGRESS_SCHEMA,
    bundle_id: bundleId,
    messages: [{
      message_id: messageId || newId('dbmsg'),
      subject,
      // partition_by="object_ref" + ordering="serial_per_partition" on the
      // handlers, so object_ref IS the per-boat partition key.
      object_ref: boatId,
      // idempotency="required" on every one of our handlers; a message without
      // this is rejected outright (worker.py:307-315).
      idempotency_key: idempotencyKey || newId('idem'),
      payload: payload || {}
    }]
  }
}

function createUplink ({ cfg, transport, deps = {} }) {
  const call = deps.callPublicOp || defaultCall
  const io = deps.io || ((...args) => require('socket.io-client').io(...args))
  const now = deps.now || Date.now

  let socket = null
  let connected = false
  let token = null
  let tokenClaimedAt = 0
  let tokenRefreshAt = 0
  let lastDisconnectReason = ''
  let closing = false         // true only for a close() WE asked for
  let onLost = () => {}       // set by the supervisor
  const pending = new Map()   // message_id -> {resolve, reject, timer}
  const listeners = new Map() // chat_service event type -> [fn]
  let redialTimer = null
  const armTimer = deps.uplinkSetTimeout || ((fn, ms) => {
    const handle = setTimeout(fn, ms)
    if (handle && typeof handle.unref === 'function') handle.unref()
    return handle
  })
  const disarmTimer = deps.uplinkClearTimeout || ((handle) => clearTimeout(handle))

  async function claimToken () {
    const res = await call(cfg, 'signalk_boat_token_claim', {
      boat_id: cfg.boatId,
      boat_credential: cfg.boatCredential
    })
    if (!res || res.ok !== true) throw fail(res && res.error ? res.error : 'token_failed')
    token = String(res.federated_token || '')
    tokenClaimedAt = now()
    const lifetimeMs = Math.max(0, Number(res.expires_at) * 1000 - tokenClaimedAt)
    tokenRefreshAt = tokenClaimedAt + Math.floor(lifetimeMs * TOKEN_REFRESH_FRACTION)
    return res
  }

  /**
   * Correlate one chat_service envelope with a waiting request.
   *
   * The type gate is load-bearing, not decoration: the Data Bus emits several
   * event types against the SAME message_id (an accepted/progress event travels
   * ahead of the handler's own reply, types.py:259-305). Resolving on "anything
   * that is not an error" would hand the caller a progress envelope as if it
   * were the handler's answer — the plan as written did exactly that and left
   * RESULT_EVENT defined and unread.
   */
  function settle (envelope) {
    const type = String((envelope || {}).type || '')
    if (type !== RESULT_EVENT && type !== ERROR_EVENT) return
    const data = (envelope || {}).data || {}
    const key = String(data.message_id || '')
    const entry = pending.get(key)
    if (!entry) return            // a result for a message we are not awaiting
    pending.delete(key)
    clearTimeout(entry.timer)
    if (type === ERROR_EVENT) {
      const inner = data.data || {}
      entry.reject(fail(String(inner.code || 'handler_error'), String(inner.message || '')))
      return
    }
    entry.resolve(data.data || {})
  }

  /** Hand any other chat_service event to whoever asked for its type
   *  (lib/rpc.js asks for `yey.boat.request`). A listener that throws must not
   *  take the socket's event loop with it. */
  function dispatch (envelope) {
    const type = String((envelope || {}).type || '')
    for (const fn of listeners.get(type) || []) {
      try { fn(envelope) } catch { /* the listener owns its own errors */ }
    }
  }

  function onEvent (type, fn) {
    if (typeof fn !== 'function') return
    const key = String(type)
    listeners.set(key, [...(listeners.get(key) || []), fn])
  }

  function armRedial () {
    if (redialTimer) { disarmTimer(redialTimer); redialTimer = null }
    if (!tokenRefreshAt) return
    const delay = Math.max(MIN_REDIAL_MS, tokenRefreshAt - now())
    redialTimer = armTimer(() => {
      redialTimer = null
      if (!closing && socket) onLost('token_refresh')
    }, delay)
  }

  async function connect () {
    // The one and only refresh point (see TOKEN_REFRESH_FRACTION above).
    if (!token || now() >= tokenRefreshAt) await claimToken()
    socket = io(cfg.cloudOrigin, {
      path: '/socket.io',
      // The plan owns the backoff curve; the library's own loop would compete.
      reconnection: false,
      auth: {
        tenant: cfg.tenant,
        project: cfg.project,
        bundle_id: cfg.bundleId,
        federated_token: token,
        client_role: 'connector'
      }
    })
    closing = false
    socket.on('connect', () => { connected = true })
    // A socket-level drop is told to the supervisor, not merely recorded. Left
    // unreported it is invisible until the next publish fails with
    // 'not_connected' — and flush() returns early when the buffer is empty, so
    // an idle boat would not notice until the heartbeat came due, up to
    // transport.heartbeat_s (default 300s) later. Nothing is lost in that
    // window, but the boat is silently off the air for it, and a plan pushed
    // from the cloud never arrives. One event handler removes the whole window.
    socket.on('disconnect', (reason) => {
      connected = false
      lastDisconnectReason = String(reason || '')
      if (!closing) onLost(`disconnect: ${lastDisconnectReason}`)
    })
    // socket.io emits this instead of 'disconnect' when the handshake itself
    // never lands (DNS, refused, a 4xx on the polling upgrade). With
    // reconnection:false the library gives up silently, so without this the
    // retry curve is never armed at all.
    socket.on('connect_error', (err) => {
      connected = false
      lastDisconnectReason = String((err && err.message) || 'connect_error')
      if (!closing) onLost(`connect_error: ${lastDisconnectReason}`)
    })
    socket.on('chat_service', (envelope) => { settle(envelope); dispatch(envelope) })
    connected = true   // the fake and the real client both emit 'connect'; this
                       // keeps a synchronous caller correct either way
    armRedial()
    return socket
  }

  function publish (subject, payload, { idempotencyKey, messageId, timeoutMs = 20000 } = {}) {
    if (!socket || !connected) return Promise.reject(fail('not_connected'))
    const pkg = buildPackage({
      bundleId: cfg.bundleId, subject, boatId: cfg.boatId, payload,
      idempotencyKey, messageId
    })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail('ack_timeout')), timeoutMs)
      socket.emit('data_bus.publish', pkg, (ack) => {
        clearTimeout(timer)
        // An ack confirms the Redis Stream write, NOT that a handler ran
        // (client-transport-protocols-README.md:270-276). Return it as-is; the
        // caller decides what a 'rejected' means for its own retry.
        resolve(ack || { schema: INGRESS_SCHEMA, status: 'rejected', accepted: [], rejected: [] })
      })
    })
  }

  /** Publish and wait for the handler's ctx.reply, correlated on message_id. */
  function request (subject, payload, { idempotencyKey, messageId, timeoutMs = 15000 } = {}) {
    const id = messageId || newId('dbmsg')
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(fail('reply_timeout'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
    })
    publish(subject, payload, { idempotencyKey, messageId: id, timeoutMs })
      .catch((err) => {
        const entry = pending.get(id)
        if (entry) { pending.delete(id); clearTimeout(entry.timer); entry.reject(err) }
      })
    return answer
  }

  function close () {
    // Set BEFORE the socket goes, so the 'disconnect' this provokes is not
    // reported as a lost link. onLinkLost() calls close() itself, so without
    // this the two would call each other.
    closing = true
    if (redialTimer) { disarmTimer(redialTimer); redialTimer = null }
    for (const [, entry] of pending) clearTimeout(entry.timer)
    pending.clear()
    if (socket) { try { socket.close() } catch { /* already gone */ } }
    socket = null
    connected = false
  }

  /** The supervisor registers its one retry curve here. */
  function setOnLost (fn) { onLost = typeof fn === 'function' ? fn : () => {} }

  function state () {
    return {
      connected,
      has_token: Boolean(token),
      token_claimed_at: tokenClaimedAt,
      token_refresh_at: tokenRefreshAt,
      last_disconnect_reason: lastDisconnectReason,
      pending_replies: pending.size,
      // The curve the uplink was built with, so a status screen can show what a
      // reconnect would wait without reaching into the runtime.
      backoff_base_s: Number((transport || {}).backoff_base_s) || 0
    }
  }

  return { claimToken, connect, publish, request, close, state, setOnLost, onEvent }
}

module.exports = {
  INGRESS_SCHEMA, RESULT_EVENT, ERROR_EVENT, TOKEN_REFRESH_FRACTION, MIN_REDIAL_MS,
  backoffDelayMs, buildPackage, createUplink
}
