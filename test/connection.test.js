'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  parseConnectionDocument, fetchConnectionDocument, parseKey, routingToCfg
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
  for (const url of ['', 'ABC-DEF-GHJ', 'javascript:alert(1)', 'file:///etc/passwd']) {
    await rejectsWith(fetchConnectionDocument(url, {
      fetchImpl: async () => { called = true }
    }), 'invalid_url')
  }
  assert.equal(called, false)
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

