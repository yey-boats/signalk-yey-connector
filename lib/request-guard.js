'use strict'

/**
 * The envelope checks every inbound WRITE request gets (remote steering `put`,
 * lib/steering-policy.js; cloud dashboards `show_dashboard`,
 * lib/dashboard-policy.js), with an on-disk replay memory:
 *
 *   boat_id     REQUIRED, a string, equal to this boat (another boat's request
 *               is dropped, never answered);
 *   deadline_ms REQUIRED, not past (dropped `expired`), and at most
 *               `maxDeadlineAheadMs` ahead (refused `deadline_too_far`: a
 *               far-future deadline would let a stale request through, and
 *               outlive the replay window);
 *   id          never seen before: remembered until its deadline +
 *               `retentionMs`, in a 0600 file in the plugin data dir, so a
 *               replay is dropped across restarts. The store is bounded; full
 *               of live ids, the request is refused (fail closed).
 *
 * Each write op owns its own guard (its own file), so a flood of one kind can
 * never fill the other's store.
 */

const fsDefault = require('node:fs')
const pathMod = require('node:path')

const MODE = 0o600

function createRequestGuard ({
  dir = null, file: fileName, now = Date.now, boatId, fs = fsDefault, debug = () => {},
  maxDeadlineAheadMs, retentionMs, maxIds, label = 'replay'
} = {}) {
  const file = dir && fileName ? pathMod.join(dir, fileName) : null
  const replay = new Map()     // id -> keep-until (ms)

  if (file) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const [id, until] of (doc && Array.isArray(doc.ids)) ? doc.ids : []) {
        if (typeof id === 'string' && Number.isFinite(until)) replay.set(id, until)
      }
    } catch { /* missing or corrupt: start empty */ }
  }

  function persist () {
    if (!file) return
    try {
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, ids: [...replay] }), { mode: MODE })
      try { fs.chmodSync(tmp, MODE) } catch { /* best effort */ }
      fs.renameSync(tmp, file)
      try { fs.chmodSync(file, MODE) } catch { /* best effort */ }
    } catch (err) {
      debug(`yey connector: ${label} replay store not saved (${err && err.message})`)
    }
  }

  function prune (t) {
    for (const [id, until] of replay) if (until < t) replay.delete(id)
  }

  const me = () => {
    try { return String((typeof boatId === 'function' ? boatId() : boatId) || '') } catch { return '' }
  }

  /**
   * The envelope, without recording anything. {} to go on; {drop: why} when
   * nobody is waiting for an answer (expired, a replay, another boat's
   * request); {refuse: why} to answer bad_request.
   */
  function inspectRequest ({ id, boat_id: bid, deadline_ms: deadline } = {}) {
    const t = now()
    if (bid === undefined || bid === null || bid === '') return { refuse: 'boat_id_missing' }
    if (typeof bid !== 'string') return { refuse: 'boat_id_type' }
    const mine = me()
    if (!mine) return { refuse: 'boat_id_unknown' }
    if (bid !== mine) return { drop: 'foreign_boat' }
    const d = typeof deadline === 'number' ? deadline : NaN
    if (!Number.isFinite(d) || d <= 0) return { refuse: 'deadline_missing' }
    if (t > d) return { drop: 'expired' }
    if (d - t > maxDeadlineAheadMs) return { refuse: 'deadline_too_far' }
    const key = String(id || '')
    prune(t)
    if (replay.has(key)) return { drop: 'duplicate' }
    return {}
  }

  /** Remember the id of a request that passed inspectRequest (and the rate).
   *  {} when recorded, {refuse: 'replay_store_full'} when the store is full of
   *  live ids (fail closed), {drop: 'duplicate'} when it is already there. */
  function recordRequest ({ id, deadline_ms: deadline } = {}) {
    const key = String(id || '')
    prune(now())
    if (replay.has(key)) return { drop: 'duplicate' }
    if (replay.size >= maxIds) return { refuse: 'replay_store_full' }
    replay.set(key, deadline + retentionMs)
    persist()
    return {}
  }

  /** inspectRequest then recordRequest, in one step. */
  function checkRequest (req = {}) {
    const verdict = inspectRequest(req)
    return (verdict.drop || verdict.refuse) ? verdict : recordRequest(req)
  }

  return { inspectRequest, recordRequest, checkRequest, replaySize: () => replay.size }
}

/** A per-minute sliding-window counter: admit() true while under `perMin`. */
function createRate ({ now = Date.now, perMin }) {
  const recent = []
  return function admit () {
    const t = now()
    while (recent.length && t - recent[0] >= 60000) recent.shift()
    if (recent.length >= perMin) return false
    recent.push(t)
    return true
  }
}

module.exports = { createRequestGuard, createRate }
