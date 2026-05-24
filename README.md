# pocketclaw

Voice-driven Telegram bridge to Claude Code on your machine. Send a voice note → Deepgram transcribes it → Claude Agent SDK runs it in your project directory → reply comes back as a Telegram message.

No open ports, no public IP, no tunnel. Telegram polls outbound from your machine.

## Setup

1. **Install dependencies**
   ```sh
   cd ~/pocketclaw
   npm install
   ```

2. **Create your Telegram bot**
   - On phone Telegram, message `@BotFather` → `/newbot` → name it → username must end in `bot`.
   - Copy the token.

3. **Get your Telegram user ID**
   - Message `@userinfobot` on Telegram. Copy the numeric ID.

4. **Get a Deepgram API key**
   - https://console.deepgram.com/ (free tier includes $200 credit).

5. **Get an Anthropic API key**
   - https://console.anthropic.com/

6. **Configure**
   ```sh
   cp .env.example .env
   # edit .env with the 4 keys + your user ID
   ```

7. **Run**
   ```sh
   npm run dev
   ```
   You should see `pocketclaw running. cwd: ...`. Now open your bot in Telegram and send `/start`.

## Commands

- `/start` — show status
- `/cwd` — show current working directory
- `/cd <absolute-path>` — switch project directory (resets session)
- `/reset` — clear conversation memory, keep cwd

Anything else (text or voice) is sent to Claude as a prompt.

## Security

- Only the user ID in `TELEGRAM_ALLOWED_USER_ID` can talk to the bot. Everyone else is silently ignored.
- Tool permissions are set to `bypassPermissions` — Claude will run shell commands and edit files without asking. Keep work in a git repo so you can revert.
- `.env` is gitignored. Never commit it.
