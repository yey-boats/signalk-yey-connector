'use strict'
// Plain wording for every refusal the panel can meet: the plugin's own errors
// (lib/connection.js, lib/consent.js, lib/routes.js) and the codes yey.boats
// answers with (signalk_boat_pair, signalk_boat_consent, the token claim).
// CommonJS so the node tests can require it; webpack bundles it into the panel.
//
// A code that is not listed gets the generic sentence with the code in
// brackets, so support can still tell what happened.

const MESSAGES = {
  // Pasting the link
  invalid_url: 'Paste the connection link from yey.boats (it starts with https://) or the code it shows.',
  unreachable: 'Could not reach yey.boats from this server. Check its internet connection and try again.',
  unknown_or_expired_code: 'This link is unknown or has expired. Get a fresh one on yey.boats.',
  invalid_document: 'This is not a yey.boats connection link.',
  invalid_key: 'This key is not complete. Copy it again from yey.boats.',
  key_required: 'This link needs the key yey.boats gave you.',
  invalid_identity: null, // the server's message says which field
  already_connected: 'Already connected. Disconnect first.',
  nothing_to_confirm: 'Paste the connection link again.',
  not_connected: 'Connect to yey.boats first.',
  plugin_stopped: 'The connector is not running.',
  network: 'The SignalK server did not answer.',
  invalid_name: 'A boat name cannot be empty.',
  origin_not_allowed: 'This link is not from yey.boats, so the connector refused it. Get the link on yey.boats. ' +
    '(Running your own server? Set allow_custom_origin in the plugin settings file.)',
  insecure_origin: 'This link starts with http://. Use the https:// link from yey.boats ' +
    '(http:// is only accepted for localhost or a yey box at yey.local).',

  // yey.boats refusing the pairing
  invalid_or_expired_code: 'This link was already used or has expired. Get a fresh one on yey.boats.',
  invalid_code: 'This link was already used or has expired. Get a fresh one on yey.boats.',
  boat_not_pending: 'This boat was removed on yey.boats. Add it again there and get a new link.',
  boat_revoked: 'This boat was removed on yey.boats. Add it again there and get a new link.',
  boat_unknown: 'yey.boats does not know this boat any more. Add it again there and get a new link.',
  unknown_boat: 'yey.boats does not know this boat any more. Add it again there and get a new link.',
  invalid_credential: 'yey.boats no longer accepts this server\'s key. Get a new link or key on yey.boats → Account.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  pairing_unavailable: 'yey.boats is having trouble right now. Try again in a few minutes.',
  token_unavailable: 'yey.boats is having trouble right now. Try again in a few minutes.',
  consent_unavailable: 'yey.boats could not show what this server would share. Try again in a few minutes.',

  // Consent
  consent_required: 'Nothing is sent until you approve what this server shares with yey.boats. Review it below.',
  consent_incomplete: 'Tick all three boxes to continue.',
  consent_stale: 'What yey.boats asks for changed while you were reading. Review the updated summary and approve again.',

  internal: 'Something went wrong in the connector. Try again; if it keeps happening, tell us on yey.boats.'
}

/** The sentence to show for an error code. `fallback` is the server's own
 *  message, used when it is more specific than the code (invalid_identity). */
function describe (code, fallback) {
  if (code && Object.prototype.hasOwnProperty.call(MESSAGES, code) && MESSAGES[code]) return MESSAGES[code]
  if (fallback && fallback !== code) return fallback
  if (code) return 'yey.boats did not accept this (' + code + '). Try again, or get a fresh link on yey.boats.'
  return 'Something went wrong. Try again.'
}

module.exports = { MESSAGES, describe }
