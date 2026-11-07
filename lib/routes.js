'use strict'

/**
 * The plugin's own HTTP surface, served under /plugins/signalk-yey-connector/…
 * (Instruments-manager/index.js:222-224, :476 — same shape).
 *
 * Nothing here is authenticated beyond SignalK's own admin session, which is
 * what guards the settings page it is embedded in. It therefore never returns
 * the boat credential.
 */

const fs = require('node:fs')
const path = require('node:path')

const PAGE_PATH = path.join(__dirname, '../public/index.html')

const PUBLIC_KEYS = [
  'state', 'detail', 'version', 'boat_id', 'enabled', 'connected', 'pairing_status',
  'plan_version', 'plan_etag', 'plan_local_etag', 'plan_problem', 'active_mappings', 'rejected',
  'mappings', 'consent', 'consent_source', 'deny', 'buffered', 'buffer_bytes',
  'buffer_dropped', 'budget', 'transport', 'retry_attempt', 'connection'
]

// Typed errors from connect-by-URL, mapped to an HTTP status the panel can
// also switch on by `error.code`. Anything else with a code is a 400.
const ERROR_STATUS = {
  unknown_or_expired_code: 404,
  unreachable: 502,
  already_connected: 409,
  nothing_to_confirm: 409
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
      return res.status(status).json({ error: { code, message: String(err && err.message) } })
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
  // The page itself. The `signalk-webapp` keyword also mounts public/ at
  // /signalk-yey-connector/; this second route is what makes the same page
  // reachable from the plugin's own settings screen, which is the URL
  // statusMessage() tells an unpaired owner to open. index.html addresses the
  // API with an absolute BASE, so it behaves identically under either mount.
  //
  // Deliberately NOT behind wrap(): this is the page you open BECAUSE nothing is
  // running, so a 503 would be exactly the wrong answer.
  router.get('/', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(fs.readFileSync(PAGE_PATH, 'utf8'))
  })

  router.get('/status', wrap(getRuntime, (runtime, req, res) =>
    res.json(project(runtime.snapshot()))))

  router.post('/pair/claim', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.pairViaClaim())))

  router.get('/pair/poll', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.pollPairing())))

  router.post('/pair/code', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.pairViaCode(String((req.body || {}).code || '')))))

  router.post('/unpair', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.unpair())))

  // ── Connect by URL (the Plugin Config panel) ───────────────────────────────
  // resolve: fetch the connection document, read the boat from SignalK, and
  //          answer with what the owner is asked to confirm. Nothing is paired.
  router.post('/connect/resolve', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.resolveConnection({ url: String((req.body || {}).url || '') }))))

  // confirm: pair with the (possibly corrected) identity; goes live on success.
  router.post('/connect/confirm', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.confirmConnection({ identity: (req.body || {}).identity }))))

  // key: URL + key mode; no confirm step. The key is never echoed back.
  router.post('/connect/key', wrap(getRuntime, async (runtime, req, res) => {
    const body = req.body || {}
    return res.json(await runtime.connectWithKey({
      url: String(body.url || ''), key: String(body.key || '')
    }))
  }))

  router.post('/disconnect', wrap(getRuntime, async (runtime, req, res) =>
    res.json(await runtime.disconnect())))
}

module.exports = { registerRoutes, jsonBody, PUBLIC_KEYS, PAGE_PATH, ERROR_STATUS }
