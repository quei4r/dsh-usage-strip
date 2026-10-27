/**
 * dsh-usage-strip — host half.
 *
 * Serves one same-origin JSON snapshot of the plan limits for the providers
 * this profile actually uses:
 *
 *   - OpenCode Go   GET https://opencode.ai/zen/go/v1/usage
 *   - Kimi Code     GET https://api.kimi.com/coding/v1/usages
 *
 * Secrets never reach the browser: the Host resolves the key from the
 * credentials service and proxies the response.
 *
 * OpenCode Go key: credential reference `OPENCODE_GO_API_KEY`.
 * Kimi Code key, in order of preference:
 *   1. credential reference `KIMI_CODE_API_KEY` (subscription API key), or
 *   2. the Kimi Code CLI credential file (`~/.kimi-code/credentials/kimi-code.json`).
 *      When its access token has expired it is refreshed through the public
 *      Kimi OAuth client and the rotated pair is written back, so the CLI keeps
 *      its login.
 *
 * Route: GET /usage-strip/usage[?force=1]
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-usage-strip'

export const inject = ['webServer', 'credentials']

const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages'
const KIMI_TOKEN_URL = 'https://auth.kimi.com/api/oauth/token'
const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'

const OPENCODE_KEY_REF = 'OPENCODE_GO_API_KEY'
const KIMI_KEY_REF = 'KIMI_CODE_API_KEY'
/** Sign-in record shared with dsh-llm-pi-ai's `kimi-coding` route. */
const KIMI_RECORD_KEY = 'llm-pi-ai/kimi-coding'

const CACHE_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
const EXPIRY_LEEWAY_S = 90

const KIMI_CLI_CREDENTIAL_FILES = [
  join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json'),
  join(homedir(), '.kimi', 'credentials', 'kimi-code.json'),
]

/** Cached snapshot + single-flight for the whole provider set. */
let cache = null
let inFlight = null

/** Last Kimi CLI token we minted, kept until it expires. */
let kimiCliToken = null
let kimiRefreshInFlight = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

async function resolveKey(ctx, ref) {
  try {
    const hit = await ctx.credentials.resolve(ref)
    const value = typeof hit?.value === 'string' ? hit.value.trim() : ''
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

async function getJson(url, headers) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  return await response.json()
}

// ── OpenCode Go ────────────────────────────────────────────────────────────

function opencodeWindows(body) {
  const usage = body?.usage
  if (usage === null || typeof usage !== 'object') throw new Error('unexpected OpenCode usage payload')
  const defs = [
    ['rolling', '5h'],
    ['weekly', 'week'],
    ['monthly', 'month'],
  ]
  const windows = []
  for (const [source, key] of defs) {
    const window = usage[source]
    if (window === null || typeof window !== 'object') continue
    const percent = Number(window.percent)
    if (!Number.isFinite(percent)) continue
    windows.push({
      key,
      percent: Math.round(percent * 10) / 10,
      resetAt: typeof window.resetsAt === 'string' ? window.resetsAt : undefined,
      status: typeof window.status === 'string' ? window.status : undefined,
    })
  }
  if (windows.length === 0) throw new Error('OpenCode usage returned no windows')
  return windows
}

async function readOpencode(ctx) {
  const key = await resolveKey(ctx, OPENCODE_KEY_REF)
  if (key === undefined) return { id: 'opencode', configured: false, ok: false, error: 'no-key' }
  try {
    const body = await getJson(OPENCODE_USAGE_URL, { authorization: `Bearer ${key}` })
    return { id: 'opencode', configured: true, ok: true, windows: opencodeWindows(body) }
  } catch (error) {
    return { id: 'opencode', configured: true, ok: false, error: messageOf(error) }
  }
}

// ── Kimi Code ──────────────────────────────────────────────────────────────

const KIMI_WINDOW_KEYS = {
  limit_5h: '5h',
  limit_1h: '1h',
  limit_1d: 'day',
  limit_7d: 'week',
  limit_month_total: 'month',
  limit_month_code: 'code',
}

function kimiWindows(body) {
  const usages = body?.usages
  const windows = []
  if (usages !== null && typeof usages === 'object') {
    for (const [rawKey, value] of Object.entries(usages)) {
      if (value === null || typeof value !== 'object') continue
      const ratio = Number(value.used_ratio)
      if (!Number.isFinite(ratio)) continue
      const key = KIMI_WINDOW_KEYS[rawKey] ?? rawKey.replace(/^limit_/, '')
      windows.push({
        key,
        percent: Math.round(ratio * 1000) / 10,
        resetAt: typeof value.reset_time === 'string' ? value.reset_time : undefined,
      })
    }
  }
  // Older payloads only carry `limits[]`; use it when `usages` is absent.
  if (windows.length === 0 && Array.isArray(body?.limits)) {
    for (const limit of body.limits) {
      const used = Number(limit?.detail?.used)
      const total = Number(limit?.detail?.limit)
      const minutes = Number(limit?.window?.duration)
      if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) continue
      const key = Number.isFinite(minutes) ? (minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`) : 'total'
      windows.push({
        key,
        percent: Math.round((used / total) * 1000) / 10,
        resetAt: typeof limit?.detail?.resetTime === 'string' ? limit.detail.resetTime : undefined,
      })
    }
  }
  // `limit_month_total` and `limit_month_code` usually report the same quota;
  // keep `month` and drop an identical `code` row so the strip shows one number.
  const seen = new Set()
  const unique = []
  for (const window of windows) {
    const signature = `${window.key}:${window.percent}`
    if (seen.has(signature)) continue
    seen.add(signature)
    unique.push(window)
  }
  const monthTotal = unique.find((window) => window.key === 'month')
  const deduped = unique.filter((window) => !(
    window.key === 'code' && monthTotal !== undefined && monthTotal.percent === window.percent
  ))
  if (deduped.length === 0) throw new Error('Kimi usage returned no windows')
  return deduped
}

function readKimiCliCredential() {
  for (const file of KIMI_CLI_CREDENTIAL_FILES) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed?.access_token === 'string' && parsed.access_token.length > 0) {
        return { file, data: parsed }
      }
    } catch {
      // try the next path
    }
  }
  return undefined
}

function persistKimiCliCredential(file, data) {
  const serialized = `${JSON.stringify(data, null, 2)}\n`
  const temporary = `${file}.dsh-tmp-${process.pid}`
  writeFileSync(temporary, serialized, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}

async function refreshKimiCliCredential(file, data) {
  const refreshToken = typeof data?.refresh_token === 'string' ? data.refresh_token : undefined
  if (refreshToken === undefined) {
    throw new Error('Kimi Code CLI credential has no refresh token; run `kimi` to sign in again')
  }
  const body = new URLSearchParams({
    client_id: KIMI_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const response = await fetch(KIMI_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = undefined
  }
  if (!response.ok || typeof payload?.access_token !== 'string') {
    const hint = response.status === 401 || response.status === 403 || payload?.error === 'invalid_grant'
      ? 'Kimi Code login expired — run `kimi` once to sign in again'
      : `Kimi token refresh failed (HTTP ${response.status})`
    throw new Error(hint)
  }
  const access = payload.access_token
  const rotated = typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
  const expiresIn = Number(payload.expires_in)
  const expiresAt = Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900)
  const next = {
    ...data,
    access_token: access,
    refresh_token: rotated ? payload.refresh_token : refreshToken,
    expires_at: expiresAt,
    token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    scope: typeof payload.scope === 'string' ? payload.scope : data?.scope,
  }
  try {
    persistKimiCliCredential(file, next)
  } catch {
    // A read-only home still allows using the fresh token for this process.
  }
  return { access, expiresAt }
}

async function kimiCliBearer() {
  const now = Math.floor(Date.now() / 1000)
  if (kimiCliToken !== null && kimiCliToken.expiresAt - EXPIRY_LEEWAY_S > now) {
    return kimiCliToken.access
  }
  if (kimiRefreshInFlight !== null) return await kimiRefreshInFlight

  kimiRefreshInFlight = (async () => {
    const credential = readKimiCliCredential()
    if (credential === undefined) throw new Error('no Kimi Code CLI credential found')
    const nowSeconds = Math.floor(Date.now() / 1000)
    const expiresAt = Number(credential.data.expires_at)
    if (Number.isFinite(expiresAt) && expiresAt - EXPIRY_LEEWAY_S > nowSeconds) {
      kimiCliToken = { access: credential.data.access_token, expiresAt }
      return kimiCliToken.access
    }
    // The Kimi CLI refreshes the same file; give it a beat and adopt its result
    // instead of racing it with a rotation of our own.
    await sleep(120)
    const recheck = readKimiCliCredential()
    const recheckExpires = Number(recheck?.data?.expires_at)
    if (
      recheck !== undefined
      && recheck.data.access_token !== credential.data.access_token
      && Number.isFinite(recheckExpires)
      && recheckExpires - EXPIRY_LEEWAY_S > nowSeconds
    ) {
      kimiCliToken = { access: recheck.data.access_token, expiresAt: recheckExpires }
      return kimiCliToken.access
    }
    const refreshed = await refreshKimiCliCredential(credential.file, credential.data)
    kimiCliToken = refreshed
    return refreshed.access
  })()

  try {
    return await kimiRefreshInFlight
  } finally {
    kimiRefreshInFlight = null
  }
}

async function readKimiRecord(ctx) {
  try {
    const record = await ctx.credentials.readRecord(KIMI_RECORD_KEY)
    return record?.payload?.type === 'oauth' ? record : undefined
  } catch {
    return undefined
  }
}

function recordUsable(record) {
  const expires = Number(record?.payload?.expires)
  return Number.isFinite(expires) && expires - 60_000 > Date.now()
}

async function refreshKimiRecord(ctx, record) {
  const payload = record.payload
  const refreshToken = typeof payload.refresh === 'string' ? payload.refresh : undefined
  if (refreshToken === undefined) throw new Error('stored Kimi sign-in has no refresh token')
  const response = await fetch(KIMI_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: KIMI_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!response.ok || typeof parsed?.access_token !== 'string') {
    throw new Error(`Kimi token refresh failed (HTTP ${response.status})`)
  }
  const expiresIn = Number(parsed.expires_in)
  const next = {
    kind: 'grant',
    payload: {
      ...payload,
      type: 'oauth',
      access: parsed.access_token,
      refresh: typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0 ? parsed.refresh_token : refreshToken,
      expires: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
    },
  }
  try {
    await ctx.credentials.modifyRecord(KIMI_RECORD_KEY, async () => next)
  } catch {
    // The DSH record stays authoritative; a failed write only costs one refresh.
  }
  return next.payload.access
}

async function kimiBearer(ctx) {
  const key = await resolveKey(ctx, KIMI_KEY_REF)
  if (key !== undefined) return { authorization: `Bearer ${key}`, source: 'credential' }

  const record = await readKimiRecord(ctx)
  if (record !== undefined && recordUsable(record)) {
    return { authorization: `Bearer ${record.payload.access}`, source: 'dsh' }
  }
  if (record !== undefined) {
    try {
      const access = await refreshKimiRecord(ctx, record)
      return { authorization: `Bearer ${access}`, source: 'dsh' }
    } catch {
      // Another consumer may have rotated it already; re-read before falling back.
      const again = await readKimiRecord(ctx)
      if (again !== undefined && recordUsable(again)) {
        return { authorization: `Bearer ${again.payload.access}`, source: 'dsh' }
      }
    }
  }

  const access = await kimiCliBearer()
  return { authorization: `Bearer ${access}`, source: 'cli' }
}

async function readKimi(ctx) {
  try {
    const auth = await kimiBearer(ctx)
    const body = await getJson(KIMI_USAGE_URL, { authorization: auth.authorization })
    return { id: 'kimi', configured: true, ok: true, source: auth.source, windows: kimiWindows(body) }
  } catch (error) {
    const message = messageOf(error)
    if (message === 'no Kimi Code CLI credential found') {
      return { id: 'kimi', configured: false, ok: false, error: 'no-key' }
    }
    return { id: 'kimi', configured: true, ok: false, error: message }
  }
}

// ── Route ──────────────────────────────────────────────────────────────────

async function collect(ctx) {
  const [opencode, kimi] = await Promise.all([readOpencode(ctx), readKimi(ctx)])
  return {
    updatedAt: Date.now(),
    providers: [opencode, kimi],
  }
}

async function snapshot(ctx, force) {
  const now = Date.now()
  if (!force && cache !== null && now - cache.at < CACHE_TTL_MS) return cache.value
  if (inFlight !== null) return await inFlight
  inFlight = (async () => {
    const value = await collect(ctx)
    cache = { at: Date.now(), value }
    return value
  })()
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/usage-strip/usage',
    handler: async (request, response) => {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      if (request.method !== 'GET') {
        response.statusCode = 405
        response.setHeader('allow', 'GET')
        response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      const url = new URL(request.url ?? '/usage-strip/usage', 'http://localhost')
      const force = url.searchParams.get('force') === '1'
      try {
        const value = await snapshot(ctx, force)
        response.end(JSON.stringify(value))
      } catch (error) {
        response.statusCode = 500
        response.end(JSON.stringify({ ok: false, error: messageOf(error) }))
      }
    },
  }), 'dsh-usage-strip: usage route')
}
