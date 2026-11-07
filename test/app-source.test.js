'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { createAppSource, createSource, hasAppApi } = require('../lib/signalk-source')
const { TREE } = require('./fixtures/connection-doc')

/** The slice of the plugin `app` the server passes (signalk-server
 *  dist/interfaces/plugins.js): signalk.self, getPath, getMetadata, config,
 *  subscriptionmanager. */
function fakeApp (over = {}) {
  const subscribers = []
  const tree = {
    ...TREE,
    navigation: {
      speedOverGround: { value: 3.1, $source: 'sim', meta: { units: 'm/s', description: 'SOG' } },
      courseOverGroundTrue: { value: 1.2, $source: 'sim' }
    }
  }
  return {
    signalk: { self: tree },
    selfContext: 'vessels.urn:mrn:imo:mmsi:238123456',
    config: { version: '2.37.0', settings: { port: 3000 } },
    getMetadata: (p) => p === 'vessels.self.navigation.courseOverGroundTrue'
      ? { units: 'rad', description: 'Course over ground (true)' } : undefined,
    subscriptionmanager: {
      subscribe: (command, unsubscribes, onError, onDelta) => {
        subscribers.push({ command, onError, onDelta })
        unsubscribes.push(() => { subscribers.splice(subscribers.indexOf(subscribers[0]), 1) })
      }
    },
    subscribers,
    ...over
  }
}

test('the server app is read in-process when it has the API', () => {
  assert.equal(hasAppApi(fakeApp()), true)
  assert.equal(createSource({ app: fakeApp() }).kind, 'app')
  assert.equal(hasAppApi({ debug () {} }), false)
})

test('without the in-process API the fallback is REST on the server\'s own port, no token', () => {
  const src = createSource({ app: { config: { settings: { port: 3456 } } } })
  assert.equal(src.kind, 'http')
  const prev = process.env.PORT
  delete process.env.PORT
  try {
    assert.match(createSource({ app: { config: { settings: { port: 3456 } } } }).streamUrl(),
      /^ws:\/\/localhost:3456\/signalk\/v1\/stream\?subscribe=self$/)
  } finally {
    if (prev !== undefined) process.env.PORT = prev
  }
})

test('selfTree, serverInfo and identity come from the app object', async () => {
  const src = createAppSource({ app: fakeApp() })
  const tree = await src.selfTree()
  assert.equal(tree.name, 'Sara')
  assert.deepEqual(await src.serverInfo(), { version: '2.37.0', plugins: [] })
  assert.deepEqual(await src.vesselIdentity(), { name: 'Sara', mmsi: '238123456' })
  assert.equal((await src.boatIdentity()).length_m, 12.4)
})

test('selfTree falls back to getPath(selfContext)', async () => {
  const app = fakeApp({ signalk: undefined, getPath: (p) => (p === 'vessels.urn:mrn:imo:mmsi:238123456' ? { name: 'Via getPath' } : undefined) })
  assert.equal((await createAppSource({ app }).selfTree()).name, 'Via getPath')
})

test('meta: inline where the tree has it, app.getMetadata otherwise', async () => {
  const src = createAppSource({ app: fakeApp() })
  const meta = await src.collectMeta(await src.selfTree())
  assert.deepEqual(meta['navigation.speedOverGround'], { units: 'm/s', description: 'SOG' })
  assert.deepEqual(meta['navigation.courseOverGroundTrue'], { units: 'rad', description: 'Course over ground (true)' })
})

test('subscribe goes through subscriptionmanager and flattens deltas to samples', () => {
  const app = fakeApp()
  const src = createAppSource({ app })
  const samples = []
  const sub = src.subscribe((s) => samples.push(s))
  assert.equal(app.subscribers.length, 1)
  assert.deepEqual(app.subscribers[0].command,
    { context: 'vessels.self', subscribe: [{ path: '*', policy: 'instant' }] })
  app.subscribers[0].onDelta({ context: 'vessels.self', updates: [{
    timestamp: '2026-11-07T10:00:00Z', $source: 'sim',
    values: [{ path: 'navigation.speedOverGround', value: 3.3 }, { path: 'bad' }],
    meta: [{ path: 'x', value: {} }]
  }] })
  assert.deepEqual(samples, [{ path: 'navigation.speedOverGround', value: 3.3,
    timestamp: '2026-11-07T10:00:00Z', source: 'sim', context: 'vessels.self' }])
  sub.close()
  assert.equal(app.subscribers.length, 0, 'close() runs the unsubscribes')
})

test('a subscription error reaches onClose once', () => {
  const app = fakeApp()
  const reasons = []
  createAppSource({ app }).subscribe(() => {}, (why) => reasons.push(why))
  app.subscribers[0].onError(new Error('bad subscription'))
  app.subscribers[0].onError(new Error('again'))
  assert.deepEqual(reasons, ['bad subscription'])
})
