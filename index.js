'use strict'

/**
 * signalk-yey-connector — the SignalK plugin entry shell.
 *
 * This file is deliberately thin: it declares the plugin contract the SignalK
 * server loads (id / name / description / schema / start / stop /
 * statusMessage / registerWithRouter, as evidenced by the only in-house plugin,
 * Instruments-manager/index.js:9-224, :310) and hands everything else to
 * lib/runtime.js. Nothing in here reaches the network, the filesystem or the
 * cloud.
 */

const pkg = require('./package.json')
// Routes are safe to require at load: lib/routes.js pulls in nothing but node
// builtins, so it cannot make this entry file unloadable.
const { registerRoutes, jsonBody } = require('./lib/routes')

// The runtime is required lazily, inside start(), rather than at module load.
// Requiring it here would make this entry file unloadable whenever lib/ is
// incomplete — which is exactly the state the repo is in while the rest of the
// plugin is still being built. Loading it on the first start() is behaviourally
// identical once lib/runtime.js exists (SignalK calls start() after load), and
// it keeps `node --check index.js` and `require('./index.js')` honest today.
let createRuntime
function loadRuntime () {
  if (!createRuntime) ({ createRuntime } = require('./lib/runtime'))
  return createRuntime
}

module.exports = function signalkYeyConnectorPlugin (app) {
  let runtime

  const plugin = {
    id: 'signalk-yey-connector',
    name: 'yey — cloud connector',
    description:
      'Sends the values your subscription plan asks for to yey.boats, over an ' +
      'outbound-only connection. No inbound ports. The plan is managed on the web ' +
      'and shown here read-only.',

    schema: () => ({
      type: 'object',
      title: 'yey — cloud connector',
      description:
        'Not connected yet? Open ' +
        'https://yey.boats/setup?source=plugin — it walks through pairing, what ' +
        'leaves the boat, and the price. Self-hosting is a direction we intend to ' +
        'offer; there is no date.',
      properties: {
        enabled: {
          type: 'boolean', title: 'Send data to yey', default: true
        },
        cloudOrigin: {
          type: 'string', title: 'yey origin', default: 'https://yey.boats'
        },
        tenant: { type: 'string', title: 'Tenant', default: 'home' },
        project: { type: 'string', title: 'Project', default: 'demo' },
        bundleId: {
          type: 'string', title: 'Bundle id', default: 'signalk@2026-06-05'
        },
        signalkUrl: {
          type: 'string',
          title: 'SignalK REST/WS base URL',
          description: 'This server, as this plugin should reach it.',
          default: 'http://localhost:3000'
        },
        signalkToken: {
          type: 'string',
          title: 'SignalK access token (only if security is enabled)',
          default: ''
        },
        boatId: {
          type: 'string', title: 'Boat id (filled in by pairing)', default: ''
        },
        boatCredential: {
          type: 'string',
          title: 'Boat credential (filled in by pairing — keep it secret)',
          default: ''
        },
        deny: {
          type: 'array',
          title: 'Never send these paths (this list always wins over the plan)',
          items: { type: 'string' },
          default: []
        },
        bufferMegabytes: {
          type: 'number', title: 'Offline buffer size (MB)', default: 50
        }
      }
    }),

    start: (options) => {
      runtime = loadRuntime()({ app, options: options || {}, version: pkg.version })
      // start() is async: it returns the first connect cycle. SignalK ignores the
      // return value, and the supervisor already funnels a failed dial into its
      // own retry curve — so the only thing left to do here is make sure an
      // unexpected rejection cannot become an unhandled promise rejection and
      // take the whole server down.
      Promise.resolve(runtime.start()).catch((err) => {
        app.debug(`yey connector: start failed (${err && err.message})`)
      })
    },

    stop: () => {
      if (runtime) runtime.stop()
      runtime = undefined
    },

    statusMessage: () => (runtime ? runtime.statusMessage() : 'stopped'),

    // Routes are served under /plugins/signalk-yey-connector/… — including
    // GET /, which serves public/index.html. That page is where both pairing
    // buttons live and it is the URL statusMessage() tells an unpaired owner to
    // open, so the route and that string ship together. The same file is also
    // mounted at /signalk-yey-connector/ by the SignalK server, because
    // package.json carries the `signalk-webapp` keyword.
    registerWithRouter: (router) => {
      router.use(jsonBody())
      registerRoutes(router, () => runtime)
    }
  }

  return plugin
}
