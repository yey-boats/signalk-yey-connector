'use strict'

/**
 * The boat's display name: the name the OWNER chose for it, which both sides
 * can change — in this plugin's panel, or on yey.boats (Account, the boat
 * menu). Distinct from the SignalK vessel name (`hello.vessel.name`, what the
 * server itself calls the boat), which never overrides an owner's choice.
 *
 * One protocol, carried on the handshake that already runs every heartbeat:
 *
 *   boat -> cloud   hello.display_name = {value, set_at}
 *                   only when the owner set the name HERE (set_at is the
 *                   moment they did, on the cloud's clock as best we know it).
 *   cloud -> boat   reply.boat = {display_name, display_name_set_at, server_time}
 *                   on every hello reply, plan or not_modified.
 *
 *   Last writer wins on set_at. A name nobody chose (the "New boat" placeholder,
 *   or the SignalK name the cloud took at pairing) has set_at null and loses to
 *   any chosen one. The cloud clamps a set_at in its future to its own now.
 *
 * Compatibility: a cloud that predates this ignores hello.display_name (it
 * reads only the fields it knows) and sends no reply.boat, so a rename here
 * stays local and the panel says so. An older connector sends no
 * hello.display_name and ignores reply.boat, so its name simply stops
 * following renames on yey.boats.
 *
 * Pure: the runtime holds the state and the clock.
 */

const MAX_LEN = 80

function fail (code, message) {
  const err = new Error(message || code)
  err.code = code
  return err
}

/** Trimmed, inner whitespace collapsed, other control characters dropped, clipped.
 *  '' when nothing is left. Mirrors boat_registry.normalize_display_name. */
function normalizeDisplayName (raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return s.slice(0, MAX_LEN).trim()
}

/** For the panel route: a usable name, or a typed refusal. */
function requireDisplayName (raw) {
  const name = normalizeDisplayName(raw)
  if (!name) throw fail('invalid_name', 'a boat name cannot be empty')
  return name
}

function ms (iso) {
  if (!iso) return NaN
  const t = Date.parse(String(iso))
  return Number.isFinite(t) ? t : NaN
}

/** The hello field, or null when the owner never named the boat here. */
function helloField (saved) {
  const s = saved || {}
  const value = normalizeDisplayName(s.display_name)
  if (!value || !s.display_name_set_at || !Number.isFinite(ms(s.display_name_set_at))) return null
  return { value, set_at: String(s.display_name_set_at) }
}

/** The cloud's reply.boat, validated; null when absent (an older cloud). */
function parseCloudBoat (raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = normalizeDisplayName(raw.display_name)
  if (!name) return null
  const setAt = raw.display_name_set_at && Number.isFinite(ms(raw.display_name_set_at))
    ? String(raw.display_name_set_at) : ''
  const serverMs = ms(raw.server_time)
  return { display_name: name, set_at: setAt, server_ms: Number.isFinite(serverMs) ? serverMs : null }
}

/**
 * What to store after the cloud answered. `saved` is the state file
 * ({display_name, display_name_set_at}); `cloud` is parseCloudBoat's answer.
 * Returns {patch, synced}: `patch` is null when nothing changes, `synced` is
 * true when both sides now hold the same name.
 */
function reconcile (saved, cloud) {
  const s = saved || {}
  if (!cloud) return { patch: null, synced: false }
  const local = normalizeDisplayName(s.display_name)
  const localAt = s.display_name_set_at ? String(s.display_name_set_at) : ''
  if (cloud.display_name === local) {
    // Same name: take the cloud's stamp (it may have clamped ours), so the next
    // hello carries exactly what the cloud holds and changes nothing there.
    if (cloud.set_at && cloud.set_at !== localAt) {
      return { patch: { display_name_set_at: cloud.set_at }, synced: true }
    }
    return { patch: null, synced: true }
  }
  // Different names. Ours stands only if the owner chose it here AND it is
  // newer than the cloud's (the cloud adopts it from the next hello; it did
  // not this time only if that hello predates the rename).
  const localMs = ms(localAt)
  const cloudMs = ms(cloud.set_at)
  const oursIsNewer = Number.isFinite(localMs) && (!Number.isFinite(cloudMs) || localMs > cloudMs)
  if (oursIsNewer) return { patch: null, synced: false }
  return { patch: { display_name: cloud.display_name, display_name_set_at: cloud.set_at }, synced: true }
}

module.exports = {
  MAX_LEN, normalizeDisplayName, requireDisplayName, helloField, parseCloudBoat, reconcile
}
