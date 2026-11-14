'use strict'

/**
 * The owner's yey.boats MIDL dashboards, offered to other plugins on this
 * server through SignalK's resources API as the custom resource type
 * `yey-dashboards` (first consumer: Instruments-manager's Display Manager).
 *
 *   app.resourcesApi.listResources('yey-dashboards', {})
 *     -> { [id]: { name, title, targetClass, updatedAt } }
 *   app.resourcesApi.getResource('yey-dashboards', id)
 *     -> { id, name, title, targetClass, updatedAt, doc }
 *
 * This is cloud -> boat, the owner's own data: nothing here sends boat data,
 * so consent and the plan do not apply. Every answer comes from the cloud over
 * the paired uplink (`yey.boat.dashboards`, the same request/reply as hello).
 * Read-only: dashboards are edited on yey.boats, so set/delete reject.
 */

const crypto = require('node:crypto')

const RESOURCE_TYPE = 'yey-dashboards'
const SUBJECT = 'yey.boat.dashboards'
const LIST_CACHE_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

function fail (code, message) {
  const err = new Error(message)
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

function summary (d) {
  const title = String(d.title || d.id)
  return {
    name: title,
    title,
    targetClass: String(d.targetClass || ''),
    updatedAt: String(d.updatedAt || '')
  }
}

/**
 * @param {object} o
 * @param {(subject, payload, opts) => Promise<object>} o.request  uplink.request
 * @param {() => boolean} o.isConnected  paired AND the socket is up
 * @param {() => string} o.accountKey  changes whenever the boat is re-paired;
 *   the cache never outlives it
 */
function createDashboardsProvider ({ request, isConnected, accountKey = () => '', now = Date.now,
  cacheMs = LIST_CACHE_MS, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let cache = null // { key, at, value }

  function invalidate () { cache = null }

  async function ask (payload) {
    if (!isConnected()) throw fail('not_connected', 'not connected to yey.boats')
    const key = accountKey()
    let reply
    try {
      reply = await request(SUBJECT, payload, {
        // idempotency="required" on the handler. A read must never be
        // de-duplicated into silence, so every call gets its own key.
        idempotencyKey: `dash_${payload.op}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
        timeoutMs
      })
    } catch (err) {
      throw cloudError(err)
    }
    const bad = replyError(reply)
    if (bad) throw bad
    return { reply, key }
  }

  async function listResources (query) {
    const key = accountKey()
    if (cache && cache.key === key && now() - cache.at < cacheMs && isConnected()) {
      return { ...cache.value }
    }
    const { reply, key: askedFor } = await ask({ op: 'list' })
    if (reply.kind !== 'dashboards' || !Array.isArray(reply.dashboards)) {
      throw fail('bad_reply', 'yey.boats: unexpected reply to dashboards list')
    }
    const value = {}
    for (const d of reply.dashboards) {
      if (!d || typeof d !== 'object' || !d.id) continue
      value[String(d.id)] = summary(d)
    }
    // Re-paired while the request was in flight: answer, but do not keep it.
    if (askedFor === accountKey()) cache = { key: askedFor, at: now(), value }
    return { ...value }
  }

  async function getResource (id, property) {
    if (!id) throw fail('bad_request', 'a dashboard id is required')
    const { reply } = await ask({ op: 'get', id: String(id) })
    const d = reply.dashboard
    if (reply.kind !== 'dashboard' || !d || typeof d !== 'object') {
      throw fail('bad_reply', 'yey.boats: unexpected reply to dashboards get')
    }
    const value = {
      id: String(d.id || id),
      ...summary({ ...d, id: d.id || id }),
      doc: typeof d.doc === 'string' ? d.doc : (d.doc == null ? '' : JSON.stringify(d.doc))
    }
    if (property) {
      if (!(property in value)) throw fail('not_found', `no property ${property}`)
      return value[property]
    }
    return value
  }

  const readOnly = () => Promise.reject(
    fail('read_only', 'yey.boats dashboards are read-only here; edit them on yey.boats'))

  return {
    invalidate,
    methods: {
      listResources,
      getResource,
      setResource: readOnly,
      deleteResource: readOnly
    }
  }
}

/** Register with the server's resources API, when it has one (SignalK >= 2).
 *  The server unregisters every provider of a plugin when it stops it
 *  (interfaces/plugins.js onStopHandlers -> resourcesApi.unRegister). */
function registerDashboardsProvider (app, provider, debug = () => {}) {
  if (!app || typeof app.registerResourceProvider !== 'function') {
    debug('yey connector: this SignalK server has no resources API; dashboards are not offered')
    return false
  }
  try {
    app.registerResourceProvider({ type: RESOURCE_TYPE, methods: provider.methods })
    return true
  } catch (err) {
    debug(`yey connector: could not register the ${RESOURCE_TYPE} provider (${err && err.message})`)
    return false
  }
}

module.exports = {
  RESOURCE_TYPE, SUBJECT, LIST_CACHE_MS, createDashboardsProvider, registerDashboardsProvider
}
