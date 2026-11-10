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

// The state file holds the boat credential: it must not be world-readable on a
// shared SignalK host (#24).
const modeOf = (file) => fs.statSync(file).mode & 0o777

test('the credential file is written owner-only (0600)', { skip: process.platform === 'win32' }, () => {
  const dir = tmp()
  const s = createState({ dir })
  s.write({ boat_id: 'b_1', boat_credential: 'bk_x' })
  assert.equal(modeOf(s.file), 0o600)
})

test('a stale tmp sibling does not leak its looser mode into the credential file', { skip: process.platform === 'win32' }, () => {
  const dir = tmp()
  const s = createState({ dir })
  fs.writeFileSync(`${s.file}.tmp`, '{}', { mode: 0o644 })
  fs.chmodSync(`${s.file}.tmp`, 0o644)
  s.write({ boat_credential: 'bk_x' })
  assert.equal(modeOf(s.file), 0o600)
})

test('an existing world-readable credential file is tightened to 0600 on start', { skip: process.platform === 'win32' }, () => {
  const dir = tmp()
  const file = path.join(dir, 'yey-connector-state.json')
  fs.writeFileSync(file, JSON.stringify({ boat_credential: 'bk_x' }))
  fs.chmodSync(file, 0o644)
  const s = createState({ dir })
  assert.equal(modeOf(file), 0o600)
  assert.equal(s.read().boat_credential, 'bk_x')
})
