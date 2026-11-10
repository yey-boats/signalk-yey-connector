'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { createRuntime } = require('../lib/runtime')
const { registerRoutes } = require('../lib/routes')
const { DOC, KEY_DOC, TREE, docFetch, CONSENT, CONSENT_URL, DOC_C, KEY_DOC_C, ALL } =
  require('./fixtures/connection-doc')

const URL_CODE = 'https://yey.boats/c/ABC-DEF-GHJ'
const URL_KEY = 'https://yey.boats/c/key'
const URL_GONE = 'https://yey.boats/c/AAA-BBB-CCC'

/** A runtime with every transport injected: the connection URL fetch
 *  (deps.fetch), the pair call (deps.callPublicOp, which lib/pairing uses) and
 *  the uplink. Pairing and connection parsing are the REAL modules. */
function harness ({ options = {}, pairReply, tree = TREE, app = {}, docs = {}, ops = {},
  uplinkState } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-connect-'))
  const fetchCalls = []
  const pairCalls = []
  let connects = 0
  const uplink = {
    connect: async () => { connects += 1 },
    close: () => {},
    setOnLost: () => {},
    state: () => ({ connected: connects > 0, ...(uplinkState ? uplinkState() : {}) }),
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
        [URL_GONE]: [404, { kind: 'yey.connection.v1', error: 'unknown_or_expired_code' }],
        ...docs
      }, fetchCalls),
      callPublicOp: async (cfg, operation, data) => {
        pairCalls.push({ cfg, operation, data })
        if (ops[operation]) return ops[operation](data, cfg)
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
  return { runtime, dir, stateFile, fetchCalls, pairCalls, connects: () => connects, uplink }
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
  // A non-yey origin needs the owner's opt-in (#25) before it is even tried.
  const h = harness({ options: { allow_custom_origin: true } })
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
  // allow_custom_origin so nowhere.example is tried and comes back unreachable (#25).
  const h = harness({ options: { allow_custom_origin: true } })
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


// ── Consent on the boat's side (#441 phase 2) ─────────────────────────────────

const URL_CODE_C = 'https://yey.boats/c/CON-SEN-TED'
const URL_KEY_C = 'https://yey.boats/c/key?v=2'
const STATUS_OK = { state: 'provisional', allowed: true, enforced: true, reason: 'terms_draft',
  terms_version: '2026-11-07-draft', terms_draft: true, accepted_at: '2026-11-07T20:00:00Z', reconsent_by: null }
const consentDocs = { [URL_CODE_C]: [200, DOC_C], [URL_KEY_C]: [200, KEY_DOC_C] }

test('resolve hands the panel the consent summary from the connection document', async () => {
  const h = harness({ docs: consentDocs })
  await h.runtime.start()
  const out = await h.runtime.resolveConnection({ url: URL_CODE_C })
  assert.equal(out.consent.kind, 'yey.consent.v1')
  assert.deepEqual(out.consent.send.map((f) => f.path),
    ['navigation.position', 'environment.depth.belowTransducer'])
  assert.equal(out.consent.terms.draft, true)
})

test('confirm without all three items ticked pairs nothing and sends nothing', async () => {
  const h = harness({ docs: consentDocs })
  await h.runtime.start()
  await h.runtime.resolveConnection({ url: URL_CODE_C })
  for (const accepted of [undefined, {}, { data_plan: true, terms: true }, { ...ALL, privacy: 'yes' }]) {
    await assert.rejects(h.runtime.confirmConnection({ identity: {}, consent: { accepted } }),
      (e) => e.code === 'consent_incomplete')
  }
  assert.equal(h.pairCalls.length, 0, 'no pair call, so the one-time code is not spent')
  assert.equal(h.connects(), 0)
  assert.ok(!fs.existsSync(h.stateFile) || !JSON.parse(fs.readFileSync(h.stateFile, 'utf8')).boat_id)
})

test('confirm with consent pairs once, carrying identity and the acceptance, then goes live', async () => {
  const h = harness({
    docs: consentDocs,
    options: { advanced: { deny: ['navigation.anchor'] } },
    pairReply: { ok: true, boat_id: 'b_7', boat_credential: 'bk_7secret', display_name: 'Sara',
      subscribed_paths: ['navigation.position', 'environment.depth.belowTransducer', 'notifications'],
      consent: STATUS_OK }
  })
  await h.runtime.start()
  await h.runtime.resolveConnection({ url: URL_CODE_C })
  const out = await h.runtime.confirmConnection({ identity: { name: 'Sara' }, consent: { accepted: ALL } })
  assert.equal(out.status, 'connected')
  assert.equal(h.pairCalls.length, 1)
  const sent = h.pairCalls[0].data.consent
  assert.deepEqual(sent, {
    kind: 'yey.consent.v1',
    accepted: ALL,
    summary_hash: CONSENT.summary_hash,
    terms_version: '2026-11-07-draft',
    privacy_version: '2026-11-07',
    deny: ['navigation.anchor'],
    connector_version: '0.2.0'
  })
  assert.equal(h.pairCalls[0].data.identity.name, 'Sara')
  assert.equal(h.connects(), 1)
  const snap = h.runtime.snapshot()
  // The boat-side boundary is what the owner approved, not the wider list the
  // cloud happens to hold.
  assert.deepEqual(snap.consent, ['navigation.position', 'environment.depth.belowTransducer'])
  assert.equal(snap.consent_status.state, 'provisional')
  assert.equal(snap.consent_record.terms_version, '2026-11-07-draft')
  assert.equal(snap.consent_record.terms_draft, true)
  assert.equal(snap.consent_record.via, 'url')
  const saved = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'))
  assert.equal(saved.consent_url, CONSENT_URL)
})

test('consent_stale keeps the fresh summary for the panel and does not connect', async () => {
  const fresh = { ...CONSENT, summary_hash: 'b'.repeat(64) }
  let calls = 0
  const h = harness({
    docs: consentDocs,
    ops: {
      signalk_boat_pair: (data) => {
        calls += 1
        return data.consent.summary_hash === fresh.summary_hash
          ? { ok: true, boat_id: 'b_7', boat_credential: 'bk_7secret', display_name: 'Sara', subscribed_paths: [] }
          : { ok: false, error: 'consent_stale', consent: fresh }
      }
    }
  })
  await h.runtime.start()
  await h.runtime.resolveConnection({ url: URL_CODE_C })
  await assert.rejects(h.runtime.confirmConnection({ identity: {}, consent: { accepted: ALL } }),
    (e) => e.code === 'consent_stale' && e.consent.summary_hash === fresh.summary_hash)
  assert.equal(h.connects(), 0)
  // Approving again approves the summary as it is now.
  const out = await h.runtime.confirmConnection({ identity: {}, consent: { accepted: ALL } })
  assert.equal(out.status, 'connected')
  assert.equal(calls, 2)
})

test('a cloud without consent (phase 1) still connects as before', async () => {
  const h = harness()
  await h.runtime.start()
  const out = await h.runtime.resolveConnection({ url: URL_CODE })
  assert.equal(out.consent, null)
  await h.runtime.confirmConnection({ identity: {} })
  assert.equal(h.pairCalls[0].data.consent, undefined)
  assert.equal(h.connects(), 1)
})

test('key mode: the boat-side summary is approved before the key is used', async () => {
  const h = harness({
    docs: consentDocs,
    ops: {
      signalk_boat_consent: (data) => data.consent
        ? { ok: true, status: STATUS_OK }
        : { ok: true, consent: CONSENT, status: { state: 'provisional', allowed: true, enforced: true } }
    }
  })
  await h.runtime.start()
  const first = await h.runtime.connectWithKey({ url: URL_KEY_C, key: 'yk1.b_42.bk_supersecret' })
  assert.equal(first.status, 'consent')
  assert.equal(first.consent.summary_hash, CONSENT.summary_hash)
  assert.equal(h.connects(), 0, 'nothing is sent before the owner approves')
  assert.equal(h.runtime.snapshot().connection.status, 'consent')
  assert.equal(JSON.stringify(first).includes('bk_supersecret'), false)
  const read = h.pairCalls[0]
  assert.equal(read.operation, 'signalk_boat_consent')
  assert.equal(read.cfg.opUrls.signalk_boat_consent, CONSENT_URL)
  assert.deepEqual(read.data, { boat_id: 'b_42', boat_credential: 'bk_supersecret' })

  await assert.rejects(h.runtime.confirmConnection({ consent: { accepted: { data_plan: true } } }),
    (e) => e.code === 'consent_incomplete')
  const out = await h.runtime.confirmConnection({ consent: { accepted: ALL } })
  assert.equal(out.status, 'connected')
  assert.equal(h.pairCalls[1].data.consent.summary_hash, CONSENT.summary_hash)
  assert.equal(h.connects(), 1)
  assert.equal(h.runtime.snapshot().consent_record.via, 'key')
})

test('a provisioned key (settings file) does not wait for the panel: acceptance was captured at key issue', async () => {
  const h = harness({ docs: consentDocs, options: { connectionUrl: URL_KEY_C, key: 'yk1.b_42.bk_supersecret' } })
  await h.runtime.start()
  assert.equal(h.connects(), 1)
  assert.equal(h.pairCalls.filter((c) => c.operation === 'signalk_boat_consent').length, 0)
})

test('a boat connected before consent existed: review and approve from the panel', async () => {
  const h = harness({
    docs: consentDocs,
    ops: {
      signalk_boat_consent: (data) => data.consent
        ? { ok: true, status: STATUS_OK }
        : { ok: true, consent: CONSENT, status: { state: 'missing', allowed: true, enforced: false } }
    },
    uplinkState: () => ({ consent: { state: 'missing', allowed: true, enforced: false } })
  })
  await h.runtime.start()
  await h.runtime.connectWithKey({ url: URL_KEY, key: 'yk1.b_42.bk_supersecret' })   // phase-1 style, no consent
  assert.equal(h.connects(), 1)
  assert.equal(h.runtime.snapshot().consent_status.state, 'missing', 'the token claim said so')
  const doc = await h.runtime.consentDocument()
  assert.equal(doc.consent.summary_hash, CONSENT.summary_hash)
  // No consent_url stored for a phase-1 connection: the op URL is built from the routing.
  assert.equal(h.pairCalls.at(-1).cfg.opUrls.signalk_boat_consent, undefined)
  const out = await h.runtime.acceptConsent({ accepted: ALL })
  assert.equal(out.status, 'approved')
  assert.equal(h.runtime.snapshot().consent_status.state, 'provisional')
  assert.equal(h.runtime.snapshot().consent_record.via, 'panel')
})

test('consent_required at the token claim parks the link; approving dials again', async () => {
  let refuse = true
  let dials = 0
  // The harness only lends its data dir and fake uplink; the runtime below is
  // built with a recording timer so a redial loop would be visible.
  const h = harness()
  h.uplink.connect = async () => {
    dials += 1
    if (refuse) throw Object.assign(new Error('consent_required'), { code: 'consent_required' })
  }
  const { createRuntime } = require('../lib/runtime')
  const timers = []
  const runtime = createRuntime({
    app: { debug: () => {}, getDataDirPath: () => h.dir },
    version: '0.2.0',
    options: {},
    deps: {
      createUplink: () => h.uplink,
      callPublicOp: async (cfg, op, data) => (op === 'signalk_boat_consent'
        ? (data.consent ? { ok: true, status: STATUS_OK } : { ok: true, consent: CONSENT, status: { state: 'missing', allowed: false, enforced: true } })
        : { ok: false, error: 'unexpected' }),
      fetch: docFetch({ [URL_KEY]: [200, KEY_DOC] }),
      source: { subscribe: () => ({ close () {} }), selfTree: async () => ({}), collectMeta: async () => ({}),
        serverInfo: async () => ({ version: '2', plugins: [] }), vesselIdentity: async () => ({ name: '', mmsi: '' }) },
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
      clearTimeout: () => {}
    }
  })
  await runtime.start()
  await runtime.connectWithKey({ url: URL_KEY, key: 'yk1.b_42.bk_supersecret' })
  assert.equal(dials, 1)
  const snap = runtime.snapshot()
  assert.equal(snap.state, 'consent_required')
  assert.equal(snap.consent_status.allowed, false)
  assert.equal(timers.length, 0, 'no retry loop while waiting for the owner')
  refuse = false
  await runtime.acceptConsent({ accepted: ALL })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(dials, 2, 'approving dials again')
  assert.notEqual(runtime.snapshot().state, 'consent_required')
  runtime.stop()
})

test('resolve takes a link behind autofill junk, or the bare code, and says which link it used', async () => {
  for (const pasted of ['adminhttps://yey.boats/c/ABC-DEF-GHJ', 'abc-def-ghj']) {
    const h = harness()
    await h.runtime.start()
    const out = await h.runtime.resolveConnection({ url: pasted })
    assert.equal(out.status, 'confirm')
    assert.equal(out.url, URL_CODE, `${pasted} -> the clean link the panel saves`)
  }
})

test('the display name from pairing is not one the owner chose on the boat', async () => {
  const h = harness()
  await h.runtime.start()
  await h.runtime.resolveConnection({ url: URL_CODE })
  await h.runtime.confirmConnection({})
  const saved = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'))
  assert.equal(saved.display_name, 'Sara')
  assert.equal(saved.display_name_set_at, '', 'so the first hello does not claim it')
})

// #25: the runtime refuses a non-yey link unless the owner set
// allow_custom_origin, and says so loudly when it is set.
test('a link on another site is origin_not_allowed (403), nothing fetched or stored', async () => {
  const h = harness()
  await assert.rejects(h.runtime.resolveConnection({ url: 'https://evil.example/c/ABC-DEF-GHJ' }),
    (e) => e.code === 'origin_not_allowed')
  assert.equal(h.fetchCalls.length, 0)
  assert.equal(fs.existsSync(h.stateFile), false)
  const r = fakeRouter()
  registerRoutes(r, () => h.runtime)
  const out = await hit(r, 'POST /connect/resolve', { url: 'http://evil.example/c/x' })
  assert.equal(out.code, 403)
  assert.equal(out.body.error.code, 'insecure_origin')
})

test('allow_custom_origin: a custom origin resolves, flagged untrusted, with a status warning', async () => {
  const CUSTOM = 'https://boats.example.org/c/ABC-DEF-GHJ'
  const doc = {
    ...DOC,
    pair_url: 'https://boats.example.org/api/integrations/bundles/home/demo/signalk@2026-06-05/public/signalk_boat_pair',
    routing: { ...DOC.routing, origin: 'https://boats.example.org' }
  }
  const h = harness({ options: { allow_custom_origin: true }, docs: { [CUSTOM]: [200, doc] } })
  assert.match(h.runtime.snapshot().origin_warning, /allow_custom_origin/)
  assert.match(h.runtime.statusMessage(), /WARNING/)
  const out = await h.runtime.resolveConnection({ url: CUSTOM })
  assert.equal(out.origin, 'https://boats.example.org')
  assert.equal(out.origin_trusted, false)
  assert.equal(h.runtime.snapshot().connection.origin_trusted, false)
  await h.runtime.confirmConnection({})
  assert.equal(h.runtime.snapshot().connection.status, 'connected')
  assert.match(h.runtime.snapshot().origin_warning, /boats\.example\.org/)
  assert.match(h.runtime.statusMessage(), /WARNING.*boats\.example\.org/)
})

test('without allow_custom_origin there is no origin warning, and yey.boats is trusted', async () => {
  const h = harness()
  assert.equal(h.runtime.snapshot().origin_warning, '')
  const out = await h.runtime.resolveConnection({ url: URL_CODE })
  assert.equal(out.origin_trusted, true)
})
