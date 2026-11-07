'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { extractIdentity, normalizeIdentity, IDENTITY_KEYS } = require('../lib/identity')

// The shape signalk-server keeps under vessels/self: static strings on the
// vessel object, design.* as value nodes.
const TREE = {
  name: 'Sara',
  mmsi: '238123456',
  communication: { callsignVhf: '9A1234' },
  design: {
    aisShipType: { value: { id: 36, name: 'Sailing' }, $source: 'defaults', timestamp: 't' },
    length: { value: { overall: 12.4, hull: 11.9 }, $source: 'defaults' },
    beam: { value: 4.1, $source: 'defaults' },
    draft: { value: { maximum: 2.05, current: 1.9 }, $source: 'defaults' }
  },
  navigation: { speedOverGround: { value: 3.2 } }
}

test('every identity field is read from vessels/self', () => {
  assert.deepEqual(extractIdentity(TREE), {
    name: 'Sara', mmsi: '238123456', callsign: '9A1234', type: 'Sailing',
    length_m: 12.4, beam_m: 4.1, draft_m: 2.05
  })
})

test('values wrapped as {value} are read too', () => {
  const out = extractIdentity({
    name: { value: 'Sara' }, mmsi: { value: '238123456' },
    communication: { callsignVhf: { value: '9A1234' } },
    design: { aisShipType: { value: 'Sailing' }, draft: { value: { current: 1.9 } } }
  })
  assert.equal(out.name, 'Sara')
  assert.equal(out.callsign, '9A1234')
  assert.equal(out.type, 'Sailing')
  assert.equal(out.draft_m, 1.9)
})

test('a server that knows nothing gives every key as null', () => {
  const out = extractIdentity({})
  assert.deepEqual(Object.keys(out), IDENTITY_KEYS)
  assert.ok(Object.values(out).every((v) => v === null))
  assert.deepEqual(extractIdentity(null), out)
})

test('nonsense dimensions are not invented', () => {
  const out = extractIdentity({ design: { length: { value: { overall: -1 } }, beam: { value: 'wide' } } })
  assert.equal(out.length_m, null)
  assert.equal(out.beam_m, null)
})

test('the confirmed identity is cleaned up: blanks to null, numbers parsed', () => {
  assert.deepEqual(normalizeIdentity({
    name: ' Sara ', mmsi: '', callsign: '9A1234', type: 'Sailing',
    length_m: '12.4', beam_m: '', draft_m: 2, extra: 'dropped'
  }), {
    name: 'Sara', callsign: '9A1234', type: 'Sailing', mmsi: null,
    length_m: 12.4, beam_m: null, draft_m: 2
  })
})

test('a wrong MMSI or dimension is refused with invalid_identity', () => {
  assert.throws(() => normalizeIdentity({ mmsi: '12345' }), (e) => e.code === 'invalid_identity')
  assert.throws(() => normalizeIdentity({ length_m: 'long' }), (e) => e.code === 'invalid_identity')
  assert.throws(() => normalizeIdentity({ draft_m: -2 }), (e) => e.code === 'invalid_identity')
})
