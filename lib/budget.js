'use strict'

// Watermarks at which each priority stops being admitted, as a fraction of the
// budget already consumed. spec: "High-priority mappings survive; normal
// degrades to a lower cadence before anything is discarded."
const SHED_AT = { low: 0.5, normal: 0.85, high: 1.0 }

/**
 * Connector-side budget enforcement.
 *
 * The cloud will not issue a plan that exceeds its budget, and the connector
 * enforces the same numbers locally anyway — because the plan is remote input
 * and a bad one must not be able to turn a customer's cellular link into a bill
 * (spec "budget is enforced on both ends").
 */
function createBudget ({ budget } = {}) {
  const maxMsgs = Math.max(1, Number((budget || {}).max_msgs_per_min) || 1)
  const maxBytes = Math.max(1, Number((budget || {}).max_bytes_per_hour) || 1)

  let minuteStart = null
  let msgsThisMinute = 0
  let hourStart = null
  let bytesThisHour = 0
  let admitted = 0
  let shed = 0

  function roll (nowMs) {
    if (minuteStart === null || nowMs - minuteStart >= 60_000) {
      minuteStart = nowMs; msgsThisMinute = 0
    }
    if (hourStart === null || nowMs - hourStart >= 3_600_000) {
      hourStart = nowMs; bytesThisHour = 0
    }
  }

  function admit (record, nowMs = Date.now()) {
    roll(nowMs)
    const bytes = Math.max(0, Number((record || {}).bytes) || 0)
    const priority = SHED_AT[(record || {}).priority] ? record.priority : 'normal'
    const ceiling = SHED_AT[priority]

    if (msgsThisMinute + 1 > maxMsgs * ceiling) {
      shed += 1
      return { admit: false, reason: 'msgs_per_min', priority }
    }
    if (bytesThisHour + bytes > maxBytes * ceiling) {
      shed += 1
      return { admit: false, reason: 'bytes_per_hour', priority }
    }
    msgsThisMinute += 1
    bytesThisHour += bytes
    admitted += 1
    return { admit: true, reason: 'ok', priority }
  }

  function stats (nowMs = Date.now()) {
    roll(nowMs)
    return {
      admitted,
      shed,
      msgs_per_min_used: msgsThisMinute,
      msgs_per_min_max: maxMsgs,
      bytes_per_hour_used: bytesThisHour,
      bytes_per_hour_max: maxBytes
    }
  }

  return { admit, stats }
}

module.exports = { SHED_AT, createBudget }
