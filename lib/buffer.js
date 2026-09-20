'use strict'

// ── lib/buffer.js ──
// The offline ring buffer and its backfill draining.
//
// This is the feature that justifies a plugin over the URL+token fallback: it is
// what makes "you were out of signal, here's your track" possible at all. Three
// properties the spec fixes and the tests pin:
//
//   * ascending time on replay, ACROSS lanes, so a backfill never looks shuffled;
//   * `low` dropped before `normal` before `high` when the cap binds;
//   * the plan_id/version a record was captured under travels with it, so a
//     cadence change never reads as a data gap.
//
// One lane file per priority is what makes the eviction rule a truncation rather
// than a rewrite: dropping the head of low.jsonl is one writeFileSync, where a
// single interleaved file would need a scan-and-rebuild to drop by priority.
//
// The clock and the filesystem are INJECTED. Nothing in here calls Date.now on its
// own behalf, so the ageing rule can be exercised in a millisecond and the whole
// module is testable with no boat and no disk.

const fsDefault = require('node:fs')
const path = require('node:path')

// Highest priority first; the eviction walk goes backwards through it.
const LANES = ['high', 'normal', 'low']
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
// boat_plan.TRANSPORT_DEFAULTS["backfill_chunk_msgs"]. Only a fallback: the real
// chunk size is plan-driven and arrives as peek(transport.backfill_chunk_msgs).
const DEFAULT_CHUNK = 100

/** What one record costs on the wire and on disk, in BYTES. `String.length` counts
 *  UTF-16 code units, so a degree sign or a boat named "Ø" would undercount and a
 *  byte cap set in bytes would be quietly exceeded. */
const lineBytes = (record) => Buffer.byteLength(JSON.stringify(record), 'utf8') + 1

function positive (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * createBuffer({ dir, maxBytes, maxAgeMs, fs, now }) → { append, peek, commit, stats, close }
 *
 * Records are JSON lines, one file per priority lane under `<dir>/buffer/`. `peek`
 * is non-destructive and `commit` releases exactly what a peek returned, so a
 * publish that is never acked is retried rather than lost — dropping it on send
 * would be precisely the data loss this buffer exists to prevent.
 *
 * `maxAgeMs <= 0` disables ageing. A falsy `dir`, or a data directory we cannot
 * write, degrades to memory: a boat that cannot buffer must still stream.
 */
function createBuffer ({ dir, maxBytes = DEFAULT_MAX_BYTES,
                         maxAgeMs = DEFAULT_MAX_AGE_MS,
                         fs = fsDefault, now = Date.now } = {}) {
  const capBytes = positive(maxBytes, DEFAULT_MAX_BYTES)
  const capAgeMs = Number.isFinite(Number(maxAgeMs)) ? Math.max(0, Number(maxAgeMs))
    : DEFAULT_MAX_AGE_MS
  const memory = { high: [], normal: [], low: [] }

  let root = dir ? path.join(dir, 'buffer') : null
  let dropped = 0
  let writeErrors = 0

  if (root) {
    try {
      fs.mkdirSync(root, { recursive: true })
    } catch {
      // An unwritable data directory is a degraded plugin, not a dead one.
      root = null
    }
  }

  const laneFile = (lane) => path.join(root, `${lane}.jsonl`)

  function loadLane (lane) {
    if (!root) return memory[lane].slice()
    let raw = ''
    try {
      raw = fs.readFileSync(laneFile(lane), 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of String(raw).split('\n')) {
      if (!line) continue
      try {
        const rec = JSON.parse(line)
        if (rec && typeof rec === 'object' && !Array.isArray(rec)) out.push(rec)
      } catch {
        // One bad line — a half-written tail after a power cut — must not cost
        // the whole lane.
      }
    }
    return out
  }

  function storeLane (lane, records) {
    if (!root) { memory[lane] = records; return }
    const body = records.map((r) => JSON.stringify(r)).join('\n')
    try {
      fs.writeFileSync(laneFile(lane), body ? `${body}\n` : '')
    } catch {
      // A full or read-only disk must not throw out of a delta handler. Count it
      // so the plugin screen can say so, and keep running.
      writeErrors += 1
    }
  }

  const loadAll = () => {
    const lanes = {}
    for (const lane of LANES) lanes[lane] = loadLane(lane)
    return lanes
  }

  const sizeOf = (records) => records.reduce((sum, r) => sum + lineBytes(r), 0)

  /** Age first, then size. Mutates `lanes`; returns the lanes that changed, so an
   *  append rewrites one file in the common case instead of all three. */
  function evict (lanes) {
    const dirty = new Set()

    // Age first: an old sample is worthless regardless of priority.
    if (capAgeMs > 0) {
      const cutoff = now() - capAgeMs
      for (const lane of LANES) {
        const before = lanes[lane].length
        lanes[lane] = lanes[lane].filter((r) => Number(r.t) >= cutoff)
        const gone = before - lanes[lane].length
        if (gone) { dropped += gone; dirty.add(lane) }
      }
    }

    // Then size, shedding whole lanes from the bottom up and oldest-first within a
    // lane. LANES is highest-first, so walk it backwards: low goes before normal,
    // normal before high.
    let total = LANES.reduce((sum, lane) => sum + sizeOf(lanes[lane]), 0)
    for (let i = LANES.length - 1; i >= 0 && total > capBytes; i--) {
      const lane = LANES[i]
      while (lanes[lane].length && total > capBytes) {
        total -= lineBytes(lanes[lane].shift())
        dropped += 1
        dirty.add(lane)
      }
    }

    return dirty
  }

  /** Append one record. Returns the stored record, with `t` resolved. */
  function append (record) {
    const rec = { ...record }
    const t = Number(rec.t)
    // NOT `Number(rec.t) || now()`: a legitimate t of 0 is falsy, and against a
    // frozen or offset clock that silently re-stamps the record.
    rec.t = Number.isFinite(t) ? t : now()
    const lane = LANES.includes(rec.priority) ? rec.priority : 'normal'

    const lanes = loadAll()
    lanes[lane].push(rec)
    const dirty = evict(lanes)
    dirty.add(lane)
    for (const name of dirty) storeLane(name, lanes[name])
    return rec
  }

  /** The next `limit` records in ascending time across all lanes, plus the cursor
   *  that commits exactly them. Non-destructive: nothing is released until the
   *  cloud has acked it. */
  function peek (limit = DEFAULT_CHUNK) {
    const want = positive(Math.floor(Number(limit)), DEFAULT_CHUNK)
    const heads = loadAll()
    const picked = []
    const cursor = { high: 0, normal: 0, low: 0 }

    while (picked.length < want) {
      let bestLane = null
      let bestT = 0
      for (const lane of LANES) {
        const next = heads[lane][cursor[lane]]
        if (!next) continue
        const t = Number(next.t)
        // A tie keeps the higher-priority lane, because LANES is walked in order.
        if (bestLane === null || t < bestT) { bestLane = lane; bestT = t }
      }
      if (bestLane === null) break
      picked.push(heads[bestLane][cursor[bestLane]])
      cursor[bestLane] += 1
    }

    return { records: picked, cursor }
  }

  /** Release exactly the records a matching peek returned. A cursor we cannot make
   *  sense of releases nothing — re-sending a chunk costs airtime, dropping one
   *  costs the track. */
  function commit (cursor) {
    if (!cursor || typeof cursor !== 'object') return
    for (const lane of LANES) {
      const raw = Math.floor(Number(cursor[lane]))
      const take = Number.isFinite(raw) && raw > 0 ? raw : 0
      if (!take) continue
      storeLane(lane, loadLane(lane).slice(take))
    }
  }

  function stats () {
    const lanes = {}
    let bytes = 0
    let count = 0
    let oldest = null
    let newest = null
    for (const lane of LANES) {
      const records = loadLane(lane)
      lanes[lane] = records.length
      count += records.length
      bytes += sizeOf(records)
      // Not records[0]: a lane is append-ordered, and the caller supplies `t`.
      for (const r of records) {
        const t = Number(r.t)
        if (!Number.isFinite(t)) continue
        if (oldest === null || t < oldest) oldest = t
        if (newest === null || t > newest) newest = t
      }
    }
    return {
      count,
      bytes,
      lanes,
      dropped,
      write_errors: writeErrors,
      oldest_t: oldest,
      newest_t: newest,
      max_bytes: capBytes,
      max_age_ms: capAgeMs,
      persistent: Boolean(root)
    }
  }

  return { append, peek, commit, stats, close: () => {}, LANES }
}

module.exports = { LANES, DEFAULT_MAX_BYTES, DEFAULT_MAX_AGE_MS, DEFAULT_CHUNK, createBuffer }
