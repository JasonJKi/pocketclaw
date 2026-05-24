# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

pocketclaw is a single-user Telegram bridge to Claude Code. Flow:

```
Telegram (text or voice) → [allowlist] → Deepgram (voice→text) → Claude Agent SDK
  → run in the target project dir → stream reply back to Telegram (chunked)
```

Telegram polls outbound from the host, so there are no open ports. ~500 LOC, ESM TypeScript, run under pm2 in production.

## Architecture

| File | Role |
|------|------|
| `src/index.ts` | Telegraf bot: auth middleware, `/start /cwd /cd /reset` commands, text/voice handlers, reply chunking. |
| `src/claude.ts` | Wraps the Claude Agent SDK `query()`. Owns session state (`cwd`, `resumeId`) and yields typed `ClaudeChunk`s. |
| `src/transcribe.ts` | Deepgram `nova-3` transcription of the OGG voice buffer. |
| `src/config.ts` | Loads/validates env. Exits on missing required vars. Single source of config. |
| `src/chunk.ts` | Splits long replies under Telegram's ~4096-char message limit on paragraph/line/word boundaries. |

State is in-memory only (one global `session`); restarting the process resets `cwd` to `DEFAULT_PROJECT_DIR` and clears conversation memory.

## Commands

```sh
npm run dev      # tsx watch — local development
npm run build    # tsc → dist/
npm start        # node dist/index.js (what pm2 runs)
npx tsc --noEmit # typecheck only

pm2 start ecosystem.config.cjs   # production
pm2 logs pocketclaw              # tail logs
pm2 restart pocketclaw
```

There is no test suite or linter. Before considering a change done, run `npx tsc --noEmit`.

## Conventions

- **ESM with explicit `.js` import specifiers** (`./config.js`), even though sources are `.ts` — required by `module: ES2022` + `moduleResolution: bundler`. Don't drop the extension.
- `strict` TypeScript is on. The one sanctioned `any` is the SDK message loop in `claude.ts` (the SDK's union types are awkward to narrow); keep new `any` out elsewhere.
- Config is read **only** through `config.ts`. Don't reach into `process.env` from feature code.
- User-facing bot strings are terse and emoji-prefixed (`💭 🔧 📝 ❌`); match that voice.

## Claude Agent SDK gotchas (important)

These cost real debugging time — the SDK defaults are surprising:

- **`settingSources` defaults to empty.** Without `['project']` the SDK runs in isolation mode and ignores the target directory's `CLAUDE.md`, `.claude/settings.json`, subagents, and slash commands. We pass `['user', 'project']` so each project behaves like real Claude Code.
- **No system prompt by default.** Without `systemPrompt: { type: 'preset', preset: 'claude_code' }` the agent is a bare assistant, not Claude Code.
- **`bypassPermissions` requires `allowDangerouslySkipPermissions: true`** alongside it.
- Optional tuning is env-driven (`CLAUDE_MODEL`, `CLAUDE_FALLBACK_MODEL`, `CLAUDE_MAX_TURNS`, `CLAUDE_MAX_BUDGET_USD`) and only passed when set — see `config.ts` / `.env.example`.

## Security & safety

- Only `TELEGRAM_ALLOWED_USER_ID` is served; all other senders are silently dropped by the middleware in `src/index.ts`. Preserve that gate.
- The agent runs with `bypassPermissions` — it edits files and runs shell commands without asking. Keep target work in git.
- **Never commit `.env`** (gitignored) and never echo secrets into logs or replies.
