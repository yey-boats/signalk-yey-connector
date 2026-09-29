'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { backoffDelayMs, buildPackage, createUplink, RESULT_EVENT } = require('../lib/uplink')
const { DEFAULT_TRANSPORT } = require('../lib/plan')

const CFG = { cloudOrigin: 'https://x', tenant: 'home', project: 'demo',
              bundleId: 'signalk@2026-06-05', boatId: 'b_1', boatCredential: 'bk_1' }

test('backoff is exponential from the plan base and capped at the plan ceiling', () => {
  const t = { ...DEFAULT_TRANSPORT, backoff_base_s: 2, backoff_ceiling_s: 300,
              reconnect_jitter_pct: 0 }
  assert.equal(backoffDelayMs(1, t, () => 0.5), 2000)
  assert.equal(backoffDelayMs(2, t, () => 0.5), 4000)
  assert.equal(backoffDelayMs(3, t, () => 0.5), 8000)
  assert.equal(backoffDelayMs(20, t, () => 0.5), 300_000)
})

test('backoff jitter stays inside the plan percentage, both directions', () => {
  const t = { ...DEFAULT_TRANSPORT, backoff_base_s: 10, backoff_ceiling_s: 300,
              reconnect_jitter_pct: 30 }
  assert.equal(backoffDelayMs(1, t, () => 0), 7000)    // -30%
  assert.equal(backoffDelayMs(1, t, () => 1), 13000)   // +30%
  assert.equal(backoffDelayMs(1, t, () => 0.5), 10000) // no jitter
})

test('the default transport is safe on its own, before any plan arrives', () => {
  /* spec: "Client-side defaults must still be safe on their own (jittered
     exponential backoff, never a tight retry loop)." */
  assert.ok(backoffDelayMs(1, DEFAULT_TRANSPORT, () => 0) >= 1000,
    'a first retry must never be a tight loop')
  assert.ok(DEFAULT_TRANSPORT.reconnect_jitter_pct > 0,
    'zero jitter means a whole fleet reconnects in lockstep after a deploy')
})

test('backoff with no plan at all is still exponential and still jittered', () => {
  // A boat that reconnects before it has ever seen a plan passes undefined here.
  assert.ok(backoffDelayMs(1, undefined, () => 0.5) >= 1000)
  assert.ok(backoffDelayMs(5, undefined, () => 0.5) > backoffDelayMs(1, undefined, () => 0.5))
})

test('backoff never returns a negative or NaN delay', () => {
  const t = { ...DEFAULT_TRANSPORT, reconnect_jitter_pct: 100 }
  for (let attempt = 0; attempt < 30; attempt++) {
    const d = backoffDelayMs(attempt, t, () => 0)
    assert.ok(Number.isFinite(d) && d >= 0, `attempt ${attempt} gave ${d}`)
  }
})

test('buildPackage matches kdcube.data_bus.ingress.v1', () => {
  const pkg = buildPackage({
    bundleId: 'signalk@2026-06-05', subject: 'yey.boat.data', boatId: 'b_1',
    payload: { values: [] }, idempotencyKey: 'k1', messageId: 'm1'
  })
  assert.equal(pkg.schema, 'kdcube.data_bus.ingress.v1')
  assert.equal(pkg.bundle_id, 'signalk@2026-06-05')
  assert.equal(pkg.messages.length, 1)
  const m = pkg.messages[0]
  assert.equal(m.subject, 'yey.boat.data')
  // partition_by="object_ref" on the handler means object_ref IS the partition
  // key, so per-boat serialization depends on this being boat_id.
  assert.equal(m.object_ref, 'b_1')
  assert.equal(m.idempotency_key, 'k1')
  assert.equal(m.message_id, 'm1')
  assert.deepEqual(m.payload, { values: [] })
})

test('buildPackage always carries an idempotency key', () => {
  /* worker.py:307-315 REJECTS a message with no idempotency_key when the
     handler declares idempotency="required" — and all five of ours do. */
  const pkg = buildPackage({ bundleId: 'b', subject: 's', boatId: 'b_1', payload: {} })
  assert.ok(pkg.messages[0].idempotency_key)
  assert.ok(pkg.messages[0].message_id)
})

/** A socket.io-client stand-in. Its ack shape is copied from publish.py:320-332. */
function fakeIo ({ ackFor = () => ({ schema: 'kdcube.data_bus.ingress.v1',
                                     status: 'accepted', accepted: [], rejected: [] }) } = {}) {
  const sockets = []
  const io = (origin, opts) => {
    const handlers = {}
    const socket = {
      origin,
      opts,
      emitted: [],
      connected: false,
      on: (event, fn) => { handlers[event] = fn },
      emit: (event, data, cb) => {
        socket.emitted.push({ event, data })
        if (cb) cb(ackFor(data))
      },
      close: () => { socket.closed = true },
      fire: (event, data) => handlers[event] && handlers[event](data),
      handlers
    }
    sockets.push(socket)
    return socket
  }
  return { io, sockets }
}

const claimOk = async (cfg, op) => {
  assert.equal(op, 'signalk_boat_token_claim')
  return { ok: true, federated_token: 'ft_1', session_id: 'sess_1',
           expires_at: Math.floor(Date.now() / 1000) + 3600,
           bundle_id: 'signalk@2026-06-05', boat_id: 'b_1' }
}

test('claimToken exchanges the boat credential for a federated token', async () => {
  let seen = null
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT, deps: {
    callPublicOp: async (cfg, op, data) => { seen = { op, data }; return claimOk(cfg, op) }
  } })
  const grant = await u.claimToken()
  assert.equal(seen.op, 'signalk_boat_token_claim')
  assert.deepEqual(seen.data, { boat_id: 'b_1', boat_credential: 'bk_1' })
  assert.equal(grant.federated_token, 'ft_1')
})

test('a refused credential surfaces its code', async () => {
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT, deps: {
    callPublicOp: async () => ({ ok: false, error: 'invalid_credential' })
  } })
  await assert.rejects(() => u.claimToken(), (err) => err.code === 'invalid_credential')
})

test('connect sends exactly the auth fields the server accepts', async () => {
  const { io, sockets } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  assert.equal(sockets[0].origin, 'https://x')
  assert.equal(sockets[0].opts.path, '/socket.io')
  assert.deepEqual(sockets[0].opts.auth, {
    tenant: 'home', project: 'demo', bundle_id: 'signalk@2026-06-05',
    federated_token: 'ft_1', client_role: 'connector'
  })
  // The library's own reconnection is OFF: the plan owns the backoff curve, and
  // two competing reconnect loops would fight.
  assert.equal(sockets[0].opts.reconnection, false)
})

test('publish emits data_bus.publish and returns the ack', async () => {
  const { io, sockets } = fakeIo({
    ackFor: () => ({ schema: 'kdcube.data_bus.ingress.v1', status: 'accepted',
                     accepted: [{ message_id: 'm1', stream_id: '1-0' }], rejected: [] })
  })
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  const ack = await u.publish('yey.boat.data', { values: [1] }, { messageId: 'm1' })
  assert.equal(sockets[0].emitted[0].event, 'data_bus.publish')
  assert.equal(sockets[0].emitted[0].data.messages[0].subject, 'yey.boat.data')
  assert.equal(ack.status, 'accepted')
})

test('a rejected ack is returned, not thrown — the caller decides', async () => {
  const { io } = fakeIo({
    ackFor: () => ({ schema: 'kdcube.data_bus.ingress.v1', status: 'rejected',
                     accepted: [],
                     rejected: [{ index: null, error: 'bundle is disabled' }] })
  })
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  const ack = await u.publish('yey.boat.data', {}, {})
  assert.equal(ack.status, 'rejected')
  assert.match(ack.rejected[0].error, /disabled/)
})

test('publish before connect refuses instead of silently dropping', async () => {
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io: fakeIo().io } })
  await assert.rejects(() => u.publish('yey.boat.data', {}, {}),
    (err) => err.code === 'not_connected')
})

test('request resolves on the chat_service result that carries our message_id', async () => {
  const { io, sockets } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  const pending = u.request('yey.boat.hello', { hello: {} },
    { messageId: 'm7', timeoutMs: 1000 })
  // ctx.reply.ok -> chat_service {type:'kdcube.data_bus.result',
  //   data:{message_id, subject, object_ref, data}} (types.py:259-305)
  sockets[0].fire('chat_service', {
    type: RESULT_EVENT, step: 'data_bus', status: 'completed',
    data: { message_id: 'm7', subject: 'yey.boat.hello', object_ref: 'b_1',
            data: { kind: 'plan', plan: { schema: 1 }, etag: 'e1' } }
  })
  const reply = await pending
  assert.equal(reply.kind, 'plan')
  assert.equal(reply.etag, 'e1')
})

test('request ignores an envelope that is not the handler’s result', async () => {
  /* The Data Bus emits several event types against the SAME message_id, and a
     progress/accepted envelope travels ahead of the handler's reply. Resolving
     on "anything that is not an error" hands the caller a progress envelope as
     if it were the answer — the plan defined RESULT_EVENT and then never read
     it, which is exactly that bug. */
  const { io, sockets } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  const pending = u.request('yey.boat.hello', {}, { messageId: 'm9', timeoutMs: 120 })
  sockets[0].fire('chat_service', {
    type: 'kdcube.data_bus.accepted',
    data: { message_id: 'm9', data: { stream_id: '1-0' } }
  })
  await assert.rejects(() => pending, (err) => err.code === 'reply_timeout')
})

test('request ignores a result for somebody else’s message', async () => {
  const { io, sockets } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  const pending = u.request('yey.boat.hello', {}, { messageId: 'mine', timeoutMs: 120 })
  sockets[0].fire('chat_service', {
    type: RESULT_EVENT,
    data: { message_id: 'someone-else', data: { kind: 'plan' } }
  })
  await assert.rejects(() => pending, (err) => err.code === 'reply_timeout')
})

test('request rejects on a handler error event', async () => {
  const { io, sockets } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  const pending = u.request('yey.boat.hello', {}, { messageId: 'm8', timeoutMs: 1000 })
  sockets[0].fire('chat_service', {
    type: 'kdcube.data_bus.error',
    data: { message_id: 'm8', data: { code: 'boat_scope', message: 'nope' } }
  })
  await assert.rejects(() => pending, (err) => err.code === 'boat_scope')
})

test('request times out rather than hanging the runtime', async () => {
  const { io } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  await assert.rejects(() => u.request('yey.boat.hello', {}, { timeoutMs: 50 }),
    (err) => err.code === 'reply_timeout')
})

test('an ack for a request that never gets a reply does not resolve it', async () => {
  /* client-transport-protocols-README.md:270-276 — the ack confirms the message
     reached the stream, NOT that a handler exists or succeeded. */
  const { io } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  await assert.rejects(() => u.request('yey.boat.hello', {}, { timeoutMs: 60 }),
    (err) => err.code === 'reply_timeout')
})

test('a request that cannot even be published fails fast, it does not wait out the timeout', async () => {
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io: fakeIo().io } })
  // never connected
  await assert.rejects(() => u.request('yey.boat.hello', {}, { timeoutMs: 30_000 }),
    (err) => err.code === 'not_connected')
})

test('state() reports what the plugin screen shows', async () => {
  const { io, sockets } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  assert.equal(u.state().connected, false)
  await u.connect()
  assert.equal(u.state().connected, true)
  sockets[0].fire('disconnect', 'transport close')
  assert.equal(u.state().connected, false)
  assert.equal(u.state().last_disconnect_reason, 'transport close')
})

test('a socket-level drop is reported, not just recorded', async () => {
  /* Without this the supervisor only learns the link died when the next publish
     rejects — and flush() returns early on an empty buffer, so an idle boat can
     be off the air for a whole heartbeat_s (300s) before anything notices. */
  const { io, sockets } = fakeIo()
  const lost = []
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  u.setOnLost((why) => lost.push(why))
  await u.connect()
  sockets[0].fire('disconnect', 'transport close')
  assert.equal(lost.length, 1)
  assert.match(lost[0], /transport close/)
})

test('a handshake that never lands is reported too', async () => {
  /* reconnection:false means socket.io gives up silently on connect_error, so
     if this is not wired the retry curve is never armed at all. */
  const { io, sockets } = fakeIo()
  const lost = []
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  u.setOnLost((why) => lost.push(why))
  await u.connect()
  sockets[0].fire('connect_error', new Error('ECONNREFUSED'))
  assert.equal(lost.length, 1)
  assert.match(lost[0], /ECONNREFUSED/)
  assert.equal(u.state().connected, false)
})

test('a close WE asked for is not reported as a lost link', async () => {
  // onLinkLost() calls uplink.close(); if close() reported back, the two would
  // ping-pong and every deliberate stop would arm a reconnect.
  const { io, sockets } = fakeIo()
  let lost = 0
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  u.setOnLost(() => { lost += 1 })
  await u.connect()
  u.close()
  sockets[0].fire('disconnect', 'io client disconnect')
  assert.equal(lost, 0)
})

test('an uplink with no listener registered still survives a drop', async () => {
  const { io, sockets } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  sockets[0].fire('disconnect', 'transport close')   // must not throw
  assert.equal(u.state().connected, false)
})

test('close is idempotent and stops the socket', async () => {
  const { io, sockets } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io } })
  await u.connect()
  u.close(); u.close()
  assert.equal(sockets[0].closed, true)
  assert.equal(u.state().connected, false)
})

test('tokenRefreshAtMs lands before expiry, not on it', async () => {
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT,
    deps: { callPublicOp: claimOk, io: fakeIo().io } })
  const grant = await u.claimToken()
  const lifetimeMs = grant.expires_at * 1000 - u.state().token_claimed_at
  assert.ok(u.state().token_refresh_at < grant.expires_at * 1000)
  assert.ok(u.state().token_refresh_at - u.state().token_claimed_at <= lifetimeMs * 0.85)
})

test('the refresh point is spent at reconnect — not on a timer', async () => {
  /* This is the whole of the refresh contract, so it is pinned rather than
     described. There is no proactive refresh by design: the cloud verifies the
     federated token once, at the socket handshake (chat.py:281), and stores the
     verified session against the sid (`:376-389`), so a live socket outlives its
     own token and a new token could not be applied to it without redialling. */
  let claims = 0
  let clock = 1_000_000
  const { io } = fakeIo()
  const u = createUplink({ cfg: CFG, transport: DEFAULT_TRANSPORT, deps: {
    io,
    now: () => clock,
    callPublicOp: async () => {
      claims += 1
      return { ok: true, federated_token: `ft_${claims}`, session_id: 'sess_1',
               expires_at: Math.floor(clock / 1000) + 3600,
               bundle_id: 'signalk@2026-06-05', boat_id: 'b_1' }
    }
  } })
  await u.connect()
  assert.equal(claims, 1)

  clock += 1_800_000                     // half the token's hour has gone
  u.close()
  await u.connect()
  assert.equal(claims, 1, 'a reconnect inside the window must reuse the token')

  clock += 1_440_000                     // now past 80% of the original hour
  u.close()
  await u.connect()
  assert.equal(claims, 2, 'a reconnect past the refresh point must re-claim')
})

// ── The reconnect herd, as a number ─────────────────────────────────────────
// Y7 depends on these two figures and quotes them in the capacity report. They
// are pinned here so that a change to DEFAULT_TRANSPORT names the new fleet
// behaviour in a diff instead of quietly moving the go/no-go.

/** The window the FIRST reconnect attempt lands in, in seconds, for a whole
 *  fleet dropped at the same instant. backoffDelayMs applies SYMMETRIC jitter
 *  (factor = 1 + (rand()*2-1)*pct), so attempt 1 is uniform over
 *  base*[1-pct, 1+pct]. */
function firstAttemptWindowS (transport) {
  const lo = backoffDelayMs(1, transport, () => 0) / 1000
  const hi = backoffDelayMs(1, transport, () => 1) / 1000
  return { lo, hi, widthS: hi - lo }
}

test('at the shipped defaults a dropped fleet redials inside a 1.2 second window', () => {
  const w = firstAttemptWindowS(DEFAULT_TRANSPORT)
  assert.equal(w.lo, 1.4)
  assert.equal(w.hi, 2.6)
  assert.equal(Number(w.widthS.toFixed(3)), 1.2)
  // 500 boats over 1.2s. Each also fires one REST signalk_boat_token_claim
  // before its socket (createUplink.connect -> claimToken), so it is that many
  // HTTP requests per second as well as that many socket.io handshakes.
  assert.equal(Math.round(500 / w.widthS), 417)
})

test('pushed to the bounds the same knobs spread the same fleet over two minutes', () => {
  const w = firstAttemptWindowS({
    ...DEFAULT_TRANSPORT, backoff_base_s: 60, reconnect_jitter_pct: 100
  })
  assert.equal(w.lo, 0)
  assert.equal(w.hi, 120)
  assert.equal(Number((500 / w.widthS).toFixed(1)), 4.2)
})

test('zero jitter is expressible and is the pathological case', () => {
  const w = firstAttemptWindowS({ ...DEFAULT_TRANSPORT, reconnect_jitter_pct: 0 })
  assert.equal(w.widthS, 0, 'no jitter means every boat redials at the same instant')
})

test('backoffDelayMs never returns a tight retry loop at the shipped defaults', () => {
  // Spec :1549 — "Client-side defaults must still be safe on their own
  // (jittered exponential backoff, never a tight retry loop) for the case where
  // a boat reconnects before receiving any plan."
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    for (const r of [0, 0.5, 1]) {
      const ms = backoffDelayMs(attempt, DEFAULT_TRANSPORT, () => r)
      assert.ok(ms >= 1400, `attempt ${attempt} rand ${r} returned ${ms}ms`)
      assert.ok(ms <= 300 * 1000 * 1.3, `attempt ${attempt} exceeded the ceiling`)
    }
  }
})
