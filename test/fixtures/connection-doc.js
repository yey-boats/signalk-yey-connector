'use strict'
// The connect-by-URL contract, shared by the runtime and route tests.
const DOC = {
  kind: 'yey.connection.v1',
  code: 'ABCDEFGHJ',
  expires_in_s: 840,
  boat: { display_name: 'Sara' },
  pair_url: 'https://yey.boats/api/integrations/bundles/home/demo/signalk@2026-06-05/public/signalk_boat_pair',
  routing: { origin: 'https://yey.boats', tenant: 'home', project: 'demo', bundle_id: 'signalk@2026-06-05' }
}
const KEY_DOC = { ...DOC, code: null, pair_url: null }

// Phase 2 (#441): the consent summary, as signalk_connection_document and
// signalk_boat_consent serve it.
const CONSENT_URL = 'https://yey.boats/api/integrations/bundles/home/demo/signalk@2026-06-05/public/signalk_boat_consent'
const CONSENT = {
  kind: 'yey.consent.v1',
  items: ['data_plan', 'terms', 'privacy'],
  send: [{ path: 'navigation.position', label: 'Position' },
    { path: 'environment.depth.belowTransducer', label: 'Depth' }],
  storage: { latest: 'while the boat is registered', history_days: 7,
    who: 'you and crew you invite', processors: 'AI providers, when a question needs them' },
  terms: { url: 'https://yey.boats/terms', version: '2026-11-07-draft', draft: true },
  privacy: { url: 'https://yey.boats/privacy', version: '2026-11-07' },
  summary_hash: 'a'.repeat(64)
}
const DOC_C = { ...DOC, consent_url: CONSENT_URL, consent: CONSENT }
const KEY_DOC_C = { ...KEY_DOC, consent_url: CONSENT_URL, consent: null }
const ALL = { data_plan: true, terms: true, privacy: true }
const TREE = {
  name: 'Sara',
  mmsi: '238123456',
  communication: { callsignVhf: '9A1234' },
  design: {
    aisShipType: { value: { id: 36, name: 'Sailing' } },
    length: { value: { overall: 12.4 } },
    beam: { value: 4.1 },
    draft: { value: { maximum: 2.05 } }
  }
}

/** fetch for the connection URL: url -> [status, body]. */
function docFetch (routes, calls = []) {
  return async (url, init) => {
    calls.push({ url, init })
    const hit = routes[url]
    if (!hit) throw new Error('ECONNREFUSED')
    const [status, body] = hit
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return { status, ok: status >= 200 && status < 300, text: async () => text }
  }
}

module.exports = { DOC, KEY_DOC, TREE, docFetch, CONSENT, CONSENT_URL, DOC_C, KEY_DOC_C, ALL }
