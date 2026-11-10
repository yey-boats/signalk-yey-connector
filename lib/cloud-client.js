'use strict'

/**
 * Calls to a KDCube bundle's PUBLIC operations.
 *
 * Route: POST /api/integrations/bundles/{tenant}/{project}/{bundle_id}/public/{operation}
 *   — vendor/.../apps/chat/proc/rest/integrations/integrations.py:3195
 *
 * Request: the body's reserved keys are conversation_id, bundle_id,
 *   config_request and data; everything else at top level is folded INTO data,
 *   and data then arrives as the method's keyword arguments
 *   — integrations.py:846-870, :5082, :5146. Sending {"data": {...}} is the
 *   shape that survives both paths.
 *
 * Response: the handler's return value is wrapped UNDER THE OPERATION NAME
 *   — integrations.py:5166-5172. Reading `ok` at the top level is the bug that
 *   killed the Y1 front-shell client; the front shell has carried an unwrapper
 *   for the same reason since Workstream F
 *   (apps/front-shell/src/hooks/useAgentChat.ts:126-152).
 */

function publicOpUrl (cfg, operation) {
  // A connection document names the pair op's URL outright (`pair_url`); when
  // it does, that URL is used exactly as given rather than rebuilt.
  const pinned = ((cfg || {}).opUrls || {})[operation]
  if (pinned) return String(pinned)
  const origin = String((cfg || {}).cloudOrigin || '').replace(/\/+$/, '')
  return `${origin}/api/integrations/bundles/${cfg.tenant}/${cfg.project}/` +
    `${cfg.bundleId}/public/${operation}`
}

function unwrapPublicOp (body, operation) {
  if (!body || typeof body !== 'object') return {}
  const nested = body[operation]
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested
  return body
}

async function callPublicOp (cfg, operation, data = {}, opts = {}) {
  const { timeoutMs = 15000, fetchImpl = globalThis.fetch } = opts
  const url = publicOpUrl(cfg, operation)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
      // A 307/308 would re-POST this body (it can hold the boat credential) to
      // wherever the redirect points, unchecked. The origin is already pinned.
      redirect: 'error',
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    const e = new Error(`${operation} failed: response was not JSON (HTTP ${res.status})`)
    e.status = res.status
    e.bodyText = text.slice(0, 512)
    throw e
  }

  if (!res.ok) {
    const e = new Error(`${operation} failed: HTTP ${res.status}`)
    e.status = res.status
    e.body = parsed
    throw e
  }

  // A bundle-level {ok:false,error} arrives as HTTP 200 (entrypoint.py:3717,
  // :3762, :3775). It is an answer, not a transport failure — return it.
  return unwrapPublicOp(parsed, operation)
}

module.exports = { publicOpUrl, unwrapPublicOp, callPublicOp }
