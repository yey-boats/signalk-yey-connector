'use strict'

/**
 * Connect by URL: the connection document and the key.
 *
 * The owner copies a connection URL from yey.boats (https://yey.boats/c/ABC-DEF-GHJ,
 * or a local origin on a yey box). `GET <url>` with `Accept: application/json`
 * answers:
 *
 *   {"kind":"yey.connection.v1","code":"ABCDEFGHJ","expires_in_s":840,
 *    "boat":{"display_name":"Sara"},
 *    "pair_url":"https://yey.boats/api/integrations/bundles/home/demo/signalk@2026-06-05/public/signalk_boat_pair",
 *    "routing":{"origin":"https://yey.boats","tenant":"home","project":"demo",
 *               "bundle_id":"signalk@2026-06-05"}}
 *
 * or 404 {"kind":"yey.connection.v1","error":"unknown_or_expired_code"}.
 *
 * Key mode: the owner pastes https://yey.boats/c/key plus a key
 * `yk1.<boat_id>.<credential>`; that URL answers the same shape with
 * `code: null` and `pair_url: null`, and supplies only the routing.
 *
 * Phase 2 (consent): both documents may also carry `consent_url`, the
 * signalk_boat_consent op, and the code document a `consent` block, the
 * yey.consent.v1 summary the owner approves before anything is sent (see
 * lib/consent.js). A cloud that predates consent sends neither, and the plugin
 * connects as in phase 1.
 *
 * Errors carry a `code` the panel can switch on:
 *   invalid_url, unreachable, unknown_or_expired_code, invalid_document,
 *   invalid_key, key_required.
 */

const { parseConsentDocument } = require('./consent')
const { isValidPairCode, normalizePairCode } = require('./pairing')

const KIND = 'yey.connection.v1'
const KEY_PREFIX = 'yk1'

function fail (code, message, extra) {
  const err = new Error(message || code)
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

function httpUrl (raw) {
  let u
  try { u = new URL(String(raw || '').trim()) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  return u
}

function nonEmpty (v) {
  return typeof v === 'string' && v.trim() !== ''
}

/** Validate a parsed connection document. Throws invalid_document. */
function parseConnectionDocument (body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.kind !== KIND) {
    throw fail('invalid_document', 'this link is not a yey.boats connection link')
  }
  if (body.error) {
    if (body.error === 'unknown_or_expired_code') {
      throw fail('unknown_or_expired_code', 'this connection link is unknown or has expired; get a fresh one on yey.boats')
    }
    throw fail('invalid_document', `yey.boats answered: ${String(body.error)}`)
  }
  const r = body.routing
  if (!r || typeof r !== 'object' || !nonEmpty(r.tenant) || !nonEmpty(r.project) ||
      !nonEmpty(r.bundle_id) || !httpUrl(r.origin)) {
    throw fail('invalid_document', 'the connection document has no usable routing')
  }
  const origin = httpUrl(r.origin).origin
  const code = body.code === null || body.code === undefined ? null : String(body.code)
  let pairUrl = null
  if (body.pair_url !== null && body.pair_url !== undefined) {
    const u = httpUrl(body.pair_url)
    // The pair call carries the boat's identity and returns its credential:
    // it has to go to the same yey origin the routing names.
    if (!u || u.origin !== origin) {
      throw fail('invalid_document', 'the connection document points pairing at another site')
    }
    pairUrl = u.href
  }
  if (code && !pairUrl) throw fail('invalid_document', 'the connection document has a code but no pair_url')
  let consentUrl = null
  if (body.consent_url !== null && body.consent_url !== undefined) {
    const u = httpUrl(body.consent_url)
    // It carries the boat credential: same origin as the routing, like pair_url.
    if (!u || u.origin !== origin) {
      throw fail('invalid_document', 'the connection document points consent at another site')
    }
    consentUrl = u.href
  }
  const consent = parseConsentDocument(body.consent === undefined ? null : body.consent)
  const boat = body.boat && typeof body.boat === 'object' ? body.boat : {}
  return {
    kind: KIND,
    code,
    expires_in_s: Number.isFinite(Number(body.expires_in_s)) ? Number(body.expires_in_s) : null,
    boat: { display_name: nonEmpty(boat.display_name) ? String(boat.display_name) : '' },
    pair_url: pairUrl,
    consent_url: consentUrl,
    consent,
    routing: {
      origin,
      tenant: String(r.tenant),
      project: String(r.project),
      bundle_id: String(r.bundle_id)
    }
  }
}

const DEFAULT_ORIGIN = 'https://yey.boats'

/**
 * What the owner pasted, as the link to fetch. Accepts:
 *   - the link itself, https://yey.boats/c/ABC-DEF-GHJ;
 *   - the link with junk in front of it. A password manager filling the
 *     SignalK admin login into this field leaves "adminhttps://yey.boats/c/…";
 *     the link is whatever starts at the first http(s)://, up to whitespace;
 *   - the bare code, ABC-DEF-GHJ (with or without dashes), on `origin`.
 * Anything else comes back trimmed, for fetchConnectionDocument to refuse as
 * invalid_url with its usual wording.
 */
function normalizeConnectionInput (raw, origin = DEFAULT_ORIGIN) {
  const s = String(raw == null ? '' : raw).trim()
  const at = s.search(/https?:\/\//i)
  if (at >= 0) return s.slice(at).split(/\s/)[0]
  if (isValidPairCode(s)) {
    const code = normalizePairCode(s)
    const grouped = code.length === 9 ? code.match(/.{3}/g).join('-') : code
    return `${String(origin).replace(/\/+$/, '')}/c/${grouped}`
  }
  return s
}

/** GET the connection document behind a URL the owner pasted. */
async function fetchConnectionDocument (rawUrl, opts = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = opts
  const u = httpUrl(normalizeConnectionInput(rawUrl))
  if (!u) throw fail('invalid_url', 'paste the connection link from yey.boats (it starts with https://)')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(u.href, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal
    })
  } catch (err) {
    throw fail('unreachable', `could not reach ${u.origin} (${(err && err.message) || 'network error'})`)
  } finally {
    clearTimeout(timer)
  }
  let text = ''
  try { text = await res.text() } catch { text = '' }
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }

  if (res.status === 404 || res.status === 410) {
    if (body && body.kind === KIND && body.error && body.error !== 'unknown_or_expired_code') {
      throw fail('invalid_document', `yey.boats answered: ${String(body.error)}`)
    }
    throw fail('unknown_or_expired_code',
      'this connection link is unknown or has expired; get a fresh one on yey.boats')
  }
  if (res.status >= 500) throw fail('unreachable', `${u.origin} answered HTTP ${res.status}; try again shortly`)
  if (!res.ok) throw fail('invalid_document', `${u.origin} answered HTTP ${res.status}`)
  if (body === null) throw fail('invalid_document', 'this link did not return a yey.boats connection document')
  return parseConnectionDocument(body)
}

/** `yk1.<boat_id>.<credential>` → {boatId, credential}. Throws invalid_key. */
function parseKey (raw) {
  const s = String(raw || '').trim()
  const parts = s.split('.')
  if (parts.length < 3 || parts[0] !== KEY_PREFIX) {
    throw fail('invalid_key', 'a yey.boats key looks like yk1.<boat>.<secret>')
  }
  const boatId = parts[1]
  const credential = parts.slice(2).join('.')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(boatId) || !/^[\x21-\x7e]{8,512}$/.test(credential)) {
    throw fail('invalid_key', 'this key is not complete; copy it again from yey.boats')
  }
  return { boatId, credential }
}

/** The routing block in the shape cloud-client/uplink already use. */
function routingToCfg (routing) {
  const r = routing || {}
  return {
    cloudOrigin: String(r.origin || '').replace(/\/+$/, ''),
    tenant: String(r.tenant || ''),
    project: String(r.project || ''),
    bundleId: String(r.bundle_id || '')
  }
}

module.exports = {
  KIND, KEY_PREFIX, DEFAULT_ORIGIN, normalizeConnectionInput,
  parseConnectionDocument, fetchConnectionDocument, parseKey, routingToCfg
}
