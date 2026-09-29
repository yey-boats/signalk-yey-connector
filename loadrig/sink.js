'use strict'
/** The cloud, modelled at the only two places it can hurt us.
 *
 *  1. AN ACK MEANS ENQUEUED, NOT PROCESSED. uplink.publish resolves on the
 *     socket ack and the ingress ack carries a stream_id, i.e. the XADD has
 *     happened and nothing has handled it. The connector commits its buffer on
 *     that ack (lib/runtime.js flush(): buffer.commit on accepted|partial), so
 *     anything merely enqueued is already gone from the boat. A sink that acked
 *     and counted would make a backlog invisible, which is the one thing we are
 *     here to measure.
 *  2. THE CONSUMER IS SERIAL. The platform Data Bus worker claims count=1 and
 *     awaits _process_claim inline (vendor/.../data_bus/worker.py): one message
 *     in flight for the whole bundle, across every subject. And MAXLEN
 *     (stream.py _xadd, approximate=True) trims the OLDEST entries whether or
 *     not the group acknowledged them.
 *
 *  Modelled exactly, not approximately: the real XADD trim is approximate
 *  (whole radix-tree nodes), so the real stream can overshoot MAXLEN a little.
 *  An exact cap is the conservative choice — it evicts no later than Redis does.
 */

// vendor/.../apps/chat/sdk/runtime/data_bus/types.py — same constant lib/uplink.js uses.
const INGRESS_SCHEMA = 'kdcube.data_bus.ingress.v1'

function createSink ({ serviceMs = 20, maxlen = 50000, now = Date.now,
                       plan = null } = {}) {
  // The plan's etag is rig metadata, not part of the plan a boat receives.
  const planEtag = String((plan && plan.__etag) || 'etag_rig')
  const planBody = plan ? Object.fromEntries(
    Object.entries(plan).filter(([k]) => k !== '__etag')) : null

  let seq = 0
  // Strictly FIFO. A plain array with a moving head index instead of shift():
  // shift() is O(n) on a large array and a 50k-deep stream would make the rig
  // measure itself. The array is compacted when the dead head gets large.
  let queue = []            // [{ id, subject, bytes }]
  let head = 0
  // Entries are delivered in order, so the delivered ones are always a PREFIX
  // of the live queue. Tracking its length instead of a per-entry flag keeps
  // enqueue and drain O(1).
  let deliveredPrefix = 0
  let handled = 0
  let evicted = 0
  let evictedUndelivered = 0
  let bytesTotal = 0
  let entries = 0
  let maxUndelivered = 0
  let helloCount = 0
  let lastDrain = null
  // Fractional service time carried between drains, so drain(10) ten times
  // with serviceMs=20 handles five messages rather than none.
  let carryMs = 0
  const perSubject = Object.create(null)
  const hellos = []         // [{ at, boatId }] in arrival order

  const live = () => queue.length - head

  function compact () {
    if (head > 1024 && head * 2 > queue.length) {
      queue = queue.slice(head)
      head = 0
    }
  }

  function enqueue (subject, payload) {
    const bytes = Buffer.byteLength(JSON.stringify(payload || {}), 'utf8')
    bytesTotal += bytes
    entries += 1
    perSubject[subject] = (perSubject[subject] || 0) + 1
    seq += 1
    const id = `${seq}-0`
    queue.push({ id, subject, bytes })
    while (live() > maxlen) {
      head += 1
      evicted += 1
      // MAXLEN trims the head regardless of acknowledgement. If the head was
      // already delivered the prefix simply shrinks; if it was not, a message
      // nobody ever read has just been deleted. That is the silent loss.
      if (deliveredPrefix > 0) deliveredPrefix -= 1
      else evictedUndelivered += 1
    }
    compact()
    const undelivered = live() - deliveredPrefix
    if (undelivered > maxUndelivered) maxUndelivered = undelivered
    return id
  }

  /** Let the serial consumer run for `elapsedMs` of virtual time. */
  function drain (elapsedMs) {
    const svc = Math.max(1, serviceMs)
    const available = carryMs + Math.max(0, elapsedMs)
    const budget = Math.floor(available / svc)
    const take = Math.min(budget, live() - deliveredPrefix)
    if (take > 0) {
      deliveredPrefix += take
      handled += take
    }
    // An idle consumer does not bank time: only the remainder of a busy
    // period carries over.
    carryMs = take < budget ? 0 : available - take * svc
    lastDrain = now()
  }

  return {
    /** An uplink stand-in for one boat. Same surface lib/uplink.js exports. */
    uplinkFor (cfg) {
      const boatId = String((cfg && cfg.boatId) || '')
      let onLost = () => {}
      let connected = false
      return {
        async claimToken () { return { ok: true, federated_token: 'ft', expires_at: 0 } },
        async connect () { connected = true },
        close () { connected = false },
        setOnLost (fn) { onLost = fn },
        state () { return { connected, pending_replies: 0 } },
        /** The socket dropped under the boat (a deploy, a network blip). */
        kill (why) { connected = false; onLost(why) },
        async publish (subject, payload) {
          const id = enqueue(subject, payload)
          return { schema: INGRESS_SCHEMA, status: 'accepted',
                   accepted: [{ message_id: `m_${id}`, stream_id: id }], rejected: [] }
        },
        async request (subject, payload) {
          if (subject === 'yey.boat.hello') {
            helloCount += 1
            hellos.push({ at: now(), boatId })
            // yey_boat_hello, verbatim in shape:
            //   if str(payload.get("plan_etag") or "") == etag and etag: not_modified
            // An empty etag never matches, or a boat with no plan would be told
            // it is up to date and never get one.
            if (planBody && String((payload || {}).plan_etag || '') === planEtag && planEtag) {
              return { kind: 'plan', not_modified: true, etag: planEtag }
            }
            return { kind: 'plan', plan: planBody, etag: planEtag }
          }
          enqueue(subject, payload)
          return {}
        }
      }
    },
    drain,
    reset () {
      queue = []; head = 0; deliveredPrefix = 0; handled = 0; evicted = 0
      evictedUndelivered = 0; bytesTotal = 0; entries = 0; maxUndelivered = 0
      helloCount = 0; hellos.length = 0; carryMs = 0
      for (const k of Object.keys(perSubject)) delete perSubject[k]
    },
    /** Hellos in arrival order, with the boat that sent each. */
    hellos () { return hellos.slice() },
    stats () {
      return {
        queued: live(),
        // What an interactive message would actually wait behind.
        undelivered: live() - deliveredPrefix,
        maxUndelivered,
        handled,
        evicted,
        evictedUndelivered,
        entries,
        bytesTotal,
        bytesPerEntry: entries ? Math.round(bytesTotal / entries) : 0,
        helloCount,
        helloAt: hellos.map((h) => h.at),
        perSubject: { ...perSubject },
        lastDrain
      }
    }
  }
}

module.exports = { createSink, INGRESS_SCHEMA }
