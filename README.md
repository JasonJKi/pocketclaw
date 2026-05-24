# pocketclaw

Multi-modal Telegram bridge to Claude Code on your machine. Send text, voice notes, images, or any file → Claude Agent SDK analyzes and executes in your project directory → reply comes back as a Telegram message.

No open ports, no public IP, no tunnel. Telegram polls outbound from your machine.

**New to PocketClaw?** → See [INSTALL.md](INSTALL.md) for the quickest way to get started!

## Quick Start (3 minutes)

The easiest way to get started is with the **interactive setup wizard**:

```sh
git clone https://github.com/yourusername/pocketclaw
cd pocketclaw
npm install
npm run setup
```

The wizard will:
1. ✅ Check for Claude Code installation
2. 🤖 Guide you through creating a Telegram bot
3. 📱 Auto-capture your Telegram user ID
4. 🎙️ Optionally configure voice transcription (Deepgram)
5. 🔑 Optionally add your Anthropic API key
6. 📁 Choose your default project directory
7. 💾 Generate your `.env` file

Then build and run:
```sh
npm run build
npm start
# or with pm2: pm2 start ecosystem.config.cjs
```

Open your bot in Telegram and send `/start` to begin!

---

## Manual Setup (if you prefer)

1. **Prerequisites**
   - Node.js 18+ installed
   - Claude Code installed (VS Code extension or CLI)
   - Telegram account

2. **Install dependencies**
   ```sh
   cd ~/pocketclaw
   npm install
   ```

3. **Create your Telegram bot**
   - On Telegram, message `@BotFather` → `/newbot` → name it → username must end in `bot`
   - Copy the token

4. **Get your Telegram user ID**
   - Message `@userinfobot` on Telegram
   - Copy the numeric ID

5. **Get API keys** (choose what you need)
   - **Required**: Either CLAUDE_CODE_OAUTH_TOKEN (from `~/.claude/config.json`) OR ANTHROPIC_API_KEY (from https://console.anthropic.com/)
   - **Optional**: DEEPGRAM_API_KEY for voice transcription (https://console.deepgram.com/ - free tier available)

6. **Configure**
   ```sh
   cp .env.example .env
   # Edit .env with your tokens and keys
   ```

7. **Run**
   ```sh
   npm run build
   npm start
   ```
   You should see `pocketclaw running. cwd: ...`. Now open your bot in Telegram and send `/start`.

## Commands

### Navigation & Project Management
- `/start` — show status and available commands
- `/cwd` — show current working directory
- `/cd <absolute-path>` — switch project directory (resets session)
- `/projects` — list available projects
- `/switch <name>` — switch to a project
- `/status` — show current session info (cwd, session ID, last activity)

### Session Management
- `/sessions` — list all Claude Code sessions for current project
- `/load <session-id>` — resume any Claude Code session (supports partial ID like `773026f0`)
- `/new` — start a new conversation (previous session saved in Claude Code history)
- `/reset` — clear conversation memory, keep cwd

### File Operations
- `/files [pattern]` — list files in current directory (optionally filtered by pattern)
- `/send <file>` — send file from current directory back to Telegram
- `/get <file>` — alias for `/send`

## Usage

Send any of the following to the bot:

### Text Messages
- **Plain text** — sent directly to Claude Code for execution
- Example: "List all Python files in this directory"
- Example: "Fix the syntax error in app.py"

### Voice Notes
- **Voice message** — transcribed via Deepgram, then sent to Claude Code
- Speak naturally, the bot will transcribe and execute your command

### Images
- **Image (vision mode)** — analyzed directly by Claude Code using vision capabilities
  - Send an image with a caption like "What's in this screenshot?"
  - Send an image with caption "Convert this diagram to code"
  - Send without caption for general analysis

- **Image (file mode)** — saved to `.telegram-uploads/` for Claude to read as a file
  - Add caption starting with `file:` or `save:` to trigger file mode
  - Example: Send image with caption `file: Extract text from this image`
  - Useful for images that need to be processed as files (PDFs converted to images, etc.)

### Documents & Files
- **Any file type** — saved to `.telegram-uploads/` directory in your current working directory
  - Supported: PDF, code files, text files, spreadsheets, notebooks, etc.
  - Claude Code can read and analyze the file using its Read tool
  - Add a caption to give Claude specific instructions
  - Without caption, Claude will analyze the file automatically

**Examples:**
- Upload a PDF with caption "Summarize this document"
- Upload a Python file with caption "Review this code for bugs"
- Upload a CSV with caption "Analyze the data in this file"
- Upload a Jupyter notebook with caption "Explain what this notebook does"
- Upload a config file with caption "What settings are configured here?"

All uploaded files are saved to `.telegram-uploads/` in your current working directory with timestamps to avoid conflicts.

## Retrieving Generated Files

When Claude Code creates files (images, reports, code, etc.), you can retrieve them:

**Method 1: Direct command**
```
/files *.png          # List all PNG files
/send output.png      # Send specific file to Telegram
/get report.pdf       # Same as /send
```

**Method 2: Ask Claude naturally**
```
"Generate a chart and send it to me"
"Create a summary report and send the PDF"
"Show me the generated image"
```

Then use `/files` to see what was created and `/send <filename>` to retrieve it.

**Examples:**
- Claude creates `diagram.png` → use `/send diagram.png` to get it
- Claude generates `report.pdf` → use `/get report.pdf`
- List recent files with `/files` to see what's available
- Filter files with `/files *.py` to see only Python files

**Limits:**
- Maximum file size: 50MB (Telegram bot API limit)
- Files must be within your current working directory for security

## Unified Session System

**PocketClaw now reads the same Claude Code sessions as VS Code** — no separate session storage!

When you use `/sessions`, you'll see all the Claude Code conversations for the current project, whether they were created:
- In VS Code's Claude Code extension
- Via the `claude` CLI tool
- Through PocketClaw itself

**Key Features:**
- **Session list**: Shows session ID (shortened), first message preview, message count, git branch, and age
- **Load any session**: Use `/load <session-id>` with full or partial ID (e.g., `773026f0` instead of the full UUID)
- **Project-specific**: Sessions are automatically filtered by the current working directory
- **Switch projects**: Use `/switch <project>` to change projects, then `/sessions` to see that project's sessions
- **No data duplication**: Everything is stored in `~/.claude/projects/<encoded-path>/` exactly where Claude Code expects it

**Example workflow:**
```
/switch pocketclaw          # Switch to pocketclaw project
/sessions                   # List all Claude Code sessions for this project
/load 773026f0              # Resume a specific session by partial ID
```

This means your conversation history is unified across all interfaces — start a conversation in VS Code, continue it in PocketClaw via Telegram, then pick it up again in the CLI or VS Code later!

## Security

- Only the user ID in `TELEGRAM_ALLOWED_USER_ID` can talk to the bot. Everyone else is silently ignored.
- Tool permissions are set to `bypassPermissions` — Claude will run shell commands and edit files without asking. Keep work in a git repo so you can revert.
- `.env` is gitignored. Never commit it.
