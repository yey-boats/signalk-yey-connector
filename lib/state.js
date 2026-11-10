'use strict'

const fsDefault = require('node:fs')
const path = require('node:path')

const FILE = 'yey-connector-state.json'
// The file holds the boat credential: owner-only, never world-readable on a
// shared SignalK host.
const MODE = 0o600

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

  // A file written by an older version (or by hand) has the umask's mode;
  // tighten it now rather than on the next write, which may be days away.
  if (file) {
    try { fs.chmodSync(file, MODE) } catch { /* absent, or a read-only disk */ }
  }

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
      // Drop any stale tmp first so the credential is never written into a
      // pre-existing world-readable file, even for an instant.
      try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: MODE })
      // `mode` only applies when the file is created; a stale tmp left by a
      // power cut keeps its old mode unless we set it.
      try { fs.chmodSync(tmp, MODE) } catch { /* best effort */ }
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

module.exports = { createState, FILE, MODE }
