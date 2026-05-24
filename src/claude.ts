import { statSync } from "node:fs";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";

// Max time between SDK messages before we assume the turn is wedged.
// With Telegraf's handler timeout disabled, this is the only ceiling.
const STREAM_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

type SessionState = {
  cwd: string;
  resumeId: string | null;
};

const session: SessionState = {
  cwd: config.defaultProjectDir,
  resumeId: null,
};

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
}

export function resetSession(): void {
  session.resumeId = null;
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

export type ClaudeChunk =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "done"; summary: string };

export async function* runClaude(prompt: string): AsyncGenerator<ClaudeChunk> {
  const messages = query({
    prompt,
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
