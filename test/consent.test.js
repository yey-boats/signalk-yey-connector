'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  parseConsentDocument, buildSubmission, parseStatus, sendPaths, callConsentOp
} = require('../lib/consent')
const { parseConnectionDocument } = require('../lib/connection')
const { describe, MESSAGES } = require('../src/panel/messages')
const { CONSENT, CONSENT_URL, DOC, DOC_C, ALL } = require('./fixtures/connection-doc')

test('a consent summary parses into what the panel renders', () => {
  const doc = parseConsentDocument(CONSENT)
  assert.deepEqual(doc.items, ['data_plan', 'terms', 'privacy'])
  assert.deepEqual(sendPaths(doc), ['navigation.position', 'environment.depth.belowTransducer'])
  assert.equal(doc.terms.draft, true)
  assert.equal(doc.privacy.url, 'https://yey.boats/privacy')
  assert.equal(doc.storage.history_days, 7)
})

test('on_request marks entries of send, never anything outside it', () => {
  assert.deepEqual(parseConsentDocument(CONSENT).on_request, [])
  const doc = parseConsentDocument({
    ...CONSENT,
    on_request: [{ path: 'environment.depth.belowTransducer', label: 'Depth' }, 'not.in.send']
  })
  assert.deepEqual(doc.on_request, [{ path: 'environment.depth.belowTransducer', label: 'Depth' }])
  assert.deepEqual(sendPaths(doc), ['navigation.position', 'environment.depth.belowTransducer'])
})

test('null is "no consent asked", anything malformed is invalid_document', () => {
  assert.equal(parseConsentDocument(null), null)
  for (const bad of [{}, { ...CONSENT, kind: 'x' }, { ...CONSENT, summary_hash: 'short' },
    { ...CONSENT, terms: { url: 'javascript:alert(1)', version: '1' } },
    { ...CONSENT, privacy: {} }]) {
    assert.throws(() => parseConsentDocument(bad), (e) => e.code === 'invalid_document')
  }
})

test('every item must be exactly true: boxes start unticked and nothing defaults one', () => {
  const doc = parseConsentDocument(CONSENT)
  for (const accepted of [undefined, null, {}, { data_plan: true, terms: true },
    { data_plan: true, terms: true, privacy: 1 }, { data_plan: 'true', terms: true, privacy: true }]) {
    assert.throws(() => buildSubmission(doc, accepted), (e) => e.code === 'consent_incomplete')
  }
  const sub = buildSubmission(doc, ALL, { deny: ['a.b', ''], version: '0.2.0' })
  assert.deepEqual(sub, {
    kind: 'yey.consent.v1', accepted: ALL, summary_hash: CONSENT.summary_hash,
    terms_version: '2026-11-07-draft', privacy_version: '2026-11-07', deny: ['a.b'],
    connector_version: '0.2.0'
  })
})

test('the status normalises unknown states to missing and keeps allowed', () => {
  assert.equal(parseStatus(null), null)
  assert.equal(parseStatus({ state: 'weird' }).state, 'missing')
  assert.equal(parseStatus({ state: 'expired', allowed: false }).allowed, false)
  assert.equal(parseStatus({ state: 'valid' }).allowed, true)
})

test('the connection document carries consent and a same-origin consent_url', () => {
  const doc = parseConnectionDocument(DOC_C)
  assert.equal(doc.consent_url, CONSENT_URL)
  assert.equal(doc.consent.summary_hash, CONSENT.summary_hash)
  const old = parseConnectionDocument(DOC)
  assert.equal(old.consent, null)
  assert.equal(old.consent_url, null)
  assert.throws(() => parseConnectionDocument({ ...DOC_C, consent_url: 'https://evil.example/x' }),
    (e) => e.code === 'invalid_document')
})

test('callConsentOp reads, records, and keeps the fresh summary on consent_stale', async () => {
  const calls = []
  const fresh = { ...CONSENT, summary_hash: 'c'.repeat(64) }
  const deps = {
    callPublicOp: async (cfg, op, data) => {
      calls.push({ op, data })
      if (!data.consent) return { ok: true, consent: CONSENT, status: { state: 'missing' } }
      return { ok: false, error: 'consent_stale', consent: fresh }
    }
  }
  const read = await callConsentOp({}, { boatId: 'b_1', credential: 'bk_x' }, deps)
  assert.equal(read.consent.summary_hash, CONSENT.summary_hash)
  assert.equal(read.status.state, 'missing')
  assert.equal(calls[0].op, 'signalk_boat_consent')
  await assert.rejects(callConsentOp({}, { boatId: 'b_1', credential: 'bk_x', consent: { x: 1 } }, deps),
    (e) => e.code === 'consent_stale' && e.consent.summary_hash === fresh.summary_hash)
})

test('every refusal code yey.boats or the plugin can produce has plain wording', () => {
  const codes = [
    // plugin
    'invalid_url', 'unreachable', 'unknown_or_expired_code', 'invalid_document', 'invalid_key',
    'key_required', 'already_connected', 'nothing_to_confirm', 'not_connected', 'plugin_stopped',
    'network', 'internal',
    // yey.boats: pairing, token claim, consent op
    'invalid_or_expired_code', 'boat_not_pending', 'boat_revoked', 'boat_unknown', 'invalid_credential',
    'rate_limited', 'pairing_unavailable', 'token_unavailable', 'consent_required', 'consent_incomplete',
    'consent_stale', 'consent_unavailable'
  ]
  for (const code of codes) {
    const text = describe(code)
    assert.ok(MESSAGES[code], `${code} has no wording`)
    assert.equal(text.includes(code), false, `${code} is shown as a bare code`)
    assert.equal(/_/.test(text), false, `${code} wording leaks an identifier`)
  }
  assert.match(describe('something_new'), /\(something_new\)/, 'an unknown code is still identifiable')
  assert.equal(describe('invalid_identity', 'MMSI must be 9 digits'), 'MMSI must be 9 digits')
})
