'use strict'

/**
 * The remote-steering audit log (#22): one JSON line per `put` the cloud
 * sends, accepted or refused, in the plugin's data dir, owner-only (0600).
 *
 *   {"t":"2026-11-10T09:00:00.000Z","request_id":"rpc_…","path":"steering.autopilot.state",
 *    "value":"auto","outcome":"accepted"}
 *
 * outcome: accepted | refused (with `error`, and `detail` when SignalK gave
 * one) | timeout | dropped (expired or duplicate request, never answered) |
 * auto_off (the runtime switched remote steering off, lib/runtime.js).
 *
 * Size-capped: when the live file would pass `maxBytes` it becomes `.1`,
 * `.1` becomes `.2`, … and the oldest past `keep` is deleted, so the log never
 * holds more than (keep + 1) × maxBytes.
 *
 * `record` is the one entry point. Today lib/rpc.js calls it from trailPut;
 * the single steering policy (#28) is meant to call the same function, so
 * keep it free of rpc details. It never throws: an audit write that fails
 * (read-only data dir, disk full) must not change what happens to the put.
 */

const fsDefault = require('node:fs')
const pathMod = require('node:path')

const AUDIT_FILE = 'yey-steering-audit.jsonl'
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
  const tail = []                    // the last records, for the panel when there is no file

  function rotate () {
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`
      const to = `${file}.${i}`
      try { fs.renameSync(from, to) } catch { /* nothing at that slot yet */ }
    }
    if (keep < 1) { try { fs.unlinkSync(file) } catch { /* already gone */ } }
  }

  function write (line) {
    let size = 0
    try { size = fs.statSync(file).size } catch { size = 0 }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate()
    fs.appendFileSync(file, line, { mode: MODE })
    // `mode` only applies when the file is created; tighten one made earlier.
    fs.chmodSync(file, MODE)
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
      write(JSON.stringify(out) + '\n')
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

  /** The last `n` records, oldest first: from disk (across a rotation), or the
   *  memory tail when there is no data dir. */
  function recent (n = 10) {
    if (!file) return tail.slice(-n)
    let rows = readLines(file)
    for (let i = 1; i <= keep && rows.length < n; i++) rows = readLines(`${file}.${i}`).concat(rows)
    return rows.slice(-n)
  }

  return { record, recent, file }
}

module.exports = { AUDIT_FILE, createSteeringAudit, loggable }
