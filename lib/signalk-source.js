'use strict'

const { leafPaths, compactMeta, MAX_METADATA_PATHS } = require('./discovery')

const ROOT = '/signalk'                       // the unauthenticated discovery document
const API = '/signalk/v1/api/vessels/self'
const STREAM = '/signalk/v1/stream?subscribe=self'
const META_CONCURRENCY = 10   // signalk_meta.collect_meta uses max_workers=10

/**
 * Reads this SignalK server over its documented HTTP + delta-WebSocket API.
 *
 * Deliberately NOT the plugin `app` object. app.streambundle /
 * app.subscriptionmanager / app.getSelfPath have no in-house precedent (they
 * appear nowhere in Instruments-manager) and the SignalK server API is not
 * vendored in this workspace, so their shapes cannot be verified here. The HTTP
 * and WS surfaces can be — they are exercised against a real signalk-server in
 * the end-to-end task (Task 16; the plan says "Task 15" in two places, which is
 * the config screens). An `app`-object adapter behind this same interface is a
 * later, performance-only change.
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

  /** Bounded-concurrency sweep of every leaf's /meta. Unbounded would open one
   *  socket per path — 300 of them against a Raspberry Pi. */
  async function collectMeta (tree, maxPaths = MAX_METADATA_PATHS) {
    const paths = leafPaths(tree, maxPaths)
    const out = {}
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
           serverInfo, vesselIdentity }
}

module.exports = { createHttpSource, ROOT, API, STREAM, META_CONCURRENCY }
