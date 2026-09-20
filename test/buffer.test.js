'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { createBuffer, LANES, DEFAULT_CHUNK } = require('../lib/buffer')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yey-buf-'))

function rec (t, priority, extra = {}) {
  return { t, priority, path: 'navigation.position', value: t,
           plan_id: 'pl_1', plan_version: 12, ...extra }
}

/**
 * Every record in this file carries a small, readable `t` — 1, 10, 20, 100+i — so
 * the expectations read as sequences rather than as epoch arithmetic. Age eviction
 * compares `t` against `now() - maxAgeMs`, so against the real `Date.now` and the
 * 24h default EVERY one of those records is already ~56 years stale and is evicted
 * on the append that put it there: the plan's first cut of this suite failed 13 of
 * its 16 tests that way, all of them reporting `count: 0`. So the buffer under test
 * gets a clock FROZEN AT 0, which puts the cutoff at -86_400_000 and ages nothing
 * out unless a test asks for it. The two tests that ARE about ageing or about the
 * clock pass their own `now` through the same helper, and the spread lets them win.
 *
 * This is the harness being honest about its own units, not an assertion bent to
 * fit the code: no expected VALUE changes.
 */
const mk = (opts = {}) => createBuffer({ now: () => 0, ...opts })

test('three lanes, highest priority first', () => {
  assert.deepEqual(LANES, ['high', 'normal', 'low'])
})

test('append then peek returns what went in', () => {
  const b = mk({ dir: tmp() })
  b.append(rec(1, 'high'))
  const batch = b.peek(10)
  assert.equal(batch.records.length, 1)
  assert.equal(batch.records[0].t, 1)
  assert.equal(batch.records[0].plan_version, 12)
})

test('peek merges lanes in ascending time, not lane order', () => {
  const b = mk({ dir: tmp() })
  b.append(rec(30, 'high'))
  b.append(rec(10, 'low'))
  b.append(rec(20, 'normal'))
  assert.deepEqual(b.peek(10).records.map((r) => r.t), [10, 20, 30])
})

test('peek honours the chunk size', () => {
  const b = mk({ dir: tmp() })
  for (let i = 0; i < 10; i++) b.append(rec(i, 'normal'))
  assert.equal(b.peek(4).records.length, 4)
})

test('peek is non-destructive until commit', () => {
  const b = mk({ dir: tmp() })
  b.append(rec(1, 'high'))
  const first = b.peek(10)
  assert.equal(b.peek(10).records.length, 1)
  b.commit(first.cursor)
  assert.equal(b.peek(10).records.length, 0)
})

test('commit of one chunk leaves the rest', () => {
  const b = mk({ dir: tmp() })
  for (let i = 0; i < 5; i++) b.append(rec(i, 'normal'))
  const batch = b.peek(2)
  b.commit(batch.cursor)
  assert.deepEqual(b.peek(10).records.map((r) => r.t), [2, 3, 4])
})

test('committed records survive a restart as committed', () => {
  const dir = tmp()
  const a = mk({ dir })
  for (let i = 0; i < 4; i++) a.append(rec(i, 'normal'))
  a.commit(a.peek(2).cursor)
  a.close()
  const b = mk({ dir })
  assert.deepEqual(b.peek(10).records.map((r) => r.t), [2, 3])
})

test('uncommitted records survive a restart — this is the whole point', () => {
  const dir = tmp()
  const a = mk({ dir })
  a.append(rec(1, 'high'))
  a.append(rec(2, 'high'))
  a.close()
  assert.deepEqual(mk({ dir }).peek(10).records.map((r) => r.t), [1, 2])
})

test('the byte cap drops low before normal before high', () => {
  const b = mk({ dir: tmp(), maxBytes: 900 })
  for (let i = 0; i < 6; i++) b.append(rec(i, 'low'))
  for (let i = 0; i < 6; i++) b.append(rec(100 + i, 'normal'))
  for (let i = 0; i < 6; i++) b.append(rec(200 + i, 'high'))
  const s = b.stats()
  assert.ok(s.bytes <= 900, `cap not enforced: ${s.bytes}`)
  assert.equal(s.lanes.high, 6, 'high must be the last thing dropped')
  assert.ok(s.lanes.low < 6, 'low must be shed first')
  assert.ok(s.dropped > 0)
})

test('the byte cap drops the OLDEST of a lane, not the newest', () => {
  const b = mk({ dir: tmp(), maxBytes: 400 })
  for (let i = 0; i < 20; i++) b.append(rec(i, 'low'))
  const kept = b.peek(100).records.map((r) => r.t)
  assert.ok(kept.length > 0)
  assert.ok(kept[kept.length - 1] === 19, 'the newest sample must survive')
  assert.ok(kept[0] > 0, 'the oldest must be the one that went')
})

test('records older than maxAge are evicted on append', () => {
  let clock = 0
  const b = mk({ dir: tmp(), maxAgeMs: 1000, now: () => clock })
  b.append(rec(0, 'high'))
  clock = 5000
  b.append(rec(5000, 'high'))
  assert.deepEqual(b.peek(10).records.map((r) => r.t), [5000])
})

test('a record carries the plan it was captured under across a cadence change', () => {
  /* spec: "backfill is labelled with the plan_id/version it was captured under,
     so a cadence change never looks like a data gap." */
  const b = mk({ dir: tmp() })
  b.append(rec(1, 'high', { plan_version: 12 }))
  b.append(rec(2, 'high', { plan_version: 13 }))
  assert.deepEqual(b.peek(10).records.map((r) => r.plan_version), [12, 13])
})

test('stats describe the buffer well enough for the plugin screen', () => {
  const b = mk({ dir: tmp() })
  b.append(rec(1, 'high'))
  b.append(rec(2, 'low'))
  const s = b.stats()
  assert.equal(s.count, 2)
  assert.ok(s.bytes > 0)
  assert.deepEqual(Object.keys(s.lanes).sort(), ['high', 'low', 'normal'])
  assert.equal(s.oldest_t, 1)
})

test('an empty buffer reports zeroes rather than NaN', () => {
  const s = mk({ dir: tmp() }).stats()
  assert.equal(s.count, 0)
  assert.equal(s.bytes, 0)
  assert.equal(s.oldest_t, null)
})

test('a corrupt lane line is skipped, the rest of the lane survives', () => {
  const dir = tmp()
  const b = mk({ dir })
  b.append(rec(1, 'high'))
  fs.appendFileSync(path.join(dir, 'buffer', 'high.jsonl'), '{not json\n')
  b.append(rec(3, 'high'))
  assert.deepEqual(mk({ dir }).peek(10).records.map((r) => r.t), [1, 3])
})

test('a null dir degrades to memory so the plugin still runs', () => {
  const b = mk({ dir: null })
  b.append(rec(1, 'high'))
  assert.equal(b.peek(10).records.length, 1)
})

// ── beyond the plan ──────────────────────────────────────────────────────────

test('a t of zero is a timestamp, not a missing one', () => {
  /* `Number(rec.t) || now()` re-stamps a legitimate t of 0. Against the runtime's
     injected clock — which a supervisor test or a replay can freeze or offset —
     that silently rewrites the oldest record in the buffer. */
  const b = mk({ dir: tmp(), now: () => 999 })
  assert.equal(b.append(rec(0, 'high')).t, 0)
  assert.equal(b.peek(10).records[0].t, 0)
})

test('a record with no usable t is stamped with the injected clock', () => {
  const b = mk({ dir: tmp(), now: () => 4242 })
  assert.equal(b.append({ priority: 'high', p: 'a', v: 1 }).t, 4242)
  assert.equal(b.append({ t: 'not a time', priority: 'high' }).t, 4242)
})

test('the byte cap counts UTF-8 bytes, not UTF-16 code units', () => {
  /* maxBytes is a byte budget on a metered link. `String.length` undercounts every
     non-ASCII character — a wind reading in ° or a boat named Sørlandet — so a cap
     measured that way is quietly exceeded. */
  const b = mk({ dir: tmp() })
  const stored = b.append({ t: 1, priority: 'high', p: 'environment.wind',
                            v: 'ø° — 15 kn', vessel: 'Sørlandet' })
  const line = JSON.stringify(stored)
  assert.equal(b.stats().bytes, Buffer.byteLength(line, 'utf8') + 1)
  assert.ok(b.stats().bytes > line.length + 1, 'the sample must actually be multi-byte')
})

test('peek with no chunk size returns a bounded default, not nothing', () => {
  const b = mk({ dir: tmp() })
  for (let i = 0; i < DEFAULT_CHUNK + 20; i++) b.append(rec(i + 1, 'normal'))
  assert.equal(b.peek().records.length, DEFAULT_CHUNK)
  assert.equal(b.peek('nonsense').records.length, DEFAULT_CHUNK)
})

test('a cursor that makes no sense releases nothing', () => {
  /* Re-sending a chunk costs airtime; dropping one costs the track. */
  const b = mk({ dir: tmp() })
  for (let i = 0; i < 3; i++) b.append(rec(i + 1, 'normal'))
  b.commit(undefined)
  b.commit(null)
  b.commit({ normal: 'two' })
  b.commit({ normal: -5 })
  assert.equal(b.peek(10).records.length, 3)
})

test('an unknown priority lands in the normal lane rather than vanishing', () => {
  const b = mk({ dir: tmp() })
  b.append(rec(1, 'urgent'))
  b.append(rec(2, undefined))
  const s = b.stats()
  assert.equal(s.lanes.normal, 2)
  assert.equal(s.count, 2)
})

test('oldest_t is the oldest record, even when a lane arrived out of order', () => {
  /* A lane is append-ordered and `t` is supplied by the caller, so the head of the
     lane is not necessarily its oldest record: a delta that arrives late carries an
     earlier timestamp. The plugin screen says "buffered since …" from this. */
  const b = mk({ dir: tmp() })
  b.append(rec(50, 'normal'))
  b.append(rec(5, 'normal'))
  b.append(rec(90, 'low'))
  const s = b.stats()
  assert.equal(s.oldest_t, 5)
  assert.equal(s.newest_t, 90)
})

test('an unwritable data directory degrades to memory instead of crashing', () => {
  /* app.getDataDirPath() on a read-only or full boat disk must not take the plugin
     down: a boat that cannot buffer must still stream. */
  const badFs = {
    mkdirSync () { throw new Error('EACCES: permission denied') },
    readFileSync () { throw new Error('EACCES: permission denied') },
    writeFileSync () { throw new Error('EACCES: permission denied') }
  }
  const b = createBuffer({ dir: '/definitely/not/writable', fs: badFs, now: () => 0 })
  b.append(rec(1, 'high'))
  assert.equal(b.peek(10).records.length, 1)
  assert.equal(b.stats().persistent, false)
})

test('a failed write is counted, not thrown out of the delta handler', () => {
  const fullDisk = {
    mkdirSync () {},
    readFileSync () { throw new Error('ENOENT') },
    writeFileSync () { throw new Error('ENOSPC: no space left on device') }
  }
  const b = createBuffer({ dir: '/full', fs: fullDisk, now: () => 0 })
  assert.doesNotThrow(() => b.append(rec(1, 'high')))
  assert.ok(b.stats().write_errors > 0)
  assert.equal(b.stats().persistent, true)
})
