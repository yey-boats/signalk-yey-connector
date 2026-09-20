'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { createState } = require('../lib/state')

function tmp () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yey-state-'))
}

test('read of a fresh directory is an empty object, not a throw', () => {
  assert.deepEqual(createState({ dir: tmp() }).read(), {})
})

test('write then read round-trips', () => {
  const s = createState({ dir: tmp() })
  s.write({ boat_id: 'b_1', boat_credential: 'bk_x' })
  assert.equal(s.read().boat_id, 'b_1')
})

test('patch merges without dropping untouched keys', () => {
  const s = createState({ dir: tmp() })
  s.write({ boat_id: 'b_1', boat_credential: 'bk_x' })
  s.patch({ plan_etag: 'deadbeef' })
  const out = s.read()
  assert.equal(out.boat_id, 'b_1')
  assert.equal(out.plan_etag, 'deadbeef')
})

test('a corrupt state file reads as empty rather than crashing the plugin', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'yey-connector-state.json'), '{not json')
  assert.deepEqual(createState({ dir }).read(), {})
})

test('write is atomic — no partial file is ever observable', () => {
  const dir = tmp()
  const s = createState({ dir })
  s.write({ boat_id: 'b_1' })
  // A tmp sibling must not be left behind.
  const left = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(left, [])
})

test('a null dir degrades to memory instead of throwing', () => {
  const s = createState({ dir: null })
  s.write({ boat_id: 'b_mem' })
  assert.equal(s.read().boat_id, 'b_mem')
})

test('an unwritable data directory degrades instead of throwing out of pairing', () => {
  // A full or read-only disk is a degraded plugin, not a dead one — and the
  // credential pairing just obtained must still be usable by the running process.
  const s = createState({
    dir: '/does/not/exist',
    fs: {
      readFileSync: () => { throw new Error('ENOENT') },
      writeFileSync: () => { throw new Error('EROFS') },
      renameSync: () => { throw new Error('EROFS') }
    }
  })
  assert.doesNotThrow(() => s.write({ boat_id: 'b_1' }))
})
