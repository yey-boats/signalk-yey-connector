'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

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

/** The same recorder for the one route that answers with HTML rather than JSON. */
function htmlRes () {
  const out = { code: 200, headers: {}, text: '' }
  return Object.assign(out, {
    status (c) { out.code = c; return this },
    setHeader (k, v) { out.headers[k.toLowerCase()] = v },
    end (body) { out.text = String(body) }
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
    pairViaClaim: async () => ({ claim_id: 'c1',
      confirm_url: 'https://yey.boats/account/boats/new?claim=c1&source=plugin' }),
    pollPairing: async () => ({ status: 'pending' }),
    pairViaCode: async () => ({ boat_id: 'b_9' }),
    unpair: async () => ({ ok: true }),
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
  for (const route of ['GET /', 'GET /status', 'POST /pair/claim', 'GET /pair/poll',
                       'POST /pair/code', 'POST /unpair']) {
    assert.ok(r.routes[route], `missing ${route}`)
  }
})

test('GET / serves the page statusMessage tells the owner to open', () => {
  /* The buttons that pair this boat live on public/index.html and nowhere else.
     A page with no route is a funnel with no entrance, so the route is pinned
     here rather than assumed. */
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub())
  const out = htmlRes()
  r.routes['GET /']({}, out)
  assert.match(out.headers['content-type'], /text\/html/)
  assert.match(out.text, /<button id="btn-claim">/)
  assert.match(out.text, /<button id="btn-code">/)
})

test('the page the plugin points at is also the webapp the Appstore mounts', () => {
  /* /signalk-yey-connector/ exists only because of the `signalk-webapp` keyword,
     and statusMessage() names /plugins/signalk-yey-connector/ — the route above.
     Both doors lead to the same file, so both are pinned. */
  const pkg = require('../package.json')
  assert.ok(pkg.keywords.includes('signalk-webapp'))
  assert.ok(pkg.files.includes('public'), 'the page must be in the published files')
  assert.ok(fs.existsSync(path.join(__dirname, '../public/index.html')))
})

test('GET / serves the page even while the plugin is stopped', () => {
  // It is the page you go to BECAUSE nothing is running. wrap()'s 503 would be
  // exactly the wrong answer here.
  const r = fakeRouter()
  registerRoutes(r, () => undefined)
  const out = htmlRes()
  r.routes['GET /']({}, out)
  assert.match(out.text, /<!doctype html>/i)
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

test('the page resumes a claim it did not start', () => {
  /* The claim survives a browser reload in the state file, but the setInterval
     that was polling does not. If the page does not pick the claim back up, the
     owner confirms on their phone and the boat never finds out. */
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  assert.match(html, /id="claim-resume"/)
  assert.match(html, /awaiting_confirmation/,
    'the page must read pairing_status, not just boat_id')
  assert.match(html, /pair\/poll/)
})

test('a stopped plugin answers 503 rather than throwing', async () => {
  const r = fakeRouter()
  registerRoutes(r, () => undefined)
  const out = res()
  await r.routes['GET /status']({}, out)
  assert.equal(out.code, 503)
  assert.equal(out.body.error.code, 'plugin_stopped')
})

test('POST /pair/claim returns a confirm url carrying source=plugin', async () => {
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub())
  const out = res()
  await r.routes['POST /pair/claim']({ body: {} }, out)
  assert.match(out.body.confirm_url, /source=plugin/)
})

test('POST /pair/code passes the typed code through', async () => {
  let seen = null
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub({
    pairViaCode: async (code) => { seen = code; return { boat_id: 'b_9' } }
  }))
  const out = res()
  await r.routes['POST /pair/code']({ body: { code: 'a1b2-c3d4' } }, out)
  assert.equal(seen, 'a1b2-c3d4')
  assert.equal(out.body.boat_id, 'b_9')
})

test('a pairing failure becomes a 400 with the code, not a 500', async () => {
  const r = fakeRouter()
  const err = new Error('nope'); err.code = 'invalid_or_expired_code'
  registerRoutes(r, () => runtimeStub({ pairViaCode: async () => { throw err } }))
  const out = res()
  await r.routes['POST /pair/code']({ body: { code: 'A1B2C3D4' } }, out)
  assert.equal(out.code, 400)
  assert.equal(out.body.error.code, 'invalid_or_expired_code')
})

test('an unexpected throw is a 500, not a pairing error the page would show the user', async () => {
  const r = fakeRouter()
  registerRoutes(r, () => runtimeStub({
    pairViaClaim: async () => { throw new TypeError('x is not a function') } }))
  const out = res()
  await r.routes['POST /pair/claim']({ body: {} }, out)
  assert.equal(out.code, 500)
  assert.equal(out.body.error.code, 'internal')
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

test('the page is honest, short, and carries the required links', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  assert.match(html, /yey\.boats\/setup\?source=plugin/)
  assert.match(html, /yey\.boats\/pricing\?source=plugin/)
  assert.match(html, /yey\.boats\/privacy\?source=plugin/)
  // The page belongs to yey.boats: the heading and the footer link there.
  assert.match(html, /<h1><a href="https:\/\/yey\.boats\/\?source=plugin"/)
  assert.match(html, /<footer>[\s\S]*yey\.boats[\s\S]*<\/footer>/)
  // Branding rule (navigator CLAUDE.md): "Powered by KDCube", where KDCube is
  // a link to https://kdcube.tech/.
  assert.match(html, /Powered by <a href="https:\/\/kdcube\.tech\/"[^>]*>KDCube<\/a>/)
})

test('a signed-out visitor is told to sign in, not shown a blank page', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  assert.match(html, /id="login"/)
  assert.match(html, /href="\/admin\/#\/login"/)
  assert.match(html, /res\.status !== 401 && res\.status !== 403/)
  assert.ok(!/await res\.json\(\)\s*\n\s*const paired/.test(html), 'status must not parse an unchecked response')
})

test('the page explains the connect steps', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  assert.match(html, /<ol class="steps">/)
  assert.match(html, /Connect to yey/)
  assert.match(html, /\/linkboat/)
})

test('every outbound link opens in a new tab', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  const externals = html.match(/<a[^>]+href="https?:[^"]+"[^>]*>/g) || []
  assert.ok(externals.length >= 4)
  for (const a of externals) {
    assert.match(a, /target="_blank"/, `link opens in place: ${a}`)
    assert.match(a, /rel="noopener/, `link is missing rel=noopener: ${a}`)
  }
})

test('self-hosting is named as a direction with no date', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  assert.match(html, /self-host/i)
  assert.ok(!/coming soon/i.test(html), '"coming soon" does not survive a slip')
  assert.match(html, /no date/i)
})

test('the page states the price and that BYOK removes token purchases', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  assert.match(html, /\$0\.99/)
  assert.match(html, /VAT/)
  assert.match(html, /your own Claude API key|BYOK/i)
})

test('the page does not promise that a boat id alone survives a data-directory wipe', () => {
  /* The page used to say "copy the boat id into the settings field above if you
     want pairing to survive a data-directory wipe". start() refuses to dial
     without BOTH the id and the credential, and the credential is never shown —
     /status must not leak it — so after a wipe the copied id alone leaves the
     plugin 'unpaired'. Say what actually happens instead. */
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  assert.ok(!/copy the boat id into the settings/i.test(html))
  assert.match(html, /pair this boat again/i)
})

/* ── Pairing is only finished when the boat is actually on the air ────────────
   The two pairing directions run against the REAL createRuntime here, with the
   pairing module and the uplink injected. That is the only way to see the bug
   this pins: cfg and the state file can be perfectly correct while start() has
   already returned 'unpaired' and nothing ever dials. `connect` below throws on
   purpose in the first test — a failed first dial still proves the dial
   happened, and it keeps the test off every code path that needs a real plan. */

function pairingRuntime ({ connect }) {
  const { createRuntime } = require('../lib/runtime')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-pair-'))
  const uplink = {
    connect,
    close: () => {},
    setOnLost: () => {},
    state: () => ({ connected: false }),
    publish: async () => ({ status: 'accepted', accepted: [], rejected: [] }),
    request: async () => ({ kind: 'plan', plan: null, etag: '' })
  }
  return createRuntime({
    app: { debug: () => {}, getDataDirPath: () => dir },
    version: '0.1.0',
    options: { enabled: true, boatId: '', boatCredential: '' },
    deps: {
      createUplink: () => uplink,
      source: {
        subscribe: () => ({ close () {} }),
        selfTree: async () => ({}),
        collectMeta: async () => ({}),
        serverInfo: async () => ({ version: '2.7.1', plugins: [] }),
        vesselIdentity: async () => ({ name: 'Sara', mmsi: '238123456' })
      },
      pairing: {
        requestClaim: async () => ({ claim_id: 'c1', claim_secret: 's1',
                                     confirm_url: 'https://yey.boats/x?source=plugin',
                                     expires_in: 600 }),
        pollClaim: async () => ({ boat_id: 'b_9', boat_credential: 'bk_9' }),
        redeemCode: async () => ({ boat_id: 'b_9', boat_credential: 'bk_9',
                                   subscribed_paths: [], display_name: 'Sara' })
      },
      setTimeout: () => 1,
      clearTimeout: () => {}
    }
  })
}

test('pairing with a code dials immediately — no SignalK restart', async () => {
  let connects = 0
  const runtime = pairingRuntime({
    connect: async () => { connects += 1; throw Object.assign(new Error('x'), { code: 'offline' }) }
  })
  await runtime.start()
  assert.equal(runtime.snapshot().state, 'unpaired', 'precondition: start() bailed out')
  assert.equal(connects, 0)

  await runtime.pairViaCode('A1B2C3D4')
  assert.equal(connects, 1, 'pairing must start the uplink, not wait for a restart')
  assert.notEqual(runtime.snapshot().state, 'unpaired')
  runtime.stop()
})

test('a confirmed claim dials immediately too', async () => {
  let connects = 0
  const runtime = pairingRuntime({ connect: async () => { connects += 1 } })
  await runtime.start()
  await runtime.pairViaClaim()
  const out = await runtime.pollPairing()
  assert.equal(out.status, 'confirmed')
  assert.equal(connects, 1, 'the claim direction must go live on confirmation')
  runtime.stop()
})

test('a claim that is still pending does not dial', async () => {
  let connects = 0
  const runtime = pairingRuntime({ connect: async () => { connects += 1 } })
  await runtime.start()
  assert.deepEqual(await runtime.pollPairing(), { status: 'idle' },
    'no claim on file means nothing to confirm and nothing to dial')
  assert.equal(connects, 0)
})

test('a pending claim is visible in the snapshot, so a reloaded page can say so', async () => {
  /* pairingStatus computes 'awaiting_confirmation'; this is what makes it mean
     something. boat_id is empty for the whole minutes-long confirmation window,
     so without this the page cannot tell "never paired" from "waiting on your
     phone". */
  const runtime = pairingRuntime({ connect: async () => {} })
  await runtime.start()
  assert.equal(runtime.snapshot().pairing_status, 'unpaired')

  await runtime.pairViaClaim()
  assert.equal(runtime.snapshot().pairing_status, 'awaiting_confirmation')
  assert.equal(runtime.snapshot().boat_id, '',
    'precondition: boat_id alone cannot express this state')

  await runtime.pollPairing()
  assert.equal(runtime.snapshot().pairing_status, 'paired')
  runtime.stop()
})

test('unpair stops the loop and forgets the credential', async () => {
  const runtime = pairingRuntime({ connect: async () => {} })
  await runtime.start()
  await runtime.pairViaCode('A1B2C3D4')
  assert.equal(runtime.snapshot().pairing_status, 'paired')
  await runtime.unpair()
  assert.equal(runtime.snapshot().pairing_status, 'unpaired')
  assert.equal(runtime.snapshot().state, 'stopped')
  assert.equal(runtime.snapshot().boat_id, '')
})
