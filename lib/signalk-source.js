'use strict'

const { leafPaths, compactMeta, MAX_METADATA_PATHS } = require('./discovery')
const { extractIdentity } = require('./identity')

const ROOT = '/signalk'                       // the unauthenticated discovery document
const API = '/signalk/v1/api/vessels/self'
const STREAM = '/signalk/v1/stream?subscribe=self'
const META_CONCURRENCY = 10   // signalk_meta.collect_meta uses max_workers=10

function nodeAt (tree, path) {
  return String(path).split('.').reduce((node, key) => (node || {})[key], tree)
}

/**
 * Reads a SignalK server over its documented HTTP + delta-WebSocket API.
 *
 * The plugin itself no longer uses this: it reads in-process through
 * createAppSource below, which needs no URL, no token and no allow_readonly.
 * This stays as the FALLBACK for a host whose `app` lacks the in-process
 * calls (then it is pointed at the server's own address, without a token) and
 * for the load rig, which reads a server from outside.
 */
function createHttpSource ({ baseUrl, token, fetchImpl, WebSocketImpl } = {}) {
  const base = String(baseUrl || 'http://localhost:3000').replace(/\/+$/, '')
  const doFetch = fetchImpl || globalThis.fetch
  // Required lazily: a host without `ws` installed must still be able to load
  // the plugin and reach its config page to say so.
  const openSocket = (url, opts) => {
    const WS = WebSocketImpl || require('ws')
    return new WS(url, opts)
  }

  const headers = token ? { authorization: `Bearer ${token}` } : {}

  async function getJson (suffix) {
    let res
    try {
      res = await doFetch(`${base}${suffix}`, { headers })
    } catch {
      return null          // the server is down; the caller degrades
    }
    if (!res.ok) return null
    try {
      return await res.json()
    } catch {
      return null
    }
  }

  async function selfTree () {
    return (await getJson(API)) || {}
  }

  async function metaFor (path) {
    // The value-tree GET returns a REDUCED inline meta with no `source`; the
    // manufacturer/model is only here (signalk_meta.py:7-10).
    const suffix = `${API}/${String(path).replace(/\./g, '/')}/meta`
    return compactMeta(await getJson(suffix))
  }

  /** Every leaf's meta, compacted.
   *
   *  signalk-server 2.33 carries the full meta — `source` included — inline in
   *  the value tree, identical to /meta for every path the simulator publishes
   *  (checked by test/e2e). When any inline meta carries `source`, the server is
   *  one of those and the tree already holds everything: zero extra requests.
   *  Otherwise fall back to a bounded-concurrency sweep of every leaf's /meta
   *  (signalk_meta.py:7-10); unbounded would open one socket per path — 300 of
   *  them against a Raspberry Pi. */
  async function collectMeta (tree, maxPaths = MAX_METADATA_PATHS) {
    const paths = leafPaths(tree, maxPaths)
    const out = {}
    const inline = paths.map((path) => [path, (nodeAt(tree, path) || {}).meta])
    if (inline.some(([, meta]) => meta && typeof meta === 'object' && meta.source)) {
      for (const [path, raw] of inline) {
        const meta = compactMeta(raw)
        if (Object.keys(meta).length) out[path] = meta
      }
      return out
    }
    let cursor = 0
    async function worker () {
      while (cursor < paths.length) {
        const path = paths[cursor++]
        const meta = await metaFor(path)
        if (meta && Object.keys(meta).length) out[path] = meta
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(META_CONCURRENCY, paths.length || 1) }, worker))
    return out
  }

  /** The server's own version, for the hello's `signalk` block.
   *
   *  GET /signalk is the discovery document and is reachable without a token even
   *  with tokensecurity on, which matters: the hello is built before anything else
   *  and must not be the thing that fails. `plugins` is reported as [] on purpose —
   *  the installed-plugin list lives behind the admin API, and Y1's
   *  boat_pairing.project_hello keeps only `signalk.version` from this block
   *  anyway (boat_pairing.py:94-134), so nothing downstream reads it. */
  async function serverInfo () {
    const doc = (await getJson(ROOT)) || {}
    const server = doc.server || {}
    const v1 = (doc.endpoints || {}).v1 || {}
    return { version: String(server.version || v1.version || ''), plugins: [] }
  }

  /** The vessel's name and MMSI, for the hello's `vessel` block — the two fields
   *  the Y1 confirm screen shows the user when they approve a boat.
   *
   *  On the SignalK full model `name` and `mmsi` are plain strings on the vessel
   *  object, but some servers wrap them as {value}. Accept both; report '' rather
   *  than throwing on a boat that has never been named. */
  async function vesselIdentity (tree) {
    const self = tree || await selfTree()
    const pick = (node) => {
      if (typeof node === 'string') return node
      if (node && typeof node === 'object' && typeof node.value === 'string') return node.value
      return ''
    }
    return { name: pick(self.name), mmsi: pick(self.mmsi) }
  }

  /** The full identity for the "Is this your boat?" step (lib/identity.js). */
  async function boatIdentity (tree) {
    return extractIdentity(tree || await selfTree())
  }

  function streamUrl () {
    // The delta socket carries the token as a query parameter, which is the shape
    // the simulator's own writer uses against a tokensecurity server
    // (simulator/src/yey/boats/simulator/engine/signalk_writer.py:944-945). The
    // Authorization header goes out too (below); servers accept either.
    const suffix = token ? `${STREAM}&token=${encodeURIComponent(token)}` : STREAM
    return `${base.replace(/^http/, 'ws')}${suffix}`
  }

  /** Flattens SignalK deltas to {path, value, timestamp, source} samples.
   *  onSample is called once per value; a malformed frame is dropped.
   *
   *  `onClose(reason)` fires once when the delta socket errors or closes. The
   *  socket is NOT re-opened here: the supervisor owns every retry curve in this
   *  plugin, so that a SignalK restart and a cloud outage back off through one
   *  piece of code with one set of plan-controlled numbers. A source that
   *  retried on its own would be a second, invisible loop. */
  function subscribe (onSample, onClose) {
    const socket = openSocket(streamUrl(), token ? { headers } : undefined)
    let closed = false
    const finish = (reason) => {
      if (closed) return
      closed = true
      if (typeof onClose === 'function') onClose(String(reason || 'closed'))
    }
    socket.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      } catch {
        return
      }
      samplesOf(frame, onSample)
    })
    socket.on('error', (err) => finish((err && err.message) || 'error'))
    socket.on('close', () => finish('close'))
    return {
      close: () => {
        closed = true            // a deliberate close is not a reason to reconnect
        try { socket.close() } catch { /* already gone */ }
      },
      socket
    }
  }

  return { selfTree, metaFor, collectMeta, subscribe, streamUrl,
           serverInfo, vesselIdentity, boatIdentity, kind: 'http' }
}

/** Flatten one SignalK delta to samples. Shared by both sources. */
function samplesOf (frame, onSample) {
  const updates = Array.isArray(frame && frame.updates) ? frame.updates : []
  for (const update of updates) {
    const values = Array.isArray(update && update.values) ? update.values : []
    for (const item of values) {
      if (!item || typeof item !== 'object' || !item.path) continue
      if (!('value' in item)) continue
      onSample({
        path: String(item.path),
        value: item.value,
        timestamp: String(update.timestamp || ''),
        source: String(update.$source || '')
      })
    }
  }
}

function pickString (node) {
  if (typeof node === 'string') return node
  if (node && typeof node === 'object' && typeof node.value === 'string') return node.value
  return ''
}

/** True when the `app` the server handed the plugin can be read in-process. */
function hasAppApi (app) {
  return Boolean(app && app.subscriptionmanager &&
    typeof app.subscriptionmanager.subscribe === 'function' &&
    (app.signalk || typeof app.getPath === 'function'))
}

/**
 * Reads THIS SignalK server in-process, through the plugin `app` object the
 * server passes to the plugin (signalk-server dist/interfaces/plugins.js):
 *
 *   tree       app.signalk.self — the same object app.getSelfPath reads with
 *              lodash.get (getSelfPath('') returns undefined, so the root is
 *              taken directly), else app.getPath(app.selfContext)
 *   meta       inline `meta` on each leaf, else app.getMetadata('vessels.self.<path>'),
 *              which is exactly what REST GET .../<path>/meta answers with
 *   version    app.config.version
 *   deltas     app.subscriptionmanager.subscribe({context:'vessels.self',
 *              subscribe:[{path:'*', policy:'instant'}]}, unsubscribes, onError, onDelta)
 *
 * No URL, no token, no allow_readonly on the server: a plugin already runs
 * with the server's own authority. Same interface as createHttpSource, so the
 * runtime and the tests do not care which one they hold.
 */
function createAppSource ({ app } = {}) {
  function selfTree () {
    let tree
    if (app && app.signalk && app.signalk.self && typeof app.signalk.self === 'object') {
      tree = app.signalk.self
    } else if (app && typeof app.getPath === 'function' && app.selfContext) {
      tree = app.getPath(app.selfContext)
    }
    return Promise.resolve(tree && typeof tree === 'object' ? tree : {})
  }

  async function metaFor (path) {
    if (!app || typeof app.getMetadata !== 'function') return {}
    try {
      return compactMeta(app.getMetadata(`vessels.self.${path}`))
    } catch {
      return {}
    }
  }

  async function collectMeta (tree, maxPaths = MAX_METADATA_PATHS) {
    const paths = leafPaths(tree, maxPaths)
    const out = {}
    for (const path of paths) {
      const inline = (nodeAt(tree, path) || {}).meta
      const meta = (inline && typeof inline === 'object' && Object.keys(inline).length)
        ? { ...(await metaFor(path)), ...compactMeta(inline) }
        : await metaFor(path)
      if (meta && Object.keys(meta).length) out[path] = meta
    }
    return out
  }

  async function serverInfo () {
    const config = (app && app.config) || {}
    return { version: String(config.version || ''), plugins: [] }
  }

  async function vesselIdentity (tree) {
    const self = tree || await selfTree()
    return { name: pickString(self.name), mmsi: pickString(self.mmsi) }
  }

  async function boatIdentity (tree) {
    return extractIdentity(tree || await selfTree())
  }

  /** In-process the stream cannot "drop" the way a socket can; onClose is kept
   *  for interface parity and fires only if the server reports a subscription
   *  error. */
  function subscribe (onSample, onClose) {
    const unsubscribes = []
    let closed = false
    const finish = (reason) => {
      if (closed) return
      closed = true
      if (typeof onClose === 'function') onClose(String(reason || 'closed'))
    }
    app.subscriptionmanager.subscribe(
      { context: 'vessels.self', subscribe: [{ path: '*', policy: 'instant' }] },
      unsubscribes,
      (err) => finish((err && err.message) || String(err || 'subscription error')),
      (delta) => { if (!closed) samplesOf(delta, onSample) }
    )
    return {
      close: () => {
        closed = true
        for (const fn of unsubscribes.splice(0)) {
          try { fn() } catch { /* already gone */ }
        }
      }
    }
  }

  return { selfTree, metaFor, collectMeta, subscribe, serverInfo, vesselIdentity,
           boatIdentity, kind: 'app' }
}

/** In-process when the server allows it; otherwise REST against the server's
 *  own address, with no token (see createHttpSource). */
function createSource ({ app } = {}) {
  if (hasAppApi(app)) return createAppSource({ app })
  const settings = (app && app.config && app.config.settings) || {}
  const port = Number(process.env.PORT) || Number(settings.port) || 3000
  return createHttpSource({ baseUrl: `http://localhost:${port}` })
}

module.exports = { createHttpSource, createAppSource, createSource, hasAppApi, samplesOf,
                   ROOT, API, STREAM, META_CONCURRENCY }
