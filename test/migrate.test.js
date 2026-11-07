'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { migrateLegacyOptions, LEGACY_DEFAULT_ROUTING } = require('../lib/migrate')
const { createState } = require('../lib/state')
const { createRuntime } = require('../lib/runtime')

const OLD_OPTIONS = {
  enabled: true,
  cloudOrigin: 'https://staging.yey.boats/',
  tenant: 'home',
  project: 'demo',
  bundleId: 'signalk@2026-06-05',
  signalkUrl: 'http://localhost:3000',
  signalkToken: 'sk-token',
  boatId: 'b_old',
  boatCredential: 'bk_oldsecret',
  deny: ['navigation.position'],
  bufferMegabytes: 20
}

function tmpState () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-migrate-'))
  return { dir, state: createState({ dir }) }
}

test('old options move into private state', () => {
  const { state } = tmpState()
  const out = migrateLegacyOptions(OLD_OPTIONS, state)
  assert.equal(out.migrated, true)
  const saved = state.read()
  assert.equal(saved.boat_id, 'b_old')
  assert.equal(saved.boat_credential, 'bk_oldsecret')
  assert.deepEqual(saved.routing, { origin: 'https://staging.yey.boats', tenant: 'home',
    project: 'demo', bundle_id: 'signalk@2026-06-05' })
})

test('the cleaned options carry no routing, token or credential; deny and buffer move under advanced', () => {
  const { state } = tmpState()
  const { cleaned, legacyKeys } = migrateLegacyOptions(OLD_OPTIONS, state)
  assert.deepEqual(cleaned, { enabled: true, advanced: { deny: ['navigation.position'], bufferMegabytes: 20 } })
  for (const k of ['cloudOrigin', 'boatCredential', 'signalkToken', 'deny']) assert.ok(legacyKeys.includes(k), k)
})

test('a boat paired with the old page (state file) and default routing gets the old defaults', () => {
  const { state } = tmpState()
  state.write({ boat_id: 'b_1', boat_credential: 'bk_1' })
  migrateLegacyOptions({ enabled: true }, state)
  assert.deepEqual(state.read().routing, LEGACY_DEFAULT_ROUTING)
})

test('private state wins: an existing boat is not overwritten by old options', () => {
  const { state } = tmpState()
  state.write({ boat_id: 'b_new', boat_credential: 'bk_new', routing: { ...LEGACY_DEFAULT_ROUTING } })
  const out = migrateLegacyOptions(OLD_OPTIONS, state)
  assert.equal(out.migrated, false)
  assert.equal(state.read().boat_id, 'b_new')
  assert.equal(state.read().routing.origin, 'https://yey.boats')
})

test('a fresh install migrates nothing', () => {
  const { state } = tmpState()
  const out = migrateLegacyOptions({ connectionUrl: '' }, state)
  assert.equal(out.migrated, false)
  assert.deepEqual(out.legacyKeys, [])
  assert.deepEqual(state.read(), {})
})

function runtimeWith (dir, options, saves) {
  return createRuntime({
    app: {
      debug: () => {},
      getDataDirPath: () => dir,
      savePluginOptions: (cfg, cb) => { saves.push(cfg); cb(null) }
    },
    version: '0.2.0',
    options,
    deps: {
      createUplink: () => ({ connect: async () => {}, close () {}, setOnLost () {},
        state: () => ({ connected: false }), publish: async () => ({}), request: async () => ({}) }),
      source: { subscribe: () => ({ close () {} }), selfTree: async () => ({}),
        collectMeta: async () => ({}), serverInfo: async () => ({ version: '' }),
        vesselIdentity: async () => ({}) },
      setTimeout: () => 1,
      clearTimeout: () => {}
    }
  })
}

test('an upgraded install keeps working and its options file loses the credential', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-migrate-rt-'))
  const saves = []
  const runtime = runtimeWith(dir, OLD_OPTIONS, saves)
  assert.equal(runtime.cfg.boatId, 'b_old')
  assert.equal(runtime.cfg.boatCredential, 'bk_oldsecret')
  assert.equal(runtime.cfg.cloudOrigin, 'https://staging.yey.boats')
  assert.deepEqual(runtime.cfg.deny, ['navigation.position'])
  assert.equal(runtime.cfg.bufferBytes, 20 * 1024 * 1024)
  assert.equal(saves.length, 1, 'the options file is rewritten once')
  assert.equal(JSON.stringify(saves[0]).includes('bk_oldsecret'), false)
  assert.equal(JSON.stringify(saves[0]).includes('sk-token'), false)
  assert.equal(runtime.snapshot().connection.status, 'connected')
  assert.equal(runtime.snapshot().connection.mode, 'legacy')

  // Next start: the rewritten options, the boat from private state.
  const again = runtimeWith(dir, saves[0], [])
  assert.equal(again.cfg.boatId, 'b_old')
  assert.equal(again.cfg.cloudOrigin, 'https://staging.yey.boats')
})

test('options are left alone when private state cannot be written', () => {
  const saves = []
  // No data dir: state is memory-only, and scrubbing would lose the credential
  // at the next restart.
  const runtime = createRuntime({
    app: { debug: () => {}, savePluginOptions: (cfg, cb) => { saves.push(cfg); cb(null) } },
    version: '0.2.0',
    options: OLD_OPTIONS,
    deps: {
      createUplink: () => ({ connect: async () => {}, close () {}, setOnLost () {},
        state: () => ({ connected: false }), publish: async () => ({}), request: async () => ({}) }),
      source: { subscribe: () => ({ close () {} }) },
      setTimeout: () => 1,
      clearTimeout: () => {}
    }
  })
  assert.equal(runtime.cfg.boatId, 'b_old', 'still runs from the migrated in-memory state')
  assert.equal(saves.length, 0)
})
