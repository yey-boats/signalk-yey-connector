'use strict'
// The cross-repo half of the plan schema: lib/plan.js mirrors boat_plan.py on a
// different release cycle, and neither suite can see a divergence alone. Set
// YEY_BUNDLE_PATH to a navigator checkout to enable (CI's cross-repo-contract job
// does). The policy vocabulary and the etag have their own checks in
// test/hello.test.js and test/plan.test.js.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { TRANSPORT_BOUNDS, DEFAULT_TRANSPORT, DEFAULT_BUDGET, applyPlan } = require('../lib/plan')

const BUNDLE = process.env.YEY_BUNDLE_PATH

test('transport bounds and defaults match boat_plan.py', { skip: !BUNDLE }, () => {
  const src = fs.readFileSync(
    path.join(BUNDLE, 'bundles/signalk@2026-06-05/boat_plan.py'), 'utf8')
  for (const [key, [lo, hi]] of Object.entries(TRANSPORT_BOUNDS)) {
    const m = src.match(new RegExp(`"${key}":\\s*\\((\\d+),\\s*(\\d+)\\)`))
    assert.ok(m, `boat_plan.TRANSPORT_BOUNDS has no ${key}`)
    assert.equal(Number(m[1]), lo, `${key} floor differs`)
    assert.equal(Number(m[2]), hi, `${key} ceiling differs`)
  }
  for (const [key, value] of Object.entries(DEFAULT_TRANSPORT)) {
    const expected = typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value)
    assert.ok(src.includes(`"${key}": ${expected}`),
      `boat_plan.DEFAULT_TRANSPORT["${key}"] is not ${expected}`)
  }
  for (const [key, value] of Object.entries(DEFAULT_BUDGET)) {
    assert.ok(src.includes(`"${key}": ${value}`),
      `boat_plan.DEFAULT_BUDGET["${key}"] is not ${value}`)
  }
})

test('the connector rejects a schema the cloud would emit as newer', () => {
  // PLAN_SCHEMA is 1 on both sides today; this is the guard for the day it is not.
  assert.equal(applyPlan({ schema: 2, mappings: [] }, { consent: [], deny: [] }).ok, false)
})
