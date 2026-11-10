'use strict'
/**
 * #26: releases come from a tag (.github/workflows/release.yml), with notes
 * taken from CHANGELOG.md by scripts/changelog-section.js, not from one-off
 * scripts kept outside the repo.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const pkg = require('../package.json')

test('CHANGELOG: an Unreleased section and one per released version, newest first', () => {
  const md = read('CHANGELOG.md')
  const heads = [...md.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1])
  assert.equal(heads[0], 'Unreleased')
  for (const v of ['0.4.0', '0.3.0', '0.2.0', '0.1.0']) assert.ok(heads.includes(v), v)
  assert.ok(heads.includes(pkg.version), `no section for package.json version ${pkg.version}`)
  const released = heads.slice(1)
  const key = (v) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0)
  assert.deepEqual(released, [...released].sort((a, b) => key(b) - key(a)))
})

test('CHANGELOG: Unreleased names the merged follow-ups', () => {
  const { section } = require('../scripts/changelog-section')
  const unreleased = section(read('CHANGELOG.md'), 'Unreleased')
  for (const n of ['#29', '#31', '#32', '#34']) assert.ok(unreleased.includes(n), n)
})

test('changelog-section: prints one version\'s notes, without the heading or the next section', () => {
  const { section } = require('../scripts/changelog-section')
  const md = '# Changelog\n\n## [Unreleased]\n\n- next\n\n## [1.2.0] - 2026-01-02\n\n- two\n- lines\n\n## [1.1.0] - 2026-01-01\n\n- old\n\n[1.2.0]: https://x\n'
  assert.equal(section(md, '1.2.0'), '- two\n- lines')
  assert.equal(section(md, 'v1.1.0'), '- old')
  assert.equal(section(md, 'Unreleased'), '- next')
  assert.equal(section(md, '9.9.9'), null)
})

test('changelog-section CLI: notes for the current version; exit 1 for an unknown one', () => {
  const script = path.join(ROOT, 'scripts', 'changelog-section.js')
  const out = execFileSync(process.execPath, [script, pkg.version], { cwd: ROOT, encoding: 'utf8' })
  assert.ok(out.trim().length > 0)
  assert.throws(() => execFileSync(process.execPath, [script, '99.0.0'], { cwd: ROOT, stdio: 'pipe' }))
})

test('release workflow: runs on v* tags, tests, packs, and attaches the tarball to a GitHub release', () => {
  const yml = read('.github/workflows/release.yml')
  assert.match(yml, /^on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- ['"]?v\*['"]?/m)
  assert.match(yml, /contents: write/)
  for (const step of ['npm ci', 'npm test', 'npm pack', 'scripts/changelog-section.js', 'gh release create']) {
    assert.ok(yml.includes(step), step)
  }
  // The tag must match package.json, or the tarball would carry another version.
  assert.match(yml, /package\.json/)
  // Not on npm yet (#26): nothing publishes there.
  assert.equal(/npm publish/.test(yml), false)
})

test('scripts/release.sh: tags a version from the repo, no paths outside it', () => {
  const sh = read('scripts/release.sh')
  assert.match(sh, /^#!\/usr\/bin\/env bash/)
  assert.ok(sh.includes('changelog-section.js'))
  assert.equal(/\/home\/|\/tmp\/claude/.test(sh), false)
  assert.ok(fs.statSync(path.join(ROOT, 'scripts', 'release.sh')).mode & 0o100, 'executable')
})
