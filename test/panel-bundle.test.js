'use strict'
/**
 * Guards the committed configurator bundle in public/. There is no build on the
 * boat (the plugin installs from a tarball or git), so a panel change that was
 * not rebuilt would ship the old panel. Modelled on signalk-to-nmea0183's
 * test/configPanelBundle.ts.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const PUBLIC = path.join(__dirname, '..', 'public')
const PANEL_DIR = path.join(__dirname, '..', 'src', 'panel')
const pkg = require('../package.json')

function read (name) {
  const file = path.join(PUBLIC, name)
  assert.ok(fs.existsSync(file), `public/${name} is missing; run "npm run build:config" and commit public/`)
  return fs.readFileSync(file, 'utf8')
}

test('remoteEntry.js exists and exposes ./PluginConfigurationPanel', () => {
  const entry = read('remoteEntry.js')
  assert.ok(entry.includes('./PluginConfigurationPanel'))
})

test('the container global is the name the admin UI derives from the package name', () => {
  const name = pkg.name.replace(/[-@/]/g, '_')
  assert.equal(name, 'signalk_yey_connector')
  assert.match(read('remoteEntry.js'), new RegExp(`var ${name}\\s*[;=]`))
})

test('the bundle carries no React of its own and offers none to the host', () => {
  for (const name of fs.readdirSync(PUBLIC).filter((n) => n.endsWith('.js'))) {
    const src = read(name)
    assert.equal(src.includes('react.transitional.element') || src.includes('react.element'), false,
      `${name} bundles a React element factory`)
  }
  assert.equal(read('remoteEntry.js').match(/\("react(-dom)?","[0-9][^"]*"/g), null,
    'remoteEntry.js registers a React version in the share scope')
})

test('public/ was rebuilt from the current panel source', () => {
  const hash = crypto.createHash('sha256')
  for (const name of fs.readdirSync(PANEL_DIR).sort()) {
    hash.update(name)
    hash.update(fs.readFileSync(path.join(PANEL_DIR, name)))
  }
  const stamp = JSON.parse(read('panel-source.json'))
  assert.equal(stamp.source_sha256, hash.digest('hex'),
    'src/panel changed since public/ was built; run "npm run build:config" and commit public/')
})

test('the package is a plugin configurator and publishes public/', () => {
  assert.ok(pkg.keywords.includes('signalk-node-server-plugin'))
  assert.ok(pkg.keywords.includes('signalk-plugin-configurator'))
  assert.ok(pkg.files.includes('public'))
  assert.equal(pkg.scripts['build:config'], 'webpack')
})
