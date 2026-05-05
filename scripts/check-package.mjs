import { access, readFile } from "node:fs/promises"

const fail = (message) => {
  console.error(message)
  process.exitCode = 1
}

const bridgeForbidden = ["claude-dashboard", "CLAUDE_DASHBOARD_CHECK_USAGE", "dashboardCheckUsage", "check-usage.js"]
const sourceForbidden = ["C:/Users/CMS", "@ts-ignore", "@ts-expect-error", "as any"]
const plaintextZaiForbidden = ["http://api.z.ai", "http://bigmodel.cn", "http://*.bigmodel.cn"]
const plaintextZaiForbiddenPatterns = [
  /http:\/\/api\.z\.ai/i,
  /http:\/\/bigmodel\.cn/i,
  /http:\/\/(?:\*\.|[^\s"'`<>]*\.)?bigmodel\.cn/i,
]
const directAdapterText = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
]

const packageText = await readFile("package.json", "utf8")
const packageJson = JSON.parse(packageText)
if (!packageJson.exports?.["./tui"]?.default) fail("package.json must export ./tui.default")
if (!packageJson.files?.includes("dist")) fail("package.json files must include dist")

for (const forbidden of bridgeForbidden) {
  for (const section of [packageJson.dependencies, packageJson.devDependencies, packageJson.peerDependencies, packageJson.optionalDependencies]) {
    if (section && Object.keys(section).some((name) => name.includes(forbidden) || section[name]?.includes(forbidden))) {
      fail(`package.json dependency metadata contains forbidden text: ${forbidden}`)
    }
  }
}

const source = await readFile("src/tui.tsx", "utf8")
const readme = await readFile("README.md", "utf8")
const distTui = await readFile("dist/tui.js", "utf8")
const distTypes = await readFile("dist/tui.d.ts", "utf8")

const requiredRefreshSourceText = [
  ["const REFRESH_MS = 5 * 60 * 1000", "source must refresh usage every 5 minutes"],
  ["setInterval(() => void refresh(), REFRESH_MS)", "source must schedule periodic usage refresh"],
  ["api.command.register", "source must register an OpenCode usage command"],
  ['slash: { name: "opencode-usage" }', "source must expose /opencode-usage slash command"],
  ["onSelect: () => void refreshUsageViews(api)", "source must connect /opencode-usage to usage refresh"],
  ["const unregisterRefreshHandler = registerRefreshHandler(refresh)", "source must register mounted usage view refresh handlers"],
  ["unregisterRefreshHandler()", "source must remove usage view refresh handlers on cleanup"],
  ["api.lifecycle.onDispose(unregisterCommand)", "source must unregister the usage command on plugin dispose"],
]

const requiredDisplaySourceText = [
  ["function usageTitle", "source must render compact usage title"],
  ['`Usage (${details.join(" / ")})`', "source must combine model and plan in the usage title"],
  ["formatCompactDateTime", "source must compact reset timestamps"],
  ["formatResetValue(props.reset)", "source must compact reset timestamps at render time"],
  ['`${year}-${month}-${day} ${hour}:${minute}`', "source must format reset time as YYYY-MM-DD HH:mm"],
]

for (const [required, message] of requiredRefreshSourceText) {
  if (!source.includes(required)) fail(message)
}

for (const [required, message] of requiredDisplaySourceText) {
  if (!source.includes(required)) fail(message)
}

const removedDisplayText = ["provider {", "account {", "usage model {", "quota {", "statusColor"]
for (const removed of removedDisplayText) {
  if (source.includes(removed)) fail(`source must not render verbose usage detail text: ${removed}`)
}

if (!distTui.includes("opencode-usage.refresh")) fail("dist must include the OpenCode usage refresh command")
if (!distTui.includes("OpenCode usage updated")) fail("dist must include successful usage refresh feedback")
if (!distTui.includes("OpenCode usage sidebar is not mounted")) fail("dist must include missing sidebar refresh feedback")
if (!distTui.includes("Usage (")) fail("dist must include compact usage title rendering")

for (const forbidden of sourceForbidden) {
  if (source.includes(forbidden)) fail(`source contains forbidden text: ${forbidden}`)
}

for (const forbidden of bridgeForbidden) {
  if (source.includes(forbidden) || readme.includes(forbidden)) fail(`package text contains forbidden text: ${forbidden}`)
}

for (const forbidden of plaintextZaiForbidden) {
  if ([source, readme, packageText, distTui, distTypes].some((text) => text.includes(forbidden))) {
    fail(`package text contains forbidden plaintext z.ai URL: ${forbidden}`)
  }
}

for (const forbiddenPattern of plaintextZaiForbiddenPatterns) {
  if ([source, readme, packageText, distTui, distTypes].some((text) => forbiddenPattern.test(text))) {
    fail(`package text contains forbidden plaintext z.ai URL pattern: ${forbiddenPattern}`)
  }
}

for (const required of directAdapterText) {
  if (!source.includes(required) && !readme.includes(required)) fail(`direct adapter text missing: ${required}`)
}

try {
  await access("dist/tui.js")
  await access("dist/tui.d.ts")
} catch {
  fail("dist/tui.js and dist/tui.d.ts must exist; run npm run build first")
}

if (distTui.includes("@opentui/solid/jsx-runtime")) {
  fail("dist/tui.js must not import or contain @opentui/solid/jsx-runtime")
}

for (const forbidden of bridgeForbidden) {
  if (distTui.includes(forbidden) || distTypes.includes(forbidden)) fail(`dist contains forbidden text: ${forbidden}`)
}

for (const required of directAdapterText) {
  if (!distTui.includes(required) && !readme.includes(required)) fail(`direct adapter dist text missing: ${required}`)
}

if (!process.exitCode) console.log("package checks passed")
