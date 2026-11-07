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
const { applyPlan, DEFAULT_TRANSPORT, coveredBy, literalHead } = require('./plan')
const { decide, applyRound } = require('./policies')
const { createBudget } = require('./budget')
const { createBuffer } = require('./buffer')
const { createUplink, backoffDelayMs } = require('./uplink')
const { createSource } = require('./signalk-source')
const { fetchConnectionDocument, parseKey, routingToCfg } = require('./connection')
const { normalizeIdentity } = require('./identity')
const { migrateLegacyOptions, LEGACY_DEFAULT_ROUTING } = require('./migrate')
const { buildCatalog, diffCatalogs } = require('./discovery')
const { pairingStatus } = require('./pairing')

// Link failures that are not an outage but the cloud refusing this boat.
// `invalid_credential` is what signalk_boat_token_claim returns for a boat
// that is revoked or unknown (check_credential refuses `revoked`). Gathering
// for a boat that can never deliver is gathering nobody consented to keep.
const TERMINAL_LINK_ERRORS = new Set(['invalid_credential'])

function createRuntime ({ app, options, version, deps = {} }) {
  const debug = (msg) => { if (app && typeof app.debug === 'function') app.debug(msg) }
  const now = deps.now || Date.now
  const setTimer = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimeout || ((handle) => clearTimeout(handle))
  const rand = deps.random || Math.random

  // deps.pairing exists for the tests; production takes the real module.
  const { requestClaim, pollClaim, redeemCode } = deps.pairing || require('./pairing')

  const opts = options || {}
  const advanced = (opts.advanced && typeof opts.advanced === 'object') ? opts.advanced : {}
  // Advanced settings, with the pre-connect-by-URL top-level keys as a fallback
  // for an options file that has not been rewritten yet.
  const deny = Array.isArray(advanced.deny) ? advanced.deny
    : (Array.isArray(opts.deny) ? opts.deny : [])
  const bufferMegabytes = advanced.bufferMegabytes !== undefined
    ? advanced.bufferMegabytes : opts.bufferMegabytes
  // Routing, boat id and credential are PRIVATE state (lib/state.js), never
  // plugin options: they come from the connection document and pairing (or the
  // key). cfg keeps the field names cloud-client/uplink have always read.
  const cfg = {
    enabled: opts.enabled !== false,
    connectionUrl: String(opts.connectionUrl || '').trim(),
    cloudOrigin: '',
    tenant: '',
    project: '',
    bundleId: '',
    boatId: '',
    boatCredential: '',
    deny: deny.map(String).filter(Boolean),
    bufferBytes: Math.max(1, Number(bufferMegabytes) || 50) * 1024 * 1024
  }

  const dataDir = (app && typeof app.getDataDirPath === 'function')
    ? app.getDataDirPath() : null
  const state = createState({ dir: dataDir })

  // Old settings (origin, tenant, project, bundle, boat id, credential) keep
  // working: copied into private state once, then ignored. When private state
  // is on disk, the options file is rewritten without them so the credential
  // stops sitting in a file the admin UI shows.
  const migration = migrateLegacyOptions(opts, state)
  function scrubOptions (cleaned) {
    if (!app || typeof app.savePluginOptions !== 'function' || !state.file) return
    try {
      app.savePluginOptions(cleaned, (err) => {
        if (err) debug(`yey connector: could not rewrite plugin options (${err.message})`)
      })
    } catch (err) {
      debug(`yey connector: could not rewrite plugin options (${err && err.message})`)
    }
  }
  if (migration.legacyKeys.length) {
    // Only scrub once the private copy is really on disk: with a file, read()
    // reads the file, so a write that fell back to memory (read-only data dir)
    // shows up here as a missing credential and the options are left alone.
    const after = state.read()
    if (!opts.boatCredential || after.boat_credential) scrubOptions(migration.cleaned)
  }

  function applyStored (saved) {
    const routing = routingToCfg(saved.routing)
    cfg.cloudOrigin = routing.cloudOrigin
    cfg.tenant = routing.tenant
    cfg.project = routing.project
    cfg.bundleId = routing.bundleId
    cfg.boatId = String(saved.boat_id || '')
    cfg.boatCredential = String(saved.boat_credential || '')
  }
  const stored = state.read()
  applyStored(stored)
  // A key left in the options of an install that is already connected has
  // nothing left to do; it carries the credential, so it goes.
  if (opts.key && cfg.boatId && cfg.boatCredential && cfg.cloudOrigin) {
    const { key, ...rest } = opts
    scrubOptions(migrateLegacyOptions(rest, state).cleaned)
  }

  const buffer = deps.buffer ||
    createBuffer({ dir: dataDir, maxBytes: cfg.bufferBytes, now })
  // In-process (app.signalk / app.subscriptionmanager); REST against the
  // server's own port only if this host's `app` lacks those calls.
  let source = deps.source || createSource({ app })
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
  let lastSentMs = 0
  // The connection document fetched by resolveConnection(), waiting for the
  // owner to confirm the boat. Memory only: it holds a one-time code that lives
  // 15 minutes, and a restart simply means pasting the link again.
  let pending = null

  // Supervisor state.
  let running = false
  // Why gathering is off although the plugin is running, when the cloud has
  // said so (a refused credential). '' otherwise.
  let gatherBlocked = ''
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
    // Consent can only NARROW a plan already running: a mapping it no longer
    // covers stops being gathered now, not at the next handshake — which may be
    // a long outage away. (Widening needs the cloud's next plan.)
    if (active && Array.isArray(active.mappings)) {
      active.mappings = active.mappings.filter((m) => coveredBy(literalHead(m.path), consent))
      for (const key of [...emitState.keys()]) if (!mappingFor(key)) emitState.delete(key)
      syncGathering()
    }
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
      syncGathering()
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

    syncGathering()
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
      lastSentMs = now()
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
   *  survive this.
   *
   *  Nor is the SignalK subscription, unless the cloud has refused the boat: a
   *  lost CLOUD link is exactly the outage the buffer is for ("you were out of
   *  signal, here's your track"), so sampling carries on under the running
   *  plan's policies and budget, and the reconnect backfills it. A dead SignalK
   *  stream has already cleared `subscription` itself (openSource). */
  function onLinkLost (why) {
    if (!running) return
    clearTimers()
    if (TERMINAL_LINK_ERRORS.has(String(why))) {
      gatherBlocked = String(why)
      syncGathering()
    }
    try { uplink.close() } catch { /* already gone */ }
    scheduleReconnect(why)
  }

  /** Gather iff running, not refused by the cloud, and holding a plan with
   *  something in it. Idempotent: it opens at most one subscription and closes
   *  the one it has, so a reconnect can never double the stream. The stream is
   *  `subscribe=self` whatever the plan says; a new plan changes what onSample
   *  keeps (mappingFor), not what is subscribed. */
  function shouldGather () {
    return running && !gatherBlocked && Boolean(active) &&
      Array.isArray(active.mappings) && active.mappings.length > 0
  }

  function syncGathering () {
    if (shouldGather()) {
      if (!subscription) openSource()
    } else if (subscription) {
      subscription.close()
      subscription = null
    }
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
    // A SignalK stream that died during an outage comes back on the next
    // retry, whether or not the cloud does.
    syncGathering()
    try {
      runState = 'connecting'
      detail = 'claiming a token'
      await uplink.connect()
      // The cloud accepted the credential: whatever blocked gathering is over.
      gatherBlocked = ''
      detail = 'saying hello'
      await handshake()
      syncGathering()
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
    if (!cfg.boatId || !cfg.boatCredential || !cfg.cloudOrigin) {
      // A key in the options file is a provisioned install: connect with it
      // now, then drop it from the options (it carries the credential).
      if (opts.key && cfg.connectionUrl && !provisioning) {
        provisioning = true
        try {
          await connectWithKey({ url: cfg.connectionUrl, key: opts.key })
          const { key, ...rest } = opts
          scrubOptions(migrateLegacyOptions(rest, state).cleaned)
          return
        } catch (err) {
          runState = 'unpaired'
          detail = `could not connect with the key in the settings (${(err && err.code) || (err && err.message)})`
          return
        } finally {
          provisioning = false
        }
      }
      runState = 'unpaired'
      detail = 'not connected — paste a connection link from yey.boats in Plugin Config → yey — cloud connector'
      return
    }
    if (running) return          // SignalK calls start() again after a settings save
    running = true
    attempt = 0
    gatherBlocked = ''
    debug(`yey connector ${version}: starting for boat ${cfg.boatId}`)
    return cycle()
  }

  let provisioning = false

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
      retry_attempt: attempt,
      // True while the SignalK stream is open — including through a cloud
      // outage, which is when it matters.
      gathering: Boolean(subscription),
      connection: connectionView()
    }
  }

  /** What the panel shows: never the credential, the code or the routing
   *  internals beyond the origin it links to. */
  function connectionView () {
    const saved = state.read()
    const paired = pairingStatus(saved) === 'paired' && Boolean(cfg.cloudOrigin)
    return {
      status: paired ? 'connected' : (pending ? 'confirming' : 'not_connected'),
      origin: cfg.cloudOrigin || (pending ? pending.doc.routing.origin : ''),
      display_name: String(saved.display_name || (saved.identity && saved.identity.name) || ''),
      mode: String(saved.connected_via || (saved.migrated_from_options ? 'legacy' : '')),
      last_sent_at: lastSentMs ? new Date(lastSentMs).toISOString() : '',
      pending: pending ? { boat: pending.doc.boat, expires_in_s: pending.doc.expires_in_s,
                           identity: pending.identity } : null
    }
  }

  /** Store a connected boat privately and go live. */
  async function adopt ({ doc, boatId, credential, displayName, identity, via, subscribedPaths }) {
    const patch = {
      routing: doc.routing,
      boat_id: boatId,
      boat_credential: credential,
      display_name: displayName || '',
      connected_via: via,
      claim_id: '',
      claim_secret: ''
    }
    if (identity) patch.identity = identity
    state.patch(patch)
    applyStored(state.read())
    if (Array.isArray(subscribedPaths) && subscribedPaths.length) setConsent(subscribedPaths)
    pending = null
    await goLive()
  }

  // deps.fetch is the HTTP transport (tests inject a fake); the parsing and
  // error typing are always the real ones.
  const fetchDoc = (url) => (deps.fetchConnectionDocument ||
    ((u) => fetchConnectionDocument(u, { fetchImpl: deps.fetch })))(url)

  /** Step 1 of connect-by-URL: fetch the document, read the boat from SignalK. */
  function assertNotConnected () {
    if (cfg.boatId && cfg.boatCredential && cfg.cloudOrigin) {
      const err = new Error('already connected; disconnect first')
      err.code = 'already_connected'
      throw err
    }
  }

  /** The routing the old pairing page uses on an install that has none yet. */
  function legacyPairCfg () {
    return cfg.cloudOrigin ? cfg : { ...cfg, ...routingToCfg(LEGACY_DEFAULT_ROUTING) }
  }
  function rememberLegacyRouting () {
    if (!state.read().routing) state.patch({ routing: { ...LEGACY_DEFAULT_ROUTING } })
    applyStored(state.read())
  }

  async function resolveConnection ({ url } = {}) {
    assertNotConnected()
    const doc = await fetchDoc(url)
    if (!doc.code) {
      const err = new Error('this link needs the key yey.boats gave you')
      err.code = 'key_required'
      throw err
    }
    let identity = null
    try {
      identity = await source.boatIdentity()
    } catch (err) {
      debug(`yey connector: could not read the boat from SignalK (${err && err.message})`)
    }
    identity = identity || normalizeIdentity({})
    if (!identity.name && doc.boat.display_name) identity = { ...identity, name: doc.boat.display_name }
    pending = { url: String(url).trim(), doc, identity, at: now() }
    return {
      status: 'confirm',
      boat: doc.boat,
      expires_in_s: doc.expires_in_s,
      origin: doc.routing.origin,
      identity
    }
  }

  /** Step 2: the owner confirmed (maybe corrected) the boat — pair with it. */
  async function confirmConnection ({ identity } = {}) {
    if (!pending) {
      const err = new Error('paste the connection link first')
      err.code = 'nothing_to_confirm'
      throw err
    }
    const confirmed = normalizeIdentity(identity || pending.identity)
    const { doc } = pending
    const pairCfg = { ...routingToCfg(doc.routing), opUrls: { signalk_boat_pair: doc.pair_url } }
    const hello = await helloFor(confirmed)
    const paired = await redeemCode(pairCfg, doc.code, hello, deps, { identity: confirmed })
    await adopt({
      doc,
      boatId: paired.boat_id,
      credential: paired.boat_credential,
      displayName: paired.display_name || confirmed.name || doc.boat.display_name,
      identity: confirmed,
      via: 'url',
      subscribedPaths: paired.subscribed_paths
    })
    return { status: 'connected', boat_id: paired.boat_id,
             display_name: String(state.read().display_name || '') }
  }

  /** Key mode: URL for the routing, key for the boat. No confirm step. */
  async function connectWithKey ({ url, key } = {}) {
    assertNotConnected()
    const parsed = parseKey(key)            // before any network: a typo fails fast
    const doc = await fetchDoc(url)
    await adopt({
      doc,
      boatId: parsed.boatId,
      credential: parsed.credential,
      displayName: doc.boat.display_name,
      via: 'key'
    })
    return { status: 'connected', boat_id: parsed.boatId,
             display_name: String(state.read().display_name || '') }
  }

  async function helloFor (confirmed) {
    const hello = await identity.hello()
    if (confirmed && (confirmed.name || confirmed.mmsi)) {
      hello.vessel = { ...(hello.vessel || {}), name: confirmed.name || '', mmsi: confirmed.mmsi || '' }
    }
    return hello
  }

  const runtimeApi = {
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
      const claim = await requestClaim(legacyPairCfg(), await identity.hello(), deps)
      state.patch({ claim_id: claim.claim_id, claim_secret: claim.claim_secret })
      return { claim_id: claim.claim_id, confirm_url: claim.confirm_url,
               expires_in: claim.expires_in }
    },

    async pollPairing () {
      const saved = state.read()
      if (!saved.claim_id) return { status: 'idle' }
      const bound = await pollClaim(legacyPairCfg(), saved, deps)
      if (!bound) return { status: 'pending' }
      rememberLegacyRouting()
      cfg.boatId = bound.boat_id
      cfg.boatCredential = bound.boat_credential
      state.patch({ boat_id: bound.boat_id, boat_credential: bound.boat_credential,
                    claim_id: '', claim_secret: '' })
      await goLive()
      return { status: 'confirmed', boat_id: bound.boat_id }
    },

    async pairViaCode (code) {
      const paired = await redeemCode(legacyPairCfg(), code, await identity.hello(), deps)
      rememberLegacyRouting()
      cfg.boatId = paired.boat_id
      cfg.boatCredential = paired.boat_credential
      // This direction DOES return the consent list (entrypoint.py:3779); the
      // claim-poll direction does not, which is why consent_source exists.
      if (paired.subscribed_paths.length) setConsent(paired.subscribed_paths)
      state.patch({ boat_id: paired.boat_id, boat_credential: paired.boat_credential })
      await goLive()
      return { boat_id: paired.boat_id, display_name: paired.display_name }
    },

    resolveConnection,
    confirmConnection,
    connectWithKey,
    disconnect: async () => {
      pending = null
      return runtimeApi.unpair()
    },

    async unpair () {
      // Local only: this wipes the boat's own copy of the credential and stops
      // the loop. It does NOT revoke anything cloud-side — the `revoked`
      // transition belongs to the Telegram /unpair command (entrypoint.py:5177),
      // not to this button.
      stop()
      cfg.boatId = ''
      cfg.boatCredential = ''
      cfg.cloudOrigin = ''
      lastSentMs = 0
      state.write({})
      return { ok: true }
    },

    __setPublish: (fn) => { publishFn = fn },
    __setSource: (s) => { source = s; identity.reset() }
  }
  return runtimeApi
}

module.exports = { createRuntime, TERMINAL_LINK_ERRORS }
