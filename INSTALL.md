# PocketClaw Installation Guide

Get PocketClaw running in 3 minutes with the interactive setup wizard.

## Prerequisites

- **Node.js 18+** installed on your Mac/Linux
- **Claude Code** installed (VS Code extension or CLI)
- **Telegram** account

## Installation Steps

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/pocketclaw.git
cd pocketclaw
npm install
```

### 2. Run Setup Wizard

```bash
npm run setup
```

The wizard will guide you through:
- ✅ Checking Claude Code installation
- 🤖 Creating a Telegram bot
- 📱 Capturing your Telegram user ID
- 🎙️ (Optional) Configuring voice transcription
- 🔑 (Optional) Adding API keys
- 📁 Setting default project directory

Just follow the prompts!

### 3. Build and Start

```bash
npm run build
npm start
```

Or use PM2 for production:

```bash
pm2 start ecosystem.config.cjs
pm2 logs pocketclaw
```

### 4. Test It!

Open Telegram, find your bot, and send:

```
/start
```

You should see the welcome screen. Try sending a message like:

```
List the files in this directory
```

## Troubleshooting

### "Missing required env var: TELEGRAM_BOT_TOKEN"

Run `npm run setup` to generate your `.env` file, or manually create one from `.env.example`.

### "Claude Code not found"

Install Claude Code:
- **VS Code**: Install the Claude Code extension
- **CLI**: `npm install -g @anthropic/claude-code`

### Voice notes not working

Voice transcription is optional. To enable it:
1. Get a Deepgram API key at https://deepgram.com (free tier available)
2. Add `DEEPGRAM_API_KEY=your_key` to `.env`
3. Restart the bot

### Bot doesn't respond

Make sure:
1. Your `TELEGRAM_ALLOWED_USER_ID` matches your Telegram user ID
2. The bot is running (`pm2 status` or check the terminal)
3. You're messaging the correct bot (check the username)

## Next Steps

- Read [README.md](README.md) for full command reference
- Check [CLAUDE.md](CLAUDE.md) for development guidelines
- Try `/help` in your bot for available commands

## Need Help?

- Open an issue: https://github.com/yourusername/pocketclaw/issues
- Check existing issues for solutions

Enjoy PocketClaw! 🐾
