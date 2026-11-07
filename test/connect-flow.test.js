'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { createRuntime } = require('../lib/runtime')
const { registerRoutes } = require('../lib/routes')
const { DOC, KEY_DOC, TREE, docFetch } = require('./fixtures/connection-doc')

const URL_CODE = 'https://yey.boats/c/ABC-DEF-GHJ'
const URL_KEY = 'https://yey.boats/c/key'
const URL_GONE = 'https://yey.boats/c/AAA-BBB-CCC'

/** A runtime with every transport injected: the connection URL fetch
 *  (deps.fetch), the pair call (deps.callPublicOp, which lib/pairing uses) and
 *  the uplink. Pairing and connection parsing are the REAL modules. */
function harness ({ options = {}, pairReply, tree = TREE, app = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-connect-'))
  const fetchCalls = []
  const pairCalls = []
  let connects = 0
  const uplink = {
    connect: async () => { connects += 1 },
    close: () => {},
    setOnLost: () => {},
    state: () => ({ connected: connects > 0 }),
    publish: async () => ({ status: 'accepted', accepted: [], rejected: [] }),
    request: async () => ({ kind: 'plan', plan: null, etag: '' })
  }
  const runtime = createRuntime({
    app: { debug: () => {}, getDataDirPath: () => dir, ...app },
    version: '0.2.0',
    options,
    deps: {
      createUplink: () => uplink,
      fetch: docFetch({
        [URL_CODE]: [200, DOC],
        [URL_KEY]: [200, KEY_DOC],
        [URL_GONE]: [404, { kind: 'yey.connection.v1', error: 'unknown_or_expired_code' }]
      }, fetchCalls),
      callPublicOp: async (cfg, operation, data) => {
        pairCalls.push({ cfg, operation, data })
        return pairReply || { ok: true, boat_id: 'b_7', boat_credential: 'bk_7secret',
                              display_name: 'Sara', subscribed_paths: ['navigation.position'] }
      },
      source: {
        subscribe: () => ({ close () {} }),
        selfTree: async () => tree,
        collectMeta: async () => ({}),
        serverInfo: async () => ({ version: '2.37.0', plugins: [] }),
        vesselIdentity: async () => ({ name: tree.name || '', mmsi: tree.mmsi || '' }),
        boatIdentity: async () => require('../lib/identity').extractIdentity(tree)
      },
      setTimeout: () => 1,
      clearTimeout: () => {}
    }
  })
  const stateFile = path.join(dir, 'yey-connector-state.json')
  return { runtime, dir, stateFile, fetchCalls, pairCalls, connects: () => connects }
}

test('resolve fetches the document and returns the boat found in SignalK, pairing nothing', async () => {
  const h = harness()
  await h.runtime.start()
  const out = await h.runtime.resolveConnection({ url: URL_CODE })
  assert.equal(out.status, 'confirm')
  assert.deepEqual(out.boat, { display_name: 'Sara' })
  assert.equal(out.origin, 'https://yey.boats')
  assert.deepEqual(out.identity, { name: 'Sara', mmsi: '238123456', callsign: '9A1234',
    type: 'Sailing', length_m: 12.4, beam_m: 4.1, draft_m: 2.05 })
  assert.equal(h.pairCalls.length, 0)
  assert.equal(h.connects(), 0)
  assert.equal(h.runtime.snapshot().connection.status, 'confirming')
  assert.equal(JSON.stringify(out).includes('ABCDEFGHJ'), false, 'the one-time code stays in the plugin')
})

test('confirm pairs at pair_url with the confirmed identity, stores privately and goes live', async () => {
  const h = harness()
  await h.runtime.start()
  await h.runtime.resolveConnection({ url: URL_CODE })
  const out = await h.runtime.confirmConnection({
    identity: { name: 'Sara II', mmsi: '238123456', callsign: '9A1234', type: 'Sailing',
                length_m: '12.4', beam_m: '4.1', draft_m: '2.05' }
  })
  assert.equal(out.status, 'connected')
  assert.equal(out.boat_id, 'b_7')

  const [call] = h.pairCalls
  assert.equal(call.operation, 'signalk_boat_pair')
  assert.equal(require('../lib/cloud-client').publicOpUrl(call.cfg, call.operation), DOC.pair_url,
    'the pair call goes to pair_url exactly')
  assert.equal(call.data.code, 'ABCDEFGHJ')
  assert.deepEqual(call.data.identity, { name: 'Sara II', mmsi: '238123456', callsign: '9A1234',
    type: 'Sailing', length_m: 12.4, beam_m: 4.1, draft_m: 2.05 })
  assert.equal(call.data.hello.vessel.name, 'Sara II', 'the hello carries the confirmed name too')

  const saved = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'))
  assert.equal(saved.boat_id, 'b_7')
  assert.equal(saved.boat_credential, 'bk_7secret')
  assert.deepEqual(saved.routing, DOC.routing)
  assert.equal(saved.connected_via, 'url')

  assert.equal(h.connects(), 1, 'connecting dials at once, no restart')
  assert.equal(h.runtime.cfg.cloudOrigin, 'https://yey.boats')
  assert.equal(h.runtime.cfg.bundleId, 'signalk@2026-06-05')
  const snap = h.runtime.snapshot()
  assert.equal(snap.connection.status, 'connected')
  assert.equal(snap.connection.display_name, 'Sara')
  assert.deepEqual(snap.consent, ['navigation.position'])
  assert.equal(JSON.stringify(snap).includes('bk_7secret'), false)
  h.runtime.stop()
})

test('a restart after connecting comes up connected from private state alone', async () => {
  const h = harness()
  await h.runtime.start()
  await h.runtime.resolveConnection({ url: URL_CODE })
  await h.runtime.confirmConnection({})
  h.runtime.stop()

  const again = createRuntime({
    app: { debug: () => {}, getDataDirPath: () => h.dir },
    version: '0.2.0',
    options: { connectionUrl: URL_CODE },
    deps: { createUplink: () => ({ connect: async () => {}, close () {}, setOnLost () {},
      state: () => ({ connected: true }), publish: async () => ({}), request: async () => ({}) }),
    source: { subscribe: () => ({ close () {} }), selfTree: async () => ({}), collectMeta: async () => ({}),
      serverInfo: async () => ({ version: '' }), vesselIdentity: async () => ({}) },
    setTimeout: () => 1, clearTimeout: () => {} }
  })
  assert.equal(again.cfg.boatId, 'b_7')
  assert.equal(again.cfg.cloudOrigin, 'https://yey.boats')
  assert.equal(again.snapshot().connection.status, 'connected')
})

test('confirm with nothing resolved is nothing_to_confirm', async () => {
  const h = harness()
  await assert.rejects(h.runtime.confirmConnection({}), (e) => e.code === 'nothing_to_confirm')
})

test('an expired link is unknown_or_expired_code, and nothing is stored', async () => {
  const h = harness()
  await assert.rejects(h.runtime.resolveConnection({ url: URL_GONE }),
    (e) => e.code === 'unknown_or_expired_code')
  assert.equal(fs.existsSync(h.stateFile), false)
})

test('an unreachable origin is unreachable', async () => {
  const h = harness()
  await assert.rejects(h.runtime.resolveConnection({ url: 'https://nowhere.example/c/x' }),
    (e) => e.code === 'unreachable')
})

test('a cloud refusal at pairing surfaces its code and leaves the boat unconnected', async () => {
  const h = harness({ pairReply: { ok: false, error: 'code_expired' } })
  await h.runtime.resolveConnection({ url: URL_CODE })
  await assert.rejects(h.runtime.confirmConnection({}), (e) => e.code === 'code_expired')
  assert.notEqual(h.runtime.snapshot().connection.status, 'connected')
})

test('a key-mode link without a key is key_required', async () => {
  const h = harness()
  await assert.rejects(h.runtime.resolveConnection({ url: URL_KEY }), (e) => e.code === 'key_required')
})

test('key mode: routing from the document, boat and credential from the key, no pair call', async () => {
  const h = harness()
  await h.runtime.start()
  const out = await h.runtime.connectWithKey({ url: URL_KEY, key: 'yk1.b_42.bk_keysecret99' })
  assert.deepEqual(out, { status: 'connected', boat_id: 'b_42', display_name: 'Sara' })
  assert.equal(h.pairCalls.length, 0)
  const saved = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'))
  assert.equal(saved.boat_id, 'b_42')
  assert.equal(saved.boat_credential, 'bk_keysecret99')
  assert.equal(saved.connected_via, 'key')
  assert.equal(h.connects(), 1)
  h.runtime.stop()
})

test('a malformed key fails before any request', async () => {
  const h = harness()
  await assert.rejects(h.runtime.connectWithKey({ url: URL_KEY, key: 'bk_nope' }),
    (e) => e.code === 'invalid_key')
  assert.equal(h.fetchCalls.length, 0)
})

test('connecting again while connected is refused', async () => {
  const h = harness()
  await h.runtime.connectWithKey({ url: URL_KEY, key: 'yk1.b_42.bk_keysecret99' })
  await assert.rejects(h.runtime.resolveConnection({ url: URL_CODE }), (e) => e.code === 'already_connected')
  h.runtime.stop()
})

test('disconnect forgets routing, boat and credential', async () => {
  const h = harness()
  await h.runtime.connectWithKey({ url: URL_KEY, key: 'yk1.b_42.bk_keysecret99' })
  await h.runtime.disconnect()
  assert.deepEqual(JSON.parse(fs.readFileSync(h.stateFile, 'utf8')), {})
  assert.equal(h.runtime.snapshot().connection.status, 'not_connected')
  assert.equal(h.runtime.snapshot().state, 'stopped')
})

test('a key in the options file (provisioned install) connects on start and is scrubbed', async () => {
  const saves = []
  const h = harness({
    options: { connectionUrl: URL_KEY, key: 'yk1.b_42.bk_keysecret99', advanced: { deny: ['a.b'] } },
    app: { savePluginOptions: (cfg, cb) => { saves.push(cfg); cb(null) } }
  })
  await h.runtime.start()
  assert.equal(h.runtime.snapshot().connection.status, 'connected')
  assert.equal(h.connects(), 1)
  assert.equal(saves.length, 1)
  assert.deepEqual(saves[0], { connectionUrl: URL_KEY, advanced: { deny: ['a.b'] } })
  h.runtime.stop()
})

// ── the routes, against the real runtime with injected transport ─────────────

function fakeRouter () {
  const routes = {}
  return {
    use: () => {},
    get: (p, fn) => { routes[`GET ${p}`] = fn },
    post: (p, fn) => { routes[`POST ${p}`] = fn },
    routes
  }
}

function res () {
  const out = { code: 200, body: null }
  return Object.assign(out, {
    status (c) { out.code = c; return this },
    json (b) { out.body = b; return this }
  })
}

async function hit (router, route, body) {
  const out = res()
  await router.routes[route]({ body: body || {} }, out)
  return out
}

test('routes: resolve → confirm → status → disconnect', async () => {
  const h = harness()
  const r = fakeRouter()
  registerRoutes(r, () => h.runtime)
  await h.runtime.start()

  let out = await hit(r, 'GET /status')
  assert.equal(out.body.connection.status, 'not_connected')

  out = await hit(r, 'POST /connect/resolve', { url: URL_CODE })
  assert.equal(out.code, 200)
  assert.equal(out.body.status, 'confirm')
  assert.equal(out.body.identity.callsign, '9A1234')

  out = await hit(r, 'POST /connect/confirm', { identity: { ...out.body.identity, name: 'Sara' } })
  assert.equal(out.code, 200)
  assert.equal(out.body.status, 'connected')

  out = await hit(r, 'GET /status')
  assert.equal(out.body.connection.status, 'connected')
  assert.equal(out.body.connection.display_name, 'Sara')
  assert.equal(out.body.boat_id, 'b_7')
  assert.equal(JSON.stringify(out.body).includes('bk_7secret'), false, '/status never shows the credential')

  out = await hit(r, 'POST /disconnect')
  assert.deepEqual(out.body, { ok: true })
  out = await hit(r, 'GET /status')
  assert.equal(out.body.connection.status, 'not_connected')
})

test('routes: key connect, and typed errors with their HTTP status', async () => {
  const h = harness()
  const r = fakeRouter()
  registerRoutes(r, () => h.runtime)

  let out = await hit(r, 'POST /connect/resolve', { url: URL_GONE })
  assert.equal(out.code, 404)
  assert.equal(out.body.error.code, 'unknown_or_expired_code')

  out = await hit(r, 'POST /connect/resolve', { url: 'https://nowhere.example/c/x' })
  assert.equal(out.code, 502)
  assert.equal(out.body.error.code, 'unreachable')

  out = await hit(r, 'POST /connect/key', { url: URL_KEY, key: 'garbage' })
  assert.equal(out.code, 400)
  assert.equal(out.body.error.code, 'invalid_key')

  out = await hit(r, 'POST /connect/confirm', {})
  assert.equal(out.code, 409)
  assert.equal(out.body.error.code, 'nothing_to_confirm')

  out = await hit(r, 'POST /connect/key', { url: URL_KEY, key: 'yk1.b_42.bk_keysecret99' })
  assert.equal(out.code, 200)
  assert.equal(out.body.status, 'connected')
  assert.equal(JSON.stringify(out.body).includes('bk_keysecret99'), false, 'the key is never echoed')
  h.runtime.stop()
})

test('routes: a stopped plugin answers 503 plugin_stopped on every connect route', async () => {
  const r = fakeRouter()
  registerRoutes(r, () => undefined)
  for (const route of ['POST /connect/resolve', 'POST /connect/confirm', 'POST /connect/key',
    'POST /disconnect', 'GET /status']) {
    const out = await hit(r, route, {})
    assert.equal(out.code, 503, route)
    assert.equal(out.body.error.code, 'plugin_stopped')
  }
})

test('a key still in the options of a connected install is scrubbed without reconnecting', async () => {
  const h = harness()
  await h.runtime.connectWithKey({ url: URL_KEY, key: 'yk1.b_42.bk_keysecret99' })
  h.runtime.stop()
  const saves = []
  const again = createRuntime({
    app: { debug: () => {}, getDataDirPath: () => h.dir, savePluginOptions: (cfg, cb) => { saves.push(cfg); cb(null) } },
    version: '0.2.0',
    options: { connectionUrl: URL_KEY, key: 'yk1.b_42.bk_keysecret99' },
    deps: { createUplink: () => ({ connect: async () => {}, close () {}, setOnLost () {},
      state: () => ({ connected: false }), publish: async () => ({}), request: async () => ({}) }),
    source: { subscribe: () => ({ close () {} }) }, setTimeout: () => 1, clearTimeout: () => {} }
  })
  assert.equal(again.cfg.boatId, 'b_42')
  assert.deepEqual(saves, [{ connectionUrl: URL_KEY }])
})
