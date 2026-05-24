import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";

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
  session.cwd = path;
  session.resumeId = null;
}

export function resetSession(): void {
  session.resumeId = null;
}

export type ClaudeChunk =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "done"; summary: string };

export async function* runClaude(prompt: string): AsyncGenerator<ClaudeChunk> {
  if (config.claudeCodeOAuthToken) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = config.claudeCodeOAuthToken;
    delete process.env.ANTHROPIC_API_KEY;
  } else if (config.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }

  const messages = query({
    prompt,
    options: {
      cwd: session.cwd,
      resume: session.resumeId ?? undefined,
      permissionMode: "bypassPermissions",
    },
  });

  let finalText = "";

  for await (const msg of messages as AsyncIterable<SDKMessage>) {
    const anyMsg = msg as any;

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
