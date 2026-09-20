'use strict'

const fsDefault = require('node:fs')
const path = require('node:path')

const FILE = 'yey-connector-state.json'

/**
 * Durable connector state beside SignalK's own plugin data
 * (app.getDataDirPath() — the same root Instruments-manager uses for its JSON
 * store, lib/manager.js:88).
 *
 * Writes are atomic (tmp + rename) because the alternative is a half-written
 * credential after a power cut, which on a boat is not a hypothetical.
 * A null dir degrades to memory so the plugin still runs under a host that does
 * not provide getDataDirPath.
 */
function createState ({ dir, fs = fsDefault } = {}) {
  let memory = {}
  const file = dir ? path.join(dir, FILE) : null

  function read () {
    if (!file) return { ...memory }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {} // absent or corrupt — both mean "nothing known yet"
    }
  }

  function write (next) {
    const value = next && typeof next === 'object' && !Array.isArray(next) ? next : {}
    if (!file) { memory = { ...value }; return value }
    const tmp = `${file}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
      fs.renameSync(tmp, file)
    } catch {
      // A read-only or full data directory must not throw out of pairing; keep
      // the value in memory so the running process stays consistent with itself.
      memory = { ...value }
    }
    return value
  }

  function patch (delta) {
    return write({ ...read(), ...(delta || {}) })
  }

  return { read, write, patch, file }
}

module.exports = { createState, FILE }
