/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

const id = "opencode-usage-sidebar"
const REFRESH_MS = 5 * 60 * 1000
const BAR_WIDTH = 10
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const USAGE_FETCH_TIMEOUT_MS = 45_000
const MINIMAX_TOKEN_PLAN_URL = "https://www.minimax.io/v1/token_plan/remains"
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/auth/key"
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const GEMINI_LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
const GEMINI_USER_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"
const ZAI_USAGE_PATH = "/api/monitor/usage/quota/limit"
const TOKEN_EXPIRY_SAFETY_MS = 5 * 60 * 1000

type ProviderKey =
  | "opencode"
  | "claude"
  | "codex"
  | "gemini"
  | "zai"
  | "minimax"
  | "deepseek"
  | "openrouter"
  | "qwen"
  | "unsupported"
type UsageStatus = "ok" | "warn" | "critical" | "error" | "unavailable"

type ModelReference = {
  providerID: string
  modelID: string
  variant?: string
}

type ActiveModel = ModelReference & {
  display: string
  providerKey: ProviderKey
  providerLabel: string
}

type UsageWindow = {
  label: string
  used?: number
  reset?: string
}

type UsageSnapshot = {
  status: UsageStatus
  provider: ProviderKey
  providerLabel: string
  account?: string
  plan?: string
  model?: string
  rows: UsageWindow[]
  message?: string
}

type RefreshHandler = () => Promise<void>

const refreshHandlers = new Set<RefreshHandler>()

function registerRefreshHandler(handler: RefreshHandler) {
  refreshHandlers.add(handler)
  return () => refreshHandlers.delete(handler)
}

async function refreshUsageViews(api: TuiPluginApi) {
  if (!refreshHandlers.size) {
    api.ui.toast({ variant: "warning", message: "OpenCode usage sidebar is not mounted" })
    return
  }

  await Promise.all([...refreshHandlers].map((handler) => handler()))
  api.ui.toast({ variant: "success", message: "OpenCode usage updated" })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readNumber(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return undefined

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function readFirstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readString(record, key)
    if (value) return value
  }
  return undefined
}

function readFirstNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readNumber(record, key)
    if (typeof value === "number") return value
  }
  return undefined
}

function readJsonRecord(raw: string) {
  const parsed: unknown = JSON.parse(raw)
  return isRecord(parsed) ? parsed : undefined
}

async function readOptionalJsonRecord(path: string) {
  try {
    return readJsonRecord(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

function normalizeUsagePercent(value: number) {
  if (!Number.isFinite(value)) return undefined
  return value >= 0 && value <= 1 ? value * 100 : value
}

function isoFromEpochSeconds(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const date = new Date(value * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function formatResetValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return formatCompactDateTime(value.trim()) ?? value.trim()
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined

  const timestamp = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value
  return formatCompactDateTime(timestamp)
}

function formatCompactDateTime(value: string | number) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return undefined

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hour = String(date.getHours()).padStart(2, "0")
  const minute = String(date.getMinutes()).padStart(2, "0")
  return `${year}-${month}-${day} ${hour}:${minute}`
}

type JsonFetchResult =
  | { ok: true; payload: unknown }
  | { ok: false; reason: "http"; status: number }
  | { ok: false; reason: "timeout" | "malformed" | "failed" }

async function fetchJson(url: string, init: RequestInit): Promise<JsonFetchResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) return { ok: false, reason: "http", status: response.status }

    try {
      const payload: unknown = await response.json()
      return { ok: true, payload }
    } catch {
      return { ok: false, reason: "malformed" }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { ok: false, reason: "timeout" }
    return { ok: false, reason: "failed" }
  } finally {
    clearTimeout(timeout)
  }
}

function fetchFailureSnapshot(active: ActiveModel, provider: string, result: Exclude<JsonFetchResult, { ok: true }>) {
  if (result.reason === "http") return unavailableSnapshot(active, `usage API unavailable for ${provider} (${result.status})`)
  if (result.reason === "timeout") return unavailableSnapshot(active, `usage API unavailable for ${provider} (request timed out)`)
  if (result.reason === "malformed") return unavailableSnapshot(active, `usage API unavailable for ${provider} (malformed response)`)
  return unavailableSnapshot(active, `usage API unavailable for ${provider} (request failed)`)
}

function usageColor(api: TuiPluginApi, used?: number) {
  const theme = api.theme.current
  if (typeof used !== "number") return theme.textMuted
  if (used >= 90) return theme.error
  if (used >= 70) return theme.warning
  return theme.success
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function usageStatus(rows: UsageWindow[]): UsageStatus {
  const highest = rows.reduce((max, row) => {
    return typeof row.used === "number" ? Math.max(max, row.used) : max
  }, 0)

  if (highest >= 90) return "critical"
  if (highest >= 70) return "warn"
  return "ok"
}

function barParts(used?: number) {
  if (typeof used !== "number") {
    return { filled: "", empty: "-".repeat(BAR_WIDTH), percent: "-" }
  }

  const percent = clampPercent(used)
  const filledLength = Math.round((percent / 100) * BAR_WIDTH)
  return {
    filled: "#".repeat(filledLength),
    empty: "-".repeat(BAR_WIDTH - filledLength),
    percent: `${percent}%`,
  }
}

function providerLabel(providerKey: ProviderKey, fallback: string) {
  if (providerKey === "opencode") return "OpenCode"
  if (providerKey === "claude") return "Claude"
  if (providerKey === "codex") return "Codex"
  if (providerKey === "gemini") return "Gemini"
  if (providerKey === "zai") return "z.ai"
  if (providerKey === "minimax") return "MiniMax"
  if (providerKey === "deepseek") return "DeepSeek"
  if (providerKey === "openrouter") return "OpenRouter"
  if (providerKey === "qwen") return "Qwen"
  return fallback || "unknown"
}

function providerMessageName(providerKey: ProviderKey, fallback: string) {
  if (providerKey === "unsupported") return (fallback || "provider").toLowerCase()
  return providerKey
}

function normalizeProvider(providerID: string, modelID?: string): ProviderKey {
  const provider = providerID.toLowerCase()
  const model = (modelID ?? "").toLowerCase()
  const combined = `${provider} ${model}`

  if (provider === "opencode") return "opencode"
  if (provider === "openai") return "codex"
  if (combined.includes("deepseek")) return "deepseek"
  if (combined.includes("minimax")) return "minimax"
  if (combined.includes("openrouter")) return "openrouter"
  if (combined.includes("qwen") || combined.includes("dashscope") || combined.includes("alibaba")) return "qwen"
  if (provider === "anthropic" || combined.includes("claude")) return "claude"
  if (provider === "codex" || combined.includes("codex")) return "codex"
  if (provider === "google" || provider === "gemini" || combined.includes("gemini")) return "gemini"
  if (provider === "zai" || provider === "z.ai" || provider === "z-ai" || combined.includes("z.ai") || combined.includes("glm")) {
    return "zai"
  }

  return "unsupported"
}

function isModelReference(value: unknown): value is ModelReference {
  if (!isRecord(value)) return false
  return typeof value.providerID === "string" && typeof value.modelID === "string"
}

function modelRef(message: AssistantMessage | UserMessage): ModelReference | undefined {
  if (message.role === "user") {
    return isModelReference(message.model) ? message.model : undefined
  }

  return {
    providerID: message.providerID,
    modelID: message.modelID,
    variant: message.variant,
  }
}

function modelDisplayFromRef(api: TuiPluginApi, providerID: string, modelID: string, variant?: string) {
  const provider = api.state.provider.find((item) => item.id === providerID)
  const model = provider?.models[modelID]
  const modelName = model?.name ?? modelID
  return [modelName, variant].filter(Boolean).join(" / ")
}

function configModelRef(api: TuiPluginApi): ModelReference | undefined {
  const raw = api.state.config.model
  if (!raw) return undefined

  const separator = raw.indexOf("/")
  if (separator < 0) return { providerID: raw, modelID: raw }

  const providerID = raw.slice(0, separator)
  const modelID = raw.slice(separator + 1)
  if (!providerID || !modelID) return { providerID: raw, modelID: raw }

  return { providerID, modelID }
}

function activeModelFromRef(api: TuiPluginApi, ref: ModelReference): ActiveModel {
  const providerKey = normalizeProvider(ref.providerID, ref.modelID)
  return {
    ...ref,
    display: modelDisplayFromRef(api, ref.providerID, ref.modelID, ref.variant),
    providerKey,
    providerLabel: providerLabel(providerKey, ref.providerID),
  }
}

function activeModel(api: TuiPluginApi, sessionID: string): ActiveModel {
  const messages = api.state.session.messages(sessionID)

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: Message | undefined = messages[index]
    if (!message) continue
    if (message.role !== "assistant" && message.role !== "user") continue

    const ref = modelRef(message)
    if (ref) return activeModelFromRef(api, ref)
  }

  const configRef = configModelRef(api)
  if (configRef) return activeModelFromRef(api, configRef)

  return {
    providerID: "unknown",
    modelID: "model syncing",
    display: "model syncing",
    providerKey: "unsupported",
    providerLabel: "unknown",
  }
}

function unavailableSnapshot(active: ActiveModel, message?: string): UsageSnapshot {
  return {
    status: "unavailable",
    provider: active.providerKey,
    providerLabel: active.providerLabel,
    rows: [],
    message: message ?? `usage API unavailable for ${providerMessageName(active.providerKey, active.providerID)}`,
  }
}

function normalizeClaudePercent(value: number) {
  return value >= 0 && value <= 1 ? value * 100 : value
}

function claudeCandidateRecords(root: Record<string, unknown>) {
  const records: Record<string, unknown>[] = [root]
  for (const key of ["data", "result", "usage", "quota"]) {
    const value = root[key]
    if (isRecord(value)) records.push(value)
  }
  return records
}

function claudeWindow(record: Record<string, unknown>, key: string, label: string): UsageWindow | undefined {
  const value = record[key]
  if (!isRecord(value)) return undefined

  const utilization = readFirstNumber(value, ["utilization", "usage", "used", "percent"])
  if (typeof utilization !== "number") return undefined

  return {
    label,
    used: normalizeClaudePercent(utilization),
    reset: readFirstString(value, ["resets_at", "reset_at", "resetAt"]),
  }
}

function parseClaudeUsage(payload: unknown, active: ActiveModel): UsageSnapshot | undefined {
  if (!isRecord(payload)) return undefined

  for (const record of claudeCandidateRecords(payload)) {
    const rows = [
      claudeWindow(record, "five_hour", "5h"),
      claudeWindow(record, "seven_day", "7d"),
      claudeWindow(record, "seven_day_sonnet", "7d sonnet"),
    ].filter((row): row is UsageWindow => Boolean(row))

    if (!rows.length) continue

    return {
      status: usageStatus(rows),
      provider: active.providerKey,
      providerLabel: active.providerLabel,
      rows,
    }
  }

  return undefined
}

async function readClaudeAccessToken() {
  try {
    const credentialsPath = join(homedir(), ".claude", ".credentials.json")
    const raw = await readFile(credentialsPath, "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return undefined

    const oauth = parsed.claudeAiOauth
    if (!isRecord(oauth)) return undefined

    const token = readString(oauth, "accessToken")
    return token
  } catch {
    return undefined
  }
}

async function loadClaudeUsage(active: ActiveModel): Promise<UsageSnapshot> {
  const token = await readClaudeAccessToken()
  if (!token) return unavailableSnapshot(active, "usage API unavailable for claude (Claude Code OAuth access token missing)")

  const result = await fetchJson(CLAUDE_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "@bigjade/opencode-usage/0.1.0",
      "anthropic-beta": "oauth-2025-04-20",
    },
  })

  if (!result.ok) return fetchFailureSnapshot(active, "claude", result)

  return parseClaudeUsage(result.payload, active) ?? unavailableSnapshot(active, "usage API unavailable for claude (no numeric usage found)")
}

function formatInteger(value: number) {
  return Math.round(value).toLocaleString("en-US")
}

function minimaxCandidateRecords(root: Record<string, unknown>) {
  const records: Record<string, unknown>[] = [root]
  const nestedKeys = ["data", "result", "token_plan", "tokenPlan", "quota"]

  for (const key of nestedKeys) {
    const value = root[key]
    if (isRecord(value)) records.push(value)
  }

  return records
}

function parseMiniMaxUsage(payload: unknown, active: ActiveModel): UsageSnapshot | undefined {
  if (!isRecord(payload)) return undefined

  const percentKeys = ["used_percent", "usage_percent", "percent", "usedPercentage", "usagePercentage"]
  const remainingKeys = [
    "remaining",
    "remain",
    "remains",
    "remain_tokens",
    "remaining_tokens",
    "available_tokens",
    "unused_tokens",
    "left_tokens",
  ]
  const totalKeys = ["total", "total_tokens", "token_total", "quota", "token_quota", "plan_tokens", "purchased_tokens"]
  const usedKeys = ["used", "used_tokens", "consumed", "consumed_tokens"]
  const resetKeys = ["reset", "reset_at", "resetAt", "expire_at", "expires_at", "expiresAt", "expiration_time"]
  const planKeys = ["plan", "plan_name", "planName", "token_plan_name", "tokenPlanName"]

  for (const record of minimaxCandidateRecords(payload)) {
    const directPercent = readFirstNumber(record, percentKeys)
    const remaining = readFirstNumber(record, remainingKeys)
    const total = readFirstNumber(record, totalKeys)
    const used = readFirstNumber(record, usedKeys)
    const reset = readFirstString(record, resetKeys)
    const plan = readFirstString(record, planKeys)

    let percent = typeof directPercent === "number" ? directPercent : undefined
    if (typeof percent !== "number" && typeof total === "number" && total > 0) {
      if (typeof used === "number") percent = (used / total) * 100
      if (typeof percent !== "number" && typeof remaining === "number") percent = ((total - remaining) / total) * 100
    }

    if (typeof percent !== "number") continue

    const quotaParts = [plan]
    if (typeof remaining === "number" && typeof total === "number") {
      quotaParts.push(`tokens ${formatInteger(remaining)} remaining of ${formatInteger(total)}`)
    } else if (typeof remaining === "number") {
      quotaParts.push(`tokens ${formatInteger(remaining)} remaining`)
    }

    const rows = [{ label: "tokens", used: percent, reset }]
    return {
      status: usageStatus(rows),
      provider: active.providerKey,
      providerLabel: active.providerLabel,
      plan: quotaParts.filter(Boolean).join(" / ") || undefined,
      rows,
    }
  }

  return undefined
}

async function loadMiniMaxUsage(active: ActiveModel): Promise<UsageSnapshot> {
  const token = process.env.MINIMAX_TOKEN_PLAN_API_KEY || process.env.MINIMAX_API_KEY
  if (!token) return unavailableSnapshot(active)

  const result = await fetchJson(MINIMAX_TOKEN_PLAN_URL, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!result.ok) return fetchFailureSnapshot(active, "minimax", result)

  return parseMiniMaxUsage(result.payload, active) ?? unavailableSnapshot(active, "usage API unavailable for minimax")
}

function parseOpenRouterUsage(payload: unknown, active: ActiveModel): UsageSnapshot | undefined {
  if (!isRecord(payload)) return undefined
  const data = isRecord(payload.data) ? payload.data : payload
  const limit = readFirstNumber(data, ["limit", "credit_limit", "credits", "total"])
  const usage = readFirstNumber(data, ["usage", "used", "spent"])
  const remaining = readFirstNumber(data, ["remaining", "remaining_credits", "balance"])
  const label = readFirstString(data, ["label", "name"])

  let percent: number | undefined
  if (typeof usage === "number" && typeof limit === "number" && limit > 0) percent = (usage / limit) * 100
  if (typeof percent !== "number" && typeof remaining === "number" && typeof limit === "number" && limit > 0) {
    percent = ((limit - remaining) / limit) * 100
  }

  const quotaParts: string[] = []
  if (typeof remaining === "number") quotaParts.push(`credits ${remaining.toFixed(2)} remaining`)
  if (typeof limit === "number") quotaParts.push(`limit ${limit.toFixed(2)}`)

  if (typeof percent !== "number") {
    return {
      status: "unavailable",
      provider: active.providerKey,
      providerLabel: active.providerLabel,
      account: label,
      rows: [],
      message: "OpenRouter usage API returned no quota percentage",
    }
  }

  const rows = [{ label: "credits", used: percent }]
  return {
    status: usageStatus(rows),
    provider: active.providerKey,
    providerLabel: active.providerLabel,
    account: label,
    plan: quotaParts.join(" / ") || undefined,
    rows,
  }
}

async function loadOpenRouterUsage(active: ActiveModel): Promise<UsageSnapshot> {
  const token = process.env.OPENROUTER_API_KEY
  if (!token) return unavailableSnapshot(active, "usage API unavailable for openrouter (OPENROUTER_API_KEY missing)")

  const result = await fetchJson(OPENROUTER_KEY_URL, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!result.ok) return fetchFailureSnapshot(active, "openrouter", result)

  return parseOpenRouterUsage(result.payload, active) ?? unavailableSnapshot(active, "usage API unavailable for openrouter")
}

function codexWindow(record: Record<string, unknown>, key: string, label: string): UsageWindow | undefined {
  const value = record[key]
  if (!isRecord(value)) return undefined

  const percent = readNumber(value, "used_percent")
  if (typeof percent !== "number") return undefined

  return {
    label,
    used: normalizeUsagePercent(percent),
    reset: isoFromEpochSeconds(readNumber(value, "reset_at")),
  }
}

function parseCodexUsage(payload: unknown, active: ActiveModel, model?: string): UsageSnapshot | undefined {
  if (!isRecord(payload)) return undefined

  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : payload
  const rows = [
    codexWindow(rateLimit, "primary_window", "5h"),
    codexWindow(rateLimit, "secondary_window", "7d"),
  ].filter((row): row is UsageWindow => Boolean(row))

  if (!rows.length) return undefined

  return {
    status: usageStatus(rows),
    provider: active.providerKey,
    providerLabel: active.providerLabel,
    plan: readFirstString(rateLimit, ["plan_type", "planType"]) ?? readFirstString(payload, ["plan_type", "planType"]),
    model,
    rows,
  }
}

function readCodexConfigModel(raw: string) {
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*model\s*=\s*["']([^"']+)["']\s*$/)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return undefined
}

async function readOptionalCodexModel() {
  try {
    return readCodexConfigModel(await readFile(join(homedir(), ".codex", "config.toml"), "utf8"))
  } catch {
    return undefined
  }
}

async function loadCodexUsage(active: ActiveModel): Promise<UsageSnapshot> {
  const credentials = await readOptionalJsonRecord(join(homedir(), ".codex", "auth.json"))
  if (!credentials) return unavailableSnapshot(active, "usage API unavailable for codex (auth.json missing or invalid)")

  const tokens = credentials.tokens
  if (!isRecord(tokens)) return unavailableSnapshot(active, "usage API unavailable for codex (tokens missing)")

  const token = readString(tokens, "access_token")
  const accountID = readString(tokens, "account_id")
  if (!token || !accountID) return unavailableSnapshot(active, "usage API unavailable for codex (access token or account id missing)")

  const result = await fetchJson(CODEX_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountID,
      "User-Agent": "@bigjade/opencode-usage/0.1.0",
    },
  })

  if (!result.ok) return fetchFailureSnapshot(active, "codex", result)

  return parseCodexUsage(result.payload, active, await readOptionalCodexModel()) ?? unavailableSnapshot(active, "usage API unavailable for codex (no numeric usage found)")
}

function geminiSelectedModel(settings?: Record<string, unknown>) {
  if (!settings) return undefined

  const selected = settings.selectedModel
  if (typeof selected === "string" && selected.trim()) return selected.trim()
  if (isRecord(selected)) {
    const model = readFirstString(selected, ["name", "model", "modelId", "id"])
    if (model) return model
  }

  const model = settings.model
  if (typeof model === "string" && model.trim()) return model.trim()
  if (isRecord(model)) return readFirstString(model, ["name", "model", "modelId", "id"])

  return undefined
}

function readGeminiSettingsProject(settings?: Record<string, unknown>) {
  return settings ? readString(settings, "cloudaicompanionProject") : undefined
}

function geminiHeaders(token: string) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
}

function parseGeminiProject(payload: unknown) {
  if (!isRecord(payload)) return undefined
  const direct = readString(payload, "cloudaicompanionProject")
  if (direct) return direct

  for (const key of ["metadata", "project", "data", "response"]) {
    const value = payload[key]
    if (!isRecord(value)) continue
    const nested = readString(value, "cloudaicompanionProject") ?? readString(value, "project")
    if (nested) return nested
  }

  return undefined
}

async function discoverGeminiProject(token: string, active: ActiveModel) {
  const result = await fetchJson(GEMINI_LOAD_CODE_ASSIST_URL, {
    method: "POST",
    headers: geminiHeaders(token),
    body: JSON.stringify({
      metadata: {
        ideType: "GEMINI_CLI",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }),
  })

  if (!result.ok) return { snapshot: fetchFailureSnapshot(active, "gemini", result) }

  const project = parseGeminiProject(result.payload)
  if (!project) return { snapshot: unavailableSnapshot(active, "usage API unavailable for gemini (project discovery failed)") }
  return { project }
}

function payloadBuckets(payload: unknown) {
  const candidates: unknown[] = [payload]
  if (isRecord(payload)) {
    for (const key of ["data", "quota", "response"]) candidates.push(payload[key])
  }

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    if (Array.isArray(candidate.buckets)) return candidate.buckets
  }

  return []
}

function geminiBucketRow(bucket: Record<string, unknown>): UsageWindow | undefined {
  const remainingFraction = readNumber(bucket, "remainingFraction")
  if (typeof remainingFraction !== "number") return undefined

  const modelID = readFirstString(bucket, ["modelId", "model", "name"])
  return {
    label: modelID ? modelID.replace(/^models\//, "") : "quota",
    used: normalizeUsagePercent((1 - remainingFraction) * 100),
    reset: formatResetValue(bucket.resetTime),
  }
}

function parseGeminiUsage(payload: unknown, active: ActiveModel, selectedModel?: string): UsageSnapshot | undefined {
  const rows = payloadBuckets(payload)
    .filter(isRecord)
    .map(geminiBucketRow)
    .filter((row): row is UsageWindow => Boolean(row))

  if (!rows.length) return undefined

  const selected = selectedModel?.toLowerCase()
  const selectedIndex = selected ? rows.findIndex((row) => row.label.toLowerCase().includes(selected) || selected.includes(row.label.toLowerCase())) : -1
  const orderedRows = selectedIndex > 0 ? [rows[selectedIndex], ...rows.slice(0, selectedIndex), ...rows.slice(selectedIndex + 1)] : rows
  const conciseRows = orderedRows.filter((row): row is UsageWindow => Boolean(row)).slice(0, 3)

  return {
    status: usageStatus(conciseRows),
    provider: active.providerKey,
    providerLabel: active.providerLabel,
    model: selectedModel,
    rows: conciseRows,
  }
}

async function loadGeminiUsage(active: ActiveModel): Promise<UsageSnapshot> {
  const credentials = await readOptionalJsonRecord(join(homedir(), ".gemini", "oauth_creds.json"))
  if (!credentials) return unavailableSnapshot(active, "usage API unavailable for gemini (oauth credentials missing or invalid)")

  const token = readString(credentials, "access_token")
  if (!token) return unavailableSnapshot(active, "usage API unavailable for gemini (access token missing)")

  const expiryDate = readNumber(credentials, "expiry_date")
  if (typeof expiryDate === "number" && expiryDate <= Date.now() + TOKEN_EXPIRY_SAFETY_MS) {
    return unavailableSnapshot(active, "usage API unavailable for gemini (access token expired or near expiry)")
  }

  const settings = await readOptionalJsonRecord(join(homedir(), ".gemini", "settings.json"))
  const selectedModel = geminiSelectedModel(settings)
  const configuredProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || readGeminiSettingsProject(settings)
  let project = configuredProject

  if (!project) {
    const discovery = await discoverGeminiProject(token, active)
    if (discovery.snapshot) return discovery.snapshot
    project = discovery.project
  }

  if (!project) return unavailableSnapshot(active, "usage API unavailable for gemini (project missing)")

  const result = await fetchJson(GEMINI_USER_QUOTA_URL, {
    method: "POST",
    headers: geminiHeaders(token),
    body: JSON.stringify({ project }),
  })

  if (!result.ok) return fetchFailureSnapshot(active, "gemini", result)

  return parseGeminiUsage(result.payload, active, selectedModel) ?? unavailableSnapshot(active, "usage API unavailable for gemini (no quota buckets found)")
}

function safeZaiOrigin(raw: string | undefined) {
  if (!raw) return undefined

  try {
    const url = new URL(raw)
    if (url.protocol !== "https:") return undefined

    const hostname = url.hostname.toLowerCase()
    if (hostname === "api.z.ai" || hostname === "bigmodel.cn" || hostname.endsWith(".bigmodel.cn")) return url.origin
  } catch {
    return undefined
  }

  return undefined
}

function zaiPercent(record: Record<string, unknown>) {
  const direct = readNumber(record, "percentage")
  if (typeof direct === "number") return normalizeUsagePercent(direct)

  const currentValue = readNumber(record, "currentValue")
  const remaining = readNumber(record, "remaining")
  const usage = readNumber(record, "usage")

  if (typeof currentValue === "number" && typeof remaining === "number" && currentValue + remaining > 0) {
    return normalizeUsagePercent((currentValue / (currentValue + remaining)) * 100)
  }

  if (typeof currentValue === "number" && typeof usage === "number" && usage > 0) {
    return normalizeUsagePercent((currentValue / usage) * 100)
  }

  return undefined
}

function zaiLimits(payload: unknown) {
  if (!isRecord(payload)) return []
  const data = isRecord(payload.data) ? payload.data : payload
  return Array.isArray(data.limits) ? data.limits : []
}

function parseZaiUsage(payload: unknown, active: ActiveModel): UsageSnapshot | undefined {
  const rows: UsageWindow[] = []

  for (const item of zaiLimits(payload)) {
    if (!isRecord(item)) continue

    const type = readString(item, "type")
    const label = type === "TOKENS_LIMIT" ? "tokens" : type === "TIME_LIMIT" ? "time" : undefined
    if (!label) continue

    const used = zaiPercent(item)
    if (typeof used !== "number") continue

    rows.push({ label, used, reset: formatResetValue(item.nextResetTime) })
  }

  if (!rows.length) return undefined

  return {
    status: usageStatus(rows),
    provider: active.providerKey,
    providerLabel: active.providerLabel,
    rows,
  }
}

async function loadZaiUsage(active: ActiveModel): Promise<UsageSnapshot> {
  const origin = safeZaiOrigin(process.env.ANTHROPIC_BASE_URL)
  if (!origin) return unavailableSnapshot(active, "usage API unavailable for z.ai (ANTHROPIC_BASE_URL must point to https z.ai)")

  const token = process.env.ANTHROPIC_AUTH_TOKEN
  if (!token) return unavailableSnapshot(active, "usage API unavailable for z.ai (ANTHROPIC_AUTH_TOKEN missing)")

  const result = await fetchJson(`${origin}${ZAI_USAGE_PATH}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  })

  if (!result.ok) return fetchFailureSnapshot(active, "z.ai", result)

  return parseZaiUsage(result.payload, active) ?? unavailableSnapshot(active, "usage API unavailable for z.ai (no quota limits found)")
}

async function loadUsage(active: ActiveModel): Promise<UsageSnapshot> {
  switch (active.providerKey) {
    case "claude":
      return loadClaudeUsage(active)
    case "minimax":
      return loadMiniMaxUsage(active)
    case "openrouter":
      return loadOpenRouterUsage(active)
    case "codex":
      return loadCodexUsage(active)
    case "gemini":
      return loadGeminiUsage(active)
    case "zai":
      return loadZaiUsage(active)
    default:
      return unavailableSnapshot(active)
  }
}

function UsageBar(props: { api: TuiPluginApi; label: string; used?: number; reset?: string }) {
  const theme = () => props.api.theme.current
  const color = () => usageColor(props.api, props.used)
  const bar = () => barParts(props.used)
  const reset = () => formatResetValue(props.reset) ?? props.reset ?? "-"

  return (
    <box>
      <text fg={theme().textMuted}>
        {props.label} [
        <span style={{ fg: color() }}>{bar().filled}</span>
        <span style={{ fg: theme().borderSubtle }}>{bar().empty}</span>] <span style={{ fg: color() }}>{bar().percent}</span>
      </text>
      <text fg={theme().textMuted}>reset {reset()}</text>
    </box>
  )
}

function compactPlanLabel(plan?: string) {
  const label = plan?.split(" / ")[0]?.trim()
  if (!label || /^(credits|tokens|limit)\b/i.test(label)) return undefined
  return label
}

function usageTitle(snapshot: UsageSnapshot | undefined, active: ActiveModel) {
  const model = snapshot?.model?.trim() || (active.providerID === "unknown" ? undefined : active.display)
  const details = [model, compactPlanLabel(snapshot?.plan)].filter((detail): detail is string => Boolean(detail))
  return details.length ? `Usage (${details.join(" / ")})` : "Usage"
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [snapshot, setSnapshot] = createSignal<UsageSnapshot | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const [loading, setLoading] = createSignal(true)
  const theme = () => props.api.theme.current
  const currentModel = createMemo(() => activeModel(props.api, props.session_id))

  const refresh = async () => {
    setLoading(true)

    try {
      const next = await loadUsage(currentModel())
      setSnapshot(next)
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    const unregisterRefreshHandler = registerRefreshHandler(refresh)
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    onCleanup(() => {
      clearInterval(timer)
      unregisterRefreshHandler()
    })
  })

  return (
    <box>
      <box flexDirection="row" gap={1}>
        <text fg={theme().text}>
          <b>{usageTitle(snapshot(), currentModel())}</b>
        </text>
      </box>
      <Show when={loading()}>
        <text fg={theme().textMuted}>checking usage...</text>
      </Show>
      <Show when={!loading() && error()}>
        <text fg={theme().error} wrapMode="word">
          {error()}
        </text>
      </Show>
      <Show when={!loading() && snapshot() && !error()}>
        <box>
          <For each={snapshot()?.rows ?? []}>{(row) => <UsageBar api={props.api} {...row} />}</For>
          <Show when={snapshot()?.message}>
            <text fg={snapshot()?.status === "unavailable" ? theme().textMuted : theme().error} wrapMode="word">
              {snapshot()?.message}
            </text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const unregisterCommand = api.command.register(() => [
    {
      title: "Refresh OpenCode usage",
      value: "opencode-usage.refresh",
      description: "Refresh the OpenCode usage sidebar now",
      category: "OpenCode Usage",
      slash: { name: "opencode-usage" },
      onSelect: () => void refreshUsageViews(api),
    },
  ])

  api.lifecycle.onDispose(unregisterCommand)

  api.slots.register({
    order: 50,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
