'use strict'

/**
 * One-release migration from the old settings form.
 *
 * Before connect-by-URL the plugin options (SignalK's plugin-config-data file,
 * which the admin UI shows) carried cloudOrigin / tenant / project / bundleId /
 * signalkUrl / signalkToken / boatId / boatCredential, and pairing wrote the boat
 * id and credential into the private state file. Now routing, boat id and
 * credential live ONLY in the private state file (lib/state.js), and SignalK is
 * read in-process, so signalkUrl / signalkToken mean nothing.
 *
 * migrateLegacyOptions() copies what an existing install still has into private
 * state, once (state wins from then on; the old option keys are ignored), and
 * returns the options with those keys removed so the caller can rewrite the
 * options file without the credential in it.
 */

const LEGACY_KEYS = ['cloudOrigin', 'tenant', 'project', 'bundleId', 'signalkUrl',
  'signalkToken', 'boatId', 'boatCredential']

// What the old schema defaulted to. An install that paired with the old form and
// never touched these fields has none of them in its options file.
const LEGACY_DEFAULT_ROUTING = {
  origin: 'https://yey.boats',
  tenant: 'home',
  project: 'demo',
  bundle_id: 'signalk@2026-06-05'
}

function str (v) {
  return typeof v === 'string' ? v.trim() : ''
}

/** `{routing}` from old-style options, or null if they name none of it. */
function legacyRouting (opts) {
  const any = ['cloudOrigin', 'tenant', 'project', 'bundleId'].some((k) => str(opts[k]))
  if (!any) return null
  return {
    origin: (str(opts.cloudOrigin) || LEGACY_DEFAULT_ROUTING.origin).replace(/\/+$/, ''),
    tenant: str(opts.tenant) || LEGACY_DEFAULT_ROUTING.tenant,
    project: str(opts.project) || LEGACY_DEFAULT_ROUTING.project,
    bundle_id: str(opts.bundleId) || LEGACY_DEFAULT_ROUTING.bundle_id
  }
}

/**
 * @param {object} options  the plugin options as SignalK passed them
 * @param {object} state    lib/state.js instance
 * @returns {{migrated: boolean, legacyKeys: string[], cleaned: object}}
 *   migrated   — something was written to private state
 *   legacyKeys — old keys present in the options (to scrub)
 *   cleaned    — the options without them, deny/buffer moved under `advanced`
 */
function migrateLegacyOptions (options, state) {
  const opts = options && typeof options === 'object' ? options : {}
  const stored = state.read()
  const patch = {}

  if (!stored.boat_id && str(opts.boatId) && str(opts.boatCredential)) {
    patch.boat_id = str(opts.boatId)
    patch.boat_credential = str(opts.boatCredential)
  }
  const hasBoat = Boolean(patch.boat_id || stored.boat_id)
  if (!stored.routing || typeof stored.routing !== 'object') {
    const fromOpts = legacyRouting(opts)
    // A boat paired under the old form with default routing has no routing in
    // either file: it was the schema default, so it is the default now.
    if (fromOpts || hasBoat) patch.routing = fromOpts || { ...LEGACY_DEFAULT_ROUTING }
  }
  const migrated = Object.keys(patch).length > 0
  if (migrated) state.patch({ ...patch, migrated_from_options: true })

  const legacyKeys = LEGACY_KEYS.filter((k) => k in opts)
  const cleaned = {}
  for (const [k, v] of Object.entries(opts)) {
    if (LEGACY_KEYS.includes(k)) continue
    if (k === 'deny' || k === 'bufferMegabytes') continue
    cleaned[k] = v
  }
  const advanced = { ...(opts.advanced && typeof opts.advanced === 'object' ? opts.advanced : {}) }
  let movedAdvanced = false
  if (Array.isArray(opts.deny) && !Array.isArray(advanced.deny)) { advanced.deny = opts.deny; movedAdvanced = true }
  if (opts.bufferMegabytes !== undefined && advanced.bufferMegabytes === undefined) {
    advanced.bufferMegabytes = opts.bufferMegabytes
    movedAdvanced = true
  }
  if ('deny' in opts || 'bufferMegabytes' in opts) legacyKeys.push(...['deny', 'bufferMegabytes'].filter((k) => k in opts))
  if (Object.keys(advanced).length || movedAdvanced) cleaned.advanced = advanced
  return { migrated, legacyKeys, cleaned }
}

module.exports = { LEGACY_KEYS, LEGACY_DEFAULT_ROUTING, migrateLegacyOptions }
