'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const {
  RESOURCE_TYPE, SUBJECT, createDashboardsProvider, registerDashboardsProvider
} = require('../lib/dashboards')
const { createRuntime } = require('../lib/runtime')

const LIST = {
  kind: 'dashboards',
  count: 2,
  dashboards: [
    { id: 'd1', title: 'Helm', targetClass: 'round-466', updatedAt: '2026-11-13T10:00:00Z' },
    { id: 'd2', title: 'Nav table', targetClass: 'wide-800x480', updatedAt: '2026-11-12T09:00:00Z' }
  ]
}
const GET = {
  kind: 'dashboard',
  dashboard: { id: 'd1', title: 'Helm', targetClass: 'round-466', updatedAt: '2026-11-13T10:00:00Z',
               doc: '{"midl":1,"pages":[]}' }
}

function errorWith (code, message = '') {
  return Object.assign(new Error(message || code), { code })
}

function provider ({ replies = [], connected = true, account = 'a1' } = {}) {
  const calls = []
  let clock = 1_000_000
  let isUp = connected
  let acct = account
  const p = createDashboardsProvider({
    request: async (subject, payload, opts) => {
      calls.push({ subject, payload, opts })
      const next = replies.shift()
      if (next instanceof Error) throw next
      return next
    },
    isConnected: () => isUp,
    accountKey: () => acct,
    now: () => clock
  })
  return { p, calls, advance: (ms) => { clock += ms }, setUp: (v) => { isUp = v },
           setAccount: (v) => { acct = v } }
}

test('listResources asks the cloud and maps the list to an object keyed by id', async () => {
  const h = provider({ replies: [LIST] })
  const out = await h.p.methods.listResources({})
  assert.deepEqual(out, {
    d1: { name: 'Helm', title: 'Helm', targetClass: 'round-466', updatedAt: '2026-11-13T10:00:00Z' },
    d2: { name: 'Nav table', title: 'Nav table', targetClass: 'wide-800x480', updatedAt: '2026-11-12T09:00:00Z' }
  })
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].subject, SUBJECT)
  assert.deepEqual(h.calls[0].payload, { op: 'list' })
  assert.match(h.calls[0].opts.idempotencyKey, /^dash_list_/)
})

test('getResource asks for one dashboard and returns it with its doc text', async () => {
  const h = provider({ replies: [GET] })
  const out = await h.p.methods.getResource('d1')
  assert.deepEqual(out, {
    id: 'd1', name: 'Helm', title: 'Helm', targetClass: 'round-466',
    updatedAt: '2026-11-13T10:00:00Z', doc: '{"midl":1,"pages":[]}'
  })
  assert.deepEqual(h.calls[0].payload, { op: 'get', id: 'd1' })
  assert.match(h.calls[0].opts.idempotencyKey, /^dash_get_/)
})

test('getResource with a property returns just that property', async () => {
  const h = provider({ replies: [GET] })
  assert.equal(await h.p.methods.getResource('d1', 'doc'), '{"midl":1,"pages":[]}')
})

test('every request carries its own idempotency key', async () => {
  const h = provider({ replies: [GET, GET] })
  await h.p.methods.getResource('d1')
  await h.p.methods.getResource('d1')
  assert.notEqual(h.calls[0].opts.idempotencyKey, h.calls[1].opts.idempotencyKey)
})

test('not connected: rejects with a clear error and asks nothing', async () => {
  const h = provider({ connected: false })
  await assert.rejects(h.p.methods.listResources({}), { code: 'not_connected', message: 'not connected to yey.boats' })
  await assert.rejects(h.p.methods.getResource('d1'), { code: 'not_connected' })
  assert.equal(h.calls.length, 0)
})

test('cloud errors surface with their code', async () => {
  const h = provider({ replies: [errorWith('not_found', 'no such dashboard'), errorWith('boat_unknown')] })
  await assert.rejects(h.p.methods.getResource('nope'),
    { code: 'not_found', message: 'yey.boats: not_found: no such dashboard' })
  await assert.rejects(h.p.methods.listResources({}), { code: 'boat_unknown', message: 'yey.boats: boat_unknown' })
})

test('a reply of the wrong kind is refused', async () => {
  const h = provider({ replies: [{ kind: 'plan' }, { ok: false, error: { code: 'bad_request', message: 'x' } }] })
  await assert.rejects(h.p.methods.listResources({}), { code: 'bad_reply' })
  await assert.rejects(h.p.methods.getResource('d1'), { code: 'bad_request' })
})

test('set and delete are read-only', async () => {
  const h = provider()
  await assert.rejects(h.p.methods.setResource('d1', {}), { code: 'read_only' })
  await assert.rejects(h.p.methods.deleteResource('d1'), { code: 'read_only' })
  assert.equal(h.calls.length, 0)
})

test('the list is cached briefly, per account, and never across a re-pair', async () => {
  const other = { kind: 'dashboards', count: 1, dashboards: [{ id: 'x', title: 'Other', targetClass: '', updatedAt: '' }] }
  const h = provider({ replies: [LIST, LIST, other] })
  await h.p.methods.listResources({})
  await h.p.methods.listResources({})
  assert.equal(h.calls.length, 1, 'second list within 30 s comes from the cache')
  h.advance(31_000)
  await h.p.methods.listResources({})
  assert.equal(h.calls.length, 2, 'stale after 30 s')
  h.setAccount('a2')
  assert.deepEqual(Object.keys(await h.p.methods.listResources({})), ['x'])
  assert.equal(h.calls.length, 3, 'a new pairing never reads the old cache')
})

test('the cache is not served while disconnected', async () => {
  const h = provider({ replies: [LIST] })
  await h.p.methods.listResources({})
  h.setUp(false)
  await assert.rejects(h.p.methods.listResources({}), { code: 'not_connected' })
})

test('registerDashboardsProvider registers the custom type when the API exists', () => {
  const registered = []
  const p = provider().p
  assert.equal(registerDashboardsProvider({ registerResourceProvider: (x) => registered.push(x) }, p), true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].type, RESOURCE_TYPE)
  assert.equal(registered[0].type, 'yey-dashboards')
  for (const m of ['listResources', 'getResource', 'setResource', 'deleteResource']) {
    assert.equal(typeof registered[0].methods[m], 'function', m)
  }
})

test('registerDashboardsProvider is a no-op on a server without the resources API', () => {
  const p = provider().p
  assert.equal(registerDashboardsProvider({}, p), false)
  assert.equal(registerDashboardsProvider({ registerResourceProvider: () => { throw new Error('x') } }, p), false)
})

test('plugin start registers yey-dashboards; an unpaired boat rejects "not connected"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-dash-'))
  const registered = []
  const app = { debug: () => {}, getDataDirPath: () => dir, setPluginStatus: () => {},
                registerResourceProvider: (x) => registered.push(x) }
  const plugin = require('../index.js')(app)
  plugin.start({})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].type, 'yey-dashboards')
  await assert.rejects(registered[0].methods.listResources({}), { message: 'not connected to yey.boats' })
  await assert.rejects(registered[0].methods.setResource('d1', {}), { code: 'read_only' })
  plugin.stop()
  await assert.rejects(registered[0].methods.getResource('d1'), { code: 'not_connected' })
})

test('plugin start on a server without the resources API still starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-dash-'))
  const plugin = require('../index.js')({ debug: () => {}, getDataDirPath: () => dir })
  assert.doesNotThrow(() => plugin.start({}))
  plugin.stop()
})

test('runtime: a paired, connected boat asks over the uplink; unpair forgets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-dash-'))
  const requests = []
  let up = true
  const uplink = {
    connect: async () => {},
    close: () => {},
    setOnLost: () => {},
    state: () => ({ connected: up }),
    publish: async () => ({ status: 'accepted', accepted: [], rejected: [] }),
    request: async (subject, payload) => {
      requests.push({ subject, payload })
      if (subject === 'yey.boat.dashboards') return payload.op === 'list' ? LIST : GET
      return {}
    }
  }
  const runtime = createRuntime({
    app: { debug: () => {}, getDataDirPath: () => dir },
    version: '0.5.0',
    options: { enabled: true, boatId: 'b_1', boatCredential: 'bk_1', cloudOrigin: 'https://yey.boats' },
    deps: {
      createUplink: () => uplink,
      source: { subscribe: () => ({ close: () => {} }), selfTree: async () => ({}),
                collectMeta: async () => ({}), serverInfo: async () => ({ version: '2.7.1', plugins: [] }),
                vesselIdentity: async () => ({ name: 'Sara', mmsi: '' }) }
    }
  })
  const m = runtime.dashboards.methods
  await assert.rejects(m.listResources({}), { code: 'not_connected' }, 'not running yet')
  await runtime.start()
  assert.deepEqual(Object.keys(await m.listResources({})), ['d1', 'd2'])
  assert.equal((await m.getResource('d1')).doc, GET.dashboard.doc)
  assert.equal(requests.filter((r) => r.subject === 'yey.boat.dashboards').length, 2)
  up = false
  await assert.rejects(m.listResources({}), { code: 'not_connected' }, 'socket down')
  up = true
  await runtime.unpair()
  await assert.rejects(m.listResources({}), { code: 'not_connected' }, 'unpaired')
})
