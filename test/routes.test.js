'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { registerRoutes, PUBLIC_KEYS } = require('../lib/routes')

/** A minimal Express-shaped router recorder. */
function fakeRouter () {
  const routes = {}
  const router = {
    use: () => {},
    get: (p, fn) => { routes[`GET ${p}`] = fn },
    post: (p, fn) => { routes[`POST ${p}`] = fn },
    routes
  }
  return router
}

function res () {
  const out = { code: 200, body: null }
  return Object.assign(out, {
    status (c) { out.code = c; return this },
    json (b) { out.body = b; return this }
  })
}

/** A Readable-shaped request, enough for the body middleware. */
function fakeRequest (method, body) {
  const handlers = {}
  const req = {
    method,
    setEncoding: () => {},
    on: (event, fn) => {
      handlers[event] = fn
      if (event === 'end') {
        setImmediate(() => {
          if (body && handlers.data) handlers.data(body)
          handlers.end()
        })
      }
      return req
    }
  }
  return req
}

/**
 * `over.snapshot` is a PATCH of the snapshot object, not a replacement for the
 * snapshot FUNCTION. Spreading `over` wholesale at the end would put that plain
 * object over the function, `runtime.snapshot()` would throw inside wrap(), and
 * every /status test would pass or fail against a 500 body instead of the
 * projection — which is how the plan's own version of this stub shipped one red
 * test and one that passed vacuously.
 */
function runtimeStub (over = {}) {
  const { snapshot: snapOver = {}, ...rest } = over
  return {
    snapshot: () => ({ state: 'starting', boat_id: 'b_1', connected: true,
      plan_version: 4, active_mappings: 2, buffered: 0, buffer_bytes: 0,
      rejected: [], budget: {}, consent: [], deny: [], ...snapOver }),
    resolveConnection: async () => ({ status: 'confirm' }),
    confirmConnection: async () => ({ status: 'connected' }),
    connectWithKey: async () => ({ status: 'consent' }),
    consentDocument: async () => ({ consent: null, consent_status: null }),
    acceptConsent: async () => ({ status: 'approved' }),
    disconnect: async () => ({ ok: true }),
    ...rest
  }
}

test('the stub really exercises the projection, not an internal 500', async () => {
  // A guard on the harness itself: the two /status tests below are only worth
  // anything if snapshot() survives being patched.
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub({ snapshot: { plan_version: 42 } }))
  const out = res()
  await r.routes['GET /status']({}, out)
  assert.equal(out.code, 200)
  assert.equal(out.body.plan_version, 42)
})

test('every documented route is registered', () => {
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub())
  for (const route of ['GET /status', 'POST /connect/resolve', 'POST /connect/confirm',
                       'POST /connect/key', 'POST /disconnect', 'GET /consent', 'POST /consent']) {
    assert.ok(r.routes[route], `missing ${route}`)
  }
})

test('the standalone page and the old pairing calls are gone (#441 phase 2)', () => {
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub())
  for (const route of ['GET /', 'POST /pair/claim', 'GET /pair/poll', 'POST /pair/code', 'POST /unpair']) {
    assert.equal(r.routes[route], undefined, `${route} should be removed`)
  }
  assert.equal(fs.existsSync(path.join(__dirname, '../public/index.html')), false)
})

test('a refusal from yey.boats becomes a 400 with the code, not a 500', async () => {
  const r = fakeRouter()
  const err = new Error('nope'); err.code = 'invalid_or_expired_code'
  registerRoutes(r, () => runtimeStub({ confirmConnection: async () => { throw err } }))
  const out = res()
  await r.routes['POST /connect/confirm']({ body: {} }, out)
  assert.equal(out.code, 400)
  assert.equal(out.body.error.code, 'invalid_or_expired_code')
})

test('an unexpected throw is a 500, not a refusal the panel would show the user', async () => {
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub({
    resolveConnection: async () => { throw new TypeError('x is not a function') } }))
  const out = res()
  await r.routes['POST /connect/resolve']({ body: {} }, out)
  assert.equal(out.code, 500)
  assert.equal(out.body.error.code, 'internal')
})

test('POST /connect/confirm passes identity and consent through', async () => {
  let seen = null
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub({ confirmConnection: async (arg) => { seen = arg; return { status: 'connected' } } }))
  const out = res()
  const consent = { accepted: { data_plan: true, terms: true, privacy: true } }
  await r.routes['POST /connect/confirm']({ body: { identity: { name: 'Sara' }, consent } }, out)
  assert.deepEqual(seen, { identity: { name: 'Sara' }, consent })
  assert.equal(out.body.status, 'connected')
})

test('consent_stale is a 409 that carries the fresh summary', async () => {
  const r = fakeRouter()
  const err = Object.assign(new Error('consent_stale'), { code: 'consent_stale', consent: { kind: 'yey.consent.v1' } })
  registerRoutes(r, () => runtimeStub({ acceptConsent: async () => { throw err } }))
  const out = res()
  await r.routes['POST /consent']({ body: { accepted: {} } }, out)
  assert.equal(out.code, 409)
  assert.equal(out.body.error.code, 'consent_stale')
  assert.deepEqual(out.body.error.consent, { kind: 'yey.consent.v1' })
})

test('consent_incomplete is a 400; consent status is projected on /status', async () => {
  const r = fakeRouter()
  const err = Object.assign(new Error('tick'), { code: 'consent_incomplete' })
  registerRoutes(r, () => runtimeStub({
    acceptConsent: async () => { throw err },
    snapshot: { consent_status: { state: 'missing', allowed: true }, consent_record: null }
  }))
  const out = res()
  await r.routes['POST /consent']({ body: {} }, out)
  assert.equal(out.code, 400)
  const st = res()
  await r.routes['GET /status']({}, st)
  assert.deepEqual(st.body.consent_status, { state: 'missing', allowed: true })
  assert.ok(PUBLIC_KEYS.includes('consent_record'))
})

test('/status carries the RPC counters, on_request and the AIS relay state', async () => {
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub({
    snapshot: {
      rpc: { served: 2, refused: 1 },
      on_request: ['notifications'],
      ais: { relaying: false, targets: 0 }
    }
  }))
  const out = res()
  await r.routes['GET /status']({}, out)
  assert.deepEqual(out.body.rpc, { served: 2, refused: 1 })
  assert.deepEqual(out.body.on_request, ['notifications'])
  assert.deepEqual(out.body.ais, { relaying: false, targets: 0 })
})

test('GET /status returns the snapshot', async () => {
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub())
  const out = res()
  await r.routes['GET /status']({}, out)
  assert.equal(out.body.plan_version, 4)
  assert.equal(out.body.connected, true)
})

test('/status never leaks the boat credential', async () => {
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub({
    snapshot: { boat_credential: 'bk_secret', cloudOrigin: 'https://yey.boats' }
  }))
  const out = res()
  await r.routes['GET /status']({}, out)
  assert.equal(out.code, 200, 'this must pass on the projection, not on an error body')
  assert.ok(!JSON.stringify(out.body).includes('bk_secret'),
    'the credential must never reach a browser')
  assert.ok(!PUBLIC_KEYS.includes('boat_credential'))
})

test('/status passes the pairing status through the projection', async () => {
  // PUBLIC_KEYS drops anything it does not list, so the page would see nothing.
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub({
    snapshot: { boat_id: '', pairing_status: 'awaiting_confirmation' } }))
  const out = res()
  await r.routes['GET /status']({}, out)
  assert.equal(out.code, 200)
  assert.equal(out.body.pairing_status, 'awaiting_confirmation')
})

test('a stopped plugin answers 503 rather than throwing', async () => {
  const r = fakeRouter()
  registerRoutes(r, () => undefined)
  const out = res()
  await r.routes['GET /status']({}, out)
  assert.equal(out.code, 503)
  assert.equal(out.body.error.code, 'plugin_stopped')
})

test('jsonBody parses a POST body without express', async () => {
  const { jsonBody } = require('../lib/routes')
  const req = fakeRequest('POST', '{"code":"a1b2-c3d4"}')
  const out = res()
  await new Promise((resolve) => jsonBody()(req, out, resolve))
  assert.deepEqual(req.body, { code: 'a1b2-c3d4' })
})

test('jsonBody answers 400 on rubbish and 413 on a body that is too large', async () => {
  const { jsonBody } = require('../lib/routes')
  const bad = res()
  await new Promise((resolve) => {
    Object.assign(bad, { json: (b) => { bad.body = b; resolve(); return bad } })
    jsonBody()(fakeRequest('POST', '{not json'), bad, () => resolve())
  })
  assert.equal(bad.code, 400)
  assert.equal(bad.body.error.code, 'bad_json')

  const big = res()
  await new Promise((resolve) => {
    Object.assign(big, { json: (b) => { big.body = b; resolve(); return big } })
    jsonBody(10)(fakeRequest('POST', '{"code":"much too long for ten bytes"}'), big,
      () => resolve())
  })
  assert.equal(big.code, 413)
})

test('jsonBody leaves a GET alone', async () => {
  const { jsonBody } = require('../lib/routes')
  const req = fakeRequest('GET', '')
  await new Promise((resolve) => jsonBody()(req, res(), resolve))
  assert.deepEqual(req.body, {})
})

test('jsonBody uses a body the host already parsed instead of waiting on a drained stream', async () => {
  /* signalk-server runs body-parser before plugin routers. The request stream is
     then already consumed, 'end' never fires again, and waiting for it hung
     every POST to this plugin on a real server. */
  const { jsonBody } = require('../lib/routes')
  const req = { method: 'POST', _body: true, body: { url: 'https://yey.boats/c/x' },
    on: () => { throw new Error('must not read the stream') }, setEncoding: () => {} }
  await new Promise((resolve) => jsonBody()(req, res(), resolve))
  assert.deepEqual(req.body, { url: 'https://yey.boats/c/x' })

  const drained = { method: 'POST', readableEnded: true,
    on: () => { throw new Error('must not read the stream') }, setEncoding: () => {} }
  await new Promise((resolve) => jsonBody()(drained, res(), resolve))
  assert.deepEqual(drained.body, {})
})
