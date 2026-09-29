'use strict'
/** lib/buffer.js's in-memory mode, with O(1) bookkeeping.
 *
 *  The real buffer, even with no directory, re-reads every lane, re-sums every
 *  record's byte size and re-filters every lane for age on EVERY append
 *  (lib/buffer.js append -> loadAll -> evict -> sizeOf). That is the right
 *  trade on a boat, where a lane file is the durable truth; for a rig holding
 *  250 boats x 24 hours of samples it is O(n^2) and would never finish.
 *
 *  Same interface, same observable behaviour for the rig's workload — records
 *  appended with a non-decreasing `t` (the runtime stamps t = now()) — and
 *  test/loadrig.test.js checks that claim by driving this and lib/buffer.js
 *  through the same random operation sequence and comparing every result.
 *  With non-monotonic `t` the age rule here trims only from the head of a lane,
 *  where the real one filters the whole lane; the rig never does that.
 */
const LANES = ['high', 'normal', 'low']
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_CHUNK = 100

const lineBytes = (record) => Buffer.byteLength(JSON.stringify(record), 'utf8') + 1

function positive (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function createMemBuffer ({ maxBytes = DEFAULT_MAX_BYTES, maxAgeMs = DEFAULT_MAX_AGE_MS,
                            now = Date.now } = {}) {
  const capBytes = positive(maxBytes, DEFAULT_MAX_BYTES)
  const capAgeMs = Number.isFinite(Number(maxAgeMs)) ? Math.max(0, Number(maxAgeMs))
    : DEFAULT_MAX_AGE_MS
  // Per lane: records[], head index, parallel sizes[], live byte total.
  const lanes = {}
  for (const lane of LANES) lanes[lane] = { recs: [], sizes: [], head: 0, bytes: 0 }
  let total = 0
  let dropped = 0

  const size = (L) => L.recs.length - L.head

  function shiftHead (L) {
    const b = L.sizes[L.head]
    L.recs[L.head] = undefined
    L.head += 1
    L.bytes -= b
    total -= b
    if (L.head > 4096 && L.head * 2 > L.recs.length) {
      L.recs = L.recs.slice(L.head)
      L.sizes = L.sizes.slice(L.head)
      L.head = 0
    }
  }

  function evict () {
    if (capAgeMs > 0) {
      const cutoff = now() - capAgeMs
      for (const lane of LANES) {
        const L = lanes[lane]
        while (size(L) && !(Number(L.recs[L.head].t) >= cutoff)) { shiftHead(L); dropped += 1 }
      }
    }
    for (let i = LANES.length - 1; i >= 0 && total > capBytes; i--) {
      const L = lanes[LANES[i]]
      while (size(L) && total > capBytes) { shiftHead(L); dropped += 1 }
    }
  }

  function append (record) {
    const rec = { ...record }
    const t = Number(rec.t)
    rec.t = Number.isFinite(t) ? t : now()
    const lane = LANES.includes(rec.priority) ? rec.priority : 'normal'
    const L = lanes[lane]
    const b = lineBytes(rec)
    L.recs.push(rec)
    L.sizes.push(b)
    L.bytes += b
    total += b
    evict()
    return rec
  }

  function peek (limit = DEFAULT_CHUNK) {
    const want = positive(Math.floor(Number(limit)), DEFAULT_CHUNK)
    const picked = []
    const cursor = { high: 0, normal: 0, low: 0 }
    while (picked.length < want) {
      let bestLane = null
      let bestT = 0
      for (const lane of LANES) {
        const L = lanes[lane]
        const i = L.head + cursor[lane]
        if (i >= L.recs.length) continue
        const tt = Number(L.recs[i].t)
        if (bestLane === null || tt < bestT) { bestLane = lane; bestT = tt }
      }
      if (bestLane === null) break
      const L = lanes[bestLane]
      picked.push(L.recs[L.head + cursor[bestLane]])
      cursor[bestLane] += 1
    }
    return { records: picked, cursor }
  }

  function commit (cursor) {
    if (!cursor || typeof cursor !== 'object') return
    for (const lane of LANES) {
      const raw = Math.floor(Number(cursor[lane]))
      let take = Number.isFinite(raw) && raw > 0 ? raw : 0
      const L = lanes[lane]
      while (take-- > 0 && size(L)) shiftHead(L)
    }
  }

  function stats () {
    const counts = {}
    let count = 0
    let oldest = null
    let newest = null
    for (const lane of LANES) {
      const L = lanes[lane]
      counts[lane] = size(L)
      count += size(L)
      if (size(L)) {
        const a = Number(L.recs[L.head].t)
        const z = Number(L.recs[L.recs.length - 1].t)
        if (oldest === null || a < oldest) oldest = a
        if (newest === null || z > newest) newest = z
      }
    }
    return { count, bytes: total, lanes: counts, dropped, write_errors: 0,
             oldest_t: oldest, newest_t: newest, max_bytes: capBytes,
             max_age_ms: capAgeMs, persistent: false }
  }

  return { append, peek, commit, stats, close: () => {}, LANES }
}

module.exports = { createMemBuffer }
