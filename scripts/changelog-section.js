#!/usr/bin/env node
'use strict'
/**
 * Print one version's section of CHANGELOG.md (without its heading), for the
 * GitHub release notes (.github/workflows/release.yml, scripts/release.sh).
 *
 *   node scripts/changelog-section.js 0.5.0      # or v0.5.0, or Unreleased
 *
 * Exits 1 when the changelog has no such section, so a release cannot go out
 * without notes.
 */
const fs = require('node:fs')
const path = require('node:path')

/** The body of `## [version]` in `md`, trimmed; null when there is none. */
function section (md, version) {
  const want = String(version || '').replace(/^v(?=\d)/, '')
  const lines = String(md).split('\n')
  const start = lines.findIndex((l) => {
    const m = /^## \[([^\]]+)\]/.exec(l)
    return m && m[1] === want
  })
  if (start < 0) return null
  const body = []
  for (const l of lines.slice(start + 1)) {
    // The next version, or the link references at the bottom.
    if (/^## /.test(l) || /^\[[^\]]+\]: /.test(l)) break
    body.push(l)
  }
  return body.join('\n').trim()
}

module.exports = { section }

if (require.main === module) {
  const version = process.argv[2]
  const file = process.argv[3] || path.join(__dirname, '..', 'CHANGELOG.md')
  const out = version ? section(fs.readFileSync(file, 'utf8'), version) : null
  if (!out) {
    process.stderr.write(`no CHANGELOG section for ${version || '(no version given)'} in ${file}\n`)
    process.exit(1)
  }
  process.stdout.write(out + '\n')
}
