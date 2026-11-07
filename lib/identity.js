'use strict'

/**
 * The boat's identity as this SignalK server knows it, for the "Is this your
 * boat?" step of connect-by-URL. Pure: the vessels/self tree is handed in.
 *
 * SignalK keeps static vessel data in two shapes. `name`, `mmsi` and
 * `communication.callsignVhf` are usually plain strings on the vessel object;
 * `design.*` are value nodes ({value, $source, timestamp}). Some servers wrap
 * the strings as {value} too, so both are accepted everywhere.
 *
 *   name       name
 *   mmsi       mmsi
 *   callsign   communication.callsignVhf
 *   type       design.aisShipType.value.name (e.g. "Sailing")
 *   length_m   design.length.value.overall
 *   beam_m     design.beam.value
 *   draft_m    design.draft.value.maximum (else .current, else .canoe)
 */

const IDENTITY_KEYS = ['name', 'mmsi', 'callsign', 'type', 'length_m', 'beam_m', 'draft_m']

function at (tree, dotted) {
  return String(dotted).split('.').reduce((node, key) =>
    (node && typeof node === 'object') ? node[key] : undefined, tree)
}

function unwrap (node) {
  if (node && typeof node === 'object' && !Array.isArray(node) && 'value' in node) return node.value
  return node
}

function text (node) {
  const v = unwrap(node)
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function metres (node, ...keys) {
  let v = unwrap(node)
  if (v && typeof v === 'object') {
    v = keys.map((k) => v[k]).find((x) => typeof x === 'number')
  }
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** Every identity key, null where this server has nothing. */
function extractIdentity (tree) {
  const self = tree && typeof tree === 'object' ? tree : {}
  const shipType = unwrap(at(self, 'design.aisShipType'))
  let type = null
  if (shipType && typeof shipType === 'object') type = text(shipType.name)
  else type = text(shipType)
  return {
    name: text(self.name),
    mmsi: text(self.mmsi),
    callsign: text(at(self, 'communication.callsignVhf')),
    type,
    length_m: metres(at(self, 'design.length'), 'overall', 'hull', 'waterline'),
    beam_m: metres(at(self, 'design.beam')),
    draft_m: metres(at(self, 'design.draft'), 'maximum', 'current', 'canoe')
  }
}

function fail (code, message) {
  const err = new Error(message || code)
  err.code = code
  return err
}

/** What the owner confirmed (and maybe corrected) in the panel, cleaned up for
 *  the pair call. Unknown keys are dropped; blanks become null. A value that is
 *  present but wrong is refused rather than silently discarded, so the owner
 *  sees why. */
function normalizeIdentity (raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const key of ['name', 'callsign', 'type']) {
    const v = src[key] === undefined || src[key] === null ? '' : String(src[key]).trim()
    out[key] = v ? v.slice(0, 120) : null
  }
  const mmsi = src.mmsi === undefined || src.mmsi === null ? '' : String(src.mmsi).trim()
  if (mmsi && !/^\d{9}$/.test(mmsi)) throw fail('invalid_identity', 'an MMSI is nine digits')
  out.mmsi = mmsi || null
  for (const key of ['length_m', 'beam_m', 'draft_m']) {
    const v = src[key]
    if (v === undefined || v === null || v === '') { out[key] = null; continue }
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0 || n > 500) {
      throw fail('invalid_identity', `${key.replace('_m', '')} must be a positive number of metres`)
    }
    out[key] = n
  }
  return out
}

module.exports = { IDENTITY_KEYS, extractIdentity, normalizeIdentity }
