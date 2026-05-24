import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
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
  deepgramApiKey: required("DEEPGRAM_API_KEY"),
  anthropicApiKey,
  claudeCodeOAuthToken,
  defaultProjectDir: process.env.DEFAULT_PROJECT_DIR || process.env.HOME || process.cwd(),
};

if (!Number.isFinite(config.allowedUserId)) {
  console.error("TELEGRAM_ALLOWED_USER_ID must be a number");
  process.exit(1);
}
