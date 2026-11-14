'use strict'

/**
 * The plugin's own HTTP surface, served under /plugins/signalk-yey-connector/…
 * (Instruments-manager/index.js:222-224, :476 — same shape).
 *
 * Nothing here is authenticated beyond SignalK's own admin session, which is
 * what guards the settings page it is embedded in. It therefore never returns
 * the boat credential.
 *
 * The standalone page (public/index.html, GET /) and the older pairing calls
 * (/pair/claim, /pair/poll, /pair/code, /unpair) are gone (#441 phase 2): the
 * Plugin Config panel is the one way to connect. Old settings files are still
 * migrated (lib/migrate.js).
 */

const PUBLIC_KEYS = [
  'state', 'detail', 'version', 'boat_id', 'enabled', 'connected', 'pairing_status',
  'plan_version', 'plan_etag', 'plan_local_etag', 'plan_problem', 'active_mappings', 'rejected',
  'mappings', 'consent', 'consent_source', 'deny', 'buffered', 'buffer_bytes',
  'buffer_dropped', 'budget', 'transport', 'retry_attempt', 'consent_status',
  'consent_record',
  // Cloud queries served over the uplink (#10) and the AIS relay (#11): counts
  // and path lists only, nothing secret.
  'rpc', 'on_request', 'ais',
  'connection',
  // #25: the origin warning, '' unless allow_custom_origin or a non-yey origin.
  'allow_custom_origin', 'origin_warning',
  // Remote steering (#22): the switch, its auto-off and the last commands.
  'remote_steering', 'remote_steering_auto_off', 'steering_log',
  // The yey.boats login linked for dashboards: {linked, user_label,
  // expires_at, pending:{expires_at}|null}. Never the grant or the link code.
  'dashboards'
]

// Typed errors from connect-by-URL, mapped to an HTTP status the panel can
// also switch on by `error.code`. Anything else with a code is a 400.
const ERROR_STATUS = {
  unknown_or_expired_code: 404,
  unreachable: 502,
  already_connected: 409,
  nothing_to_confirm: 409,
  not_connected: 409,
  // Consent (#441 phase 2). consent_stale carries the fresh summary.
  consent_incomplete: 400,
  consent_stale: 409,
  consent_required: 409,
  consent_unavailable: 502,
  invalid_credential: 403,
  // #25: a link that points somewhere other than yey.boats.
  origin_not_allowed: 403,
  insecure_origin: 403
}

function project (snapshot) {
  const out = {}
  for (const key of PUBLIC_KEYS) if (key in (snapshot || {})) out[key] = snapshot[key]
  return out
}

function wrap (getRuntime, handler) {
  return async (req, res) => {
    const runtime = getRuntime()
    if (!runtime) {
      // Same shape Instruments-manager uses for a stopped plugin (index.js:1325).
      return res.status(503).json({ error: { code: 'plugin_stopped' } })
    }
    try {
      return await handler(runtime, req, res)
    } catch (err) {
      const code = (err && typeof err.code === 'string' && err.code) || 'internal'
      const status = code === 'internal' ? 500 : (ERROR_STATUS[code] || 400)
      const error = { code, message: String(err && err.message) }
      // consent_stale: the summary as it is now, so the panel can show it.
      if (err && err.consent && typeof err.consent === 'object') error.consent = err.consent
      return res.status(status).json({ error })
    }
  }
}

/** Minimal JSON body middleware.
 *
 *  express IS present in a SignalK server, but `require('express')` resolves from
 *  THIS package's node_modules, and a plugin installed by the Appstore may not
 *  have it hoisted there. Declaring express as a dependency to find out is worse:
 *  it would ship a second copy of the host's own framework. So parse the body.
 */
function jsonBody (limitBytes = 64 * 1024) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') { req.body = {}; return next() }
    // signalk-server runs body-parser in front of plugin routers: the stream is
    // already consumed and 'end' would never fire again, which hung every POST.
    // Use what the host parsed.
    if (req._body || req.readableEnded) {
      if (!req.body || typeof req.body !== 'object') req.body = {}
      return next()
    }
    let raw = ''
    let over = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (over) return
      raw += chunk
      if (raw.length > limitBytes) { over = true; raw = '' }
    })
    req.on('end', () => {
      if (over) return res.status(413).json({ error: { code: 'body_too_large' } })
      if (!raw) { req.body = {}; return next() }
      try {
        req.body = JSON.parse(raw)
      } catch {
        return res.status(400).json({ error: { code: 'bad_json' } })
      }
      return next()
    })
    req.on('error', () => res.status(400).json({ error: { code: 'bad_request' } }))
  }
}

function registerRoutes (router, getRuntime) {
  router.get('/status', wrap(getRuntime, (runtime, req, res) =>
    res.json(project(runtime.snapshot()))))

  // ── Connect by URL (the Plugin Config panel) ───────────────────────────────
  // resolve: fetch the connection document, read the boat from SignalK, and
  //          answer with what the owner is asked to confirm. Nothing is paired.
  router.post('/connect/resolve', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.resolveConnection({ url: String((req.body || {}).url || '') }))))

  // confirm: pair with the (possibly corrected) identity and the owner's
  // consent {accepted:{data_plan,terms,privacy}}; goes live on success. In key
  // mode it records the consent for the key's boat instead.
  router.post('/connect/confirm', wrap(getRuntime, async (runtime, req, res) => {
    const body = req.body || {}
    return res.json(await runtime.confirmConnection({ identity: body.identity, consent: body.consent }))
  }))

  // key: URL + key mode; answers the consent summary to approve (or connects
  // directly against a cloud without consent). The key is never echoed back.
  router.post('/connect/key', wrap(getRuntime, async (runtime, req, res) => {
    const body = req.body || {}
    return res.json(await runtime.connectWithKey({
      url: String(body.url || ''), key: String(body.key || '')
    }))
  }))

  // ── The boat's display name (lib/display-name.js) ─────────────────────────
  // POST {display_name}: rename the connected boat. Stored here at once and
  // sent to yey.boats with the next hello; a rename there comes back the same
  // way. Last writer wins.
  router.post('/display-name', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.setDisplayName({ name: (req.body || {}).display_name }))))

  router.post('/disconnect', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.disconnect())))

  // ── Consent for a connected boat (#441 phase 2) ────────────────────────────
  // GET: the summary to approve and the boat's status. POST {accepted}: record.
  router.get('/consent', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.consentDocument())))

  router.post('/consent', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.acceptConsent({ accepted: (req.body || {}).accepted }))))
}

module.exports = { registerRoutes, jsonBody, PUBLIC_KEYS, ERROR_STATUS }
