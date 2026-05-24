import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function optionalNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`${name} must be a number`);
    process.exit(1);
  }
  return value;
}

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const claudeCodeOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!anthropicApiKey && !claudeCodeOAuthToken) {
  console.error("Missing auth: set CLAUDE_CODE_OAUTH_TOKEN (Max plan) or ANTHROPIC_API_KEY");
  process.exit(1);
}

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUserId: Number(required("TELEGRAM_ALLOWED_USER_ID")),
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || undefined, // Optional now
  anthropicApiKey,
  claudeCodeOAuthToken,
  defaultProjectDir: process.env.DEFAULT_PROJECT_DIR || process.env.HOME || process.cwd(),
  // Optional Claude Agent SDK tuning. Unset values fall back to the CLI defaults.
  model: process.env.CLAUDE_MODEL || undefined,
  fallbackModel: process.env.CLAUDE_FALLBACK_MODEL || undefined,
  maxTurns: optionalNumber("CLAUDE_MAX_TURNS"),
  maxBudgetUsd: optionalNumber("CLAUDE_MAX_BUDGET_USD"),
};

if (!Number.isFinite(config.allowedUserId)) {
  console.error("TELEGRAM_ALLOWED_USER_ID must be a number");
  process.exit(1);
}
