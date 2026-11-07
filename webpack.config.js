'use strict'

// Builds public/remoteEntry.js: the Plugin Config panel the SignalK admin UI
// loads over Module Federation (keyword `signalk-plugin-configurator`). Modelled
// on @signalk/signalk-to-nmea0183's webpack.config.js.
//
//   npm run build:config      (commit the result: there is no build on the boat)
//
// The container's global name is the package name with [-@/] replaced by `_`,
// which is how the admin UI finds it: `signalk_yey_connector`.

const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { ModuleFederationPlugin } = require('webpack').container
const { sources } = require('webpack')
const packageJson = require('./package.json')

const containerName = packageJson.name.replace(/[-@/]/g, '_')
const PANEL_DIR = path.resolve(__dirname, 'src/panel')

/** sha256 over the panel sources, written next to the bundle so a test can tell
 *  a stale public/ from a fresh one (test/panel-bundle.test.js). */
function panelSourceHash () {
  const hash = crypto.createHash('sha256')
  for (const name of fs.readdirSync(PANEL_DIR).sort()) {
    hash.update(name)
    hash.update(fs.readFileSync(path.join(PANEL_DIR, name)))
  }
  return hash.digest('hex')
}

class PanelSourceStampPlugin {
  apply (compiler) {
    compiler.hooks.thisCompilation.tap('PanelSourceStamp', (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: 'PanelSourceStamp', stage: compilation.constructor.PROCESS_ASSETS_STAGE_ADDITIONAL },
        () => {
          const body = JSON.stringify({ source_sha256: panelSourceHash() }, null, 2) + '\n'
          compilation.emitAsset('panel-source.json', new sources.RawSource(body))
        })
    })
  }
}

module.exports = {
  entry: './src/panel/index.js',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'public'),
    publicPath: 'auto',
    // public/ holds only this build's output (the old standalone page is gone).
    clean: true
  },
  optimization: {
    // Stable chunk names, so a rebuild with no source change is a no-op diff.
    chunkIds: 'deterministic',
    moduleIds: 'deterministic'
  },
  performance: { hints: false },
  plugins: [
    new ModuleFederationPlugin({
      name: containerName,
      library: { type: 'var', name: containerName },
      filename: 'remoteEntry.js',
      exposes: {
        './PluginConfigurationPanel': './src/panel/PluginConfigurationPanel'
      },
      shared: {
        // The panel renders inside the admin UI's React tree and must use the
        // host's React (^19 today). `import: false` keeps any React out of this
        // bundle and out of the share scope; `requiredVersion: false` accepts
        // whichever React the host shares. react-dom is never imported by the
        // panel; it is listed so a future import cannot bundle a second copy.
        react: { singleton: true, requiredVersion: false, import: false },
        'react-dom': { singleton: true, requiredVersion: false, import: false }
      }
    }),
    new PanelSourceStampPlugin()
  ]
}
