import { Markup } from "telegraf";

/**
 * Build the /help command menu with categories
 */
export function buildHelpMenu() {
  const text = [
    "🤖 PocketClaw Command Reference",
    "",
    "Select a category to learn more:",
  ].join("\n");

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📂 Projects & Sessions", "help:projects")],
    [Markup.button.callback("📁 File Operations", "help:files")],
    [Markup.button.callback("🔧 Git Workflows", "help:git")],
    [Markup.button.callback("⚡ Dev Tools", "help:dev")],
    [Markup.button.callback("💬 Chat & AI", "help:chat")],
    [Markup.button.callback("⚙️ Settings", "help:settings")],
  ]);

  return { text, keyboard };
}

/**
 * Build help text for specific categories
 */
export function buildHelpCategory(category: string): string {
  const categories: Record<string, string> = {
    projects: [
      "📂 Projects & Sessions",
      "",
      "/projects - Interactive project selector",
      "/switch <name> - Switch to project",
      "/info - Current project info",
      "",
      "/sessions - List all saved sessions",
      "/save <name> - Save current session",
      "/load <name> - Load a saved session",
      "/new <name> - Create new session",
      "/delete <name> - Delete a session",
      "",
      "/status - Session status & quick actions",
      "/reset - Reset current conversation",
    ].join("\n"),

    files: [
      "📁 File Operations",
      "",
      "/files [pattern] - Interactive file browser",
      "/send <file> - Send file to Telegram",
      "/get <file> - Alias for /send",
      "/cwd - Show current directory",
      "/cd <path> - Change directory",
      "",
      "You can also:",
      "• Upload files directly (drag & drop)",
      "• Send images (with/without captions)",
      "• Send voice messages for transcription",
    ].join("\n"),

    git: [
      "🔧 Git Workflows",
      "",
      "/commit - Interactive commit workflow",
      "/status - Show git status",
      "/diff - Show changes",
      "/branch - Branch operations",
      "/pr - Create pull request",
      "/push - Push changes",
      "/pull - Pull latest changes",
      "",
      "These commands use Claude to:",
      "• Generate commit messages",
      "• Analyze changes",
      "• Create PR descriptions",
    ].join("\n"),

    dev: [
      "⚡ Dev Tools",
      "",
      "/test [pattern] - Run tests",
      "/build - Build the project",
      "/dev - Start dev server",
      "/lint - Run linter",
      "/logs - View logs",
      "",
      "Claude will:",
      "• Detect your test framework",
      "• Use the right build tool",
      "• Fix errors automatically (if asked)",
    ].join("\n"),

    chat: [
      "💬 Chat & AI Commands",
      "",
      "/ask <question> - Ask without execution",
      "/explain <file> - Explain code",
      "/fix <issue> - Debug and fix",
      "/add <feature> - Add new feature",
      "/refactor <target> - Refactor code",
      "",
      "💡 Tip: These commands tell Claude your",
      "intent clearly, helping it provide better",
      "assistance tailored to your specific need.",
    ].join("\n"),

    settings: [
      "⚙️ Settings & Info",
      "",
      "/start - Welcome message",
      "/help - This help system",
      "/status - Session status",
      "/cwd - Current directory",
      "/cd <path> - Change directory",
      "/reset - Reset conversation",
      "",
      "🔐 Security:",
      "• Only your Telegram ID can use this bot",
      "• Files are sandboxed to current project",
      "• Sessions auto-expire after 24h",
    ].join("\n"),
  };

  return categories[category] || "Category not found.";
}

/**
 * Build project selector with inline keyboard
 */
export function buildProjectSelector(
  projects: Array<{ name: string; description?: string }>,
  maxButtons: number = 10,
) {
  if (projects.length === 0) {
    return {
      text: "No projects found with Claude configurations.\n\nProjects need a CLAUDE.md file or .claude/ directory.",
      keyboard: null,
    };
  }

  const text = [
    "📂 Available Projects",
    "",
    "Select a project to switch:",
  ].join("\n");

  // Create keyboard with project buttons (2 per row for readability)
  const buttons = projects.slice(0, maxButtons).map((p) => {
    const emoji = getProjectEmoji(p.name);
    return Markup.button.callback(`${emoji} ${p.name}`, `project:${p.name}`);
  });

  // Arrange in rows of 2
  const rows: any[] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  // Add refresh button
  rows.push([Markup.button.callback("🔄 Refresh", "projects:refresh")]);

  const keyboard = Markup.inlineKeyboard(rows);

  return { text, keyboard };
}

/**
 * Build file browser with pagination
 */
export function buildFileBrowser(
  files: Array<{ name: string; size: number }>,
  page: number = 0,
  pageSize: number = 10,
) {
  if (files.length === 0) {
    return {
      text: "No files in current directory.",
      keyboard: null,
    };
  }

  const start = page * pageSize;
  const end = start + pageSize;
  const pageFiles = files.slice(start, end);
  const totalPages = Math.ceil(files.length / pageSize);

  const fileList = pageFiles
    .map((f) => {
      const icon = getFileIcon(f.name);
      const size = formatFileSize(f.size);
      return `${icon} ${f.name} (${size})`;
    })
    .join("\n");

  const text = [
    `📁 Files (page ${page + 1}/${totalPages})`,
    "",
    fileList,
    "",
    "Tap a file to download:",
  ].join("\n");

  // Create buttons for files (1 per row)
  const fileButtons = pageFiles.map((f) => [
    Markup.button.callback(`📤 ${f.name}`, `file:${f.name}`),
  ]);

  // Add navigation buttons
  const navButtons = [];
  if (page > 0) {
    navButtons.push(Markup.button.callback("⬅️ Previous", `files:${page - 1}`));
  }
  if (end < files.length) {
    navButtons.push(Markup.button.callback("Next ➡️", `files:${page + 1}`));
  }

  const rows = [...fileButtons];
  if (navButtons.length > 0) {
    rows.push(navButtons);
  }

  const keyboard = Markup.inlineKeyboard(rows);

  return { text, keyboard };
}

/**
 * Build session selector
 */
export function buildSessionSelector(
  sessions: Array<{ name: string; lastActivity: number }>,
  currentSessionName?: string,
) {
  if (sessions.length === 0) {
    return {
      text: [
        "No saved sessions found.",
        "",
        "Use /save <name> to save your current session.",
      ].join("\n"),
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback("💾 Save current session", "session:save-prompt")],
      ]),
    };
  }

  const text = ["📋 Saved Sessions", "", "Select a session to load:"].join("\n");

  const buttons = sessions.map((s) => {
    const icon = s.name === currentSessionName ? "✅" : "💬";
    const age = formatAge(s.lastActivity);
    return [Markup.button.callback(`${icon} ${s.name} (${age})`, `session:load:${s.name}`)];
  });

  // Add action buttons
  buttons.push([
    Markup.button.callback("💾 Save current", "session:save-prompt"),
    Markup.button.callback("🗑️ Delete...", "session:delete-prompt"),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  return { text, keyboard };
}

/**
 * Build quick actions menu for current project
 */
export function buildQuickActions(projectName: string, hasGit: boolean = true) {
  const text = [`⚡ Quick Actions - ${projectName}`, "", "What would you like to do?"].join("\n");

  const buttons = [
    [Markup.button.callback("📊 Status", "quick:status"), Markup.button.callback("📂 Files", "quick:files")],
    [Markup.button.callback("💬 Sessions", "quick:sessions"), Markup.button.callback("🔄 Reset", "quick:reset")],
  ];

  if (hasGit) {
    buttons.push([
      Markup.button.callback("🔧 Git status", "quick:git-status"),
      Markup.button.callback("📝 Commit", "quick:commit"),
    ]);
  }

  buttons.push([
    Markup.button.callback("🧪 Tests", "quick:test"),
    Markup.button.callback("🏗️ Build", "quick:build"),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  return { text, keyboard };
}

// Helper functions

function getProjectEmoji(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("bot")) return "🤖";
  if (lower.includes("web") || lower.includes("app")) return "🌐";
  if (lower.includes("api") || lower.includes("server")) return "🔌";
  if (lower.includes("mobile")) return "📱";
  if (lower.includes("game")) return "🎮";
  if (lower.includes("data") || lower.includes("db")) return "💾";
  if (lower.includes("ai") || lower.includes("ml")) return "🧠";
  return "📁";
}

function getFileIcon(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();

  const icons: Record<string, string> = {
    ts: "📘",
    js: "📙",
    tsx: "⚛️",
    jsx: "⚛️",
    json: "📦",
    md: "📝",
    txt: "📄",
    png: "🖼️",
    jpg: "🖼️",
    jpeg: "🖼️",
    gif: "🖼️",
    svg: "🎨",
    pdf: "📕",
    zip: "🗜️",
    py: "🐍",
    rs: "🦀",
    go: "🐹",
    java: "☕",
    rb: "💎",
    css: "🎨",
    html: "🌐",
    xml: "📋",
    yml: "⚙️",
    yaml: "⚙️",
    toml: "⚙️",
    env: "🔐",
    git: "🔧",
  };

  return icons[ext || ""] || "📄";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
