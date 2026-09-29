'use strict'
/** CLI. Every number in the capacity report comes out of one of these.
 *
 *   node loadrig/run.js steady --ns 10,25,50,100,200,400 --minutes 30
 *   node loadrig/run.js herd   --ns 50,100,250,500 --fleet-transport-file curves.json
 *   node loadrig/run.js storm  --n 250 --offline-hours 24 [--mode buffered|link_down]
 *
 *  --service-ms is THE number to vary. It is the mean cloud handler time, and
 *  nothing local can measure it: _boat_values does a Redis HSET, a blocking
 *  InfluxDB POST and a Postgres UPDATE per message, behind a strictly serial
 *  worker. The operator measures it once against staging and the sweeps are
 *  re-run at that value.
 *
 *  --fleet-transport / --fleet-transport-file take boat_capacity.
 *  transport_for_fleet's output as JSON, so the rig never imports Python:
 *  either one transport block, or a map { "<n>": block } — for a map, each N
 *  uses the block of the largest key not above it.
 *
 *  --start-spread-ms <ms> (steady, storm) boots the fleet across this window
 *  instead of the default one hour; 0 is the phase-locked worst case.
 *  --out <name> writes loadrig/out/<name>.json instead of <sweep>.json.
 *  --generated-at <iso> pins the one field that otherwise differs between two
 *  runs with the same seed, so a re-run can be compared byte for byte.
 */
const fs = require('node:fs')
const path = require('node:path')
const { DEFAULT_TRANSPORT } = require('../lib/plan')
const sweeps = require('./sweeps')

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

function numbers (raw, fallback) {
  if (!raw) return fallback
  return String(raw).split(',').map((x) => Number(x.trim())).filter((x) => x > 0)
}

function loadTrace () {
  const p = arg('trace', 'loadrig/trace.json')
  if (!fs.existsSync(p)) {
    console.error(`no trace at ${p} — capture one (node loadrig/capture.js, operator-run ` +
                  'against a LOCAL signalk-server) or derive one offline ' +
                  '(python loadrig/derive-trace.py, needs the simulator importable)')
    process.exit(2)
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** A plan over the paths the trace actually carries, capped at max_mappings
 *  (lib/hello.js LIMITS.max_mappings = 200). */
function planFor (trace, transport) {
  const paths = [...new Set(trace.deltas.map((d) => d.path))].slice(0, 200)
  return {
    schema: 1, plan_id: 'pl_rig', version: 1, __etag: 'etag_rig',
    budget: { max_msgs_per_min: 30, max_bytes_per_hour: 262144 },
    defaults: { policy: 'on_change', min_interval_s: 5, max_interval_s: 300 },
    transport,
    mappings: paths.map((p, i) => ({
      path: p, as: `v${i}`, policy: 'on_change',
      min_interval_s: 10, max_interval_s: 600,
      priority: i < 5 ? 'high' : 'normal'
    }))
  }
}

/** One transport block, or a function of N over a { "<n>": block } map. */
function fleetCurve (raw) {
  const parsed = JSON.parse(raw)
  const keys = Object.keys(parsed)
  if (!keys.length || !keys.every((k) => /^\d+$/.test(k))) return parsed
  const edges = keys.map(Number).sort((a, b) => a - b)
  return (n) => {
    let chosen = edges[0]
    for (const e of edges) if (e <= n) chosen = e
    return parsed[String(chosen)]
  }
}

async function main () {
  const which = process.argv[2]
  const trace = loadTrace()
  const serviceMs = Number(arg('service-ms', 20))
  const maxlen = Number(arg('maxlen', 50000))
  const seed = Number(arg('seed', 1))
  const budget = Number(arg('interactive-budget-ms', 2000))
  const generatedAt = arg('generated-at', null)
  const transportRaw = arg('transport-file')
    ? fs.readFileSync(arg('transport-file'), 'utf8') : arg('transport')
  const transport = transportRaw ? JSON.parse(transportRaw) : { ...DEFAULT_TRANSPORT }
  const plan = planFor(trace, transport)
  const spreadRaw = arg('start-spread-ms', null)
  const common = { trace, plan, seed, serviceMs, maxlen, interactiveBudgetMs: budget,
                   generatedAt,
                   // Default: boot across the budget hour (see sweeps.js). 0 = phase-locked.
                   ...(spreadRaw === null ? {} : { startSpreadMs: Number(spreadRaw) }) }

  let report
  if (which === 'steady') {
    report = await sweeps.steadyState({
      ...common, ns: numbers(arg('ns'), [10, 25, 50, 100, 200, 400]),
      minutes: Number(arg('minutes', 30))
    })
  } else if (which === 'herd') {
    const fleetRaw = arg('fleet-transport-file')
      ? fs.readFileSync(arg('fleet-transport-file'), 'utf8') : arg('fleet-transport')
    report = await sweeps.reconnectHerd({
      ...common, ns: numbers(arg('ns'), [50, 100, 250, 500]),
      waitMs: Number(arg('wait-ms', 900_000)),
      curves: {
        shipped: { ...DEFAULT_TRANSPORT },
        // Whatever boat_capacity.transport_for_fleet produces. Without it, the
        // widest curve the bounds allow, and the report must say which it was.
        fleet: fleetRaw
          ? fleetCurve(fleetRaw)
          : { ...DEFAULT_TRANSPORT, backoff_base_s: 60, reconnect_jitter_pct: 100 }
      }
    })
    report.params.fleetCurveSource = fleetRaw ? 'boat_capacity.transport_for_fleet'
      : 'bounds (backoff_base_s 60, reconnect_jitter_pct 100)'
  } else if (which === 'storm') {
    report = await sweeps.backfillStorm({
      ...common, n: Number(arg('n', 250)),
      offlineHours: Number(arg('offline-hours', 24)),
      drainLimitHours: Number(arg('drain-limit-hours', 6)),
      mode: arg('mode', 'buffered')
    })
  } else {
    console.error('usage: node loadrig/run.js <steady|herd|storm> [flags]')
    process.exit(2)
  }

  const dir = arg('out-dir', 'loadrig/out')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `${arg('out', report.sweep)}.json`)
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report.summary, null, 2))
  console.log(`wrote ${out}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
