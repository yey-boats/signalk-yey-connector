'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  parseConnectionDocument, fetchConnectionDocument, parseKey, routingToCfg, normalizeConnectionInput
} = require('../lib/connection')

// The contract, verbatim.
const DOC = {
  kind: 'yey.connection.v1',
  code: 'ABCDEFGHJ',
  expires_in_s: 840,
  boat: { display_name: 'Sara' },
  pair_url: 'https://yey.boats/api/integrations/bundles/home/demo/signalk@2026-06-05/public/signalk_boat_pair',
  routing: { origin: 'https://yey.boats', tenant: 'home', project: 'demo', bundle_id: 'signalk@2026-06-05' }
}
const KEY_DOC = { ...DOC, code: null, pair_url: null }

function fakeFetch (status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init })
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return { status, ok: status >= 200 && status < 300, text: async () => text }
  }
}

async function rejectsWith (promise, code) {
  await assert.rejects(promise, (err) => { assert.equal(err.code, code); return true })
}

test('a contract document parses to code, boat, pair_url and routing', () => {
  const doc = parseConnectionDocument(DOC)
  assert.equal(doc.code, 'ABCDEFGHJ')
  assert.equal(doc.expires_in_s, 840)
  assert.deepEqual(doc.boat, { display_name: 'Sara' })
  assert.equal(doc.pair_url, DOC.pair_url)
  assert.deepEqual(doc.routing, DOC.routing)
})

test('the key-mode document (code and pair_url null) parses', () => {
  const doc = parseConnectionDocument(KEY_DOC)
  assert.equal(doc.code, null)
  assert.equal(doc.pair_url, null)
  assert.equal(doc.routing.tenant, 'home')
})

test('a local origin works the same way', () => {
  const local = {
    ...DOC,
    pair_url: 'http://yey.local/api/integrations/bundles/home/demo/signalk@2026-06-05/public/signalk_boat_pair',
    routing: { ...DOC.routing, origin: 'http://yey.local' }
  }
  assert.equal(parseConnectionDocument(local).routing.origin, 'http://yey.local')
})

test('malformed documents are invalid_document', () => {
  const bad = [
    null, [], 'x', {}, { ...DOC, kind: 'something.else' },
    { ...DOC, routing: undefined },
    { ...DOC, routing: { ...DOC.routing, tenant: '' } },
    { ...DOC, routing: { ...DOC.routing, origin: 'ftp://yey.boats' } },
    { ...DOC, pair_url: null },                                  // a code with nowhere to redeem it
    { ...DOC, pair_url: 'https://evil.example/pair' }            // pairing pointed off-site
  ]
  for (const body of bad) {
    assert.throws(() => parseConnectionDocument(body), (err) => err.code === 'invalid_document',
      JSON.stringify(body))
  }
})

test('an error document is unknown_or_expired_code', () => {
  assert.throws(() => parseConnectionDocument({ kind: 'yey.connection.v1', error: 'unknown_or_expired_code' }),
    (err) => err.code === 'unknown_or_expired_code')
})

test('fetch: GET with Accept: application/json, contract body parses', async () => {
  const calls = []
  const doc = await fetchConnectionDocument('https://yey.boats/c/ABC-DEF-GHJ',
    { fetchImpl: fakeFetch(200, DOC, calls) })
  assert.equal(doc.code, 'ABCDEFGHJ')
  assert.equal(calls[0].url, 'https://yey.boats/c/ABC-DEF-GHJ')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.accept, 'application/json')
})

test('fetch: 404 is unknown_or_expired_code', async () => {
  await rejectsWith(fetchConnectionDocument('https://yey.boats/c/AAA-BBB-CCC', {
    fetchImpl: fakeFetch(404, { kind: 'yey.connection.v1', error: 'unknown_or_expired_code' })
  }), 'unknown_or_expired_code')
  // A bare 404 page (no JSON) means the same to the owner.
  await rejectsWith(fetchConnectionDocument('https://yey.boats/c/AAA-BBB-CCC', {
    fetchImpl: fakeFetch(404, '<html>not found</html>')
  }), 'unknown_or_expired_code')
})

test('fetch: network failure and 5xx are unreachable', async () => {
  await rejectsWith(fetchConnectionDocument('https://yey.boats/c/x', {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') }
  }), 'unreachable')
  await rejectsWith(fetchConnectionDocument('https://yey.boats/c/x', {
    fetchImpl: fakeFetch(503, 'busy')
  }), 'unreachable')
})

test('fetch: an HTML page or malformed JSON is invalid_document', async () => {
  await rejectsWith(fetchConnectionDocument('https://yey.boats/c/x', {
    fetchImpl: fakeFetch(200, '<!doctype html><html></html>')
  }), 'invalid_document')
  await rejectsWith(fetchConnectionDocument('https://yey.boats/c/x', {
    fetchImpl: fakeFetch(200, '{"kind":')
  }), 'invalid_document')
})

test('fetch: something that is not an http(s) URL is invalid_url, with no request', async () => {
  let called = false
  for (const url of ['', 'ABC-DEF', 'javascript:alert(1)', 'file:///etc/passwd']) {
    await rejectsWith(fetchConnectionDocument(url, {
      fetchImpl: async () => { called = true }
    }), 'invalid_url')
  }
  assert.equal(called, false)
})

test('the pasted value is cleaned up: autofill junk in front, a bare code, the link as is', () => {
  assert.equal(normalizeConnectionInput('https://yey.boats/c/ABC-DEF-GHJ'), 'https://yey.boats/c/ABC-DEF-GHJ')
  assert.equal(normalizeConnectionInput('  https://yey.boats/c/ABC-DEF-GHJ  '), 'https://yey.boats/c/ABC-DEF-GHJ')
  // Chrome filled the SignalK admin username in front of the link.
  assert.equal(normalizeConnectionInput('adminhttps://yey.boats/c/ABC-DEF-GHJ'), 'https://yey.boats/c/ABC-DEF-GHJ')
  assert.equal(normalizeConnectionInput('admin HTTPS://yey.boats/c/ABC-DEF-GHJ secret'), 'HTTPS://yey.boats/c/ABC-DEF-GHJ')
  assert.equal(normalizeConnectionInput('xhttp://yey.local:3000/c/ABCDEFGHJ'), 'http://yey.local:3000/c/ABCDEFGHJ')
  // The bare code, as the account page also shows it.
  assert.equal(normalizeConnectionInput('ABC-DEF-GHJ'), 'https://yey.boats/c/ABC-DEF-GHJ')
  assert.equal(normalizeConnectionInput('abcdefghj'), 'https://yey.boats/c/ABC-DEF-GHJ')
  assert.equal(normalizeConnectionInput('ABC-DEF-GHJ', 'http://box.local/'), 'http://box.local/c/ABC-DEF-GHJ')
  // Nothing recognisable: returned trimmed, for the fetch to refuse.
  assert.equal(normalizeConnectionInput(' admin '), 'admin')
  assert.equal(normalizeConnectionInput(null), '')
})

test('fetch: a link behind autofill junk, or a bare code, fetches the clean link', async () => {
  const asked = []
  const fetchImpl = async (u) => { asked.push(u); return { status: 404, ok: false, text: async () => '' } }
  await rejectsWith(fetchConnectionDocument('adminhttps://yey.boats/c/ABC-DEF-GHJ', { fetchImpl }), 'unknown_or_expired_code')
  await rejectsWith(fetchConnectionDocument('ABC-DEF-GHJ', { fetchImpl }), 'unknown_or_expired_code')
  assert.deepEqual(asked, ['https://yey.boats/c/ABC-DEF-GHJ', 'https://yey.boats/c/ABC-DEF-GHJ'])
})

test('a key parses to boat id and credential', () => {
  assert.deepEqual(parseKey('yk1.b_42.bk_abcdefgh12345'), { boatId: 'b_42', credential: 'bk_abcdefgh12345' })
  assert.deepEqual(parseKey('  yk1.b_42.bk_abc.def.ghi  '), { boatId: 'b_42', credential: 'bk_abc.def.ghi' },
    'the credential may itself contain dots; only the first two separate')
})

test('a bad key is invalid_key', () => {
  for (const key of ['', 'bk_abcdefgh', 'yk2.b_1.bk_abcdefgh', 'yk1.b_1', 'yk1..bk_abcdefgh',
    'yk1.b_1.short', 'yk1.b 1.bk_abcdefgh', 'yk1.b_1.bk_abc defgh']) {
    assert.throws(() => parseKey(key), (err) => err.code === 'invalid_key', key)
  }
})

test('routing maps onto the cfg names the uplink reads', () => {
  assert.deepEqual(routingToCfg(DOC.routing), {
    cloudOrigin: 'https://yey.boats', tenant: 'home', project: 'demo', bundleId: 'signalk@2026-06-05'
  })
})


// #25: a connection link may only point the boat at yey.boats, unless the
// owner opted in with allow_custom_origin. http:// only on this machine or a
// yey box (yey.local).
const { checkOrigin, ALLOWED_ORIGINS } = require('../lib/connection')

test('origins: yey.boats, my.yey.boats and local hosts are trusted without any setting', () => {
  for (const raw of ['https://yey.boats/c/ABC-DEF-GHJ', 'https://my.yey.boats/c/x',
    'http://yey.local/c/x', 'http://yey.local:3000/c/x', 'http://localhost:8080/c/x',
    'http://127.0.0.1:9/c/x', 'https://localhost/c/x']) {
    const out = checkOrigin(raw)
    assert.equal(out.trusted, true, raw)
    assert.equal(out.origin, new URL(raw).origin)
  }
  assert.ok(ALLOWED_ORIGINS.includes('https://yey.boats'))
})

test('origins: any other https origin is origin_not_allowed unless allow_custom_origin', () => {
  for (const raw of ['https://evil.example/c/x', 'https://yey.boats.evil.example/c/x',
    'https://yey.boats:8443/c/x', 'https://staging.example/c/x']) {
    assert.throws(() => checkOrigin(raw), (e) => e.code === 'origin_not_allowed', raw)
    const out = checkOrigin(raw, { allowCustomOrigin: true })
    assert.equal(out.trusted, false, raw)
  }
})

test('origins: http:// is refused off localhost/yey.local, even with allow_custom_origin', () => {
  for (const raw of ['http://yey.boats/c/x', 'http://evil.example/c/x', 'http://192.168.1.5/c/x']) {
    assert.throws(() => checkOrigin(raw), (e) => e.code === 'insecure_origin', raw)
    assert.throws(() => checkOrigin(raw, { allowCustomOrigin: true }),
      (e) => e.code === 'insecure_origin', raw)
  }
})

test('fetch: a link on another site is refused before any request', async () => {
  const calls = []
  await rejectsWith(fetchConnectionDocument('https://evil.example/c/ABC-DEF-GHJ',
    { fetchImpl: fakeFetch(200, DOC, calls) }), 'origin_not_allowed')
  await rejectsWith(fetchConnectionDocument('http://evil.example/c/ABC-DEF-GHJ',
    { fetchImpl: fakeFetch(200, DOC, calls) }), 'insecure_origin')
  assert.equal(calls.length, 0)
})

test('fetch: a yey.boats link whose document routes elsewhere is refused', async () => {
  const away = {
    ...DOC,
    pair_url: 'https://evil.example/api/integrations/bundles/home/demo/signalk@2026-06-05/public/signalk_boat_pair',
    routing: { ...DOC.routing, origin: 'https://evil.example' }
  }
  await rejectsWith(fetchConnectionDocument('https://yey.boats/c/ABC-DEF-GHJ',
    { fetchImpl: fakeFetch(200, away) }), 'origin_not_allowed')
})

test('fetch: with allowCustomOrigin a custom https origin connects', async () => {
  const custom = {
    ...DOC,
    pair_url: 'https://boats.example.org/api/integrations/bundles/home/demo/signalk@2026-06-05/public/signalk_boat_pair',
    routing: { ...DOC.routing, origin: 'https://boats.example.org' }
  }
  const doc = await fetchConnectionDocument('https://boats.example.org/c/ABC-DEF-GHJ',
    { fetchImpl: fakeFetch(200, custom), allowCustomOrigin: true })
  assert.equal(doc.routing.origin, 'https://boats.example.org')
})

test('fetch: a yey.boats link that redirects to another site is refused (#25 review)', async () => {
  const redirected = (finalUrl) => async () => ({
    status: 200, ok: true, url: finalUrl, text: async () => JSON.stringify(DOC)
  })
  await rejectsWith(fetchConnectionDocument('https://yey.boats/c/ABC-DEF-GHJ',
    { fetchImpl: redirected('https://evil.example/c/ABC-DEF-GHJ') }), 'origin_not_allowed')
  await rejectsWith(fetchConnectionDocument('https://yey.boats/c/ABC-DEF-GHJ',
    { fetchImpl: redirected('http://yey.boats/c/ABC-DEF-GHJ') }), 'insecure_origin')
  // A redirect inside yey.boats is fine.
  const doc = await fetchConnectionDocument('https://yey.boats/c/ABC-DEF-GHJ',
    { fetchImpl: redirected('https://my.yey.boats/c/ABC-DEF-GHJ') })
  assert.equal(doc.routing.origin, 'https://yey.boats')
})

test('isUnencryptedOrigin: only http:// local hosts', () => {
  const { isUnencryptedOrigin } = require('../lib/connection')
  assert.equal(isUnencryptedOrigin('http://yey.local'), true)
  assert.equal(isUnencryptedOrigin('http://localhost:3000'), true)
  assert.equal(isUnencryptedOrigin('https://yey.local'), false)
  assert.equal(isUnencryptedOrigin('https://yey.boats'), false)
  assert.equal(isUnencryptedOrigin('http://evil.example'), false)
  assert.equal(isUnencryptedOrigin(''), false)
})
