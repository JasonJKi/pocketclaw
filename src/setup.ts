#!/usr/bin/env node
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Telegraf } from "telegraf";

const rl = readline.createInterface({ input, output });

// Helper to print styled messages
function log(message: string, type: "info" | "success" | "error" | "step" = "info") {
  const icons = {
    info: "ℹ️",
    success: "✅",
    error: "❌",
    step: "📋",
  };
  console.log(`${icons[type]} ${message}`);
}

// Check if Claude Code is installed
function checkClaudeCode(): boolean {
  const claudeDir = join(homedir(), ".claude");
  return existsSync(claudeDir);
}

// Auto-detect common project directories
function suggestProjectDir(): string {
  const homeDir = homedir();
  const candidates = [
    join(homeDir, "code"),
    join(homeDir, "projects"),
    join(homeDir, "workspace"),
    join(homeDir, "dev"),
    join(homeDir, "Documents", "code"),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }

  return homeDir;
}

// Validate Telegram bot token format
function validateBotToken(token: string): boolean {
  // Telegram bot tokens are in the format: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz
  return /^\d+:[A-Za-z0-9_-]+$/.test(token);
}

// Auto-capture Telegram user ID by listening for a message
async function captureUserId(botToken: string): Promise<number | null> {
  return new Promise((resolve) => {
    const bot = new Telegraf(botToken);
    let captured = false;

    bot.on("message", (ctx) => {
      if (!captured && ctx.from) {
        captured = true;
        bot.stop();
        resolve(ctx.from.id);
      }
    });

    bot.launch().catch(() => {
      resolve(null);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      if (!captured) {
        bot.stop();
        resolve(null);
      }
    }, 120_000);
  });
}

// Main setup flow
async function setup() {
  console.log("\n🐾 Welcome to PocketClaw Setup!\n");
  console.log("This wizard will help you configure PocketClaw in ~3 minutes.\n");

  const config: Record<string, string> = {};

  // Step 1: Check Claude Code
  log("Checking Claude Code installation...", "step");
  if (checkClaudeCode()) {
    log("Claude Code found at ~/.claude", "success");
  } else {
    log("Claude Code not found at ~/.claude", "error");
    console.log("\nPlease install Claude Code first:");
    console.log("  • VS Code: Install the Claude Code extension");
    console.log("  • CLI: npm install -g @anthropic/claude-code\n");
    const proceed = await rl.question("Continue anyway? (y/n): ");
    if (proceed.toLowerCase() !== "y") {
      log("Setup cancelled.", "error");
      process.exit(1);
    }
  }

  // Step 2: Telegram Bot Token
  console.log("\n" + "=".repeat(60));
  log("Setting up Telegram bot", "step");
  console.log("\n1. Open: https://t.me/botfather");
  console.log("2. Send: /newbot");
  console.log("3. Follow the prompts to create your bot");
  console.log("4. Copy the bot token you receive\n");

  let botToken = "";
  while (!botToken) {
    const token = await rl.question("Paste your bot token: ");
    if (validateBotToken(token.trim())) {
      botToken = token.trim();
      config.TELEGRAM_BOT_TOKEN = botToken;
      log("Bot token validated!", "success");
    } else {
      log("Invalid token format. Please try again.", "error");
    }
  }

  // Step 3: Capture User ID
  console.log("\n" + "=".repeat(60));
  log("Getting your Telegram user ID", "step");
  console.log("\nSend any message to your bot now...");
  console.log("(Listening for 2 minutes...)\n");

  const userId = await captureUserId(botToken);
  if (userId) {
    config.TELEGRAM_ALLOWED_USER_ID = userId.toString();
    log(`Got it! Your user ID: ${userId}`, "success");
  } else {
    log("Couldn't capture user ID automatically.", "error");
    const manualId = await rl.question("Enter your Telegram user ID manually: ");
    config.TELEGRAM_ALLOWED_USER_ID = manualId.trim();
  }

  // Step 4: Optional - Deepgram for voice transcription
  console.log("\n" + "=".repeat(60));
  log("Optional: Voice note transcription (Deepgram)", "step");
  console.log("\nEnable voice note transcription?");
  console.log("  • Requires Deepgram API key (free tier available)");
  console.log("  • Sign up at: https://deepgram.com\n");

  const enableVoice = await rl.question("Enable voice notes? (y/n): ");
  if (enableVoice.toLowerCase() === "y") {
    const deepgramKey = await rl.question("Paste your Deepgram API key: ");
    config.DEEPGRAM_API_KEY = deepgramKey.trim();
    log("Deepgram configured!", "success");
  } else {
    log("Voice transcription disabled (you can add this later)", "info");
  }

  // Step 5: Anthropic API Key (optional, for custom models)
  console.log("\n" + "=".repeat(60));
  log("Optional: Anthropic API key", "step");
  console.log("\nBy default, PocketClaw uses your Claude Code credentials.");
  console.log("You can optionally provide an Anthropic API key for custom configuration.\n");

  const addApiKey = await rl.question("Add Anthropic API key? (y/n): ");
  if (addApiKey.toLowerCase() === "y") {
    const apiKey = await rl.question("Paste your API key: ");
    config.ANTHROPIC_API_KEY = apiKey.trim();
    log("API key configured!", "success");
  } else {
    log("Using Claude Code credentials", "info");
  }

  // Step 6: Default Project Directory
  console.log("\n" + "=".repeat(60));
  log("Default project directory", "step");
  const suggestedDir = suggestProjectDir();
  console.log(`\nSuggested: ${suggestedDir}`);

  const useSuggested = await rl.question("Use this directory? (y/n): ");
  if (useSuggested.toLowerCase() === "y") {
    config.DEFAULT_PROJECT_DIR = suggestedDir;
  } else {
    const customDir = await rl.question("Enter your project directory path: ");
    config.DEFAULT_PROJECT_DIR = customDir.trim();
  }

  log(`Project directory: ${config.DEFAULT_PROJECT_DIR}`, "success");

  // Write .env file
  console.log("\n" + "=".repeat(60));
  log("Writing configuration to .env", "step");

  const envPath = join(process.cwd(), ".env");
  const envContent = Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // Check if .env already exists
  if (existsSync(envPath)) {
    console.log("\n⚠️  .env file already exists!");
    const overwrite = await rl.question("Overwrite? (y/n): ");
    if (overwrite.toLowerCase() !== "y") {
      log("Setup cancelled. Your existing .env was not modified.", "info");
      rl.close();
      process.exit(0);
    }
  }

  writeFileSync(envPath, envContent);
  log(".env file created!", "success");

  // Final instructions
  console.log("\n" + "=".repeat(60));
  log("Setup complete! 🎉", "success");
  console.log("\nNext steps:\n");
  console.log("  1. Build the project:");
  console.log("     npm run build\n");
  console.log("  2. Start PocketClaw:");
  console.log("     npm start");
  console.log("     (or use pm2: pm2 start ecosystem.config.cjs)\n");
  console.log("  3. Message your bot on Telegram to get started!\n");
  console.log("Configuration saved to: .env");
  console.log("\nNeed help? Check the README.md or open an issue on GitHub.\n");

  rl.close();
}

// Run setup
setup().catch((err) => {
  log(`Setup failed: ${err.message}`, "error");
  process.exit(1);
});
