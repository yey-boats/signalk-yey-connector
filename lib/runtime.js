'use strict'

/**
 * The connector's runtime: the loop, and the supervisor that turns it.
 *
 * The loop:
 *
 *   connect ──► hello (+ the CLOUD's plan_etag) ──► reply: plan | not_modified
 *                                             │
 *                                      applyPlan(consent, deny)
 *                                             │
 *                                      plan_ack (accepted, rejected[])
 *                                             │
 *   deltas ─► decide() per mapping ─► budget.admit ─► buffer.append
 *                                             │
 *   tick ─► flush: peek(backfill_chunk_msgs) ─► publish ─► ack ─► commit
 *        └─ heartbeat_s elapsed ─► hello again (plan changes land here)
 *
 *   anything above throws ─► onLinkLost ─► backoffDelayMs(attempt, transport)
 *                                             └─► connect again
 *
 * Every collaborator is injectable through `deps` (clock, timers, randomness,
 * SignalK source, uplink, pairing), which is what lets the whole loop be tested
 * with no boat, no socket and no cloud.
 */

const { createState } = require('./state')
const { buildHello } = require('./hello')
const { applyPlan, DEFAULT_TRANSPORT } = require('./plan')
const { decide, applyRound } = require('./policies')
const { createBudget } = require('./budget')
const { createBuffer } = require('./buffer')
const { createUplink, backoffDelayMs } = require('./uplink')
const { createHttpSource } = require('./signalk-source')
const { buildCatalog, diffCatalogs } = require('./discovery')
const { pairingStatus } = require('./pairing')

function createRuntime ({ app, options, version, deps = {} }) {
  const debug = (msg) => { if (app && typeof app.debug === 'function') app.debug(msg) }
  const now = deps.now || Date.now
  const setTimer = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimeout || ((handle) => clearTimeout(handle))
  const rand = deps.random || Math.random

  // deps.pairing exists for the tests; production takes the real module.
  const { requestClaim, pollClaim, redeemCode } = deps.pairing || require('./pairing')

  const opts = options || {}
  const cfg = {
    enabled: opts.enabled !== false,
    cloudOrigin: String(opts.cloudOrigin || 'https://yey.boats').replace(/\/+$/, ''),
    tenant: String(opts.tenant || 'home'),
    project: String(opts.project || 'demo'),
    bundleId: String(opts.bundleId || 'signalk@2026-06-05'),
    signalkUrl: String(opts.signalkUrl || 'http://localhost:3000').replace(/\/+$/, ''),
    signalkToken: String(opts.signalkToken || ''),
    boatId: String(opts.boatId || ''),
    boatCredential: String(opts.boatCredential || ''),
    deny: Array.isArray(opts.deny) ? opts.deny.map(String) : [],
    bufferBytes: Math.max(1, Number(opts.bufferMegabytes) || 50) * 1024 * 1024
  }

  const dataDir = (app && typeof app.getDataDirPath === 'function')
    ? app.getDataDirPath() : null
  const state = createState({ dir: dataDir })
  const stored = state.read()
  if (!cfg.boatId && stored.boat_id) cfg.boatId = stored.boat_id
  if (!cfg.boatCredential && stored.boat_credential) cfg.boatCredential = stored.boat_credential

  const buffer = deps.buffer ||
    createBuffer({ dir: dataDir, maxBytes: cfg.bufferBytes, now })
  let source = deps.source || createHttpSource({
    baseUrl: cfg.signalkUrl, token: cfg.signalkToken
  })
  const uplink = (deps.createUplink || createUplink)({
    cfg, transport: DEFAULT_TRANSPORT, deps
  })
  let publishFn = (subject, payload, opt) => uplink.publish(subject, payload, opt)

  let runState = 'stopped'
  let detail = ''
  let consent = Array.isArray(stored.consent) ? stored.consent : []
  let consentSource = consent.length ? 'pairing' : 'none'
  let active = null            // the applied plan
  // The CLOUD's etag for the plan we are running. Deliberately NOT seeded from
  // the state file: the plan body itself is not persisted, so after a restart
  // there is no plan in memory, and echoing the stored etag would make the cloud
  // answer not_modified and leave the boat with no plan at all. state.plan_etag
  // is kept for the screen and for support, not for the handshake.
  let cloudEtag = ''
  let planProblem = ''
  let transport = { ...DEFAULT_TRANSPORT }
  let budget = createBudget({ budget: { max_msgs_per_min: 30, max_bytes_per_hour: 262144 } })
  const emitState = new Map()  // path -> {lastEmitMs, lastValue}
  let lastHelloMs = 0
  let subscription = null
  let lastCatalog = stored.catalog || null

  // Supervisor state.
  let running = false
  let connectTimer = null
  let tickTimer = null
  let attempt = 0

  /**
   * The capability document, built once from the SignalK server itself.
   *
   * `buildHello({ version })` alone would ship empty blocks, and
   * boat_pairing.project_hello keeps exactly `signalk.version` and
   * `vessel.{name,mmsi}` (boat_pairing.py:94-134) — those blank blocks are what
   * the Y1 confirm screen renders, so the user would approve a nameless boat.
   *
   * `bufferBytes` is threaded through because LIMITS.buffer_bytes is advertised
   * to the cloud as a real number a plan can be checked against: a boat
   * configured for 10 MB must not tell the cloud it can absorb 50.
   *
   * Cached, because neither value changes while the plugin runs and a handshake
   * must not block on a server that has gone away. A read that produced nothing
   * is NOT cached, so the next hello tries again rather than pinning '' forever.
   */
  const identity = (() => {
    let cached = null
    return {
      async hello () {
        if (!cached) {
          let signalk = { version: '', plugins: [] }
          let vessel = { name: '', mmsi: '' }
          try { signalk = await source.serverInfo() } catch { /* degrade to blank */ }
          try { vessel = await source.vesselIdentity() } catch { /* degrade to blank */ }
          if (signalk.version || vessel.name || vessel.mmsi) cached = { signalk, vessel }
          return buildHello({ version, signalk, vessel, bufferBytes: cfg.bufferBytes })
        }
        return buildHello({
          version, signalk: cached.signalk, vessel: cached.vessel, bufferBytes: cfg.bufferBytes
        })
      },
      reset () { cached = null }
    }
  })()

  function setConsent (paths) {
    consent = (paths || []).map(String)
    consentSource = 'pairing'
    state.patch({ consent })
  }

  function mappingFor (path) {
    if (!active) return null
    // Exact first, then the single wildcard form the plan vocabulary allows.
    for (const m of active.mappings) {
      if (m.path === path) return m
    }
    for (const m of active.mappings) {
      if (!m.path.includes('*')) continue
      const rx = new RegExp(`^${m.path.split('*').map((s) =>
        s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+')}$`)
      if (rx.test(path)) return m
    }
    return null
  }

  function onSample (sample) {
    if (!active || !sample || !sample.path) return
    const mapping = mappingFor(sample.path)
    if (!mapping) return
    const st = emitState.get(sample.path) || {}
    const nowMs = now()
    const verdict = decide({ mapping, state: st, sample, nowMs, transport })
    if (!verdict.emit) return

    const value = applyRound(mapping, sample.value)
    const record = {
      t: nowMs,
      priority: mapping.priority || 'normal',
      n: mapping.as,
      p: sample.path,
      v: value,
      ts: sample.timestamp || '',
      plan_id: active.plan_id,
      plan_version: active.version
    }
    const admitted = budget.admit(
      { bytes: JSON.stringify(record).length, priority: record.priority }, nowMs)
    if (!admitted.admit) {
      debug(`yey connector: budget shed ${sample.path} (${admitted.reason})`)
      return
    }
    buffer.append(record)
    emitState.set(sample.path, { lastEmitMs: nowMs, lastValue: sample.value })
  }

  async function handshake () {
    const reply = await uplink.request('yey.boat.hello', {
      hello: await identity.hello(),
      // The CLOUD's etag, echoed verbatim — never our own etagOf().
      // yey_boat_hello compares payload.plan_etag against boat_plan.plan_etag(plan),
      // a Python sha256 over the RAW plan. Our etag is a JS sha256 over the
      // PROJECTED, CLAMPED plan. The two can never be equal, so sending ours
      // would make not_modified dead code: every heartbeat would re-deliver the
      // plan, re-apply it, re-publish plan_ack and rewrite the state file.
      plan_etag: active ? cloudEtag : ''
    })
    lastHelloMs = now()
    if (reply && reply.not_modified) {
      if (reply.etag) { cloudEtag = String(reply.etag); state.patch({ plan_etag: cloudEtag }) }
      return active
    }

    const applied = applyPlan(reply && reply.plan, { consent, deny: cfg.deny })
    if (!applied.ok) {
      planProblem = String(applied.reason || 'bad_plan')
      active = { plan_id: '', version: 0, etag: '', mappings: [], rejected: [] }
      transport = applied.transport
      // A refused plan must NOT be remembered as running, or the next heartbeat
      // would say not_modified and the boat would sit there doing nothing.
      cloudEtag = ''
      state.patch({ plan_etag: '' })
      await publishFn('yey.boat.plan_ack', {
        plan_id: '', version: Number((reply && reply.plan && reply.plan.version) || 0),
        etag: String((reply && reply.etag) || ''), local_etag: '', accepted: 0,
        rejected: [{ reason: planProblem }], connector_version: version
      }, {})
      return active
    }

    planProblem = ''
    active = applied
    cloudEtag = String((reply && reply.etag) || '')
    transport = applied.transport
    budget = createBudget({ budget: applied.budget })
    if (!consent.length) {
      // The claim-poll direction does not return subscribed_paths; fall back to
      // what the plan asks for, minus the deny list, and SAY SO in the snapshot.
      consent = applied.mappings.map((m) => m.path)
      consentSource = 'plan'
    }
    // Live apply: drop emit state only for paths that left the plan.
    for (const key of [...emitState.keys()]) if (!mappingFor(key)) emitState.delete(key)

    state.patch({ plan_etag: cloudEtag, plan_version: applied.version })
    // `etag` is the cloud's, so the cloud can compare plan_ack.etag with the
    // plan_etag column directly; `local_etag` is our own content hash of the
    // plan as APPLIED, so a clamp the cloud did not expect is visible.
    await publishFn('yey.boat.plan_ack',
      { ...applied.ack(), etag: cloudEtag, local_etag: applied.etag,
        connector_version: version }, {})
    debug(`yey connector: plan v${applied.version} applied, ` +
          `${applied.mappings.length} mappings, ${applied.rejected.length} refused`)
    return active
  }

  async function flush () {
    if (!active) return
    const chunk = Math.max(1, Number(transport.backfill_chunk_msgs) || 100)
    const batch = buffer.peek(chunk)
    if (!batch.records.length) return
    const stats = buffer.stats()
    // More buffered than one chunk means we are catching up, not streaming.
    const subject = stats.count > batch.records.length ? 'yey.boat.backfill' : 'yey.boat.data'
    const ack = await publishFn(subject, {
      plan_id: active.plan_id,
      plan_version: active.version,
      values: batch.records.map((r) => ({ t: r.t, n: r.n, p: r.p, v: r.v, ts: r.ts,
                                          plan_version: r.plan_version }))
    }, {})
    // Release ONLY on an accepted/partial ack. A rejection means it never
    // reached the stream, and dropping it here is the data loss the buffer
    // exists to prevent.
    if (ack && (ack.status === 'accepted' || ack.status === 'partial')) {
      buffer.commit(batch.cursor)
    } else {
      debug(`yey connector: publish ${subject} not accepted (${ack && ack.status})`)
    }
  }

  async function discover () {
    const tree = await source.selfTree()
    const metaByPath = await source.collectMeta(tree)
    const catalog = buildCatalog({ tree, metaByPath, nowIso: new Date(now()).toISOString() })
    const diff = diffCatalogs(lastCatalog, catalog)
    lastCatalog = catalog
    state.patch({ catalog })
    await publishFn('yey.boat.catalog', { catalog, diff }, {})
    return { catalog, diff }
  }

  async function tick () {
    const heartbeatMs = Math.max(1, Number(transport.heartbeat_s) || 300) * 1000
    if (now() - lastHelloMs >= heartbeatMs) await handshake()
    await flush()
  }

  // ── The supervisor: the thing that turns the loop ──────────────────────────

  function clearTimers () {
    if (connectTimer) { clearTimer(connectTimer); connectTimer = null }
    if (tickTimer) { clearTimer(tickTimer); tickTimer = null }
  }

  /** One retry curve for every way the link can die, with plan-controlled
   *  numbers (spec:1526-1541). A second loop anywhere else would be a curve
   *  nobody can push a fix to. */
  function scheduleReconnect (why) {
    if (!running || connectTimer) return
    attempt += 1
    const delayMs = backoffDelayMs(attempt, transport, rand)
    runState = 'reconnecting'
    detail = `${why} — retry ${attempt} in ${Math.round(delayMs / 1000)}s`
    debug(`yey connector: ${detail}`)
    connectTimer = setTimer(() => { connectTimer = null; return cycle() }, delayMs)
  }

  /** Everything that can drop the link lands here: a failed connect, an expired
   *  token, a throwing tick, a dropped or never-completed socket, a dead
   *  SignalK delta socket. The buffer is NOT touched — it exists precisely to
   *  survive this. */
  function onLinkLost (why) {
    if (!running) return
    clearTimers()
    if (subscription) { subscription.close(); subscription = null }
    try { uplink.close() } catch { /* already gone */ }
    scheduleReconnect(why)
  }

  // The socket's own two failures — it drops, or its handshake never lands —
  // reach onLinkLost through here. Without this line recovery waits for the next
  // publish to fail, and flush() returns early on an empty buffer, so an idle
  // boat stays silently off the air until the heartbeat is due, up to
  // transport.heartbeat_s (default 300s). setOnLost is called rather than passed
  // to createUplink because the uplink is constructed above, before this
  // function exists.
  uplink.setOnLost(onLinkLost)

  function tickIntervalMs () {
    const base = Math.max(1, Number(transport.backfill_chunk_interval_s) || 5)
    const multiplier = transport.quiet_mode
      ? Math.max(1, Number(transport.quiet_interval_multiplier) || 1)
      : 1
    return base * multiplier * 1000
  }

  function scheduleTick () {
    if (!running || tickTimer) return
    tickTimer = setTimer(async () => {
      tickTimer = null
      try {
        await tick()            // heartbeat-when-due + flush
        scheduleTick()          // re-read the interval: a plan may have changed it
      } catch (err) {
        onLinkLost(String((err && err.code) || (err && err.message) || 'tick_failed'))
      }
    }, tickIntervalMs())
  }

  function openSource () {
    if (subscription) { subscription.close(); subscription = null }
    subscription = source.subscribe(onSample, (why) => {
      subscription = null
      // The SignalK server went away rather than the cloud, but it is the same
      // outage as far as the boat is concerned — one curve, one place to fix.
      onLinkLost(`signalk ${why}`)
    })
  }

  async function cycle () {
    if (!running) return
    try {
      runState = 'connecting'
      detail = 'claiming a token'
      await uplink.connect()
      detail = 'saying hello'
      await handshake()
      openSource()
      try {
        await discover()
      } catch (err) {
        // A boat with no catalog still streams; do not fail the connect for it.
        debug(`yey connector: discovery failed (${err && err.message})`)
      }
      attempt = 0
      runState = 'running'
      detail = ''
      scheduleTick()
    } catch (err) {
      onLinkLost(String((err && err.code) || (err && err.message) || 'connect_failed'))
    }
  }

  /** Async on purpose: SignalK ignores the return value, and a test can await
   *  the first cycle instead of racing it. */
  async function start () {
    if (!cfg.enabled) { runState = 'disabled'; detail = 'sending is switched off'; return }
    if (!cfg.boatId || !cfg.boatCredential) {
      runState = 'unpaired'
      detail = 'not paired — open /plugins/signalk-yey-connector/ to connect this boat'
      return
    }
    if (running) return          // SignalK calls start() again after a settings save
    running = true
    attempt = 0
    debug(`yey connector ${version}: starting for boat ${cfg.boatId}`)
    return cycle()
  }

  function stop () {
    running = false
    clearTimers()
    if (subscription) { subscription.close(); subscription = null }
    uplink.close()
    runState = 'stopped'
    detail = ''
  }

  /** Pairing just supplied what start() was missing. Dial now — nobody should
   *  have to restart SignalK to finish installing this plugin. */
  async function goLive () {
    try {
      await start()
    } catch (err) {
      // A connect failure is the supervisor's retry curve to own, not a reason
      // to tell the browser that pairing — which DID succeed — failed.
      debug(`yey connector: pairing succeeded but the first dial did not (${err && err.message})`)
    }
  }

  function snapshot () {
    const stats = buffer.stats()
    return {
      state: runState,
      detail,
      version,
      boat_id: cfg.boatId,
      enabled: cfg.enabled,
      connected: Boolean(uplink.state().connected),
      pairing_status: pairingStatus(state.read()),
      plan_version: active ? active.version : 0,
      plan_etag: cloudEtag,                        // what the cloud calls this plan
      plan_local_etag: active ? active.etag : '',  // our hash of the plan as applied
      plan_problem: planProblem,
      active_mappings: active ? active.mappings.length : 0,
      rejected: active && active.rejected ? active.rejected : [],
      mappings: active ? active.mappings : [],
      consent,
      consent_source: consentSource,
      deny: cfg.deny,
      buffered: stats.count,
      buffer_bytes: stats.bytes,
      buffer_dropped: stats.dropped,
      budget: budget.stats(now()),
      transport,
      retry_attempt: attempt
    }
  }

  return {
    cfg,
    start,
    stop,
    statusMessage: () =>
      runState === 'stopped' ? 'stopped' : (detail ? `${runState} — ${detail}` : runState),
    snapshot,
    setConsent,
    handshake,
    onSample,
    flush,
    discover,
    tick,

    async pairViaClaim () {
      // identity.hello(), not buildHello({ version }): the claim's hello is what
      // the web confirm screen renders, so it has to carry the vessel's name.
      const claim = await requestClaim(cfg, await identity.hello(), deps)
      state.patch({ claim_id: claim.claim_id, claim_secret: claim.claim_secret })
      return { claim_id: claim.claim_id, confirm_url: claim.confirm_url,
               expires_in: claim.expires_in }
    },

    async pollPairing () {
      const saved = state.read()
      if (!saved.claim_id) return { status: 'idle' }
      const bound = await pollClaim(cfg, saved, deps)
      if (!bound) return { status: 'pending' }
      cfg.boatId = bound.boat_id
      cfg.boatCredential = bound.boat_credential
      state.patch({ boat_id: bound.boat_id, boat_credential: bound.boat_credential,
                    claim_id: '', claim_secret: '' })
      await goLive()
      return { status: 'confirmed', boat_id: bound.boat_id }
    },

    async pairViaCode (code) {
      const paired = await redeemCode(cfg, code, await identity.hello(), deps)
      cfg.boatId = paired.boat_id
      cfg.boatCredential = paired.boat_credential
      // This direction DOES return the consent list (entrypoint.py:3779); the
      // claim-poll direction does not, which is why consent_source exists.
      if (paired.subscribed_paths.length) setConsent(paired.subscribed_paths)
      state.patch({ boat_id: paired.boat_id, boat_credential: paired.boat_credential })
      await goLive()
      return { boat_id: paired.boat_id, display_name: paired.display_name }
    },

    async unpair () {
      // Local only: this wipes the boat's own copy of the credential and stops
      // the loop. It does NOT revoke anything cloud-side — the `revoked`
      // transition belongs to the Telegram /unpair command (entrypoint.py:5177),
      // not to this button.
      stop()
      cfg.boatId = ''
      cfg.boatCredential = ''
      state.write({})
      return { ok: true }
    },

    __setPublish: (fn) => { publishFn = fn },
    __setSource: (s) => { source = s; identity.reset() }
  }
}

module.exports = { createRuntime }
