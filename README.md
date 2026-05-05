# @bigjade/opencode-usage

OpenCode TUI sidebar plugin that shows provider usage/quota when a safe local source is available.

## What It Shows

- Active OpenCode model/provider.
- Provider usage bars with percentages when supported.
- Clear `usage API unavailable` messages when provider account usage cannot be queried safely.

Usage data refreshes every 5 minutes while the sidebar is mounted. Run `/opencode-usage` in OpenCode to refresh the sidebar immediately.

Supported usage sources:

| Provider | Source |
|---|---|
| Claude | Local Claude Code OAuth credentials in `~/.claude/.credentials.json` plus Anthropic OAuth usage API |
| OpenAI / Codex | Read-only `~/.codex/auth.json` credentials with ChatGPT `https://chatgpt.com/backend-api/wham/usage` usage endpoint; optional model label from `~/.codex/config.toml` |
| Gemini | Read-only `~/.gemini/oauth_creds.json` plus optional `~/.gemini/settings.json`; Google Code Assist `loadCodeAssist` project discovery and `retrieveUserQuota` quota endpoint |
| z.ai | `ANTHROPIC_BASE_URL` restricted to z.ai/BigModel origins plus `ANTHROPIC_AUTH_TOKEN` with `/api/monitor/usage/quota/limit` quota endpoint |
| MiniMax | `MINIMAX_TOKEN_PLAN_API_KEY` or `MINIMAX_API_KEY` with Token Plan endpoint |
| OpenRouter | `OPENROUTER_API_KEY` with `/api/v1/auth/key` |

Providers without a verified local quota API, such as direct DeepSeek or direct Qwen/DashScope, are labeled but not faked.

Credential files and environment tokens are read only. Tokens are never displayed, logged, cached, or stored by this plugin, and provider CLIs such as `codex` or `gemini` are not executed.

## Install From Local Tarball

```powershell
npm install
npm run build
npm test
npm pack
opencode plugin .\bigjade-opencode-usage-0.1.2.tgz --global
```

Restart OpenCode after installation.

## Registry Install

When the package is published to npm, install it with:

```powershell
npm install @bigjade/opencode-usage
```

## Environment Variables

Only these optional variables are read. Token values are never displayed or stored.

```text
GOOGLE_CLOUD_PROJECT
GOOGLE_CLOUD_PROJECT_ID
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
MINIMAX_TOKEN_PLAN_API_KEY
MINIMAX_API_KEY
OPENROUTER_API_KEY
```

## Local Development

```powershell
npm install
npm run build
npm test
npm run pack:dry
```

Do not publish or distribute generated `.tgz` files containing private changes without review.
