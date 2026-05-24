import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ClaudeSession {
  sessionId: string;
  firstMessage: string;
  lastActivity: number;
  messageCount: number;
  gitBranch?: string;
}

/**
 * Encode a working directory path the same way Claude Code does:
 * Replace non-alphanumeric characters (except - and _) with hyphens.
 * Examples:
 *   /Users/jason → -Users-jason
 *   /Users/jason/pocketclaw → -Users-jason-pocketclaw
 */
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Get the Claude Code projects directory for a specific working directory.
 * This is where Claude Code stores session JSONL files.
 */
function getClaudeProjectDir(cwd: string): string {
  const encodedPath = encodeProjectPath(cwd);
  return join(homedir(), ".claude", "projects", encodedPath);
}

/**
 * Parse a Claude Code session JSONL file to extract metadata.
 * Each line is a JSON object representing a message or event.
 * We extract the first user message and count total messages.
 */
function parseSessionFile(sessionPath: string): ClaudeSession | null {
  try {
    const content = readFileSync(sessionPath, "utf-8");
    const lines = content.trim().split("\n");

    let sessionId = "";
    let firstMessage = "";
    let lastActivity = 0;
    let messageCount = 0;
    let gitBranch: string | undefined;

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        // Extract session ID
        if (!sessionId && entry.sessionId) {
          sessionId = entry.sessionId;
        }

        // Extract git branch
        if (!gitBranch && entry.gitBranch) {
          gitBranch = entry.gitBranch;
        }

        // Track last activity timestamp
        if (entry.timestamp) {
          const ts = new Date(entry.timestamp).getTime();
          if (ts > lastActivity) {
            lastActivity = ts;
          }
        }

        // Count user/assistant messages
        if (entry.type === "user" || entry.type === "assistant") {
          messageCount++;

          // Extract first meaningful user message (skip agent warmup messages)
          if (
            !firstMessage &&
            entry.type === "user" &&
            entry.message?.content &&
            !entry.isSidechain
          ) {
            // Handle both string content and array content
            const content = entry.message.content;
            if (typeof content === "string") {
              if (content !== "Warmup") {
                firstMessage = content;
              }
            } else if (Array.isArray(content)) {
              // Find first text block
              const textBlock = content.find((block: any) => block.type === "text");
              if (textBlock?.text && textBlock.text !== "Warmup") {
                firstMessage = textBlock.text;
              }
            }
          }
        }
      } catch (err) {
        // Skip malformed lines
        continue;
      }
    }

    // If we didn't find a session ID or any messages, skip this file
    if (!sessionId || messageCount === 0) {
      return null;
    }

    return {
      sessionId,
      firstMessage: firstMessage || "(no message preview)",
      lastActivity: lastActivity || Date.now(),
      messageCount,
      gitBranch,
    };
  } catch (err) {
    console.warn(`Failed to parse session file ${sessionPath}:`, err);
    return null;
  }
}

/**
 * List all Claude Code sessions for a specific project directory.
 * Reads from ~/.claude/projects/<encoded-cwd>/ and parses JSONL files.
 */
export function listSessions(projectPath: string): ClaudeSession[] {
  const projectDir = getClaudeProjectDir(projectPath);

  if (!existsSync(projectDir)) {
    return [];
  }

  try {
    const files = readdirSync(projectDir);
    const sessions: ClaudeSession[] = [];

    for (const file of files) {
      // Skip agent session files (they're sub-sessions)
      if (file.startsWith("agent-")) continue;

      // Only process .jsonl files
      if (!file.endsWith(".jsonl")) continue;

      const fullPath = join(projectDir, file);

      // Skip if not a file
      try {
        const stats = statSync(fullPath);
        if (!stats.isFile()) continue;
      } catch {
        continue;
      }

      // Parse the session
      const session = parseSessionFile(fullPath);
      if (session) {
        sessions.push(session);
      }
    }

    // Sort by last activity (most recent first)
    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  } catch (err) {
    console.warn(`Failed to list sessions from ${projectDir}:`, err);
    return [];
  }
}

/**
 * Load a specific session by ID (for resuming).
 * Returns the session metadata if found.
 */
export function loadSession(projectPath: string, sessionId: string): ClaudeSession | null {
  const projectDir = getClaudeProjectDir(projectPath);
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);

  if (!existsSync(sessionFile)) {
    return null;
  }

  return parseSessionFile(sessionFile);
}

/**
 * Find a session by partial ID match (for user convenience).
 * Allows users to type just the first few characters of a session ID.
 */
export function findSessionByPrefix(projectPath: string, prefix: string): ClaudeSession | null {
  const sessions = listSessions(projectPath);
  return sessions.find((s) => s.sessionId.startsWith(prefix)) || null;
}

/**
 * Format sessions list for display in Telegram with clickable buttons.
 * Returns both text and inline keyboard.
 */
export function formatSessionsList(
  sessions: ClaudeSession[],
  currentSessionId: string | null,
  page: number = 0,
  pageSize: number = 5
): { text: string; sessions: ClaudeSession[]; totalPages: number } {
  if (sessions.length === 0) {
    return {
      text: "No Claude Code sessions found for this project.\n\nStart a conversation in Claude Code or VS Code to create sessions.",
      sessions: [],
      totalPages: 0,
    };
  }

  const totalPages = Math.ceil(sessions.length / pageSize);
  const start = page * pageSize;
  const end = start + pageSize;
  const pageSessions = sessions.slice(start, end);

  const lines: string[] = [
    `📋 *Claude Code Sessions* (${sessions.length} total)`,
    `Page ${page + 1}/${totalPages}\n`,
  ];

  for (const session of pageSessions) {
    const isActive = session.sessionId === currentSessionId;
    const icon = isActive ? "▶️" : "💬";
    const age = formatAge(session.lastActivity);
    const shortId = session.sessionId.slice(0, 8);

    // Truncate message preview
    const preview = session.firstMessage.slice(0, 60);
    const previewText = session.firstMessage.length > 60 ? `${preview}...` : preview;

    lines.push(`${icon} \`${shortId}\` · ${age} · ${session.messageCount} msgs`);
    lines.push(`   _${previewText}_`);
    if (session.gitBranch) {
      lines.push(`   🌿 ${session.gitBranch}`);
    }
    lines.push("");
  }

  lines.push("\n💡 Tap a session below to load it");

  return {
    text: lines.join("\n"),
    sessions: pageSessions,
    totalPages,
  };
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
