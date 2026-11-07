'use strict'

const { callPublicOp: defaultCall } = require('./cloud-client')

// boat_registry.PAIR_CODE_ALPHABET — Crockford base32, no I/L/O/U
// (bundles/signalk@2026-06-05/boat_registry.py:24)
const PAIR_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
// boat_registry._CONFUSABLES (boat_registry.py:40)
const CONFUSABLES = { I: '1', L: '1', O: '0', U: 'V' }

// Codes are shown as dash-separated groups of three (ABC-DEF-GHJ) and accepted
// with no separators, or a single space or dash AT THE GROUP BOUNDARIES only —
// the same rule as boat_registry.normalize_grouped_code. A separator anywhere
// else makes the code unreadable rather than "close enough".
const GROUPED = /^[0-9A-Z]{3}(?:[ -]?[0-9A-Z]{3})*$/
const PLAIN = /^[0-9A-Z]+$/
// 9 = the current length (3x3). 8 = codes minted before 2026-11-07, still
// accepted by the cloud while they live (15 minutes).
const PAIR_CODE_LENGTHS = [9, 8]

function normalizePairCode (raw) {
  const s = String(raw || '').trim().toUpperCase()
  if (!GROUPED.test(s) && !PLAIN.test(s)) return ''
  return s.replace(/[ -]/g, '').split('').map((ch) => CONFUSABLES[ch] || ch).join('')
}

function isValidPairCode (raw) {
  const code = normalizePairCode(raw)
  return PAIR_CODE_LENGTHS.includes(code.length) &&
    [...code].every((ch) => PAIR_CODE_ALPHABET.includes(ch))
}

function fail (code, message, extra) {
  const err = new Error(message || code)
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

/** `extra.identity` is the boat as the owner confirmed it in the panel
 *  ({name, mmsi, callsign, type, length_m, beam_m, draft_m}); `extra.consent`
 *  is the owner's acceptance (lib/consent.js buildSubmission), recorded by the
 *  cloud in the same call. Each is sent only when given. A refusal keeps the
 *  cloud's fresh consent summary on the error (`consent_stale`). */
async function redeemCode (cfg, rawCode, hello, deps = {}, extra = {}) {
  if (!isValidPairCode(rawCode)) throw fail('invalid_code', 'a pairing code looks like ABC-DEF-GHJ')
  const call = deps.callPublicOp || defaultCall
  const data = { code: normalizePairCode(rawCode), hello: hello || {} }
  if (extra && extra.identity) data.identity = extra.identity
  if (extra && extra.consent) data.consent = extra.consent
  const res = await call(cfg, 'signalk_boat_pair', data)
  if (!res || res.ok !== true) {
    throw fail(res && res.error ? res.error : 'pair_failed', undefined,
      res && res.consent ? { consent: res.consent } : undefined)
  }
  return {
    boat_id: String(res.boat_id || ''),
    display_name: String(res.display_name || ''),
    subscribed_paths: Array.isArray(res.subscribed_paths) ? res.subscribed_paths : [],
    boat_credential: String(res.boat_credential || ''),
    consent: res.consent || null
  }
}

/** The three states a screen has to render. A claim lives in the state file for
 *  the whole minutes-long confirmation window while boat_id is still empty, so
 *  "never paired" and "waiting on your phone" are different answers. */
function pairingStatus (state) {
  const s = state || {}
  if (s.boat_id && s.boat_credential) return 'paired'
  if (s.claim_id) return 'awaiting_confirmation'
  return 'unpaired'
}

module.exports = {
  PAIR_CODE_ALPHABET, normalizePairCode, isValidPairCode,
  redeemCode, pairingStatus
}
