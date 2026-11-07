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

module.exports = { DOC, KEY_DOC, TREE, docFetch }
