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

    // The admin UI shows the configurator panel (public/remoteEntry.js,
    // keyword `signalk-plugin-configurator`) instead of a form generated from
    // this schema; the schema still describes the options file, and is the form
    // an older admin UI falls back to. Routing, boat id and credential are NOT
    // here: they live in the connector's private state file (lib/state.js).
    // There is no `key` field any more (yey.boats connects by link); a `key`
    // already in an options file (a provisioned install) still connects once
    // and is then removed (lib/runtime.js start()).
    schema: () => ({
      type: 'object',
      title: 'yey — cloud connector',
      description:
        'Get a connection link on yey.boats (Account → Connect a SignalK server), ' +
        'paste it here and confirm your boat.',
      properties: {
        connectionUrl: {
          type: 'string',
          title: 'Connection URL',
          description: 'From yey.boats, for example https://yey.boats/c/ABC-DEF-GHJ (or just the code)',
          default: ''
        },
        remote_steering: {
          type: 'boolean',
          title: 'Allow remote steering from yey.boats (autopilot only)',
          description:
            'Off by default. When on, yey.boats may ask this server to change the ' +
            'autopilot only (steering.autopilot.state, its heading / wind-angle ' +
            'targets and steering.autopilot.actions.*), carried out by your own ' +
            'autopilot plugin. Nothing else can be written. You must ALSO turn ' +
            'remote steering on in the yey.boats app, with a code sent to your ' +
            'Telegram. The "Never send these paths" list below still applies. ' +
            'Untick to switch it off immediately.',
          default: false
        },
        advanced: {
          type: 'object',
          title: 'Advanced',
          properties: {
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

    // Routes are served under /plugins/signalk-yey-connector/…: the calls the
    // Plugin Config panel makes (connect/resolve, connect/confirm, connect/key,
    // consent, status, disconnect). There is no standalone page any more.
    registerWithRouter: (router) => {
      router.use(jsonBody())
      registerRoutes(router, () => runtime)
    }
  }

  return plugin
}
