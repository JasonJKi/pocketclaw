import { statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";

// Max time between SDK messages before we assume the turn is wedged.
// With Telegraf's handler timeout disabled, this is the only ceiling.
const STREAM_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

type SessionState = {
  cwd: string;
  resumeId: string | null;
  lastActivity?: number;
  contextSentThisRun?: boolean; // Track if we've sent PocketClaw context since bot started
};

const SESSION_FILE = join(process.env.HOME || "/tmp", ".pocketclaw-session.json");

function loadSession(): SessionState {
  try {
    if (existsSync(SESSION_FILE)) {
      const data = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
      // Only restore if session is less than 24 hours old
      const age = Date.now() - (data.lastActivity || 0);
      if (age < 24 * 60 * 60 * 1000) {
        console.log(`Restored session: ${data.resumeId ? "resumeId present" : "no resumeId"}, cwd: ${data.cwd}`);
        return data;
      }
    }
  } catch (err: any) {
    console.warn(`Failed to load session: ${err?.message ?? String(err)}`);
  }
  return {
    cwd: config.defaultProjectDir,
    resumeId: null,
  };
}

function saveSession(): void {
  try {
    const data = {
      ...session,
      lastActivity: Date.now(),
    };
    writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err: any) {
    console.warn(`Failed to save session: ${err?.message ?? String(err)}`);
  }
}

const session: SessionState = loadSession();

export function getCwd(): string {
  return session.cwd;
}

export function setCwd(path: string): void {
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${path}`);
  }
  session.cwd = path;
  session.resumeId = null;
  saveSession();
}

export function resetSession(): void {
  session.resumeId = null;
  session.contextSentThisRun = false; // Reset context flag when starting new session
  saveSession();
}

export function setResumeId(resumeId: string): void {
  session.resumeId = resumeId;
  session.contextSentThisRun = false; // Reset context flag when loading a session
  saveSession();
}

export function getSessionInfo(): { cwd: string; resumeId: string | null; lastActivity: number | undefined } {
  return {
    cwd: session.cwd,
    resumeId: session.resumeId,
    lastActivity: session.lastActivity,
  };
}

// Resolve auth once at module load instead of mutating global process.env on
// every prompt. Prefer the Max-plan OAuth token; fall back to an API key.
function resolveClaudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.claudeCodeOAuthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = config.claudeCodeOAuthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (config.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }
  return env;
}

const claudeEnv = resolveClaudeEnv();

/**
 * Generate comprehensive PocketClaw context for Claude
 */
function getPocketClawContext(isResumed: boolean): string {
  const intro = isResumed
    ? "[Context: PocketClaw bot restarted. Continuing previous conversation.]"
    : "[Context: You are being accessed through PocketClaw, a Telegram bot interface.]";

  return `${intro}

INTERFACE: Telegram messaging
- User communicates via Telegram messages
- Keep responses under 4096 chars per message
- Use Telegram markdown: *bold*, _italic_, \`code\`, \`\`\`language blocks\`\`\`

AVAILABLE POCKETCLAW COMMANDS:
You can intelligently suggest or use these commands in your responses:

Projects & Sessions:
- /projects - Switch between projects
- /sessions - Manage saved conversation sessions
- /save <name> - Save current session
- /load <name> - Resume a saved session
- /switch <project> - Switch to different project

Files:
- /files [pattern] - Browse files interactively
- /send <file> - Send file to Telegram
- /get <file> - Download file

Git Workflows:
- /commit - Interactive commit with AI-generated message
- /status - Git status
- /diff - Show git changes
- /pr - Create pull request
- /push, /pull - Git operations

Dev Tools:
- /test [pattern] - Run tests
- /build - Build project
- /lint - Run linter
- /logs - View logs

AI Commands (when user wants specific behavior):
- /ask <question> - Answer without executing code
- /explain <file> - Explain code
- /fix <issue> - Debug and fix
- /add <feature> - Implement new feature
- /refactor <target> - Refactor code

INTELLIGENT COMMAND USAGE:
- When user says "commit this", suggest or use: /commit
- When user asks about files, suggest: /files
- When user mentions switching projects, use: /projects
- When user wants to save progress, use: /save <name>
- Recognize user intent and suggest appropriate commands
- You can tell users about these commands when relevant

RESPONSE GUIDELINES:
- Be concise (Telegram context)
- Use inline code and blocks appropriately
- Suggest commands when they'd help workflow
- Remember: user can upload files, images, voice messages directly

`;
}

export type ClaudeChunk =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "done"; summary: string };

export async function* runClaude(prompt: string): AsyncGenerator<ClaudeChunk> {
  // Inject context on first message after bot start (whether new or resumed session)
  const needsContext = !session.contextSentThisRun;
  const isResumedSession = !!session.resumeId;

  let contextualPrompt = prompt;
  if (needsContext) {
    const contextPrefix = isResumedSession
      ? getPocketClawContext(true)
      : getPocketClawContext(false);
    contextualPrompt = contextPrefix + prompt;
    session.contextSentThisRun = true;
  }

  const messages = query({
    prompt: contextualPrompt,
    options: {
      cwd: session.cwd,
      resume: session.resumeId ?? undefined,
      // Behave like Claude Code, not a bare assistant: use its system prompt...
      systemPrompt: { type: "preset", preset: "claude_code" },
      // ...and load the target project's (and user's) CLAUDE.md, settings,
      // subagents, and slash commands. The SDK loads none of these by default.
      settingSources: ["user", "project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Run under the same node binary as this process (matches pm2's PATH).
      executable: process.execPath as "node",
      env: claudeEnv,
      // Optional guardrails — only applied when set in the environment.
      model: config.model,
      fallbackModel: config.fallbackModel,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      stderr: (data) => console.error(`[claude] ${data}`),
    },
  });

  let finalText = "";
  const iterator = (messages as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();

  while (true) {
    let result: IteratorResult<SDKMessage>;
    try {
      result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () =>
              reject(
                new Error(
                  `Claude SDK stalled (no output for ${STREAM_IDLE_TIMEOUT_MS / 1000}s)`,
                ),
              ),
            STREAM_IDLE_TIMEOUT_MS,
          );
          t.unref();
        }),
      ]);
    } catch (err) {
      try {
        await iterator.return?.(undefined as any);
      } catch {}
      throw err;
    }

    if (result.done) return;
    const anyMsg = result.value as any;

    if (anyMsg.session_id && !session.resumeId) {
      session.resumeId = anyMsg.session_id;
      saveSession();
    }

    if (anyMsg.type === "assistant" && anyMsg.message?.content) {
      for (const block of anyMsg.message.content) {
        if (block.type === "text" && block.text) {
          finalText += block.text;
          yield { kind: "text", text: block.text };
        } else if (block.type === "tool_use") {
          yield { kind: "tool", name: block.name, input: block.input };
        }
      }
    }

    if (anyMsg.type === "result") {
      yield { kind: "done", summary: finalText || anyMsg.result || "(no output)" };
      return;
    }
  }
}

export async function* runClaudeWithImage(
  prompt: string,
  imageBuffer: Buffer,
): AsyncGenerator<ClaudeChunk> {
  // Inject context on first message after bot start (whether new or resumed session)
  const needsContext = !session.contextSentThisRun;
  const isResumedSession = !!session.resumeId;

  let contextualPrompt = prompt;
  if (needsContext) {
    const contextPrefix = isResumedSession
      ? getPocketClawContext(true)
      : getPocketClawContext(false);
    contextualPrompt = contextPrefix + prompt;
    session.contextSentThisRun = true;
  }

  // Convert image buffer to base64
  const base64Image = imageBuffer.toString("base64");

  // Detect media type from image buffer (simple magic number detection)
  let mediaType = "image/jpeg";
  if (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50) {
    mediaType = "image/png";
  } else if (imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49) {
    mediaType = "image/gif";
  } else if (imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49) {
    mediaType = "image/webp";
  }

  // Create a message with image content
  const userMessage = {
    role: "user" as const,
    content: [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: base64Image,
        },
      },
      {
        type: "text" as const,
        text: contextualPrompt,
      },
    ],
  };

  // Create an async generator that yields the user message with required SDK fields
  async function* messageGenerator(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user" as const,
      message: userMessage,
      parent_tool_use_id: null,
      session_id: session.resumeId || "",
    } as SDKUserMessage;
  }

  const messages = query({
    prompt: messageGenerator(),
    options: {
      cwd: session.cwd,
      resume: session.resumeId ?? undefined,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      executable: process.execPath as "node",
      env: claudeEnv,
      model: config.model,
      fallbackModel: config.fallbackModel,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      stderr: (data) => console.error(`[claude] ${data}`),
    },
  });

  let finalText = "";
  const iterator = (messages as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();

  while (true) {
    let result: IteratorResult<SDKMessage>;
    try {
      result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () =>
              reject(
                new Error(
                  `Claude SDK stalled (no output for ${STREAM_IDLE_TIMEOUT_MS / 1000}s)`,
                ),
              ),
            STREAM_IDLE_TIMEOUT_MS,
          );
          t.unref();
        }),
      ]);
    } catch (err) {
      try {
        await iterator.return?.(undefined as any);
      } catch {}
      throw err;
    }

    if (result.done) return;
    const anyMsg = result.value as any;

    if (anyMsg.session_id && !session.resumeId) {
      session.resumeId = anyMsg.session_id;
      saveSession();
    }

    if (anyMsg.type === "assistant" && anyMsg.message?.content) {
      for (const block of anyMsg.message.content) {
        if (block.type === "text" && block.text) {
          finalText += block.text;
          yield { kind: "text", text: block.text };
        } else if (block.type === "tool_use") {
          yield { kind: "tool", name: block.name, input: block.input };
        }
      }
    }

    if (anyMsg.type === "result") {
      yield { kind: "done", summary: finalText || anyMsg.result || "(no output)" };
      return;
    }
  }
}
