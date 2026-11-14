'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { SUBJECT, STATE_KEY, createDashboards } = require('../lib/dashboards')
const { createState } = require('../lib/state')
const { createRuntime } = require('../lib/runtime')
const { registerRoutes } = require('../lib/routes')

const T0 = Date.parse('2026-11-14T10:00:00Z')
const GRANT = 'gr_secret_1234567890'

const LINK = { kind: 'link', link_id: 'lk_1', code: 'ABC-123', verify_url: 'https://yey.boats/link', expires_in: 600 }
const APPROVED = { kind: 'link_status', status: 'approved', grant: GRANT, user_label: 'Ann (owner)',
                   expires_at: '2026-12-14T10:00:00Z' }
const PENDING = { kind: 'link_status', status: 'pending' }
const LIST = {
  kind: 'dashboards',
  count: 2,
  user_label: 'Ann (owner)',
  dashboards: [
    { id: 'd1', title: 'Helm', targetClass: 'round-466', updatedAt: '2026-11-13T10:00:00Z' },
    { id: 'd2', title: 'Nav table', targetClass: 'wide-800x480', updatedAt: '2026-11-12T09:00:00Z' }
  ]
}
const GET = {
  kind: 'dashboard',
  dashboard: { id: 'd1', title: 'Helm', targetClass: 'round-466', updatedAt: '2026-11-13T10:00:00Z',
               doc: { midl: 1, pages: [] } }
}

function errorWith (code, message = '') {
  return Object.assign(new Error(message || code), { code })
}

function tmpDir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'yey-dash-')) }

/** A dashboards module over a scripted cloud. `replies` answer in order; a
 *  function reply is called with the payload. */
function harness ({ replies = [], connected = true, dir = null, state } = {}) {
  const calls = []
  let clock = T0
  let up = connected
  const st = state || createState({ dir })
  const d = createDashboards({
    request: async (subject, payload, opts) => {
      calls.push({ subject, payload, opts })
      let next = replies.shift()
      if (typeof next === 'function') next = next(payload)
      if (next instanceof Error) throw next
      return next
    },
    isConnected: () => up,
    state: st,
    now: () => clock
  })
  return { d, api: d.api, calls, state: st, replies,
           advance: (ms) => { clock += ms }, setUp: (v) => { up = v } }
}

async function linked (h) {
  h.replies.unshift(LINK, APPROVED)
  await h.api.linkStart()
  await h.api.linkPoll()
  h.calls.length = 0
}

// ── linking ──────────────────────────────────────────────────────────────────

test('linkStart asks link_start and returns the code, verify_url and expiry', async () => {
  const h = harness({ replies: [LINK] })
  const out = await h.api.linkStart()
  assert.deepEqual(out, { code: 'ABC-123', verify_url: 'https://yey.boats/link',
                          expires_at: '2026-11-14T10:10:00.000Z' })
  assert.equal(h.calls[0].subject, SUBJECT)
  assert.deepEqual(h.calls[0].payload, { op: 'link_start' })
  assert.match(h.calls[0].opts.idempotencyKey, /^dash_link_start_/)
  const s = await h.api.state()
  assert.deepEqual(s, { connected: true, linked: false, user_label: '', expires_at: '',
                        pending: { code: 'ABC-123', verify_url: 'https://yey.boats/link',
                                   expires_at: '2026-11-14T10:10:00.000Z' } })
})

test('linkPoll: pending, then approved stores the grant and clears the pending link', async () => {
  const h = harness({ replies: [LINK, PENDING, APPROVED] })
  await h.api.linkStart()
  assert.deepEqual(await h.api.linkPoll(), { status: 'pending' })
  assert.deepEqual(h.calls[1].payload, { op: 'link_poll', link_id: 'lk_1' })
  assert.deepEqual(await h.api.linkPoll(),
    { status: 'approved', user_label: 'Ann (owner)', expires_at: '2026-12-14T10:00:00Z' })
  assert.deepEqual(h.state.read()[STATE_KEY],
    { grant: GRANT, user_label: 'Ann (owner)', expires_at: '2026-12-14T10:00:00Z' })
  const s = await h.api.state()
  assert.equal(s.linked, true)
  assert.equal(s.pending, null)
  assert.equal(JSON.stringify(s).includes(GRANT), false, 'state() never shows the grant')
})

test('linkPoll: rejected and expired clear the pending link and store nothing', async () => {
  for (const status of ['rejected', 'expired']) {
    const h = harness({ replies: [LINK, { kind: 'link_status', status }] })
    await h.api.linkStart()
    assert.deepEqual(await h.api.linkPoll(), { status })
    assert.equal((await h.api.state()).pending, null)
    assert.equal(h.state.read()[STATE_KEY], undefined)
    await assert.rejects(h.api.linkPoll(), { code: 'no_pending_link' })
  }
})

test('linkPoll without linkStart rejects no_pending_link; a lapsed link is expired locally', async () => {
  const h = harness({ replies: [LINK] })
  await assert.rejects(h.api.linkPoll(), { code: 'no_pending_link' })
  await h.api.linkStart()
  h.advance(601_000)
  assert.deepEqual(await h.api.linkPoll(), { status: 'expired' })
  assert.equal(h.calls.length, 1, 'no cloud call for a lapsed link')
})

test('a new approval replaces the earlier grant: at most one is held', async () => {
  const h = harness()
  await linked(h)
  h.replies.push(LINK, { ...APPROVED, grant: 'gr_two', user_label: 'Bo (crew)' })
  await h.api.linkStart()
  await h.api.linkPoll()
  assert.equal(h.state.read()[STATE_KEY].grant, 'gr_two')
  assert.equal((await h.api.state()).user_label, 'Bo (crew)')
})

test('approved without a grant, or a reply of the wrong kind, is bad_reply', async () => {
  const h = harness({ replies: [LINK, { kind: 'link_status', status: 'approved' }, { kind: 'plan' }] })
  await h.api.linkStart()
  await assert.rejects(h.api.linkPoll(), { code: 'bad_reply' })
  await assert.rejects(h.api.linkStart(), { code: 'bad_reply' })
})

// ── reading ──────────────────────────────────────────────────────────────────

test('list passes the grant and returns {dashboards, user_label}', async () => {
  const h = harness()
  await linked(h)
  h.replies.push(LIST)
  const out = await h.api.list()
  assert.deepEqual(out, {
    dashboards: [
      { id: 'd1', title: 'Helm', targetClass: 'round-466', updatedAt: '2026-11-13T10:00:00Z' },
      { id: 'd2', title: 'Nav table', targetClass: 'wide-800x480', updatedAt: '2026-11-12T09:00:00Z' }
    ],
    user_label: 'Ann (owner)'
  })
  assert.deepEqual(h.calls[0].payload, { op: 'list', grant: GRANT })
  assert.match(h.calls[0].opts.idempotencyKey, /^dash_list_/)
})

test('get passes the grant and the id and returns the dashboard with its doc', async () => {
  const h = harness()
  await linked(h)
  h.replies.push(GET)
  assert.deepEqual(await h.api.get('d1'), { ...GET.dashboard })
  assert.deepEqual(h.calls[0].payload, { op: 'get', grant: GRANT, id: 'd1' })
  await assert.rejects(h.api.get(''), { code: 'bad_request' })
})

test('every request carries its own idempotency key', async () => {
  const h = harness()
  await linked(h)
  h.replies.push(GET, GET)
  await h.api.get('d1')
  await h.api.get('d1')
  assert.notEqual(h.calls[0].opts.idempotencyKey, h.calls[1].opts.idempotencyKey)
})

test('not connected: list/get/link calls reject not_connected and ask nothing', async () => {
  const h = harness()
  await linked(h)
  h.setUp(false)
  for (const p of [h.api.list(), h.api.get('d1'), h.api.linkStart()]) {
    await assert.rejects(p, { code: 'not_connected' })
  }
  assert.equal(h.calls.length, 0)
  assert.equal((await h.api.state()).connected, false)
})

test('no grant: list/get reject not_linked without a cloud call', async () => {
  const h = harness()
  await assert.rejects(h.api.list(), { code: 'not_linked' })
  await assert.rejects(h.api.get('d1'), { code: 'not_linked' })
  assert.equal(h.calls.length, 0)
})

test('a grant past expires_at is not_linked locally and forgotten', async () => {
  const h = harness()
  await linked(h)
  h.advance(31 * 24 * 3600 * 1000)
  assert.equal((await h.api.state()).linked, false)
  await assert.rejects(h.api.list(), { code: 'not_linked' })
  assert.equal(h.calls.length, 0)
  assert.equal(h.state.read()[STATE_KEY], null)
})

test('grant_invalid from the cloud forgets the grant and rejects grant_invalid', async () => {
  const h = harness()
  await linked(h)
  h.replies.push(errorWith('grant_invalid', 'user lost access'))
  await assert.rejects(h.api.get('d1'), { code: 'grant_invalid' })
  assert.equal((await h.api.state()).linked, false)
  await assert.rejects(h.api.list(), { code: 'not_linked' })
  assert.equal(h.calls.length, 1)
})

test('other cloud errors keep their code and keep the grant', async () => {
  const h = harness()
  await linked(h)
  h.replies.push(errorWith('not_found', 'no such dashboard'), errorWith('boat_unknown'),
    { ok: false, error: { code: 'bad_request', message: 'x' } })
  await assert.rejects(h.api.get('nope'), { code: 'not_found', message: 'yey.boats: not_found: no such dashboard' })
  await assert.rejects(h.api.list(), { code: 'boat_unknown' })
  await assert.rejects(h.api.list(), { code: 'bad_request' })
  assert.equal((await h.api.state()).linked, true)
})

test('the list is cached for 30 s per grant', async () => {
  const other = { kind: 'dashboards', count: 1, user_label: 'Bo', dashboards: [{ id: 'x', title: 'Other' }] }
  const h = harness()
  await linked(h)
  h.replies.push(LIST, LIST)
  await h.api.list()
  const second = await h.api.list()
  second.dashboards.length = 0 // a caller mutating its copy does not touch the cache
  assert.equal((await h.api.list()).dashboards.length, 2)
  assert.equal(h.calls.length, 1, 'within 30 s the list comes from the cache')
  h.advance(31_000)
  await h.api.list()
  assert.equal(h.calls.length, 2, 'stale after 30 s')
  // A different grant never reads the old cache.
  h.replies.push(LINK, { ...APPROVED, grant: 'gr_two' }, other)
  await h.api.linkStart()
  await h.api.linkPoll()
  assert.deepEqual((await h.api.list()).dashboards.map((d) => d.id), ['x'])
  assert.equal(h.calls.at(-1).payload.grant, 'gr_two')
})

test('the cache is not served while disconnected or unlinked', async () => {
  const h = harness()
  await linked(h)
  h.replies.push(LIST)
  await h.api.list()
  h.setUp(false)
  await assert.rejects(h.api.list(), { code: 'not_connected' })
  h.setUp(true)
  h.replies.push({ kind: 'unlinked' })
  await h.api.unlink()
  await assert.rejects(h.api.list(), { code: 'not_linked' })
})

// ── unlinking, reset, persistence ────────────────────────────────────────────

test('unlink gives the grant back and forgets it', async () => {
  const h = harness()
  await linked(h)
  h.replies.push({ kind: 'unlinked' })
  assert.deepEqual(await h.api.unlink(), { linked: false })
  assert.deepEqual(h.calls[0].payload, { op: 'unlink', grant: GRANT })
  assert.equal((await h.api.state()).linked, false)
  // Nothing held: no call.
  assert.deepEqual(await h.api.unlink(), { linked: false })
  assert.equal(h.calls.length, 1)
})

test('unlink forgets the grant locally even when the call fails', async () => {
  const h = harness()
  await linked(h)
  h.replies.push(errorWith('reply_timeout'))
  await assert.rejects(h.api.unlink(), { code: 'reply_timeout' })
  assert.equal((await h.api.state()).linked, false)
  const g = harness()
  await linked(g)
  g.setUp(false)
  await assert.rejects(g.api.unlink(), { code: 'not_connected' })
  assert.equal((await g.api.state()).linked, false)
})

test('reset (unpair / re-pair) clears the grant, the pending link and the cache', async () => {
  const h = harness()
  await linked(h)
  h.replies.push(LINK)
  await h.api.linkStart()
  h.d.reset()
  const s = await h.api.state()
  assert.equal(s.linked, false)
  assert.equal(s.pending, null)
  assert.equal(h.state.read()[STATE_KEY], null)
})

test('an approval that lands after a reset is not stored', async () => {
  const h = harness()
  let release
  h.replies.push(LINK, () => new Promise((resolve) => { release = () => resolve(APPROVED) }))
  await h.api.linkStart()
  const poll = h.api.linkPoll()
  await new Promise((resolve) => setImmediate(resolve))
  h.d.reset()
  release()
  await assert.rejects(poll, { code: 'no_pending_link' })
  assert.equal(h.state.read()[STATE_KEY], undefined)
  assert.equal((await h.api.state()).linked, false)
})

test('the grant survives a restart (state file), owner-only', async () => {
  const dir = tmpDir()
  const h = harness({ dir })
  await linked(h)
  const file = createState({ dir }).file
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const again = harness({ dir, replies: [LIST] })
  assert.equal((await again.api.state()).linked, true)
  await again.api.list()
  assert.equal(again.calls[0].payload.grant, GRANT)
})

test('statusView shows link state only: never the grant or the code', async () => {
  const h = harness()
  await linked(h)
  h.replies.push(LINK)
  await h.api.linkStart()
  const v = h.d.statusView()
  assert.deepEqual(v, { linked: true, user_label: 'Ann (owner)', expires_at: '2026-12-14T10:00:00Z',
                        pending: { expires_at: '2026-11-14T10:10:00.000Z' } })
  assert.equal(JSON.stringify(v).includes(GRANT), false)
  assert.equal(JSON.stringify(v).includes('ABC-123'), false)
})

// ── plugin and runtime ───────────────────────────────────────────────────────

function fakeUplink (handler) {
  const st = { up: true }
  return {
    st,
    connect: async () => {},
    close: () => {},
    setOnLost: () => {},
    state: () => ({ connected: st.up }),
    publish: async () => ({ status: 'accepted', accepted: [], rejected: [] }),
    request: async (subject, payload) => (subject === SUBJECT ? handler(payload) : {})
  }
}

const SOURCE = {
  subscribe: () => ({ close: () => {} }),
  selfTree: async () => ({}),
  collectMeta: async () => ({}),
  serverInfo: async () => ({ version: '2.7.1', plugins: [] }),
  vesselIdentity: async () => ({ name: 'Sara', mmsi: '' })
}

function cloudHandler (requests) {
  return (payload) => {
    requests.push(payload)
    switch (payload.op) {
      case 'link_start': return LINK
      case 'link_poll': return APPROVED
      case 'list': return LIST
      case 'get': return GET
      case 'unlink': return { kind: 'unlinked' }
      default: throw errorWith('bad_request')
    }
  }
}

function runtimeWith (dir, uplink, debugLog = []) {
  return createRuntime({
    app: { debug: (m) => debugLog.push(String(m)), getDataDirPath: () => dir },
    version: '0.5.0',
    options: { enabled: true, boatId: 'b_1', boatCredential: 'bk_1', cloudOrigin: 'https://yey.boats' },
    deps: { createUplink: () => uplink, source: SOURCE }
  })
}

test('plugin start sets app.yeyDashboards with Promise methods; stop deletes it', async () => {
  const dir = tmpDir()
  const app = { debug: () => {}, getDataDirPath: () => dir, setPluginStatus: () => {} }
  const plugin = require('../index.js')(app)
  assert.equal(app.yeyDashboards, undefined)
  plugin.start({})
  const api = app.yeyDashboards
  assert.deepEqual(Object.keys(api).sort(), ['get', 'linkPoll', 'linkStart', 'list', 'state', 'unlink'])
  const s = await api.state()
  assert.equal(s.connected, false)
  assert.equal(s.linked, false)
  await assert.rejects(api.list(), { code: 'not_connected' })
  await assert.rejects(api.linkStart(), { code: 'not_connected' })
  // Other plugins get their own shallow copy of app, so the API is published
  // process-wide too (signalk-server interfaces/plugins.js).
  assert.equal(globalThis[Symbol.for('yey-boats.dashboards')], api)
  const otherPluginsApp = Object.assign({}, { debug: () => {} })
  assert.equal(otherPluginsApp.yeyDashboards, undefined, 'a copied app does not see it')
  plugin.stop()
  assert.equal('yeyDashboards' in app, false)
  assert.equal(globalThis[Symbol.for('yey-boats.dashboards')], undefined)
  await assert.rejects(api.get('d1'), { code: 'not_connected' }, 'a kept reference rejects while stopped')
})

test('no yey-dashboards resource provider is registered', () => {
  const dir = tmpDir()
  const registered = []
  const app = { debug: () => {}, getDataDirPath: () => dir, registerResourceProvider: (x) => registered.push(x) }
  const plugin = require('../index.js')(app)
  plugin.start({})
  plugin.stop()
  assert.deepEqual(registered, [])
})

test('runtime: link, list and get over the uplink; the grant is never logged; unpair forgets', async () => {
  const dir = tmpDir()
  const requests = []
  const debugLog = []
  const uplink = fakeUplink(cloudHandler(requests))
  const runtime = runtimeWith(dir, uplink, debugLog)
  const api = runtime.dashboards
  await assert.rejects(api.list(), { code: 'not_connected' }, 'not running yet')
  await runtime.start()
  await assert.rejects(api.list(), { code: 'not_linked' })
  const started = await api.linkStart()
  assert.equal(started.code, 'ABC-123')
  assert.equal(started.verify_url, LINK.verify_url)
  assert.ok(Date.parse(started.expires_at) > Date.now())
  assert.equal((await api.linkPoll()).status, 'approved')
  assert.deepEqual((await api.list()).dashboards.map((d) => d.id), ['d1', 'd2'])
  assert.deepEqual((await api.get('d1')).doc, GET.dashboard.doc)
  assert.ok(requests.filter((r) => r.op === 'list' || r.op === 'get').every((r) => r.grant === GRANT))

  const status = runtime.snapshot().dashboards
  assert.deepEqual(status, { linked: true, user_label: 'Ann (owner)', expires_at: APPROVED.expires_at, pending: null })
  assert.equal(debugLog.some((m) => m.includes(GRANT)), false, 'the grant is never logged')

  uplink.st.up = false
  await assert.rejects(api.list(), { code: 'not_connected' }, 'socket down')
  uplink.st.up = true

  await runtime.unpair()
  assert.equal(runtime.snapshot().dashboards.linked, false)
  assert.equal(fs.readFileSync(path.join(dir, 'yey-connector-state.json'), 'utf8').includes(GRANT), false)
  runtime.stop()
})

test('runtime: the grant survives a restart; unpair clears it and the pending link', async () => {
  const dir = tmpDir()
  const requests = []
  const first = runtimeWith(dir, fakeUplink(cloudHandler(requests)))
  await first.start()
  await first.dashboards.linkStart()
  await first.dashboards.linkPoll()
  first.stop()

  const second = runtimeWith(dir, fakeUplink(cloudHandler(requests)))
  await second.start()
  assert.equal((await second.dashboards.state()).linked, true, 'restored from the state file')
  await second.dashboards.list()
  assert.equal(requests.at(-1).grant, GRANT)

  await second.dashboards.linkStart()
  assert.ok((await second.dashboards.state()).pending)
  await second.unpair()
  assert.equal(createState({ dir }).read()[STATE_KEY], undefined)
  const s = await second.dashboards.state()
  assert.equal(s.linked, false)
  assert.equal(s.pending, null)
})

test('/status shows the dashboards link state without the grant', async () => {
  const dir = tmpDir()
  const runtime = runtimeWith(dir, fakeUplink(cloudHandler([])))
  await runtime.start()
  await runtime.dashboards.linkStart()
  await runtime.dashboards.linkPoll()
  const routes = {}
  const router = { get: (p, h) => { routes[`GET ${p}`] = h }, post: (p, h) => { routes[`POST ${p}`] = h } }
  registerRoutes(router, () => runtime)
  let body
  await routes['GET /status']({}, { status () { return this }, json (b) { body = b; return this } })
  assert.deepEqual(body.dashboards, { linked: true, user_label: 'Ann (owner)',
                                      expires_at: APPROVED.expires_at, pending: null })
  assert.equal(JSON.stringify(body).includes(GRANT), false)
  runtime.stop()
})
