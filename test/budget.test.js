'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBudget, SHED_AT } = require('../lib/budget')

const BUDGET = { max_msgs_per_min: 10, max_bytes_per_hour: 1000 }

test('a message inside the budget is admitted', () => {
  const b = createBudget({ budget: BUDGET })
  assert.equal(b.admit({ bytes: 10, priority: 'high' }, 1000).admit, true)
})

test('low priority sheds first, at half the budget', () => {
  const b = createBudget({ budget: BUDGET })
  for (let i = 0; i < 5; i++) b.admit({ bytes: 1, priority: 'high' }, 1000)
  assert.equal(b.admit({ bytes: 1, priority: 'low' }, 1000).admit, false,
    'low stops at 50% of max_msgs_per_min')
  assert.equal(b.admit({ bytes: 1, priority: 'normal' }, 1000).admit, true)
  assert.equal(b.admit({ bytes: 1, priority: 'high' }, 1000).admit, true)
})

test('high priority survives right up to the budget, and no further', () => {
  const b = createBudget({ budget: BUDGET })
  for (let i = 0; i < 10; i++) {
    assert.equal(b.admit({ bytes: 1, priority: 'high' }, 1000).admit, true, `message ${i}`)
  }
  const over = b.admit({ bytes: 1, priority: 'high' }, 1000)
  assert.equal(over.admit, false)
  assert.equal(over.reason, 'msgs_per_min')
})

test('the byte ceiling is enforced on its own hour window', () => {
  const b = createBudget({ budget: { max_msgs_per_min: 1000, max_bytes_per_hour: 100 } })
  assert.equal(b.admit({ bytes: 99, priority: 'high' }, 1000).admit, true)
  assert.equal(b.admit({ bytes: 99, priority: 'high' }, 1000).reason, 'bytes_per_hour')
  // A new hour resets it; the minute window is separate and rolls sooner.
  assert.equal(b.admit({ bytes: 99, priority: 'high' }, 1000 + 3_600_000).admit, true)
})

test('the minute window rolls without touching the hour window', () => {
  const b = createBudget({ budget: BUDGET })
  for (let i = 0; i < 10; i++) b.admit({ bytes: 1, priority: 'high' }, 1000)
  assert.equal(b.admit({ bytes: 1, priority: 'high' }, 1000).admit, false)
  assert.equal(b.admit({ bytes: 1, priority: 'high' }, 1000 + 60_000).admit, true)
  assert.equal(b.stats(1000 + 60_000).bytes_per_hour_used, 11)
})

test('an unknown priority is treated as normal, never as unlimited', () => {
  const b = createBudget({ budget: BUDGET })
  const out = b.admit({ bytes: 1, priority: 'critical' }, 1000)
  assert.equal(out.priority, 'normal')
  assert.equal(SHED_AT.normal < SHED_AT.high, true)
})

test('stats report what the plugin screen shows', () => {
  const b = createBudget({ budget: BUDGET })
  b.admit({ bytes: 7, priority: 'high' }, 1000)
  const s = b.stats(1000)
  assert.equal(s.admitted, 1)
  assert.equal(s.msgs_per_min_used, 1)
  assert.equal(s.bytes_per_hour_used, 7)
  assert.equal(s.msgs_per_min_max, 10)
})
