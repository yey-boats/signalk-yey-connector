'use strict'
/** Capture a real SignalK trace once, so N synthetic boats can replay it.
 *
 *  OPERATOR-RUN, against a LOCAL signalk-server fed by the simulator — never a
 *  deployed one. The simulator is a SignalK CLIENT (simulator cli.py:
 *  --signalk-host is where it connects OUT to), publishes ONE vessel with a
 *  module-constant MMSI (engine/signalk_writer.py SELF_MMSI) and ticks on a
 *  literal 1.0s (engine/runner.py drive()). So N boats cannot be N simulators
 *  without N signalk-servers too. Capture once, replay N times
 *  (loadrig/source.js).
 *
 *    SIGNALK_URL=http://localhost:3000 CAPTURE_SECONDS=300 node loadrig/capture.js
 *
 *  Output: { capturedAt, baseUrl, seconds, server, vessel, self, meta,
 *            deltas: [{ t, path, value }] }  with t in ms from the start.
 *  loadrig/trace.json is gitignored: it is megabytes and it is reproducible.
 */
const fs = require('node:fs')
const path = require('node:path')

async function captureTrace ({ baseUrl = 'http://localhost:3000', token = '',
                               seconds = 120, out = 'loadrig/trace.json' } = {},
                             deps = {}) {
  const source = deps.source ||
    require('../lib/signalk-source').createHttpSource({ baseUrl, token })
  const clock = deps.now || Date.now
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  // The tree first: collectMeta and vesselIdentity both take it, and without it
  // collectMeta has no leaf paths to describe and returns {}.
  const self = await source.selfTree()
  const [meta, server, vessel] = await Promise.all([
    source.collectMeta(self), source.serverInfo(), source.vesselIdentity(self)
  ])

  const started = clock()
  const deltas = []
  let lostWhy = ''
  const sub = source.subscribe((sample) => {
    deltas.push({ t: clock() - started, path: sample.path, value: sample.value })
  }, (why) => { lostWhy = String(why || 'closed') })
  await sleep(seconds * 1000)
  sub.close()
  // A trace cut short by a dropped delta socket is a trace of the outage, not
  // of the boat. Refuse it rather than let N boats replay a gap.
  if (lostWhy) throw new Error(`the SignalK delta stream closed mid-capture (${lostWhy})`)
  if (!deltas.length) throw new Error(`no deltas in ${seconds}s from ${baseUrl} — is the simulator publishing?`)

  const trace = { capturedAt: new Date(clock()).toISOString(), baseUrl, seconds,
                  server, vessel, self, meta, deltas }
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(trace))
  }
  return { path: out, deltas: deltas.length,
           paths: new Set(deltas.map((d) => d.path)).size, trace }
}

module.exports = { captureTrace }

if (require.main === module) {
  captureTrace({
    baseUrl: process.env.SIGNALK_URL || 'http://localhost:3000',
    token: process.env.SIGNALK_TOKEN || '',
    seconds: Number(process.env.CAPTURE_SECONDS || 120),
    out: process.env.CAPTURE_OUT || 'loadrig/trace.json'
  }).then(({ trace, ...summary }) => console.log(JSON.stringify(summary)), (e) => {
    console.error(e.message); process.exit(1)
  })
}
