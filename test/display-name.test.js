'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  normalizeDisplayName, requireDisplayName, helloField, parseCloudBoat, reconcile, MAX_LEN
} = require('../lib/display-name')
const { buildHello } = require('../lib/hello')

const T0 = '2026-11-08T10:00:00.000Z'
const T1 = '2026-11-08T11:00:00.000Z'

test('a name is trimmed, collapsed, stripped of control characters and clipped', () => {
  assert.equal(normalizeDisplayName('  Sea   Breeze \n'), 'Sea Breeze')
  assert.equal(normalizeDisplayName('Sea\u0000Breeze'), 'SeaBreeze')
  assert.equal(normalizeDisplayName(null), '')
  assert.equal(normalizeDisplayName('x'.repeat(200)).length, MAX_LEN)
  assert.throws(() => requireDisplayName('   '), (e) => e.code === 'invalid_name')
})

test('the hello carries the name only when the owner chose it on this boat', () => {
  assert.equal(helloField({ display_name: 'Sara' }), null, 'from pairing: nobody chose it here')
  assert.equal(helloField({ display_name: '', display_name_set_at: T0 }), null)
  assert.deepEqual(helloField({ display_name: 'Sara', display_name_set_at: T0 }), { value: 'Sara', set_at: T0 })

  const plain = buildHello({ version: '0.3.0' })
  assert.equal('display_name' in plain, false, 'a boat nobody renamed sends the 0.2.0 hello')
  const named = buildHello({ version: '0.3.0', displayName: { value: 'Sara', set_at: T0 } })
  assert.deepEqual(named.display_name, { value: 'Sara', set_at: T0 })
})

test('reply.boat from an older cloud is absent, and a junk one is ignored', () => {
  assert.equal(parseCloudBoat(undefined), null)
  assert.equal(parseCloudBoat({ display_name: '' }), null)
  assert.equal(parseCloudBoat([]), null)
  assert.deepEqual(parseCloudBoat({ display_name: 'Sara', display_name_set_at: 'nonsense' }),
    { display_name: 'Sara', set_at: '', server_ms: null })
})

test('last writer wins: a newer cloud name replaces ours', () => {
  const out = reconcile({ display_name: 'Old', display_name_set_at: T0 },
    { display_name: 'New', set_at: T1 })
  assert.deepEqual(out, { patch: { display_name: 'New', display_name_set_at: T1 }, synced: true })
})

test('last writer wins: our newer rename stands until the cloud takes it', () => {
  const out = reconcile({ display_name: 'Ours', display_name_set_at: T1 },
    { display_name: 'Theirs', set_at: T0 })
  assert.deepEqual(out, { patch: null, synced: false })
})

test('a name nobody chose loses to one somebody chose, on either side', () => {
  // The cloud took the SignalK name at pairing (no set_at); the owner renamed here.
  assert.deepEqual(reconcile({ display_name: 'Ours', display_name_set_at: T0 },
    { display_name: 'From SignalK', set_at: '' }), { patch: null, synced: false })
  // Nothing chosen here: the cloud's name is the name, chosen or not.
  assert.deepEqual(reconcile({ display_name: 'Sara' }, { display_name: 'Renamed', set_at: T0 }),
    { patch: { display_name: 'Renamed', display_name_set_at: T0 }, synced: true })
  assert.deepEqual(reconcile({ display_name: 'Sara' }, { display_name: 'New boat', set_at: '' }),
    { patch: { display_name: 'New boat', display_name_set_at: '' }, synced: true })
})

test('the same name on both sides takes the cloud stamp, so the next hello is a no-op', () => {
  assert.deepEqual(reconcile({ display_name: 'Sara', display_name_set_at: '2099-01-01T00:00:00.000Z' },
    { display_name: 'Sara', set_at: T0 }), { patch: { display_name_set_at: T0 }, synced: true })
  assert.deepEqual(reconcile({ display_name: 'Sara', display_name_set_at: T0 },
    { display_name: 'Sara', set_at: T0 }), { patch: null, synced: true })
})

test('the panel has no key field, and keeps password managers out of its inputs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel', 'PluginConfigurationPanel.js'), 'utf8')
  assert.equal(/yey-key|Key \(only if/.test(src), false, 'the key field is gone: yey.boats connects by link')
  assert.equal(src.includes("'/connect/key'"), false)
  // The link input: not a url/username-looking field, autocomplete off.
  const input = src.slice(src.indexOf("id: 'yey-url'"), src.indexOf("id: 'yey-url'") + 400)
  assert.match(input, /autoComplete: 'off'/)
  assert.match(input, /type: 'text'/)
  assert.match(input, /name: 'yey-connection-link'/)
  assert.match(input, /'data-1p-ignore': 'true'/)
  assert.match(src, /'\/display-name'/, 'the connected view can rename the boat')
})

// The cloud half of the name protocol (navigator bundles/signalk@2026-06-05:
// entrypoint._boat_hello_name, boat_registry "Display name"). Set
// YEY_BUNDLE_PATH to a navigator checkout to enable, as for test/contract.test.js.
// A navigator that predates the protocol is a skip, not a failure: this
// connector works against it (renames stay local, the panel says so), and the
// two repos must be mergeable in either order.
const BUNDLE = process.env.YEY_BUNDLE_PATH

test('the cloud reads hello.display_name and answers reply.boat with the same keys', { skip: !BUNDLE }, (t) => {
  const dir = path.join(BUNDLE, 'bundles/signalk@2026-06-05')
  const ep = fs.readFileSync(path.join(dir, 'entrypoint.py'), 'utf8')
  if (!ep.includes('_boat_hello_name')) {
    t.skip('this navigator predates display-name sync')
    return
  }
  const reg = fs.readFileSync(path.join(dir, 'boat_registry.py'), 'utf8')
  assert.match(ep, /hello\.get\("display_name"\)/, 'the hello handler reads hello.display_name')
  assert.match(ep, /sent\.get\("value"\)/)
  assert.match(ep, /sent\.get\("set_at"\)/)
  assert.match(ep, /\{"boat": boat_view\}/, 'every hello reply carries reply.boat')
  for (const key of ['"display_name"', '"display_name_set_at"', '"server_time"']) {
    assert.ok(reg.includes(key), `boat_name_view names ${key}`)
  }
  const max = reg.match(/^DISPLAY_NAME_MAX\s*=\s*(\d+)/m)
  assert.ok(max, 'boat_registry.DISPLAY_NAME_MAX')
  assert.equal(Number(max[1]), MAX_LEN, 'both sides clip a name to the same width')
})
