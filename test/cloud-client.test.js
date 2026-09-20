'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const { callPublicOp, unwrapPublicOp, publicOpUrl } = require('../lib/cloud-client')

const ENVELOPE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/public-op-response.json'), 'utf8'))

/** A real HTTP server, so nothing here depends on a mock of fetch. */
function serve (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, origin: `http://127.0.0.1:${port}` })
    })
  })
}

function readBody (req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => resolve(raw))
  })
}

const CFG = { tenant: 'home', project: 'demo', bundleId: 'signalk@2026-06-05' }

test('publicOpUrl matches integrations.py:3195', () => {
  const url = publicOpUrl({ ...CFG, cloudOrigin: 'https://yey.boats' }, 'signalk_boat_pair')
  assert.equal(url,
    'https://yey.boats/api/integrations/bundles/home/demo/signalk@2026-06-05/public/signalk_boat_pair')
})

test('unwrapPublicOp returns the result nested under the operation alias', () => {
  const out = unwrapPublicOp(ENVELOPE, 'signalk_boat_claim_request')
  assert.equal(out.ok, true)
  assert.equal(out.claim_id, 'Zm9vYmFyYmF6')
})

test('unwrapPublicOp does NOT return the envelope when the alias is present', () => {
  const out = unwrapPublicOp(ENVELOPE, 'signalk_boat_claim_request')
  assert.equal(out.status, undefined, 'returned the envelope instead of the result')
  assert.equal(out.tenant, undefined)
})

test('unwrapPublicOp falls back to the body when there is no alias key', () => {
  const out = unwrapPublicOp({ ok: true, boat_id: 'b_1' }, 'signalk_boat_pair')
  assert.equal(out.boat_id, 'b_1')
})

test('unwrapPublicOp tolerates a non-object body', () => {
  assert.deepEqual(unwrapPublicOp(null, 'op'), {})
  assert.deepEqual(unwrapPublicOp('nope', 'op'), {})
  // An alias whose value is not an object is not an unwrap target.
  assert.deepEqual(unwrapPublicOp({ op: 'text' }, 'op'), { op: 'text' })
})

test('callPublicOp posts {data:{...}} and unwraps the alias', async () => {
  let seenPath = null
  let seenBody = null
  let seenType = null
  const { server, origin } = await serve(async (req, res) => {
    seenPath = req.url
    seenType = req.headers['content-type']
    seenBody = JSON.parse(await readBody(req))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(ENVELOPE))
  })
  try {
    const out = await callPublicOp({ ...CFG, cloudOrigin: origin },
      'signalk_boat_claim_request', { hello: { connector_version: '0.1.0' } })
    assert.equal(seenPath,
      '/api/integrations/bundles/home/demo/signalk@2026-06-05/public/signalk_boat_claim_request')
    assert.match(seenType, /application\/json/)
    // integrations.py:846-870 keeps `data` as a reserved key and passes it
    // through as kwargs; anything else at top level gets folded INTO data.
    assert.deepEqual(seenBody, { data: { hello: { connector_version: '0.1.0' } } })
    assert.equal(out.claim_id, 'Zm9vYmFyYmF6')
  } finally {
    server.close()
  }
})

test('callPublicOp throws with the status on a non-2xx', async () => {
  const { server, origin } = await serve((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'slow down' }))
  })
  try {
    await assert.rejects(
      () => callPublicOp({ ...CFG, cloudOrigin: origin }, 'signalk_boat_pair', {}),
      (err) => err.status === 429 && /signalk_boat_pair/.test(err.message))
  } finally {
    server.close()
  }
})

test('callPublicOp throws on a non-JSON 200 rather than returning junk', async () => {
  const { server, origin } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>nginx</html>')
  })
  try {
    await assert.rejects(
      () => callPublicOp({ ...CFG, cloudOrigin: origin }, 'signalk_boat_pair', {}),
      /not JSON/)
  } finally {
    server.close()
  }
})

test('callPublicOp aborts on timeout instead of hanging the plugin', async () => {
  const { server, origin } = await serve(() => { /* never responds */ })
  try {
    await assert.rejects(
      () => callPublicOp({ ...CFG, cloudOrigin: origin }, 'signalk_boat_pair', {},
        { timeoutMs: 120 }),
      (err) => err.name === 'AbortError' || /abort/i.test(String(err.message)))
  } finally {
    server.close()
  }
})

test('a bundle-level {ok:false,error} is returned, not thrown', async () => {
  const { server, origin } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      signalk_boat_pair: { ok: false, error: 'invalid_or_expired_code' }
    }))
  })
  try {
    const out = await callPublicOp({ ...CFG, cloudOrigin: origin }, 'signalk_boat_pair', {})
    assert.equal(out.ok, false)
    assert.equal(out.error, 'invalid_or_expired_code')
  } finally {
    server.close()
  }
})
