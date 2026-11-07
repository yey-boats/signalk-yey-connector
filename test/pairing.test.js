'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { requestClaim, pollClaim, redeemCode, pairingStatus, normalizePairCode, isValidPairCode } = require('../lib/pairing')

const CFG = { cloudOrigin: 'https://x', tenant: 'home', project: 'demo',
              bundleId: 'signalk@2026-06-05' }

/** Stands in for callPublicOp — records the call, returns a scripted result.
 *  It returns the UNWRAPPED result because that is what callPublicOp returns
 *  (see lib/cloud-client.js); the envelope is that module's problem and is
 *  covered by its own tests against a real HTTP server. */
function scripted (script) {
  const calls = []
  return {
    calls,
    call: async (cfg, operation, data) => {
      calls.push({ operation, data })
      const next = script[operation]
      if (typeof next === 'function') return next(data, calls)
      if (next === undefined) throw new Error(`unscripted op ${operation}`)
      return next
    }
  }
}

test('requestClaim posts the hello and returns the claim material', async () => {
  const s = scripted({
    signalk_boat_claim_request: {
      ok: true, claim_id: 'c1', claim_secret: 's1',
      confirm_url: 'https://yey.boats/account/boats/new?claim=c1', expires_in: 1800
    }
  })
  const claim = await requestClaim(CFG, { connector_version: '0.1.0' },
    { callPublicOp: s.call })
  assert.equal(s.calls[0].operation, 'signalk_boat_claim_request')
  assert.deepEqual(s.calls[0].data, { hello: { connector_version: '0.1.0' } })
  assert.equal(claim.claim_id, 'c1')
  assert.equal(claim.claim_secret, 's1')
  assert.match(claim.confirm_url, /source=plugin/,
    'every outbound link carries source=plugin for the GA4 funnel')
})

test('requestClaim does not double a source the cloud already set', async () => {
  const s = scripted({
    signalk_boat_claim_request: {
      ok: true, claim_id: 'c1', claim_secret: 's1',
      confirm_url: 'https://yey.boats/x?claim=c1&source=email', expires_in: 60
    }
  })
  const claim = await requestClaim(CFG, {}, { callPublicOp: s.call })
  assert.equal(claim.confirm_url, 'https://yey.boats/x?claim=c1&source=email')
})

test('requestClaim surfaces a bundle-level error as an Error with its code', async () => {
  const s = scripted({ signalk_boat_claim_request: { ok: false, error: 'rate_limited' } })
  await assert.rejects(
    () => requestClaim(CFG, {}, { callPublicOp: s.call }),
    (err) => err.code === 'rate_limited')
})

test('pollClaim returns null while pending', async () => {
  const s = scripted({ signalk_boat_claim_poll: { ok: true, status: 'pending' } })
  const out = await pollClaim(CFG, { claim_id: 'c1', claim_secret: 's1' },
    { callPublicOp: s.call })
  assert.equal(out, null)
  assert.deepEqual(s.calls[0].data, { claim_id: 'c1', claim_secret: 's1' })
})

test('pollClaim returns the boat and its credential once confirmed', async () => {
  const s = scripted({
    signalk_boat_claim_poll: {
      ok: true, status: 'confirmed', boat_id: 'b_1', boat_credential: 'bk_x'
    }
  })
  const out = await pollClaim(CFG, { claim_id: 'c1', claim_secret: 's1' },
    { callPublicOp: s.call })
  assert.deepEqual(out, { boat_id: 'b_1', boat_credential: 'bk_x' })
})

test('pollClaim refuses a confirmation that carries no credential', async () => {
  /* The cloud caches the plaintext for the claim's lifetime; past that it
     answers confirmed with no credential and the honest outcome is to re-pair,
     not to come up half-bound with nothing to authenticate with. */
  const s = scripted({
    signalk_boat_claim_poll: { ok: true, status: 'confirmed', boat_id: 'b_1' }
  })
  await assert.rejects(
    () => pollClaim(CFG, { claim_id: 'c1', claim_secret: 's1' }, { callPublicOp: s.call }),
    (err) => err.code === 'credential_unavailable')
})

test('redeemCode sends the normalized code and the hello', async () => {
  const s = scripted({
    signalk_boat_pair: (data) => {
      assert.equal(data.code, 'A1B2C3D4E')
      return { ok: true, boat_id: 'b_2', display_name: 'Sara',
               subscribed_paths: ['navigation.position'], boat_credential: 'bk_y' }
    }
  })
  const out = await redeemCode(CFG, ' a1b-2c3-d4e ', { connector_version: '0.1.0' },
    { callPublicOp: s.call })
  assert.equal(out.boat_id, 'b_2')
  assert.equal(out.boat_credential, 'bk_y')
  assert.deepEqual(out.subscribed_paths, ['navigation.position'])
})

test('redeemCode normalizes the way the cloud does', async () => {
  /* boat_registry.normalize_grouped_code: upper-cases, accepts separators only
     between groups of three, and folds I->1 L->1 O->0 U->V. Doing it on the
     boat too means a typo is rejected at the keyboard, not after a round trip. */
  const s = scripted({ signalk_boat_pair: (d) => {
    assert.equal(d.code, '1100V1234')
    return { ok: true, boat_id: 'b_3', boat_credential: 'bk_z', subscribed_paths: [] }
  } })
  await redeemCode(CFG, 'il0 ou1 234', {}, { callPublicOp: s.call })
})

test('redeemCode rejects a locally-invalid code without a round trip', async () => {
  const s = scripted({})
  await assert.rejects(
    () => redeemCode(CFG, 'SHORT', {}, { callPublicOp: s.call }),
    (err) => err.code === 'invalid_code')
  assert.equal(s.calls.length, 0)
})

test('redeemCode surfaces the cloud refusal code', async () => {
  const s = scripted({ signalk_boat_pair: { ok: false, error: 'invalid_or_expired_code' } })
  await assert.rejects(
    () => redeemCode(CFG, 'A1B2C3D4', {}, { callPublicOp: s.call }),
    (err) => err.code === 'invalid_or_expired_code')
})

test('pairingStatus reports the three states a screen has to render', () => {
  assert.equal(pairingStatus({}), 'unpaired')
  assert.equal(pairingStatus({ claim_id: 'c1' }), 'awaiting_confirmation')
  assert.equal(pairingStatus({ boat_id: 'b_1', boat_credential: 'bk_x' }), 'paired')
  // A boat id with no credential is not a paired boat: start() refuses to dial
  // on it, so the page must not claim otherwise.
  assert.equal(pairingStatus({ boat_id: 'b_1' }), 'unpaired')
})

test('codes are accepted as shown, with spaces, or with nothing at the group boundaries', () => {
  for (const typed of ['A1B-2C3-D4E', 'a1b 2c3 d4e', 'A1B2C3D4E']) {
    assert.equal(normalizePairCode(typed), 'A1B2C3D4E')
    assert.equal(isValidPairCode(typed), true)
  }
})

test('a separator off the group boundary is refused locally', async () => {
  assert.equal(isValidPairCode('A1B2-C3D4E'), false)
  assert.equal(isValidPairCode('A1B--2C3D4E'), false)
  const s = scripted({})
  await assert.rejects(() => redeemCode(CFG, 'A1B2-C3D4E', {}, { callPublicOp: s.call }),
    (err) => err.code === 'invalid_code')
  assert.equal(s.calls.length, 0)
})

test('legacy 8-character codes still work while they live', () => {
  assert.equal(isValidPairCode('A1B2C3D4'), true)
  assert.equal(isValidPairCode('A1B2C3D4E5'), false)
})
