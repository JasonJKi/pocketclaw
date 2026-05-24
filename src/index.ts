import { writeFileSync, mkdirSync, readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, isAbsolute, resolve, extname } from "node:path";
import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "./config.js";
import { transcribeOggBuffer, isTranscriptionEnabled } from "./transcribe.js";
import { runClaude, runClaudeWithImage, getCwd, setCwd, resetSession, setResumeId, getSessionInfo } from "./claude.js";
import { chunkForTelegram } from "./chunk.js";
import { discoverProjects, findProjectByName, formatProjectsList } from "./projects.js";
import { listSessions, loadSession as loadSessionById, findSessionByPrefix, formatSessionsList } from "./sessions.js";
import {
  buildHelpMenu,
  buildHelpCategory,
  buildProjectSelector,
  buildFileBrowser,
  buildQuickActions,
} from "./commands.js";

const bot = new Telegraf(config.telegramBotToken, {
  handlerTimeout: Infinity,
});

// Best-effort reply for progress/status pings. Swallows send errors so
// a transient Telegram failure (rate limit, network blip) can't kill an
// in-flight Claude turn or leave a stuck session behind.
async function tryReply(ctx: any, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (err: any) {
    console.warn(`reply failed: ${err?.message ?? String(err)}`);
  }
}

// Format a timestamp as a human-readable relative time
function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Download a file from Telegram and save it to .telegram-uploads in cwd
async function downloadAndSaveFile(
  ctx: any,
  fileId: string,
  fileName: string,
): Promise<string> {
  const uploadsDir = join(getCwd(), ".telegram-uploads");
  try {
    mkdirSync(uploadsDir, { recursive: true });
  } catch (err: any) {
    console.warn(`mkdir .telegram-uploads failed: ${err?.message ?? String(err)}`);
  }

  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link.toString(), { signal: AbortSignal.timeout(60_000) });
  const buffer = Buffer.from(await res.arrayBuffer());

  // Sanitize filename to prevent path traversal
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const timestamp = Date.now();
  const fullPath = join(uploadsDir, `${timestamp}_${safeName}`);

  writeFileSync(fullPath, buffer);
  return fullPath;
}

// Snapshot current directory files for detecting new files after Claude execution
function snapshotFiles(dir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  try {
    if (!existsSync(dir)) return snapshot;
    const files = readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile()) {
        const fullPath = join(dir, file.name);
        const stats = statSync(fullPath);
        snapshot.set(file.name, stats.mtimeMs);
      }
    }
  } catch (err: any) {
    console.warn(`snapshot failed: ${err?.message ?? String(err)}`);
  }
  return snapshot;
}

// Detect new or modified files, filtering for likely output files (images, PDFs, etc.)
function detectNewFiles(dir: string, before: Map<string, number>): string[] {
  const newFiles: string[] = [];
  const interestingExtensions = [".png", ".jpg", ".jpeg", ".pdf", ".gif", ".svg", ".webp", ".mp4", ".mov"];

  try {
    if (!existsSync(dir)) return newFiles;
    const files = readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile()) {
        const ext = extname(file.name).toLowerCase();
        if (!interestingExtensions.includes(ext)) continue;

        const fullPath = join(dir, file.name);
        const stats = statSync(fullPath);
        const oldMtime = before.get(file.name);

        // New file or modified file
        if (!oldMtime || stats.mtimeMs > oldMtime) {
          newFiles.push(file.name);
        }
      }
    }
  } catch (err: any) {
    console.warn(`detectNewFiles failed: ${err?.message ?? String(err)}`);
  }

  return newFiles;
}

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== config.allowedUserId) {
    console.warn(`Rejected message from user ${ctx.from?.id} (${ctx.from?.username})`);
    return;
  }
  await next();
});

bot.command("start", async (ctx) => {
  const welcomeText = [
    "🤖 *PocketClaw Ready*",
    "",
    `📁 ${getCwd()}`,
    "",
    "I'm your AI coding assistant via Telegram!",
    "",
    "💬 Send me messages, voice notes, images, or files",
    "🔧 Use /help to see all commands",
    "⚡ Or tap a quick action below:",
  ].join("\n");

  const hasGit = existsSync(join(getCwd(), ".git"));
  const quickActions = buildQuickActions(getCwd().split("/").pop() || "current", hasGit);

  await ctx.reply(welcomeText, { parse_mode: "Markdown" });
  await ctx.reply(quickActions.text, quickActions.keyboard);
});

bot.command("help", async (ctx) => {
  const { text, keyboard } = buildHelpMenu();
  await ctx.reply(text, keyboard);
});

bot.command("cwd", (ctx) => ctx.reply(`cwd: ${getCwd()}`));

bot.command("cd", (ctx) => {
  const arg = ctx.message.text.replace(/^\/cd(@\S+)?\s*/, "").trim();
  if (!arg) return ctx.reply("Usage: /cd <absolute-path>");
  try {
    setCwd(arg);
  } catch (err: any) {
    return ctx.reply(`❌ ${err?.message ?? String(err)}`);
  }
  return ctx.reply(`cwd → ${arg}\n(session reset)`);
});

bot.command("reset", (ctx) => {
  resetSession();
  return ctx.reply("Session reset.");
});

bot.command("status", (ctx) => {
  const info = getSessionInfo();
  const sessionAge = info.lastActivity
    ? `${Math.floor((Date.now() - info.lastActivity) / 1000)}s ago`
    : "never";

  return ctx.reply(
    [
      "📊 Session Status",
      `📁 cwd: ${info.cwd}`,
      `🔑 session: ${info.resumeId ? "active" : "none"}`,
      `⏱️ last activity: ${sessionAge}`,
    ].join("\n")
  );
});

bot.command("projects", async (ctx) => {
  const projects = discoverProjects();
  const { text, keyboard } = buildProjectSelector(projects);

  if (keyboard) {
    await ctx.reply(text, keyboard);
  } else {
    await ctx.reply(text);
  }
});

bot.command("switch", (ctx) => {
  const arg = ctx.message.text.replace(/^\/switch(@\S+)?\s*/, "").trim();
  if (!arg) {
    return ctx.reply("Usage: /switch <project-name>\n\nUse /projects to see available projects.");
  }

  const projects = discoverProjects();
  const project = findProjectByName(arg, projects);

  if (!project) {
    return ctx.reply(
      `❌ Project "${arg}" not found.\n\nUse /projects to see available projects.`,
    );
  }

  try {
    setCwd(project.path);
    return ctx.reply(
      [
        `✅ Switched to: ${project.name}`,
        `📁 ${project.path}`,
        project.description ? `📝 ${project.description}` : "",
        "",
        "(session reset)",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (err: any) {
    return ctx.reply(`❌ ${err?.message ?? String(err)}`);
  }
});

async function sendFileToTelegram(ctx: any, filePath: string): Promise<void> {
  try {
    // Resolve path relative to cwd if not absolute
    const fullPath = isAbsolute(filePath) ? filePath : resolve(getCwd(), filePath);

    // Security check: ensure file is within cwd (prevent path traversal)
    const cwd = getCwd();
    if (!fullPath.startsWith(cwd)) {
      await ctx.reply(`❌ Access denied. File must be within current directory:\n${cwd}`);
      return;
    }

    // Check if file exists and is a file (not directory)
    let stats;
    try {
      stats = statSync(fullPath);
    } catch (err: any) {
      await ctx.reply(`❌ File not found: ${filePath}`);
      return;
    }

    if (!stats.isFile()) {
      await ctx.reply(`❌ Not a file: ${filePath}`);
      return;
    }

    // Check file size (Telegram has a 50MB limit for bots)
    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > 50) {
      await ctx.reply(`❌ File too large: ${sizeMB.toFixed(1)}MB (limit: 50MB)`);
      return;
    }

    await tryReply(ctx, `📤 Sending ${filePath}...`);

    // Read and send the file
    const buffer = readFileSync(fullPath);
    const fileName = filePath.split("/").pop() || "file";

    await ctx.replyWithDocument({
      source: buffer,
      filename: fileName,
    });
  } catch (err: any) {
    console.error(err);
    await ctx.reply(`❌ Failed to send file: ${err?.message ?? String(err)}`);
  }
}

bot.command("send", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/send(@\S+)?\s*/, "").trim();
  if (!arg) {
    return ctx.reply("Usage: /send <file-path>\n\nExample: /send output.png");
  }
  await sendFileToTelegram(ctx, arg);
});

bot.command("get", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/get(@\S+)?\s*/, "").trim();
  if (!arg) {
    return ctx.reply("Usage: /get <file-path>\n\nExample: /get report.pdf");
  }
  await sendFileToTelegram(ctx, arg);
});

bot.command("files", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/files(@\S+)?\s*/, "").trim();
  const pattern = arg || "*";

  try {
    const cwd = getCwd();
    const allFiles = readdirSync(cwd, { withFileTypes: true });

    // Filter files (not directories) and apply pattern if specified
    let files = allFiles.filter((f) => f.isFile());

    if (pattern !== "*") {
      const regex = new RegExp(pattern.replace(/\*/g, ".*"), "i");
      files = files.filter((f) => regex.test(f.name));
    }

    // Sort by modification time (most recent first)
    const fileStats = files
      .map((f) => {
        const fullPath = join(cwd, f.name);
        const stats = statSync(fullPath);
        return { name: f.name, mtime: stats.mtime, size: stats.size };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const { text, keyboard } = buildFileBrowser(fileStats, 0, 10);

    if (keyboard) {
      await ctx.reply(text, keyboard);
    } else {
      await ctx.reply(text);
    }
  } catch (err: any) {
    console.error(err);
    await ctx.reply(`❌ Failed to list files: ${err?.message ?? String(err)}`);
  }
});

async function handlePrompt(ctx: any, prompt: string) {
  if (!prompt.trim()) {
    await tryReply(ctx, "(empty prompt)");
    return;
  }

  let thinkingId: number | undefined;
  try {
    const thinking = await ctx.reply(`💭 ${prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt}`);
    thinkingId = thinking.message_id;
  } catch (err: any) {
    console.warn(`thinking-reply failed: ${err?.message ?? String(err)}`);
  }

  // Snapshot files before Claude execution
  const filesBefore = snapshotFiles(getCwd());

  let claudeFinished = false;
  try {
    let finalText = "";
    let streamBuffer = "";
    let lastStreamSent = 0;
    const STREAM_CHUNK_SIZE = 500; // Send every 500 chars or 2 seconds
    const STREAM_INTERVAL_MS = 2000;

    for await (const chunk of runClaude(prompt)) {
      if (chunk.kind === "text") {
        finalText += chunk.text;
        streamBuffer += chunk.text;

        // Stream text in real-time if buffer is large enough or enough time has passed
        const now = Date.now();
        if (streamBuffer.length >= STREAM_CHUNK_SIZE || now - lastStreamSent >= STREAM_INTERVAL_MS) {
          if (streamBuffer.trim()) {
            await tryReply(ctx, streamBuffer);
            streamBuffer = "";
            lastStreamSent = now;
          }
        }
      } else if (chunk.kind === "tool") {
        // Flush any pending text before tool notification
        if (streamBuffer.trim()) {
          await tryReply(ctx, streamBuffer);
          streamBuffer = "";
        }
        // Extract description from tool input if available
        const input = chunk.input as any;
        const description = input?.description;
        const toolMsg = description ? `🔧 ${chunk.name}: ${description}` : `🔧 ${chunk.name}`;
        await tryReply(ctx, toolMsg);
        lastStreamSent = Date.now();
      } else if (chunk.kind === "done") {
        finalText = finalText || chunk.summary;
      }
    }
    claudeFinished = true;

    // Send any remaining buffered text
    if (streamBuffer.trim()) {
      await tryReply(ctx, streamBuffer);
    }

    // If nothing was streamed, send the final output
    if (!finalText.trim() || finalText.trim() === streamBuffer.trim()) {
      // Already sent everything via streaming
    } else if (lastStreamSent === 0) {
      // Nothing was streamed, send final output
      const out = finalText.trim() || "(no output)";
      const pieces = chunkForTelegram(out);
      let delivered = 0;
      for (const piece of pieces) {
        try {
          await ctx.reply(piece);
          delivered++;
          // Rate limit throttling
          if (delivered < pieces.length) {
            await new Promise(r => setTimeout(r, 50));
          }
        } catch (err: any) {
          console.error(`final-reply piece ${delivered + 1}/${pieces.length} failed:`, err);
          await tryReply(ctx, `⚠️ delivery failed at piece ${delivered + 1}/${pieces.length}: ${err?.message ?? String(err)}`);
          break;
        }
      }
    }

    // Detect new files and offer to send them
    const newFiles = detectNewFiles(getCwd(), filesBefore);
    if (newFiles.length > 0 && newFiles.length <= 3) {
      const buttons = newFiles.map((file) => [
        Markup.button.callback(`📤 Send ${file}`, `send:${file}`)
      ]);
      await tryReply(
        ctx,
        `I created ${newFiles.length} file(s): ${newFiles.join(", ")}`
      );
      await ctx.reply("Send to Telegram?", Markup.inlineKeyboard(buttons));
    } else if (newFiles.length > 3) {
      await tryReply(ctx, `I created ${newFiles.length} files. Use /files to list them.`);
    }
  } catch (err: any) {
    console.error(err);
    // Only reset the session if Claude itself failed mid-turn. If the
    // failure happened after Claude finished (delivery-only), the work
    // is real and worth keeping in the resume chain.
    if (!claudeFinished) resetSession();
    await tryReply(
      ctx,
      claudeFinished
        ? `❌ ${err?.message ?? String(err)}`
        : `❌ ${err?.message ?? String(err)}\n(session reset)`,
    );
  } finally {
    if (thinkingId !== undefined) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, thinkingId);
      } catch {}
    }
  }
}

async function handlePromptWithImage(ctx: any, prompt: string, imageBuffer: Buffer) {
  if (!prompt.trim()) {
    await tryReply(ctx, "(empty prompt)");
    return;
  }

  let thinkingId: number | undefined;
  try {
    const thinking = await ctx.reply(`💭 ${prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt}`);
    thinkingId = thinking.message_id;
  } catch (err: any) {
    console.warn(`thinking-reply failed: ${err?.message ?? String(err)}`);
  }

  let claudeFinished = false;
  try {
    let finalText = "";
    let streamBuffer = "";
    let lastStreamSent = 0;
    const STREAM_CHUNK_SIZE = 500;
    const STREAM_INTERVAL_MS = 2000;

    for await (const chunk of runClaudeWithImage(prompt, imageBuffer)) {
      if (chunk.kind === "text") {
        finalText += chunk.text;
        streamBuffer += chunk.text;

        const now = Date.now();
        if (streamBuffer.length >= STREAM_CHUNK_SIZE || now - lastStreamSent >= STREAM_INTERVAL_MS) {
          if (streamBuffer.trim()) {
            await tryReply(ctx, streamBuffer);
            streamBuffer = "";
            lastStreamSent = now;
          }
        }
      } else if (chunk.kind === "tool") {
        if (streamBuffer.trim()) {
          await tryReply(ctx, streamBuffer);
          streamBuffer = "";
        }
        // Extract description from tool input if available
        const input = chunk.input as any;
        const description = input?.description;
        const toolMsg = description ? `🔧 ${chunk.name}: ${description}` : `🔧 ${chunk.name}`;
        await tryReply(ctx, toolMsg);
        lastStreamSent = Date.now();
      } else if (chunk.kind === "done") {
        finalText = finalText || chunk.summary;
      }
    }
    claudeFinished = true;

    if (streamBuffer.trim()) {
      await tryReply(ctx, streamBuffer);
    }

    if (!finalText.trim() || finalText.trim() === streamBuffer.trim()) {
      // Already sent via streaming
    } else if (lastStreamSent === 0) {
      const out = finalText.trim() || "(no output)";
      const pieces = chunkForTelegram(out);
      let delivered = 0;
      for (const piece of pieces) {
        try {
          await ctx.reply(piece);
          delivered++;
          if (delivered < pieces.length) {
            await new Promise(r => setTimeout(r, 50));
          }
        } catch (err: any) {
          console.error(`final-reply piece ${delivered + 1}/${pieces.length} failed:`, err);
          await tryReply(ctx, `⚠️ delivery failed at piece ${delivered + 1}/${pieces.length}: ${err?.message ?? String(err)}`);
          break;
        }
      }
    }
  } catch (err: any) {
    console.error(err);
    if (!claudeFinished) resetSession();
    await tryReply(
      ctx,
      claudeFinished
        ? `❌ ${err?.message ?? String(err)}`
        : `❌ ${err?.message ?? String(err)}\n(session reset)`,
    );
  } finally {
    if (thinkingId !== undefined) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, thinkingId);
      } catch {}
    }
  }
}

// Session management commands
bot.command("sessions", async (ctx) => {
  try {
    const allSessions = listSessions(getCwd());
    const sessionInfo = getSessionInfo();
    const { text, sessions: pageSessions, totalPages } = formatSessionsList(allSessions, sessionInfo.resumeId, 0, 5);

    if (allSessions.length === 0) {
      await ctx.reply(text, { parse_mode: "Markdown" });
      return;
    }

    // Build inline keyboard with session buttons
    const buttons = pageSessions.map((session) => {
      const shortId = session.sessionId.slice(0, 8);
      const preview = session.firstMessage.slice(0, 30);
      const label = `${shortId}: ${preview}${session.firstMessage.length > 30 ? "..." : ""}`;
      return [Markup.button.callback(label, `session:load:${session.sessionId}`)];
    });

    // Add pagination if needed
    const paginationRow = [];
    if (totalPages > 1) {
      if (0 > 0) {
        paginationRow.push(Markup.button.callback("⬅️ Prev", `session:page:${0 - 1}`));
      }
      paginationRow.push(Markup.button.callback("🆕 New Session", "session:new"));
      if (0 < totalPages - 1) {
        paginationRow.push(Markup.button.callback("Next ➡️", `session:page:${0 + 1}`));
      }
    } else {
      paginationRow.push(Markup.button.callback("🆕 New Session", "session:new"));
    }

    buttons.push(paginationRow);

    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (err: any) {
    console.error(err);
    await ctx.reply(`❌ Failed to list sessions: ${err?.message ?? String(err)}`);
  }
});

bot.command("load", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/load(@\S+)?\s*/, "").trim();
  if (!arg) {
    return ctx.reply("Usage: /load <session-id>\n\nUse /sessions to see available sessions.\n\nYou can use the full ID or just the first few characters (e.g., `773026f0` or `773026f0-8956-44f9-aa21-75652e487b0f`)");
  }

  try {
    // Try to find session by prefix first (user convenience)
    let session = findSessionByPrefix(getCwd(), arg);

    // If not found by prefix, try exact ID
    if (!session) {
      session = loadSessionById(getCwd(), arg);
    }

    if (!session) {
      return ctx.reply(`❌ Session "${arg}" not found.\n\nUse /sessions to see available sessions.`);
    }

    // Load the session by setting the resume ID
    setResumeId(session.sessionId);

    const preview = session.firstMessage.slice(0, 100);
    await ctx.reply(
      [
        `✅ Loaded session \`${session.sessionId.slice(0, 8)}\``,
        `📅 ${formatAge(session.lastActivity)}`,
        `💬 ${session.messageCount} messages`,
        session.gitBranch ? `🌿 ${session.gitBranch}` : "",
        "",
        `Preview: "${preview}${session.firstMessage.length > 100 ? "..." : ""}"`,
      ]
        .filter(Boolean)
        .join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (err: any) {
    console.error(err);
    await ctx.reply(`❌ Failed to load session: ${err?.message ?? String(err)}`);
  }
});

bot.command("new", async (ctx) => {
  try {
    const sessionInfo = getSessionInfo();
    const hadSession = !!sessionInfo.resumeId;

    // Reset to start new session
    resetSession();

    if (hadSession) {
      await ctx.reply(`✅ Started new session\n\n(Previous session ${sessionInfo.resumeId?.slice(0, 8)} is saved in Claude Code history)`);
    } else {
      await ctx.reply("🆕 Started new session");
    }
  } catch (err: any) {
    console.error(err);
    await ctx.reply(`❌ Failed to create new session: ${err?.message ?? String(err)}`);
  }
});

// Git workflow shortcuts
bot.command("commit", async (ctx) => {
  await handlePrompt(ctx, "Please create a git commit. Review the changes, generate an appropriate commit message, and commit them.");
});

bot.command("diff", async (ctx) => {
  await handlePrompt(ctx, "Show me the git diff of current changes.");
});

bot.command("pr", async (ctx) => {
  await handlePrompt(ctx, "Create a pull request for the current branch. Generate a good PR title and description based on the changes.");
});

bot.command("push", async (ctx) => {
  await handlePrompt(ctx, "Push the current branch to remote.");
});

bot.command("pull", async (ctx) => {
  await handlePrompt(ctx, "Pull the latest changes from remote.");
});

bot.command("branch", async (ctx) => {
  await handlePrompt(ctx, "Show me the current git branch and list other branches.");
});

// Dev tool shortcuts
bot.command("test", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/test(@\S+)?\s*/, "").trim();
  const prompt = arg ? `Run tests matching: ${arg}` : "Run the test suite.";
  await handlePrompt(ctx, prompt);
});

bot.command("build", async (ctx) => {
  await handlePrompt(ctx, "Build the project.");
});

bot.command("lint", async (ctx) => {
  await handlePrompt(ctx, "Run the linter and fix any issues.");
});

bot.command("logs", async (ctx) => {
  await handlePrompt(ctx, "Show me recent logs.");
});

bot.command("dev", async (ctx) => {
  await handlePrompt(ctx, "Start the development server.");
});

// AI-focused commands
bot.command("ask", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/ask(@\S+)?\s*/, "").trim();
  if (!arg) {
    return ctx.reply("Usage: /ask <question>\n\nExample: /ask How does authentication work in this app?");
  }
  await handlePrompt(ctx, `Please answer this question without executing any code: ${arg}`);
});

bot.command("explain", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/explain(@\S+)?\s*/, "").trim();
  if (!arg) {
    return ctx.reply("Usage: /explain <file-or-code>\n\nExample: /explain src/auth.ts");
  }
  await handlePrompt(ctx, `Please explain: ${arg}`);
});

bot.command("fix", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/fix(@\S+)?\s*/, "").trim();
  if (!arg) {
    return ctx.reply("Usage: /fix <issue>\n\nExample: /fix login button not working");
  }
  await handlePrompt(ctx, `Please debug and fix this issue: ${arg}`);
});

bot.command("add", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/add(@\S+)?\s*/, "").trim();
  if (!arg) {
    return ctx.reply("Usage: /add <feature>\n\nExample: /add logout button to header");
  }
  await handlePrompt(ctx, `Please implement this feature: ${arg}`);
});

bot.command("refactor", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/refactor(@\S+)?\s*/, "").trim();
  if (!arg) {
    return ctx.reply("Usage: /refactor <target>\n\nExample: /refactor auth module to use hooks");
  }
  await handlePrompt(ctx, `Please refactor: ${arg}`);
});

// Handle inline keyboard button clicks
bot.on("callback_query", async (ctx) => {
  try {
    const data = (ctx.callbackQuery as any).data;
    if (!data) return;

    // Help system navigation
    if (data.startsWith("help:")) {
      const category = data.substring(5);
      const helpText = buildHelpCategory(category);
      const backButton = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back to menu", "help:menu")]]);
      await ctx.editMessageText(helpText, backButton);
      await ctx.answerCbQuery();
      return;
    }

    if (data === "help:menu") {
      const { text, keyboard } = buildHelpMenu();
      await ctx.editMessageText(text, keyboard);
      await ctx.answerCbQuery();
      return;
    }

    // Project switching
    if (data.startsWith("project:")) {
      const projectName = data.substring(8);
      await ctx.answerCbQuery(`Switching to ${projectName}...`);

      const projects = discoverProjects();
      const project = findProjectByName(projectName, projects);

      if (project) {
        try {
          setCwd(project.path);
          await ctx.reply(
            [
              `✅ Switched to: ${project.name}`,
              `📁 ${project.path}`,
              project.description ? `📝 ${project.description}` : "",
              "",
              "(session reset)",
            ]
              .filter(Boolean)
              .join("\n"),
          );

          // Show quick actions for new project
          const hasGit = existsSync(join(project.path, ".git"));
          const quickActions = buildQuickActions(project.name, hasGit);
          await ctx.reply(quickActions.text, quickActions.keyboard);
        } catch (err: any) {
          await ctx.reply(`❌ ${err?.message ?? String(err)}`);
        }
      }
      return;
    }

    if (data === "projects:refresh") {
      await ctx.answerCbQuery("Refreshing...");
      const projects = discoverProjects();
      const { text, keyboard } = buildProjectSelector(projects);
      if (keyboard) {
        await ctx.editMessageText(text, keyboard);
      }
      return;
    }

    // File browser
    if (data.startsWith("file:")) {
      const fileName = data.substring(5);
      await ctx.answerCbQuery(`Sending ${fileName}...`);
      await sendFileToTelegram(ctx, fileName);
      return;
    }

    if (data.startsWith("files:")) {
      const page = parseInt(data.substring(6));
      await ctx.answerCbQuery();

      try {
        const cwd = getCwd();
        const allFiles = readdirSync(cwd, { withFileTypes: true });
        const files = allFiles
          .filter((f) => f.isFile())
          .map((f) => {
            const fullPath = join(cwd, f.name);
            const stats = statSync(fullPath);
            return { name: f.name, mtime: stats.mtime, size: stats.size };
          })
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        const { text, keyboard } = buildFileBrowser(files, page, 10);
        if (keyboard) {
          await ctx.editMessageText(text, keyboard);
        }
      } catch (err: any) {
        console.error(err);
      }
      return;
    }

    // Session management callbacks
    if (data.startsWith("session:load:")) {
      const sessionId = data.substring(13);
      await ctx.answerCbQuery("Loading session...");

      try {
        const session = loadSessionById(getCwd(), sessionId);

        if (!session) {
          await ctx.reply(`❌ Session not found.`);
          return;
        }

        // Load the session by setting the resume ID
        setResumeId(session.sessionId);

        const preview = session.firstMessage.slice(0, 100);
        await ctx.reply(
          [
            `✅ Loaded session \`${session.sessionId.slice(0, 8)}\``,
            `📅 ${formatAge(session.lastActivity)}`,
            `💬 ${session.messageCount} messages`,
            session.gitBranch ? `🌿 ${session.gitBranch}` : "",
            "",
            `Preview: "${preview}${session.firstMessage.length > 100 ? "..." : ""}"`,
          ]
            .filter(Boolean)
            .join("\n"),
          { parse_mode: "Markdown" }
        );
      } catch (err: any) {
        console.error(err);
        await ctx.reply(`❌ Failed to load session: ${err?.message ?? String(err)}`);
      }
      return;
    }

    if (data.startsWith("session:page:")) {
      const page = parseInt(data.substring(13));
      await ctx.answerCbQuery();

      try {
        const allSessions = listSessions(getCwd());
        const sessionInfo = getSessionInfo();
        const { text, sessions: pageSessions, totalPages } = formatSessionsList(allSessions, sessionInfo.resumeId, page, 5);

        // Build inline keyboard with session buttons
        const buttons = pageSessions.map((session) => {
          const shortId = session.sessionId.slice(0, 8);
          const preview = session.firstMessage.slice(0, 30);
          const label = `${shortId}: ${preview}${session.firstMessage.length > 30 ? "..." : ""}`;
          return [Markup.button.callback(label, `session:load:${session.sessionId}`)];
        });

        // Add pagination
        const paginationRow = [];
        if (page > 0) {
          paginationRow.push(Markup.button.callback("⬅️ Prev", `session:page:${page - 1}`));
        }
        paginationRow.push(Markup.button.callback("🆕 New Session", "session:new"));
        if (page < totalPages - 1) {
          paginationRow.push(Markup.button.callback("Next ➡️", `session:page:${page + 1}`));
        }

        buttons.push(paginationRow);

        await ctx.editMessageText(text, {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard(buttons),
        });
      } catch (err: any) {
        console.error(err);
        await ctx.reply(`❌ Failed to load sessions page: ${err?.message ?? String(err)}`);
      }
      return;
    }

    if (data === "session:new") {
      await ctx.answerCbQuery("Starting new session...");

      try {
        const sessionInfo = getSessionInfo();
        const hadSession = !!sessionInfo.resumeId;

        // Reset to start new session
        resetSession();

        if (hadSession) {
          await ctx.reply(`✅ Started new session\n\n(Previous session ${sessionInfo.resumeId?.slice(0, 8)} is saved in Claude Code history)`);
        } else {
          await ctx.reply("🆕 Started new session");
        }
      } catch (err: any) {
        console.error(err);
        await ctx.reply(`❌ Failed to create new session: ${err?.message ?? String(err)}`);
      }
      return;
    }

    // Quick actions
    if (data.startsWith("quick:")) {
      const action = data.substring(6);
      await ctx.answerCbQuery();

      switch (action) {
        case "status":
          const info = getSessionInfo();
          const sessionAge = info.lastActivity
            ? `${Math.floor((Date.now() - info.lastActivity) / 1000)}s ago`
            : "never";
          await ctx.reply(
            [
              "📊 Session Status",
              `📁 cwd: ${info.cwd}`,
              `🔑 session: ${info.resumeId ? "active" : "none"}`,
              `⏱️ last activity: ${sessionAge}`,
            ].join("\n"),
          );
          break;

        case "files":
          // Re-use /files command logic
          try {
            const cwd = getCwd();
            const allFiles = readdirSync(cwd, { withFileTypes: true });
            const files = allFiles
              .filter((f) => f.isFile())
              .map((f) => {
                const fullPath = join(cwd, f.name);
                const stats = statSync(fullPath);
                return { name: f.name, mtime: stats.mtime, size: stats.size };
              })
              .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

            const { text, keyboard } = buildFileBrowser(files, 0, 10);
            if (keyboard) {
              await ctx.reply(text, keyboard);
            } else {
              await ctx.reply(text);
            }
          } catch (err: any) {
            await ctx.reply(`❌ Failed to list files: ${err?.message ?? String(err)}`);
          }
          break;

        case "sessions":
          // Re-use /sessions command logic
          try {
            const allSessions = listSessions(getCwd());
            const sessionInfo = getSessionInfo();
            const { text, sessions: pageSessions, totalPages } = formatSessionsList(allSessions, sessionInfo.resumeId, 0, 5);

            if (allSessions.length === 0) {
              await ctx.reply(text, { parse_mode: "Markdown" });
              return;
            }

            // Build inline keyboard with session buttons
            const buttons = pageSessions.map((session) => {
              const shortId = session.sessionId.slice(0, 8);
              const preview = session.firstMessage.slice(0, 30);
              const label = `${shortId}: ${preview}${session.firstMessage.length > 30 ? "..." : ""}`;
              return [Markup.button.callback(label, `session:load:${session.sessionId}`)];
            });

            // Add pagination if needed
            const paginationRow = [];
            if (totalPages > 1) {
              if (0 > 0) {
                paginationRow.push(Markup.button.callback("⬅️ Prev", `session:page:${0 - 1}`));
              }
              paginationRow.push(Markup.button.callback("🆕 New Session", "session:new"));
              if (0 < totalPages - 1) {
                paginationRow.push(Markup.button.callback("Next ➡️", `session:page:${0 + 1}`));
              }
            } else {
              paginationRow.push(Markup.button.callback("🆕 New Session", "session:new"));
            }

            buttons.push(paginationRow);

            await ctx.reply(text, {
              parse_mode: "Markdown",
              ...Markup.inlineKeyboard(buttons),
            });
          } catch (err: any) {
            await ctx.reply(`❌ Failed to list sessions: ${err?.message ?? String(err)}`);
          }
          break;

        case "reset":
          resetSession();
          await ctx.reply("✅ Session reset.");
          break;

        case "git-status":
          await handlePrompt(ctx, "Show me git status");
          break;

        case "commit":
          await handlePrompt(ctx, "Please create a git commit. Review the changes, generate an appropriate commit message, and commit them.");
          break;

        case "test":
          await handlePrompt(ctx, "Run the test suite.");
          break;

        case "build":
          await handlePrompt(ctx, "Build the project.");
          break;
      }
      return;
    }

    // Legacy send file handler
    if (data.startsWith("send:")) {
      const fileName = data.substring(5);
      await ctx.answerCbQuery(`Sending ${fileName}...`);
      await sendFileToTelegram(ctx, fileName);
      return;
    }
  } catch (err: any) {
    console.error("callback_query error:", err);
    await ctx.answerCbQuery(`Error: ${err?.message ?? String(err)}`);
  }
});

bot.on(message("text"), async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  await handlePrompt(ctx, ctx.message.text);
});

bot.on(message("voice"), async (ctx) => {
  // Check if transcription is enabled
  if (!isTranscriptionEnabled()) {
    await ctx.reply("❌ Voice transcription is not configured.\n\nTo enable voice notes:\n1. Get a Deepgram API key at https://deepgram.com\n2. Add DEEPGRAM_API_KEY to your .env file\n3. Restart the bot");
    return;
  }

  const fileId = ctx.message.voice.file_id;
  await tryReply(ctx, "🎙️ transcribing…");

  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(link.toString(), { signal: AbortSignal.timeout(30_000) });
    const audio = Buffer.from(await res.arrayBuffer());
    const transcript = await transcribeOggBuffer(audio);

    if (!transcript) {
      await tryReply(ctx, "(couldn't hear anything)");
      return;
    }
    await tryReply(ctx, `📝 ${transcript}`);
    await handlePrompt(ctx, transcript);
  } catch (err: any) {
    console.error(err);
    await tryReply(ctx, `❌ transcription failed: ${err?.message ?? String(err)}`);
  }
});

bot.on(message("photo"), async (ctx) => {
  try {
    // Get the highest resolution photo (Telegram sends multiple sizes)
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;
    const caption = ctx.message.caption?.trim() || "";

    // No caption = just save the file (dump mode)
    // With caption = analyze with vision API
    if (!caption) {
      await tryReply(ctx, "📥 saving image…");
      const fileName = `image_${photo.file_unique_id}.jpg`;
      const filePath = await downloadAndSaveFile(ctx, fileId, fileName);
      const relPath = filePath.replace(getCwd() + "/", "");
      await ctx.reply(`✅ Saved to ${relPath}`);
    } else {
      // Use vision API for direct image analysis
      await tryReply(ctx, "🖼️ analyzing image…");
      const link = await ctx.telegram.getFileLink(fileId);
      const res = await fetch(link.toString(), { signal: AbortSignal.timeout(30_000) });
      const imageBuffer = Buffer.from(await res.arrayBuffer());
      await handlePromptWithImage(ctx, caption, imageBuffer);
    }
  } catch (err: any) {
    console.error(err);
    await tryReply(ctx, `❌ image processing failed: ${err?.message ?? String(err)}`);
  }
});

bot.on(message("document"), async (ctx) => {
  await tryReply(ctx, "📥 downloading file…");

  try {
    const doc = ctx.message.document;
    const fileId = doc.file_id;
    const fileName = doc.file_name || `file_${doc.file_unique_id}`;
    const caption = ctx.message.caption?.trim() || "";

    const filePath = await downloadAndSaveFile(ctx, fileId, fileName);
    const relPath = filePath.replace(getCwd() + "/", "");

    const prompt =
      caption || `I've uploaded a file to ${relPath}. Please read and analyze it.`;

    await handlePrompt(ctx, prompt);
  } catch (err: any) {
    console.error(err);
    await tryReply(ctx, `❌ file upload failed: ${err?.message ?? String(err)}`);
  }
});

// Surface anything that escapes a handler so we see it in logs instead
// of failing silently. pm2 will restart on uncaughtException.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  process.exit(1);
});

bot
  .launch()
  .then(async () => {
    console.log(`pocketclaw running. cwd: ${getCwd()}`);
    console.log(`Allowed user: ${config.allowedUserId}`);

    // Send startup notification to user
    try {
      const projects = discoverProjects();
      const projectsList = projects.length > 0
        ? projects.map(p => {
            const configInfo = p.configs && p.configs.length > 0
              ? ` (${p.configs.join(", ")})`
              : "";
            return `  • ${p.name}${configInfo}`;
          }).join("\n")
        : "  (none found)";

      await bot.telegram.sendMessage(
        config.allowedUserId,
        `🤖 pocketclaw restarted\n📁 cwd: ${getCwd()}\n\n📋 Projects with Claude configs:\n${projectsList}`
      );
    } catch (err: any) {
      console.warn(`Failed to send startup notification: ${err?.message ?? String(err)}`);
    }
  })
  .catch((err) => {
    console.error("bot.launch failed:", err);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
