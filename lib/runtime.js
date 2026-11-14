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
const {
  fetchConnectionDocument, normalizeConnectionInput, parseKey, routingToCfg, checkOrigin, isTrustedOrigin,
  isUnencryptedOrigin
} = require('./connection')
const { normalizeIdentity } = require('./identity')
const displayNames = require('./display-name')
const { migrateLegacyOptions } = require('./migrate')
const { buildCatalog, diffCatalogs, leafPaths } = require('./discovery')
const { pairingStatus } = require('./pairing')
const {
  parseConsentDocument, sendPaths, buildSubmission, parseStatus, localRecord,
  callConsentOp
} = require('./consent')
const { createRpcServer, REQUEST_EVENT } = require('./rpc')
const { createSteeringAudit } = require('./steering-audit')
const { createSteeringPolicy } = require('./steering-policy')
const { AIS_PATH, aisMapping, createAisCollector } = require('./ais')
const { createDashboards } = require('./dashboards')

// Link failures that are not an outage but the cloud refusing this boat.
// `invalid_credential` is what signalk_boat_token_claim returns for a boat
// that is revoked or unknown (check_credential refuses `revoked`). Gathering
// for a boat that can never deliver is gathering nobody consented to keep.
const TERMINAL_LINK_ERRORS = new Set(['invalid_credential'])
// Re-discover at most this often when samples show paths the catalog lacks.
const REDISCOVER_MIN_MS = 60_000
// ...and look for new paths in the tree itself this often, gathering or not.
const REDISCOVER_TREE_MS = 120_000
// The cloud refusing a token because the owner has not approved what is sent
// (#441 phase 2). Not an outage: retrying cannot help until the owner approves
// in the panel, so the supervisor parks instead of redialling.
const CONSENT_LINK_ERRORS = new Set(['consent_required'])
// Why remote steering was kept off on start, as the status and panel say it.
const STEERING_PROBLEMS = Object.freeze({
  not_durable: 'auto-off is set, but the time steering was switched on cannot be saved ' +
    '(the plugin data folder is missing or read-only), so a restart could not keep the ' +
    'auto-off deadline. Make the data folder writable, or set auto-off to 0, and restart the plugin.',
  // #41: auto-off fired, but switching the owner's switch off in the options
  // could not be saved, so the options still say on.
  auto_off_fired: 'auto-off switched it off, but the plugin options could not be saved, ' +
    'so they still say remote steering is on. Untick Remote steering and save, ' +
    'then tick it again to start a new auto-off period.'
})

function createRuntime ({ app, options, version, deps = {} }) {
  const debug = (msg) => { if (app && typeof app.debug === 'function') app.debug(msg) }
  const now = deps.now || Date.now
  const setTimer = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimeout || ((handle) => clearTimeout(handle))
  const rand = deps.random || Math.random

  // deps.pairing exists for the tests; production takes the real module.
  const { redeemCode } = deps.pairing || require('./pairing')

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
    // Remote steering (lib/rpc.js op `put`): the owner's own switch, off unless
    // the options file says exactly `true`. The cloud cannot change it.
    remoteSteering: opts.remote_steering === true,
    // #25: connect to an origin other than yey.boats only when the options
    // file says exactly `true`. Not in the panel on purpose: a deliberate step.
    allowCustomOrigin: opts.allow_custom_origin === true,
    // #22: switch remote steering off this many hours after it was turned on.
    // 0 (the default) never does.
    remoteSteeringAutoOffHours: Math.max(0, Number(opts.remote_steering_auto_off_hours) || 0),
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

  function applyStored (saved) {
    const routing = routingToCfg(saved.routing)
    cfg.cloudOrigin = routing.cloudOrigin
    cfg.tenant = routing.tenant
    cfg.project = routing.project
    cfg.bundleId = routing.bundleId
    cfg.boatId = String(saved.boat_id || '')
    cfg.boatCredential = String(saved.boat_credential || '')
    // The consent op's URL as the connection document named it; without one
    // (a boat connected before consent existed) cloud-client builds it from
    // the routing, like every other public op.
    cfg.opUrls = saved.consent_url ? { signalk_boat_consent: String(saved.consent_url) } : {}
  }
  const stored = state.read()
  applyStored(stored)
  // A key left in the options of an install that is already connected has
  // nothing left to do; it carries the credential, so it goes.
  if (opts.key && cfg.boatId && cfg.boatCredential && cfg.cloudOrigin) {
    const { key, ...rest } = opts
    scrubOptions(migrateLegacyOptions(rest, state).cleaned)
  } else if (migration.legacyKeys.length) {
    // (Not both: the scrub above already drops the legacy keys, and saving
    // migration.cleaned first would write the key, credential and all, again.)
    // Only scrub once the private copy is really on disk: with a file, read()
    // reads the file, so a write that fell back to memory (read-only data dir)
    // shows up here as a missing credential and the options are left alone.
    const after = state.read()
    if (!opts.boatCredential || after.boat_credential) scrubOptions(migration.cleaned)
  }

  // ── Remote steering: audit log and auto-off (#22) ──────────────────────────
  const steeringAudit = deps.steeringAudit || createSteeringAudit({ dir: dataDir, now, debug })
  // When the switch went on, kept in private state so a restart (SignalK
  // restarts the plugin on every settings save) does not restart the clock.
  // Switched off, it is forgotten: turning it on again starts a new period.
  // The start time is also held here: with a read-only data dir the patch does
  // not reach the file, and auto-off must still fire (#33).
  let steeringOnSince = ''
  // Fail closed (#39): with auto-off set, the start time must be on disk, or a
  // restart would start the clock again (or turn steering back on after
  // auto-off fired and the options save failed on the same read-only disk).
  // Then remote steering stays off until the data dir is writable again.
  let steeringProblem = ''
  function keepSteeringOff (problem) {
    cfg.remoteSteering = false
    steeringOnSince = ''
    steeringProblem = problem
    const msg = `Remote steering is off: ${STEERING_PROBLEMS[problem]}`
    debug(`yey connector: ${msg}`)
    if (app && typeof app.setPluginStatus === 'function') {
      try { app.setPluginStatus(msg) } catch { /* best effort */ }
    }
  }
  if (cfg.remoteSteering && stored.remote_steering_auto_off_fired) {
    // #41: auto-off fired and the options save that switches the owner's
    // switch off failed (the data dir itself is writable): the switch still
    // reads on, but this is not the owner turning it on again.
    keepSteeringOff('auto_off_fired')
  } else if (cfg.remoteSteering) {
    steeringOnSince = String(stored.remote_steering_on_since || '') || new Date(now()).toISOString()
    if (!stored.remote_steering_on_since) state.patch({ remote_steering_on_since: steeringOnSince })
    const durable = Boolean(state.file) &&
      String(state.read().remote_steering_on_since || '') === steeringOnSince
    if (cfg.remoteSteeringAutoOffHours && !durable) keepSteeringOff('not_durable')
  } else if (stored.remote_steering_on_since || stored.remote_steering_auto_off_fired) {
    // Seen off: the next switch-on starts a new period.
    state.patch({ remote_steering_on_since: '', remote_steering_auto_off_fired: false })
  }
  let steeringAutoOffTimer = null
  function steeringOffAtMs () {
    if (!cfg.remoteSteering || !cfg.remoteSteeringAutoOffHours) return 0
    const since = Date.parse(state.read().remote_steering_on_since || steeringOnSince || '')
    return Number.isFinite(since) ? since + cfg.remoteSteeringAutoOffHours * 3600e3 : 0
  }
  /** Switch remote steering off if its time is up; true while it is still on. */
  function checkSteeringAutoOff () {
    if (!cfg.remoteSteering) return false
    const offAt = steeringOffAtMs()
    if (!offAt || now() < offAt) return true
    cfg.remoteSteering = false
    steeringOnSince = ''
    const at = new Date(now()).toISOString()
    // The marker (#41) keeps it off across a restart until the options save
    // below has switched the owner's switch off.
    state.patch({ remote_steering_on_since: '', remote_steering_auto_off_at: at, remote_steering_auto_off_fired: true })
    const after = state.read()
    // A read-only disk with a stale start time on it fires at once, every
    // time: say why (#41).
    if (!state.file || after.remote_steering_auto_off_at !== at) steeringProblem = 'not_durable'
    const msg = `Remote steering switched off automatically after ${cfg.remoteSteeringAutoOffHours} h` +
      (steeringProblem === 'not_durable' ? `. ${STEERING_PROBLEMS.not_durable}` : '')
    debug(`yey connector: ${msg}`)
    steeringAudit.record({ path: null, outcome: 'auto_off',
      detail: `remote_steering_auto_off_hours=${cfg.remoteSteeringAutoOffHours}` })
    if (app && typeof app.setPluginStatus === 'function') {
      try { app.setPluginStatus(msg) } catch { /* best effort */ }
    }
    // The owner's switch in the options file goes off too, so the panel shows
    // it off and a restart does not turn it back on.
    if (app && typeof app.savePluginOptions === 'function') {
      try {
        // migration.cleaned is the start-time options: on a connected boat its
        // `key` (it carries the credential) was already scrubbed, so it stays out.
        // Only when the credential is really on disk, as in the start-time
        // scrub: with no data dir, or a read-only one, the key in the options
        // is the only durable copy, and dropping it would disconnect the boat
        // on the next restart (#33).
        const { key, ...withoutKey } = migration.cleaned
        const connected = cfg.boatId && cfg.boatCredential && cfg.cloudOrigin
        const durable = Boolean(state.file) && Boolean(state.read().boat_credential)
        app.savePluginOptions({ ...(connected && durable ? withoutKey : migration.cleaned), remote_steering: false }, (err) => {
          if (err) {
            debug(`yey connector: could not save remote_steering off (${err.message})`)
            return
          }
          state.patch({ remote_steering_auto_off_fired: false })
        })
      } catch (err) {
        debug(`yey connector: could not save remote_steering off (${err && err.message})`)
      }
    }
    return false
  }
  function armSteeringAutoOff () {
    if (steeringAutoOffTimer) { clearTimer(steeringAutoOffTimer); steeringAutoOffTimer = null }
    if (!checkSteeringAutoOff()) return
    const offAt = steeringOffAtMs()
    if (!offAt) return
    // setTimeout overflows past ~24.8 days: wake at most hourly and re-check.
    steeringAutoOffTimer = setTimer(() => { steeringAutoOffTimer = null; armSteeringAutoOff() },
      Math.max(1000, Math.min(offAt - now(), 3600e3)))
  }
  armSteeringAutoOff()

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
  // Re-discovery. The catalog is what the cloud builds the plan from, and it
  // used to be taken once per connection. A boat whose instruments come up
  // after the connector (the normal power-up order) then reported a catalog
  // without them, got a plan that asked for nothing, and sent nothing until it
  // happened to reconnect. A sample on a path the last catalog did not have
  // marks it stale; tick() re-discovers at most once per REDISCOVER_MIN_MS and
  // says hello again when paths were added, so the cloud re-plans at once.
  let unseenPaths = false
  let lastDiscoverMs = 0
  let subscription = null
  // The AIS relay (lib/ais.js): a second, vessels.* subscription, open only
  // while the running plan carries the consented `ais` item.
  let aisSubscription = null
  let selfMmsi = ''
  const ais = createAisCollector({
    isSelf: (context, mmsi) =>
      (typeof source.selfContext === 'function' && context === source.selfContext()) ||
      (Boolean(selfMmsi) && mmsi === selfMmsi)
  })
  let lastCatalog = stored.catalog || null
  let lastSentMs = 0
  // The connection document fetched by resolveConnection(), waiting for the
  // owner to confirm the boat. Memory only: it holds a one-time code that lives
  // 15 minutes, and a restart simply means pasting the link again.
  let pending = null
  // Consent (#441 phase 2). consentStatus: what the cloud last said about this
  // boat's acceptance (token claim or the consent op), null if it never said.
  // consentDoc: the last summary fetched for a connected boat, kept so the
  // owner approves exactly what they were shown.
  let consentStatus = parseStatus(stored.consent_status)
  let consentDoc = null
  // The owner-chosen display name (lib/display-name.js). nameSync is what the
  // panel says about it: '' (nothing known yet), 'synced', 'pending' (renamed
  // here, yey.boats has not confirmed yet) or 'unsupported' (the cloud
  // answered a hello without reply.boat: it predates the protocol).
  let nameSync = ''
  // cloud clock minus ours, from reply.boat.server_time; a rename here is
  // stamped on the cloud's clock so a boat whose clock is off by an hour does
  // not lose (or win) every last-writer-wins comparison.
  let clockSkewMs = 0
  // A rename here asks for a hello at the next tick rather than at the next
  // heartbeat (up to transport.heartbeat_s later).
  let helloDue = false

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
          selfMmsi = String((vessel && vessel.mmsi) || '')
          if (signalk.version || vessel.name || vessel.mmsi) cached = { signalk, vessel }
          return buildHello({ version, signalk, vessel, bufferBytes: cfg.bufferBytes,
                              displayName: displayNames.helloField(state.read()) })
        }
        return buildHello({
          version, signalk: cached.signalk, vessel: cached.vessel, bufferBytes: cfg.bufferBytes,
          displayName: displayNames.helloField(state.read())
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
    if (!sample || !sample.path) return
    if (!unseenPaths) {
      const known = lastCatalog && lastCatalog.paths
      // No catalog yet: the connect cycle's own discovery covers it.
      if (known && !lastCatalog.truncated && !(sample.path in known)) unseenPaths = true
    }
    if (!active) return
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

  /** reply.boat: the cloud's view of the display name, on every hello reply. */
  function noteCloudBoat (raw) {
    const cloud = displayNames.parseCloudBoat(raw)
    if (!cloud) {
      // An older cloud: renames here stay here until it learns the protocol.
      nameSync = 'unsupported'
      return
    }
    if (cloud.server_ms !== null) clockSkewMs = cloud.server_ms - now()
    const saved = state.read()
    const { patch, synced } = displayNames.reconcile(saved, cloud)
    if (patch) {
      state.patch(patch)
      if (patch.display_name && patch.display_name !== saved.display_name) {
        debug(`yey connector: renamed on yey.boats to "${patch.display_name}"`)
      }
    }
    nameSync = synced ? 'synced' : 'pending'
  }

  async function handshake () {
    helloDue = false
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
    noteCloudBoat(reply && reply.boat)
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
      // SignalK's Dashboard → Connection activity lists a plugin only once it
      // reports what it sent to other hosts. Count values, not batches.
      if (app && typeof app.reportOutputMessages === 'function') {
        try { app.reportOutputMessages(batch.records.length) } catch { /* cosmetic */ }
      }
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
    lastDiscoverMs = now()
    unseenPaths = false
    state.patch({ catalog })
    await publishFn('yey.boat.catalog', { catalog, diff }, {})
    return { catalog, diff }
  }

  async function tick () {
    const heartbeatMs = Math.max(1, Number(transport.heartbeat_s) || 300) * 1000
    const sinceDiscover = now() - lastDiscoverMs
    // Samples flag new paths only while gathering is on, and an empty plan
    // turns gathering off: that boat would never notice its instruments
    // arriving. So also look at the tree itself every REDISCOVER_TREE_MS.
    if (!unseenPaths && lastCatalog && lastCatalog.paths && !lastCatalog.truncated &&
        sinceDiscover >= REDISCOVER_TREE_MS) {
      lastDiscoverMs = now()
      try {
        const known = lastCatalog.paths
        unseenPaths = leafPaths(await source.selfTree()).some((p) => !(p in known))
      } catch { /* SignalK is down; the next check will tell */ }
      if (unseenPaths) lastDiscoverMs = 0
    }
    if (unseenPaths && now() - lastDiscoverMs >= REDISCOVER_MIN_MS) {
      const { diff } = await discover()
      // A new path only matters to the cloud if it can now be planned: ask.
      if (diff.added.length) await handshake()
    }
    if (helloDue || now() - lastHelloMs >= heartbeatMs) await handshake()
    syncAis()
    collectAis()
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
    if (CONSENT_LINK_ERRORS.has(String(why))) {
      // Park: no gathering (nobody approved keeping it), no redial loop. The
      // owner's approval in the panel (acceptConsent) dials again.
      gatherBlocked = String(why)
      syncGathering()
      try { uplink.close() } catch { /* already gone */ }
      consentStatus = { ...(consentStatus || {}), state: (consentStatus && consentStatus.state) || 'missing', allowed: false }
      runState = 'consent_required'
      detail = 'yey.boats needs your approval before anything is sent — open Plugin Config → yey — cloud connector'
      attempt = 0
      return
    }
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
    syncAis()
  }

  /** The AIS relay follows the plan: open iff gathering AND the plan carries the
   *  `ais` mapping (consented, and not on the local deny list — applyPlan has
   *  already dropped it otherwise) AND this source can see other vessels. */
  function syncAis () {
    const want = shouldGather() && Boolean(aisMapping(active)) &&
      typeof source.subscribeVessels === 'function'
    if (want && !aisSubscription) {
      aisSubscription = source.subscribeVessels(
        (sample) => ais.onSample(sample, now()),
        (why) => {
          aisSubscription = null
          // AIS is optional: a dead vessels stream must not take the boat's own
          // data down with it. It reopens on the next syncGathering.
          debug(`yey connector: AIS stream closed (${why})`)
        })
    } else if (!want && aisSubscription) {
      aisSubscription.close()
      aisSubscription = null
    }
  }

  /** Move due AIS targets into the buffer, through the same budget as
   *  everything else (low priority: sheds first). */
  function collectAis () {
    const mapping = aisMapping(active)
    if (!mapping || !aisSubscription) return
    const nowMs = now()
    for (const target of ais.drain(nowMs, mapping)) {
      const record = {
        t: nowMs,
        priority: mapping.priority || 'low',
        n: mapping.as || AIS_PATH,
        p: AIS_PATH,
        v: target,
        ts: new Date(nowMs).toISOString(),
        plan_id: active.plan_id,
        plan_version: active.version
      }
      const admitted = budget.admit(
        { bytes: JSON.stringify(record).length, priority: record.priority }, nowMs)
      if (!admitted.admit) {
        debug(`yey connector: budget shed AIS ${target.mmsi} (${admitted.reason})`)
        continue
      }
      buffer.append(record)
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

  // Cloud -> boat queries (lib/rpc.js). The policy is read FRESH on every
  // request — consent, the deny list and the running plan can all change while
  // the plugin runs, and a stale copy is how a narrowed consent keeps answering.
  const rpc = (deps.createRpcServer || createRpcServer)({
    app,
    getSource: () => source,
    policy: () => ({
      consent,
      deny: cfg.deny,
      mappings: active && Array.isArray(active.mappings) ? active.mappings : [],
      onRequest: active && Array.isArray(active.on_request) ? active.on_request : []
    }),
    getCatalog: () => lastCatalog,
    publish: (subject, payload, opt) => publishFn(subject, payload, opt),
    boatId: () => cfg.boatId,
    // Read fresh on every put; the auto-off deadline is checked here too, so
    // it holds even if the timer is late.
    remoteSteering: () => checkSteeringAutoOff(),
    audit: (entry) => steeringAudit.record(entry),
    // The one steering policy (#28); its replay ids persist in the data dir.
    steeringPolicy: deps.steeringPolicy || createSteeringPolicy({
      dir: dataDir, now, debug, boatId: () => cfg.boatId
    }),
    version,
    setStatus: (msg) => {
      if (app && typeof app.setPluginStatus === 'function') app.setPluginStatus(msg)
    },
    now,
    debug
  })
  // yey.boats dashboards for other plugins (lib/dashboards.js), behind a
  // yey.boats login linked on this boat: the pairing alone does not reach them.
  // Asked of the cloud over this uplink; the grant lives in the private state
  // file, and a re-pair or unpair forgets it.
  const dashboards = createDashboards({
    request: (subject, payload, opt) => uplink.request(subject, payload, opt),
    isConnected: () => running && Boolean(cfg.boatId && cfg.boatCredential && cfg.cloudOrigin) &&
      Boolean((uplink.state() || {}).connected),
    state,
    now
  })

  if (typeof uplink.onEvent === 'function') {
    uplink.onEvent(REQUEST_EVENT, (envelope) => {
      rpc.handle(envelope).catch((err) => debug(`yey connector: rpc failed (${err && err.message})`))
    })
  }

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
      noteConsentStatus((uplink.state() || {}).consent)
      detail = 'saying hello'
      await handshake()
      syncGathering()
      try {
        const hadCatalog = Boolean(lastCatalog && lastCatalog.paths)
        const { diff } = await discover()
        // The hello above was planned against the catalog the cloud had BEFORE
        // this one. When it gained paths, re-plan now rather than at the next
        // heartbeat (up to transport.heartbeat_s later).
        // A first-ever catalog needs no second hello: with no catalog the cloud
        // plans from the consent list, which already covers everything sent.
        if (hadCatalog && diff.added.length) await handshake()
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
    armSteeringAutoOff()       // again after a stop(); a no-op unless auto-off is set
    if (!cfg.enabled) { runState = 'disabled'; detail = 'sending is switched off'; return }
    if (!cfg.boatId || !cfg.boatCredential || !cfg.cloudOrigin) {
      // A key in the options file is a provisioned install: connect with it
      // now, then drop it from the options (it carries the credential).
      if (opts.key && cfg.connectionUrl && !provisioning) {
        provisioning = true
        try {
          await connectWithKey({ url: cfg.connectionUrl, key: opts.key, provisioned: true })
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
    if (steeringAutoOffTimer) { clearTimer(steeringAutoOffTimer); steeringAutoOffTimer = null }
    // A pending suppressed-refusals count is written now, not lost (#33).
    if (typeof rpc.stop === 'function') { try { rpc.stop() } catch { /* best effort */ } }
    if (subscription) { subscription.close(); subscription = null }
    if (aisSubscription) { aisSubscription.close(); aisSubscription = null }
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
      remote_steering: cfg.remoteSteering,
      remote_steering_auto_off: steeringAutoOffView(),
      // The last steering commands, newest last (the audit file has them all).
      steering_log: steeringAudit.recent(10),
      buffered: stats.count,
      buffer_bytes: stats.bytes,
      buffer_dropped: stats.dropped,
      budget: budget.stats(now()),
      transport,
      rpc: rpc.stats(),
      on_request: active && Array.isArray(active.on_request) ? active.on_request : [],
      retry_attempt: attempt,
      // True while the SignalK stream is open — including through a cloud
      // outage, which is when it matters.
      gathering: Boolean(subscription),
      consent_status: consentStatus,
      consent_record: state.read().consent_record || null,
      // AIS relay: on only with a consented, not-denied `ais` plan item.
      ais: { relaying: Boolean(aisSubscription), targets: ais.size() },
      connection: connectionView(),
      allow_custom_origin: cfg.allowCustomOrigin,
      origin_warning: originWarning(),
      // The yey.boats login linked for dashboards: never the grant or the code.
      dashboards: dashboards.statusView()
    }
  }

  function steeringAutoOffView () {
    const saved = state.read()
    const offAt = steeringOffAtMs()
    return {
      hours: cfg.remoteSteeringAutoOffHours,
      on_since: cfg.remoteSteering ? String(saved.remote_steering_on_since || steeringOnSince || '') : '',
      off_at: offAt ? new Date(offAt).toISOString() : '',
      switched_off_at: String(saved.remote_steering_auto_off_at || ''),
      // 'not_durable' when remote steering was kept off on start (#39).
      problem: steeringProblem,
      problem_text: steeringProblem ? STEERING_PROBLEMS[steeringProblem] : ''
    }
  }

  /** What the panel shows: never the credential, the code or the routing
   *  internals beyond the origin it links to. */
  function connectionView () {
    const saved = state.read()
    const paired = pairingStatus(saved) === 'paired' && Boolean(cfg.cloudOrigin)
    return {
      status: paired ? 'connected' : (pending ? (pending.mode === 'key' ? 'consent' : 'confirming') : 'not_connected'),
      origin: cfg.cloudOrigin || (pending ? pending.doc.routing.origin : ''),
      origin_trusted: isTrustedOrigin(cfg.cloudOrigin || (pending ? pending.doc.routing.origin : '') ||
        'https://yey.boats'),
      origin_unencrypted: isUnencryptedOrigin(cfg.cloudOrigin || (pending ? pending.doc.routing.origin : '')),
      display_name: String(saved.display_name || (saved.identity && saved.identity.name) || ''),
      // 'synced' | 'pending' | 'unsupported' | '' — see setDisplayName.
      display_name_sync: paired ? nameSync : '',
      mode: String(saved.connected_via || (saved.migrated_from_options ? 'legacy' : '')),
      last_sent_at: lastSentMs ? new Date(lastSentMs).toISOString() : '',
      pending: pending ? { boat: pending.doc.boat, expires_in_s: pending.doc.expires_in_s,
                           identity: pending.identity } : null
    }
  }

  /** Store a connected boat privately and go live. */
  async function adopt ({ doc, boatId, credential, displayName, identity, via, subscribedPaths,
    consentRecord, status }) {
    const patch = {
      routing: doc.routing,
      boat_id: boatId,
      boat_credential: credential,
      display_name: displayName || '',
      // The name came from the pairing answer: nobody chose it on this boat.
      display_name_set_at: '',
      connected_via: via,
      consent_url: doc.consent_url || '',
      claim_id: '',
      claim_secret: ''
    }
    if (identity) patch.identity = identity
    if (consentRecord) patch.consent_record = consentRecord
    if (status) { consentStatus = status; patch.consent_status = status }
    state.patch(patch)
    // A (re-)pair: the last pairing's login link and grant do not carry over.
    dashboards.reset()
    applyStored(state.read())
    if (Array.isArray(subscribedPaths) && subscribedPaths.length) setConsent(subscribedPaths)
    pending = null
    await goLive()
  }

  // deps.fetch is the HTTP transport (tests inject a fake); the parsing and
  // error typing are always the real ones.
  // The origin check (#25) runs here too, so it holds whatever does the fetch:
  // the pasted link before any request, the routing origin after.
  const fetchDoc = async (url) => {
    const allowCustomOrigin = cfg.allowCustomOrigin
    checkOrigin(url, { allowCustomOrigin })
    const doc = await (deps.fetchConnectionDocument ||
      ((u) => fetchConnectionDocument(u, { fetchImpl: deps.fetch, allowCustomOrigin })))(url)
    checkOrigin(doc.routing.origin, { allowCustomOrigin })
    return doc
  }

  /** '' normally; otherwise the warning the status line and panel show. */
  function originWarning () {
    const origin = cfg.cloudOrigin || (pending ? pending.doc.routing.origin : '')
    if (origin && !isTrustedOrigin(origin)) {
      return `WARNING: ${cfg.cloudOrigin ? 'connected' : 'connecting'} to ${origin}, which is not yey.boats` +
        (cfg.allowCustomOrigin ? ' (allow_custom_origin is on)' : '')
    }
    if (cfg.allowCustomOrigin) {
      return 'WARNING: allow_custom_origin is on: connection links from sites other than yey.boats are accepted'
    }
    return ''
  }

  /** Step 1 of connect-by-URL: fetch the document, read the boat from SignalK. */
  function assertNotConnected () {
    if (cfg.boatId && cfg.boatCredential && cfg.cloudOrigin) {
      const err = new Error('already connected; disconnect first')
      err.code = 'already_connected'
      throw err
    }
  }

  async function resolveConnection ({ url: raw } = {}) {
    assertNotConnected()
    // The link, the link behind autofill junk, or the bare code.
    const url = normalizeConnectionInput(raw)
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
    pending = { mode: 'url', url: String(url).trim(), doc, identity, at: now() }
    return {
      status: 'confirm',
      // What was actually fetched, so the panel saves the clean link.
      url,
      boat: doc.boat,
      expires_in_s: doc.expires_in_s,
      origin: doc.routing.origin,
      origin_trusted: isTrustedOrigin(doc.routing.origin),
      origin_unencrypted: isUnencryptedOrigin(doc.routing.origin),
      identity,
      // The summary the owner approves next; null from a cloud without consent.
      consent: doc.consent
    }
  }

  /** Step 2: the owner confirmed (maybe corrected) the boat and approved the
   *  consent summary — pair with both in one call. Nothing is paired, stored
   *  or sent unless all three consent items are ticked (when the cloud asks
   *  for consent at all). In key mode this records the acceptance instead. */
  async function confirmConnection ({ identity, consent } = {}) {
    if (!pending) {
      const err = new Error('paste the connection link first')
      err.code = 'nothing_to_confirm'
      throw err
    }
    if (pending.mode === 'key') return confirmKey({ consent })
    const confirmed = normalizeIdentity(identity || pending.identity)
    pending.identity = confirmed
    const { doc } = pending
    const pairCfg = { ...routingToCfg(doc.routing), opUrls: { signalk_boat_pair: doc.pair_url } }
    const extra = { identity: confirmed }
    if (doc.consent) {
      extra.consent = buildSubmission(doc.consent, (consent || {}).accepted,
        { deny: cfg.deny, version })
    }
    const hello = await helloFor(confirmed)
    let paired
    try {
      paired = await redeemCode(pairCfg, doc.code, hello, deps, extra)
    } catch (err) {
      throw refreshOnStale(err, (fresh) => { pending.doc = { ...pending.doc, consent: fresh } })
    }
    const status = parseStatus(paired.consent)
    await adopt({
      doc,
      boatId: paired.boat_id,
      credential: paired.boat_credential,
      displayName: paired.display_name || confirmed.name || doc.boat.display_name,
      identity: confirmed,
      via: 'url',
      subscribedPaths: doc.consent ? sendPaths(doc.consent) : paired.subscribed_paths,
      consentRecord: doc.consent
        ? localRecord(doc.consent, extra.consent, status, 'url', new Date(now()).toISOString())
        : null,
      status
    })
    return { status: 'connected', boat_id: paired.boat_id,
             display_name: String(state.read().display_name || '') }
  }

  /** A `consent_stale` refusal carries the summary as it is now: keep it, so
   *  the panel can show it and the owner approves the current one. */
  function refreshOnStale (err, keep) {
    if (err && err.code === 'consent_stale' && err.consent) {
      let fresh = null
      try { fresh = parseConsentDocument(err.consent) } catch { fresh = null }
      if (fresh) { keep(fresh); err.consent = fresh } else delete err.consent
    }
    return err
  }

  /** Key mode: URL for the routing, key for the boat. The owner accepted the
   *  terms when yey.boats issued the key; the boat-side summary is still shown
   *  and approved here before anything is sent. `provisioned` (a key in the
   *  settings file, no one at the panel) relies on the acceptance captured at
   *  key issue; the cloud refuses the token if there is none. */
  async function connectWithKey ({ url: raw, key, provisioned = false } = {}) {
    assertNotConnected()
    const parsed = parseKey(key)            // before any network: a typo fails fast
    const url = normalizeConnectionInput(raw)
    const doc = await fetchDoc(url)
    if (doc.consent_url && !provisioned) {
      const kcfg = { ...routingToCfg(doc.routing), opUrls: { signalk_boat_consent: doc.consent_url } }
      const read = await callConsentOp(kcfg, { boatId: parsed.boatId, credential: parsed.credential }, deps)
      if (!read.consent) {
        const err = new Error('yey.boats sent no consent summary; try again shortly')
        err.code = 'consent_unavailable'
        throw err
      }
      pending = { mode: 'key', url: String(url).trim(), doc, parsed, kcfg, consent: read.consent, at: now() }
      return {
        status: 'consent',
        boat: doc.boat,
        origin: doc.routing.origin,
        origin_trusted: isTrustedOrigin(doc.routing.origin),
        origin_unencrypted: isUnencryptedOrigin(doc.routing.origin),
        consent: read.consent,
        consent_status: read.status
      }
    }
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

  async function confirmKey ({ consent } = {}) {
    const p = pending
    const submission = buildSubmission(p.consent, (consent || {}).accepted, { deny: cfg.deny, version })
    let res
    try {
      res = await callConsentOp(p.kcfg,
        { boatId: p.parsed.boatId, credential: p.parsed.credential, consent: submission }, deps)
    } catch (err) {
      throw refreshOnStale(err, (fresh) => { p.consent = fresh })
    }
    await adopt({
      doc: p.doc,
      boatId: p.parsed.boatId,
      credential: p.parsed.credential,
      displayName: p.doc.boat.display_name,
      via: 'key',
      subscribedPaths: sendPaths(p.consent),
      consentRecord: localRecord(p.consent, submission, res.status, 'key', new Date(now()).toISOString()),
      status: res.status
    })
    return { status: 'connected', boat_id: p.parsed.boatId,
             display_name: String(state.read().display_name || '') }
  }

  function noteConsentStatus (raw) {
    const parsed = parseStatus(raw)
    if (!parsed) return
    consentStatus = parsed
    state.patch({ consent_status: parsed })
  }

  function assertConnected () {
    if (!(cfg.boatId && cfg.boatCredential && cfg.cloudOrigin)) {
      const err = new Error('connect to yey.boats first')
      err.code = 'not_connected'
      throw err
    }
  }

  /** A connected boat: the summary to approve and the boat's consent status
   *  (boats connected before consent existed, a re-consent, a widened plan). */
  async function consentDocument () {
    assertConnected()
    const res = await callConsentOp(cfg, { boatId: cfg.boatId, credential: cfg.boatCredential }, deps)
    consentDoc = res.consent
    if (res.status) noteConsentStatus(res.status)
    return { consent: res.consent, consent_status: consentStatus }
  }

  /** A connected boat: record the owner's approval, then (if the cloud had
   *  parked the link for want of it) dial again. */
  async function acceptConsent ({ accepted } = {}) {
    assertConnected()
    if (!consentDoc) await consentDocument()
    const submission = buildSubmission(consentDoc, accepted, { deny: cfg.deny, version })
    let res
    try {
      res = await callConsentOp(cfg,
        { boatId: cfg.boatId, credential: cfg.boatCredential, consent: submission }, deps)
    } catch (err) {
      throw refreshOnStale(err, (fresh) => { consentDoc = fresh })
    }
    const record = localRecord(consentDoc, submission, res.status, 'panel', new Date(now()).toISOString())
    state.patch({ consent_record: record })
    if (res.status) noteConsentStatus(res.status)
    setConsent(record.send)
    if (gatherBlocked === 'consent_required') {
      gatherBlocked = ''
      runState = 'connecting'
      detail = ''
      if (running) cycle()
      else goLive()
    }
    return { status: 'approved', consent_status: consentStatus, consent_record: record }
  }

  /** The owner renamed the boat in the panel. Stored at once (the panel shows
   *  it), sent with the next hello — at the next tick, not the next heartbeat —
   *  and kept, last writer wins, against a rename on yey.boats. */
  async function setDisplayName ({ name } = {}) {
    assertConnected()
    const value = displayNames.requireDisplayName(name)
    const setAt = new Date(now() + clockSkewMs).toISOString()
    state.patch({ display_name: value, display_name_set_at: setAt })
    nameSync = nameSync === 'unsupported' ? 'unsupported' : 'pending'
    helloDue = true
    return { display_name: value, display_name_set_at: setAt, display_name_sync: nameSync }
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
    statusMessage: () => {
      const line = runState === 'stopped' ? 'stopped' : (detail ? `${runState} — ${detail}` : runState)
      const warning = originWarning()
      return warning ? `${warning}. ${line}` : line
    },
    snapshot,
    setConsent,
    handshake,
    onSample,
    flush,
    discover,
    tick,

    resolveConnection,
    confirmConnection,
    connectWithKey,
    consentDocument,
    acceptConsent,
    setDisplayName,
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
      consentStatus = null
      consentDoc = null
      nameSync = ''
      helloDue = false
      dashboards.reset()
      state.write({})
      return { ok: true }
    },

    rpc,
    // The in-process API index.js offers as app.yeyDashboards.
    dashboards: dashboards.api,
    __setPublish: (fn) => { publishFn = fn },
    __setSource: (s) => { source = s; identity.reset() }
  }
  return runtimeApi
}

module.exports = { createRuntime, TERMINAL_LINK_ERRORS, CONSENT_LINK_ERRORS }
