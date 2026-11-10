'use strict'

/**
 * The remote-steering audit log (#22): one JSON line per `put` the cloud
 * sends, accepted or refused, in the plugin's data dir, owner-only (0600).
 *
 *   {"t":"2026-11-10T09:00:00.000Z","request_id":"rpc_…","path":"steering.autopilot.state",
 *    "value":"auto","outcome":"accepted"}
 *
 * outcome: accepted | refused (with `error`, and `detail`: what SignalK said,
 * or the steering policy's reason — value_not_allowed, value_out_of_range,
 * value_type, value_missing, boat_id_missing, boat_id_unknown,
 * deadline_missing, deadline_too_far, replay_store_full) | timeout | dropped
 * (`error` expired, duplicate, foreign_boat, bad_schema or bad_id; never
 * answered) | a second accepted/refused line with `detail` after_timeout when a
 * timed-out put finally settles |
 * auto_off (the runtime switched remote steering off, lib/runtime.js) |
 * suppressed (lib/rpc.js: more non-accepted puts than the per-minute cap;
 * `detail` is `n=<count>` for the window).
 *
 * Two files, each size-capped on its own (#33): what HAPPENED (accepted,
 * timeout, auto_off, and the late outcome of a timed-out put) in
 * yey-steering-audit.jsonl, and what did not (refused, dropped, suppressed) in
 * yey-steering-refusals.jsonl, so no flood of refusals, however long, can
 * rotate an accepted command out of the log. When a live file would pass
 * `maxBytes` it becomes `.1`, `.1` becomes `.2`, … and the oldest past `keep`
 * is deleted, so each log never holds more than (keep + 1) × maxBytes.
 *
 * `record` is the one entry point. Today lib/rpc.js calls it from trailPut;
 * the single steering policy (#28) is meant to call the same function, so
 * keep it free of rpc details. It never throws: an audit write that fails
 * (read-only data dir, disk full) must not change what happens to the put.
 */

const fsDefault = require('node:fs')
const pathMod = require('node:path')

const AUDIT_FILE = 'yey-steering-audit.jsonl'
const REFUSALS_FILE = 'yey-steering-refusals.jsonl'
// Outcomes that go to AUDIT_FILE; everything else goes to REFUSALS_FILE.
const KEPT_OUTCOMES = Object.freeze(['accepted', 'timeout', 'auto_off'])
const MODE = 0o600
const MAX_STRING = 64
const MEMORY_TAIL = 50

/** A put value as it may be logged: a JSON scalar, a capped string, or its type. */
function loggable (v) {
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v === 'string') return v.slice(0, MAX_STRING)
  return v === undefined ? null : typeof v
}

function createSteeringAudit ({
  dir, now = Date.now, maxBytes = 256 * 1024, keep = 3, debug = () => {}, fs = fsDefault
} = {}) {
  const file = dir ? pathMod.join(dir, AUDIT_FILE) : null
  const refusalsFile = dir ? pathMod.join(dir, REFUSALS_FILE) : null
  const tail = []                    // the last records, for the panel when there is no file

  function rotate (name) {
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? name : `${name}.${i - 1}`
      const to = `${name}.${i}`
      try { fs.renameSync(from, to) } catch { /* nothing at that slot yet */ }
    }
    if (keep < 1) { try { fs.unlinkSync(name) } catch { /* already gone */ } }
  }

  function write (name, line) {
    let size = 0
    try { size = fs.statSync(name).size } catch { size = 0 }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate(name)
    fs.appendFileSync(name, line, { mode: MODE })
    // `mode` only applies when the file is created; tighten one made earlier.
    fs.chmodSync(name, MODE)
  }

  /** Which file a record belongs in: what happened, or what did not. */
  function fileFor (out) {
    const lateOutcome = typeof out.detail === 'string' && out.detail.startsWith('after_timeout')
    return (KEPT_OUTCOMES.includes(out.outcome) || lateOutcome) ? file : refusalsFile
  }

  function record (entry) {
    const e = entry || {}
    const out = { t: new Date(now()).toISOString() }
    if (e.request_id) out.request_id = String(e.request_id).slice(0, 80)
    out.path = typeof e.path === 'string' ? e.path.slice(0, 120) : null
    if ('value' in e) out.value = loggable(e.value)
    out.outcome = String(e.outcome || 'refused')
    if (e.error) out.error = String(e.error).slice(0, 60)
    if (e.detail) out.detail = String(e.detail).slice(0, 120)
    tail.push(out)
    while (tail.length > MEMORY_TAIL) tail.shift()
    if (!file) return out
    try {
      write(fileFor(out), JSON.stringify(out) + '\n')
    } catch (err) {
      debug(`yey connector: steering audit not written (${(err && err.code) || (err && err.message)})`)
    }
    return out
  }

  function readLines (name) {
    try {
      return fs.readFileSync(name, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }
  }

  /** The last `n` rows of one log, oldest first, across its rotation. */
  function lastOf (name, n) {
    let rows = readLines(name)
    for (let i = 1; i <= keep && rows.length < n; i++) rows = readLines(`${name}.${i}`).concat(rows)
    return rows.slice(-n)
  }

  /** The last `n` records of both logs, oldest first: from disk (across a
   *  rotation), or the memory tail when there is no data dir. */
  function recent (n = 10) {
    if (!file) return tail.slice(-n)
    const rows = lastOf(file, n).concat(lastOf(refusalsFile, n))
    // Stable: records with the same time keep their per-file order.
    rows.sort((a, b) => String(a.t).localeCompare(String(b.t)))
    return rows.slice(-n)
  }

  return { record, recent, file, refusalsFile }
}

module.exports = { AUDIT_FILE, REFUSALS_FILE, KEPT_OUTCOMES, createSteeringAudit, loggable }
