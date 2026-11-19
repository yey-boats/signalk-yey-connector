'use strict'

/**
 * The one cloud-dashboards policy (display provisioning contract v1, §1).
 * Every `show_dashboard` the cloud sends — "put this yey.boats dashboard on
 * these displays" — is checked HERE, on the boat; lib/rpc.js only calls it,
 * in this order, every time:
 *
 *   1. the owner's plugin option `allow_cloud_dashboards` must be on. It is ON
 *      by default (owner decision 2026-11-16: a dashboard is not a control and
 *      the cloud already lets only the boat's owner send one); unticking it
 *      refuses every show (`cloud_dashboards_off`). The cloud cannot flip it.
 *   2. the envelope, exactly as for remote steering (lib/request-guard.js):
 *      boat_id required and ours, deadline_ms required, not past and at most
 *      MAX_DEADLINE_AHEAD_MS ahead, the id never seen before — remembered on
 *      disk in its own file (yey-dashboards-replay.json), so a replay is
 *      dropped across restarts (`bad_request` with the reason in `detail`, or
 *      dropped unanswered: expired / duplicate / foreign_boat).
 *      Then the arguments' shape (`bad_request`, `detail` names the field).
 *   3. `JSON.stringify(dashboard.doc)` at most MAX_DOC_BYTES (48 KiB, Display
 *      Manager's record cap), counted in UTF-8 bytes (`too_large`);
 *   4. a rate of its own, 6 shows a minute, separate from steering
 *      (`rate_limited`);
 *   5. Display Manager's in-process API must be there
 *      (`globalThis[Symbol.for('yey-boats.display-manager')]`, version >= 1)
 *      (`unsupported`, `detail: display_manager_missing`);
 *   6. hand off to `dm.showDashboard({...})`, bounded by HANDLER_TIMEOUT_MS
 *      (15 s) (`timeout`). Display Manager's validator refusing the doc is
 *      `invalid_dashboard` with its message in `detail`.
 *
 * The deadline window is wider than steering's 15 s because the hand-off
 * itself may take up to 15 s: the cloud sets deadline_ms about 20 s ahead.
 *
 * `displays` (read) is not gated by consent, the plan or this switch: it is
 * not boat data leaving the boat, and its reply reports the switch.
 */

const fsDefault = require('node:fs')
const { createRequestGuard, createRate } = require('./request-guard')

const POLICY_VERSION = 1
const REPLAY_FILE = 'yey-dashboards-replay.json'
const DISPLAY_MANAGER_KEY = Symbol.for('yey-boats.display-manager')
const MIN_DISPLAY_MANAGER_VERSION = 1

const SHOWS_PER_MIN = 6
const MAX_DOC_BYTES = 48 * 1024
const HANDLER_TIMEOUT_MS = 15 * 1000
const MAX_DEADLINE_AHEAD_MS = 30 * 1000
const REPLAY_RETENTION_MS = 10 * 60 * 1000
const MAX_REPLAY_IDS = 256

const MAX_TARGETS = 32          // display ids in one show
const MAX_LISTED = 64           // displays in one `displays` reply / results in one show
const MAX_ID = 128
const MAX_TITLE = 200
const MAX_LABEL = 120
const MAX_ERROR = 500           // a validator message, passed through
const STATES = Object.freeze(['shown', 'queued', 'refused', 'unknown_display'])

// A display id as Display Manager stores it ([a-z0-9_.-], 1-64: its
// sanitizeDeviceId form), never an Object.prototype member. Display Manager
// keeps displays in an id-keyed object: '__proto__' or 'constructor' there
// reached Object.prototype (Instruments-manager #88), so such an id never
// leaves the connector, whoever chose it (cloud, model, MCP).
const DISPLAY_ID = /^[a-z0-9_.-]{1,64}$/
const RESERVED_IDS = new Set([...Object.getOwnPropertyNames(Object.prototype), '__proto__', 'prototype'])
const isDisplayId = (id) => typeof id === 'string' && DISPLAY_ID.test(id) && !RESERVED_IDS.has(id)

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const optString = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max)

/** UTF-8 bytes of JSON.stringify(doc); Infinity when it cannot be serialised. */
function docBytes (doc) {
  try { return Buffer.byteLength(JSON.stringify(doc), 'utf8') } catch { return Infinity }
}

/**
 * The arguments of one show_dashboard, checked and normalised.
 * {request} to go on, or {error: detail} for bad_request.
 */
function validateArgs (args) {
  const a = isObject(args) ? args : {}
  let ids = a.display_ids
  if (ids === 'all') ids = ['all']
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_TARGETS) return { error: 'display_ids' }
  if (!ids.every((id) => typeof id === 'string' && id.trim() && id.length <= MAX_ID)) return { error: 'display_ids' }
  ids = [...new Set(ids.map((id) => id.trim()))]
  // "all" = every registered display, alone or not at all.
  if (ids.includes('all') && ids.length > 1) return { error: 'display_ids' }
  if (!ids.every((id) => id === 'all' || isDisplayId(id))) return { error: 'display_ids' }
  const d = a.dashboard
  if (!isObject(d)) return { error: 'dashboard' }
  if (typeof d.source_id !== 'string' || !d.source_id.trim() || d.source_id.length > MAX_ID) {
    return { error: 'dashboard.source_id' }
  }
  if (!optString(d.title, MAX_TITLE)) return { error: 'dashboard.title' }
  if (!optString(d.updated_at, 64)) return { error: 'dashboard.updated_at' }
  if (!optString(d.screen, MAX_ID) || d.screen === '') return { error: 'dashboard.screen' }
  if (!isObject(d.doc)) return { error: 'dashboard.doc' }
  return {
    request: {
      sourceId: d.source_id.trim(),
      title: str(d.title, MAX_TITLE),
      updatedAt: str(d.updated_at, 64),
      doc: d.doc,
      screen: typeof d.screen === 'string' ? d.screen : null,
      displayIds: ids[0] === 'all' ? 'all' : ids,
      requestedBy: str(a.requested_by, MAX_LABEL)
    }
  }
}

/** Display Manager's API when it is there and new enough, else null. */
function displayManagerFrom (value) {
  const dm = value
  if (!dm || (typeof dm !== 'object' && typeof dm !== 'function')) return null
  if (!(Number(dm.version) >= MIN_DISPLAY_MANAGER_VERSION)) return null
  if (typeof dm.listDisplays !== 'function' || typeof dm.showDashboard !== 'function') return null
  return dm
}

/** listDisplays() as the reply may carry it: the contract's fields, bounded. */
function sanitizeDisplays (list) {
  const out = []
  for (const d of Array.isArray(list) ? list : []) {
    if (!isObject(d) || typeof d.id !== 'string' || !d.id) continue
    const screen = isObject(d.screen)
      ? { id: str(d.screen.id, MAX_ID), title: str(d.screen.title, MAX_TITLE), record: str(d.screen.record, MAX_ID) }
      : null
    const preset = isObject(d.preset) ? { id: str(d.preset.id, MAX_ID), name: str(d.preset.name, MAX_TITLE) } : null
    out.push({
      id: d.id.slice(0, MAX_ID),
      name: str(d.name, MAX_TITLE),
      class: str(d.class, 64),
      online: d.online === true,
      screen,
      preset
    })
    if (out.length >= MAX_LISTED) break
  }
  return out
}

/** showDashboard()'s answer as the reply may carry it, or null when unreadable. */
function sanitizeShowResult (res) {
  if (!isObject(res)) return null
  const preset = isObject(res.preset)
    ? { id: str(res.preset.id, MAX_ID), name: str(res.preset.name, MAX_TITLE), created: res.preset.created === true }
    : null
  const results = []
  for (const r of Array.isArray(res.results) ? res.results : []) {
    if (!isObject(r)) continue
    const state = STATES.includes(r.state) ? r.state : 'refused'
    const row = { display_id: str(r.display_id, MAX_ID), state }
    if (typeof r.screen === 'string' && r.screen) row.screen = r.screen.slice(0, MAX_ID)
    if (r.error !== undefined && r.error !== null) row.error = String(r.error).slice(0, MAX_ERROR)
    else if (!STATES.includes(r.state)) row.error = `unexpected state ${String(r.state).slice(0, 40)}`
    results.push(row)
    if (results.length >= MAX_LISTED) break
  }
  return { preset, results }
}

/** The policy as `capabilities` publishes it (cloud_dashboards). */
function describePolicy () {
  return {
    version: POLICY_VERSION,
    max_doc_bytes: MAX_DOC_BYTES,
    rate: { shows_per_min: SHOWS_PER_MIN },
    handler_timeout_ms: HANDLER_TIMEOUT_MS,
    request: { boat_id: 'required', deadline_ms: 'required', max_deadline_ahead_ms: MAX_DEADLINE_AHEAD_MS, replay: 'persisted' }
  }
}

function createDashboardPolicy ({
  dir = null, now = Date.now, boatId, fs = fsDefault, debug = () => {},
  showsPerMin = SHOWS_PER_MIN, maxReplayIds = MAX_REPLAY_IDS, maxDocBytes = MAX_DOC_BYTES
} = {}) {
  const guard = createRequestGuard({
    dir, file: REPLAY_FILE, now, boatId, fs, debug, label: 'dashboards',
    maxDeadlineAheadMs: MAX_DEADLINE_AHEAD_MS, retentionMs: REPLAY_RETENTION_MS, maxIds: maxReplayIds
  })
  return {
    inspectRequest: guard.inspectRequest,
    recordRequest: guard.recordRequest,
    checkRequest: guard.checkRequest,
    replaySize: guard.replaySize,
    validateArgs,
    /** '' when the doc fits, else the too_large detail. */
    checkSize: (doc) => {
      const n = docBytes(doc)
      return n <= maxDocBytes ? '' : `doc ${Number.isFinite(n) ? n : '?'} bytes > ${maxDocBytes}`
    },
    admitRate: createRate({ now, perMin: showsPerMin }),
    describe: describePolicy
  }
}

module.exports = {
  POLICY_VERSION, REPLAY_FILE, DISPLAY_MANAGER_KEY, MIN_DISPLAY_MANAGER_VERSION,
  SHOWS_PER_MIN, MAX_DOC_BYTES, HANDLER_TIMEOUT_MS, MAX_DEADLINE_AHEAD_MS, MAX_TARGETS,
  docBytes, validateArgs, isDisplayId, displayManagerFrom, sanitizeDisplays, sanitizeShowResult,
  describePolicy, createDashboardPolicy
}
