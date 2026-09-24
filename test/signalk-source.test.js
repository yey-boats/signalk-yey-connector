'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { createHttpSource, ROOT, API } = require('../lib/signalk-source')

/** A fetch stand-in: a map of suffix -> body, everything else a 404. */
function fakeFetch (bodies) {
  const seen = []
  const impl = async (url, init) => {
    seen.push({ url, headers: (init || {}).headers || {} })
    const suffix = url.replace(/^http:\/\/boat:3000/, '')
    if (!(suffix in bodies)) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => bodies[suffix] }
  }
  impl.seen = seen
  return impl
}

const BASE = 'http://boat:3000'

test('serverInfo reads the unauthenticated discovery document', async () => {
  const fetchImpl = fakeFetch({ [ROOT]: { server: { id: 'signalk-server', version: '2.7.1' } } })
  const src = createHttpSource({ baseUrl: BASE, fetchImpl })
  assert.deepEqual(await src.serverInfo(), { version: '2.7.1', plugins: [] })
})

test('a server that is down degrades to blanks instead of throwing', async () => {
  const src = createHttpSource({
    baseUrl: BASE,
    fetchImpl: async () => { throw new Error('ECONNREFUSED') }
  })
  assert.deepEqual(await src.serverInfo(), { version: '', plugins: [] })
  assert.deepEqual(await src.vesselIdentity(), { name: '', mmsi: '' })
  assert.deepEqual(await src.selfTree(), {})
})

test('vesselIdentity accepts both the plain and the {value} shape', async () => {
  const plain = createHttpSource({ baseUrl: BASE,
    fetchImpl: fakeFetch({ [API]: { name: 'Sara', mmsi: '238123456' } }) })
  assert.deepEqual(await plain.vesselIdentity(), { name: 'Sara', mmsi: '238123456' })

  const wrapped = createHttpSource({ baseUrl: BASE,
    fetchImpl: fakeFetch({ [API]: { name: { value: 'Sara' }, mmsi: { value: '238' } } }) })
  assert.deepEqual(await wrapped.vesselIdentity(), { name: 'Sara', mmsi: '238' })

  const nameless = createHttpSource({ baseUrl: BASE, fetchImpl: fakeFetch({ [API]: {} }) })
  assert.deepEqual(await nameless.vesselIdentity(), { name: '', mmsi: '' })
})

test('collectMeta sweeps every leaf and keeps only the paths that have meta', async () => {
  const tree = {
    navigation: { position: { value: { latitude: 45, longitude: 13 } } },
    environment: { depth: { belowTransducer: { value: 8.4 } } }
  }
  const fetchImpl = fakeFetch({
    [`${API}/navigation/position/meta`]: {
      units: 'deg', source: { manufacturer: 'Rusty Boats', model: 'RB-1' }
    }
  })
  const src = createHttpSource({ baseUrl: BASE, fetchImpl })
  const meta = await src.collectMeta(tree)
  assert.deepEqual(Object.keys(meta), ['navigation.position'])
  assert.equal(meta['navigation.position'].units, 'deg')
})

test('collectMeta reads a tree whose inline meta carries source without one request', async () => {
  // signalk-server 2.33: the value tree's inline meta is the full meta.
  const tree = {
    navigation: { position: { value: { latitude: 45, longitude: 13 },
      meta: { units: 'deg', source: { manufacturer: 'Rusty Boats', model: 'RB-1' } } } },
    environment: { depth: { belowTransducer: { value: 8.4, meta: { units: 'm' } } } },
    design: { draft: { value: 1.9 } }
  }
  const fetchImpl = fakeFetch({})
  const src = createHttpSource({ baseUrl: BASE, fetchImpl })
  const meta = await src.collectMeta(tree)
  assert.deepEqual(fetchImpl.seen, [])
  assert.deepEqual(meta, {
    'navigation.position': { units: 'deg', gear: { manufacturer: 'Rusty Boats', model: 'RB-1' } },
    'environment.depth.belowTransducer': { units: 'm' }
  })
})

test('collectMeta still sweeps /meta when the inline meta has no source anywhere', async () => {
  // An older server's reduced inline meta: units yes, source never.
  const tree = { navigation: { position: { value: { latitude: 45, longitude: 13 },
    meta: { units: 'deg' } } } }
  const fetchImpl = fakeFetch({
    [`${API}/navigation/position/meta`]: {
      units: 'deg', source: { manufacturer: 'Rusty Boats', model: 'RB-1' }
    }
  })
  const src = createHttpSource({ baseUrl: BASE, fetchImpl })
  const meta = await src.collectMeta(tree)
  assert.equal(fetchImpl.seen.length, 1)
  assert.equal(meta['navigation.position'].gear.model, 'RB-1')
})

test('the token travels on the delta socket URL and in the header', () => {
  const src = createHttpSource({ baseUrl: BASE, token: 'tok en' })
  assert.match(src.streamUrl(), /^ws:\/\/boat:3000\/signalk\/v1\/stream\?subscribe=self&token=tok%20en$/)
})

/** A ws stand-in. */
class FakeSocket extends EventEmitter {
  constructor (url, opts) { super(); this.url = url; this.opts = opts; this.closed = false }
  close () { this.closed = true }
}

test('subscribe flattens deltas to samples and drops malformed frames', () => {
  let socket = null
  const src = createHttpSource({
    baseUrl: BASE,
    WebSocketImpl: class extends FakeSocket {
      constructor (...args) { super(...args); socket = this }
    }
  })
  const samples = []
  src.subscribe((s) => samples.push(s))
  socket.emit('message', 'not json')
  socket.emit('message', JSON.stringify({ updates: [{ timestamp: 'T', $source: 'gps',
    values: [{ path: 'navigation.position', value: { latitude: 45, longitude: 13 } },
             { path: 'no.value.here' }] }] }))
  assert.equal(samples.length, 1)
  assert.equal(samples[0].path, 'navigation.position')
  assert.equal(samples[0].timestamp, 'T')
  assert.equal(samples[0].source, 'gps')
})

test('a dead delta socket reports once and does NOT reconnect itself', () => {
  /* The supervisor owns every retry curve in this plugin, with numbers a plan
     can push. A source that retried on its own would be a second, invisible
     loop nobody can fix from the cloud. */
  let socket = null
  let sockets = 0
  const src = createHttpSource({
    baseUrl: BASE,
    WebSocketImpl: class extends FakeSocket {
      constructor (...args) { super(...args); socket = this; sockets += 1 }
    }
  })
  const closes = []
  src.subscribe(() => {}, (why) => closes.push(why))
  socket.emit('error', new Error('ECONNRESET'))
  socket.emit('close')
  assert.deepEqual(closes, ['ECONNRESET'], 'exactly one report, not one per event')
  assert.equal(sockets, 1, 'the source must not dial again on its own')
})

test('a close we asked for is not reported as an outage', () => {
  let socket = null
  const src = createHttpSource({
    baseUrl: BASE,
    WebSocketImpl: class extends FakeSocket {
      constructor (...args) { super(...args); socket = this }
    }
  })
  const closes = []
  const sub = src.subscribe(() => {}, (why) => closes.push(why))
  sub.close()
  socket.emit('close')
  assert.deepEqual(closes, [])
  assert.equal(socket.closed, true)
})
