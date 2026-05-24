# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

pocketclaw is a single-user Telegram bridge to Claude Code. Flow:

```
Telegram (text/voice/images/files) → [allowlist] → Deepgram (voice→text) → Claude Agent SDK
  → run in the target project dir → stream reply back to Telegram (chunked)
```

Telegram polls outbound from the host, so there are no open ports. ~650 LOC, ESM TypeScript, run under pm2 in production.

**Multi-modal input support:**
- Text messages → direct to Claude
- Voice notes → transcribed via Deepgram → to Claude
- Images → vision API (direct analysis) OR saved to `.telegram-uploads/` (file mode)
- Documents → saved to `.telegram-uploads/` → Claude reads via Read tool

## Architecture

| File | Role |
|------|------|
| `src/index.ts` | Telegraf bot: auth middleware, commands (`/start /cwd /cd /reset /projects /switch /files /send /get /sessions /load /new`), message handlers (text/voice/photo/document), file upload/download logic, reply chunking. |
| `src/claude.ts` | Wraps the Claude Agent SDK `query()`. Owns session state (`cwd`, `resumeId`) and yields typed `ClaudeChunk`s. Includes `runClaude()` for text and `runClaudeWithImage()` for vision API. Exposes `setResumeId()` for loading sessions. |
| `src/sessions.ts` | Reads Claude Code's native session files from `~/.claude/projects/<encoded-cwd>/`. Parses JSONL format to extract session metadata (first message, message count, git branch, last activity). No separate session storage — directly reads what Claude Code and VS Code create. |
| `src/transcribe.ts` | Deepgram `nova-3` transcription of the OGG voice buffer. |
| `src/config.ts` | Loads/validates env. Exits on missing required vars. Single source of config. |
| `src/chunk.ts` | Splits long replies under Telegram's ~4096-char message limit on paragraph/line/word boundaries. |
| `src/projects.ts` | Auto-discovers git repos and Claude projects in home dir, finds by name, formats project listings for `/projects` and `/switch` commands. |

**Session Management:**
- PocketClaw reads **native Claude Code sessions** from `~/.claude/projects/<encoded-cwd>/` — the same sessions you see in VS Code's Claude Code extension
- Current session state (`cwd`, `resumeId`, `lastActivity`) is persisted to `~/.pocketclaw-session.json` and survives bot restarts
- Sessions expire after 24 hours of inactivity. Restarting with an expired session resets `cwd` to `DEFAULT_PROJECT_DIR` and starts fresh
- Use `/sessions` to list all Claude Code sessions for the current project, and `/load <session-id>` to resume any session (supports partial ID matching like `773026f0`)
- When you switch projects with `/switch`, the session list updates to show that project's Claude Code sessions

**File handling:**
- **Uploads**: Documents and images (in file mode) are saved to `.telegram-uploads/` in the current working directory with timestamped filenames. This directory is gitignored.
- **Downloads**: Users can retrieve files from the current directory using `/send <file>` or `/get <file>`. The `/files` command lists available files. Files are sent back to Telegram with a 50MB size limit (Telegram bot API constraint). Path traversal is prevented - only files within `cwd` can be sent.

## Features

- **Unified session system**: PocketClaw reads the same Claude Code sessions as VS Code — no separate session storage
- **Session persistence**: Conversation context survives bot restarts (stored in `~/.pocketclaw-session.json`, expires after 24h)
- **Real-time streaming**: Claude's responses stream to Telegram as they're generated (every 500 chars or 2 seconds)
- **Smart file detection**: Auto-detects new images/PDFs/videos created during execution and offers inline buttons to send them
- **Rate limiting**: 50ms throttle between message chunks to avoid Telegram flood limits
- **/status command**: Shows current session info (cwd, session active, last activity)
- **/sessions command**: Lists all Claude Code sessions for the current project with message previews, counts, and timestamps
- **/load command**: Resume any Claude Code session by ID (supports partial matching like `773026f0`)

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
