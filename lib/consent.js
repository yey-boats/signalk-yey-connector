'use strict'

/**
 * Consent on the boat's side (#441, phase 2).
 *
 * The plugin is the sensitive side: before anything leaves the boat the owner
 * sees what will be sent, what yey.boats keeps and for how long, and the privacy
 * policy and terms, and ticks three SEPARATE, unticked items:
 *
 *   data_plan  approve the data plan (what is sent; its lawful basis is the contract)
 *   terms      "I have read and agree to the Terms", at a specific version
 *   privacy    "I have read the privacy policy" (an acknowledgement, not an agreement)
 *
 * yey.boats serves the summary (`yey.consent.v1`) and records the acceptance.
 * The document arrives in the connection document (`consent`, URL mode) or from
 * the `signalk_boat_consent` op (key mode, and boats connected before consent
 * existed). Wire shapes:
 *
 *   document  {"kind":"yey.consent.v1","items":["data_plan","terms","privacy"],
 *              "send":[{"path":"navigation.position","label":"Position"},…],
 *              "storage":{"latest":"…","history_days":7,"who":"…","processors":"…"},
 *              "terms":{"url":"https://yey.boats/terms","version":"2026-11-07-draft","draft":true},
 *              "privacy":{"url":"https://yey.boats/privacy","version":"2026-11-07"},
 *              "summary_hash":"<64 hex>"}
 *
 *   accept    {"kind":"yey.consent.v1",
 *              "accepted":{"data_plan":true,"terms":true,"privacy":true},
 *              "summary_hash":"<echoed>","terms_version":"…","privacy_version":"…",
 *              "deny":[…],"connector_version":"0.2.0"}
 *
 *   status    {"state":"valid|provisional|reconsent_due|missing|expired",
 *              "allowed":true,"enforced":true,"reason":"…","terms_version":"…",
 *              "terms_draft":true,"accepted_at":"…","reconsent_by":"…"|null}
 *
 * `summary_hash` is the cloud's hash of the summary it served; echoing it binds
 * the acceptance to exactly what was shown. If the summary changed in between,
 * the cloud answers `consent_stale` with the fresh document.
 */

const { callPublicOp: defaultCall } = require('./cloud-client')

const KIND = 'yey.consent.v1'
const ITEMS = ['data_plan', 'terms', 'privacy']
const STATES = ['valid', 'provisional', 'reconsent_due', 'missing', 'expired']
const OP = 'signalk_boat_consent'

function fail (code, message, extra) {
  const err = new Error(message || code)
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

function str (v) {
  return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : '')
}

function httpUrl (raw) {
  try {
    const u = new URL(String(raw || ''))
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : ''
  } catch { return '' }
}

/** A validated consent document, or throws invalid_document. null in → null out. */
function parseConsentDocument (raw) {
  if (raw === null || raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.kind !== KIND) {
    throw fail('invalid_document', 'yey.boats sent a consent summary this plugin cannot read')
  }
  const hash = str(raw.summary_hash)
  if (!/^[0-9a-f]{64}$/.test(hash)) throw fail('invalid_document', 'the consent summary has no hash')
  const terms = raw.terms && typeof raw.terms === 'object' ? raw.terms : {}
  const privacy = raw.privacy && typeof raw.privacy === 'object' ? raw.privacy : {}
  if (!str(terms.version) || !httpUrl(terms.url) || !str(privacy.version) || !httpUrl(privacy.url)) {
    throw fail('invalid_document', 'the consent summary does not name the terms and privacy policy')
  }
  const send = (Array.isArray(raw.send) ? raw.send : [])
    .map((f) => (typeof f === 'string' ? { path: f, label: '' } : f))
    .filter((f) => f && typeof f === 'object' && str(f.path))
    .map((f) => ({ path: str(f.path), label: str(f.label) }))
  // The entries of `send` the plan does not stream, read from the boat only
  // when a question needs one (yey.boat.request). Display only: never outside
  // `send`, and absent from an older cloud.
  const inSend = new Set(send.map((f) => f.path))
  const onRequest = (Array.isArray(raw.on_request) ? raw.on_request : [])
    .map((f) => (typeof f === 'string' ? { path: f, label: '' } : f))
    .filter((f) => f && typeof f === 'object' && inSend.has(str(f.path)))
    .map((f) => ({ path: str(f.path), label: str(f.label) }))
  const storage = raw.storage && typeof raw.storage === 'object' ? raw.storage : {}
  return {
    kind: KIND,
    items: ITEMS.slice(),
    send,
    on_request: onRequest,
    storage: {
      latest: str(storage.latest),
      history_days: Number.isFinite(Number(storage.history_days)) ? Number(storage.history_days) : null,
      who: str(storage.who),
      processors: str(storage.processors)
    },
    terms: { url: httpUrl(terms.url), version: str(terms.version), draft: terms.draft === true },
    privacy: { url: httpUrl(privacy.url), version: str(privacy.version) },
    summary_hash: hash
  }
}

/** The paths the owner approved, which become the boat-side consent boundary. */
function sendPaths (doc) {
  return ((doc && doc.send) || []).map((f) => f.path)
}

/**
 * The acceptance to send. Each item must be exactly `true`: the boxes start
 * unticked and nothing here defaults one. Throws consent_incomplete otherwise,
 * before any network call.
 */
function buildSubmission (doc, accepted, { deny = [], version = '' } = {}) {
  if (!doc) throw fail('consent_unavailable', 'there is no consent summary to approve')
  const a = accepted && typeof accepted === 'object' ? accepted : {}
  const missing = ITEMS.filter((k) => a[k] !== true)
  if (missing.length) {
    throw fail('consent_incomplete', `tick all three items to continue (missing: ${missing.join(', ')})`,
      { missing })
  }
  return {
    kind: KIND,
    accepted: { data_plan: true, terms: true, privacy: true },
    summary_hash: doc.summary_hash,
    terms_version: doc.terms.version,
    privacy_version: doc.privacy.version,
    deny: (deny || []).map(String).filter(Boolean),
    connector_version: String(version || '')
  }
}

/** A normalised status from the cloud, or null. */
function parseStatus (raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const state = STATES.includes(raw.state) ? raw.state : 'missing'
  return {
    state,
    allowed: raw.allowed !== false,
    enforced: raw.enforced === true,
    reason: str(raw.reason),
    terms_version: str(raw.terms_version),
    terms_draft: raw.terms_draft === true,
    accepted_at: str(raw.accepted_at),
    reconsent_by: str(raw.reconsent_by) || null
  }
}

/** What the plugin remembers locally about an acceptance (no secrets). */
function localRecord (doc, submission, status, via, nowIso) {
  return {
    accepted_at: (status && status.accepted_at) || nowIso,
    terms_version: submission.terms_version,
    terms_draft: Boolean(doc && doc.terms && doc.terms.draft),
    privacy_version: submission.privacy_version,
    summary_hash: submission.summary_hash,
    send: sendPaths(doc),
    deny: submission.deny,
    via
  }
}

/**
 * The signalk_boat_consent op: without `consent` it reads the summary and the
 * boat's status; with it, it records the acceptance. Authenticated by the boat
 * credential, which never leaves this module except in the request body.
 */
async function callConsentOp (cfg, { boatId, credential, consent } = {}, deps = {}) {
  const call = deps.callPublicOp || defaultCall
  const data = { boat_id: String(boatId || ''), boat_credential: String(credential || '') }
  if (consent) data.consent = consent
  const res = await call(cfg, OP, data)
  if (!res || res.ok !== true) {
    const code = (res && res.error) || 'consent_unavailable'
    let fresh = null
    try { fresh = parseConsentDocument(res && res.consent) } catch { fresh = null }
    throw fail(code, code, fresh ? { consent: fresh } : undefined)
  }
  return {
    consent: parseConsentDocument(res.consent || null),
    status: parseStatus(res.status)
  }
}

module.exports = {
  KIND, ITEMS, OP, parseConsentDocument, sendPaths, buildSubmission, parseStatus,
  localRecord, callConsentOp
}
