# Slacker

An AI agent that lives in Slack. Powered by Claude via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk), it can read/write code, run commands, search codebases, manage files, and interact with Slack — all from a chat thread.

## Architecture

```
Slack events (DMs, @mentions, threads, files)
  │
  ▼
Bolt.js (Socket Mode)
  │
  ├── Reactive loop: handleMessage() → Claude Agent SDK → stream response
  │     • Downloads attached files to workspace
  │     • Builds prompt with thread history + Slack context
  │     • Streams Block Kit activity card (tool-by-tool progress)
  │     • Posts response text to thread
  │
  └── Proactive loop: worker timer (every 15s) → pick task → handleMessage()
        • Pulls from SQLite task queue
        • Runs tasks through the same Claude pipeline
        • Posts status updates to the originating thread
```

**Key concepts:**
- **Query** — one message → one Claude session → one response. The unit of work.
- **Thread session** — persistent Claude context across a whole thread (resumed via session ID).
- **Task** — a queued unit of work the proactive worker picks up and executes autonomously.
- **Workspace** — each team+channel gets its own directory at `~/.slacker/workspaces/<teamId>/<channelName>/`.

## Source files

| File | What it does |
|------|-------------|
| `src/app.ts` | Main entry point. Event handlers, message processing, activity cards, worker loop, shutdown/resume logic. |
| `src/slack-tools.ts` | MCP server exposing 9 Slack tools to Claude (post_message, react, upload_file, etc.) |
| `src/session-store.ts` | SQLite-backed session tracking. Persists active queries and thread session IDs across restarts. |
| `src/task-store.ts` | SQLite-backed task queue. CRUD for the proactive worker. |
| `src/task-cli.ts` | CLI for managing tasks from within a Claude session (`add`, `done`, `cancel`, `pending`, `list`). |
| `src/installation-store.ts` | OAuth installation persistence with optional AES-256-GCM token encryption. |
| `AGENT.md` | Bot persona and behavior instructions injected into every Claude session. |
| `manifest.json` | Slack app manifest (scopes, events, slash commands). |
| `scripts/setup.ts` | Create a new Slack app from the manifest. |
| `scripts/update.ts` | Update an existing Slack app's manifest. |

## Setup

### Prerequisites

- Node.js 22+
- A Slack workspace where you can install apps

### 1. Install dependencies

```bash
npm install
```

### 2. Create the Slack app

```bash
# Set your Slack config tokens in .env first (see .env.example)
npm run setup
```

This creates the app from `manifest.json`, writes credentials to `.env`, and prints an install URL.

### 3. Configure environment

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

**Required:**
- `SLACK_APP_TOKEN` — App-level token (starts with `xapp-`). Enable Socket Mode in your app settings to get this.
- `SLACK_SIGNING_SECRET` — Found in Basic Information → App Credentials.

**For OAuth (multi-tenant):**
- `SLACK_CLIENT_ID` — OAuth client ID
- `SLACK_CLIENT_SECRET` — OAuth client secret
- `STATE_SECRET` — Random string for OAuth state verification

**For legacy single-workspace mode:**
- `SLACK_BOT_TOKEN` — Bot token (starts with `xoxb-`). Only needed if not using OAuth.

**Optional:**
- `ENCRYPTION_KEY` — AES-256 key (64 hex chars) for encrypting stored OAuth tokens at rest.
- `OAUTH_REDIRECT_URI` — Custom redirect URI for OAuth flow.

### 4. Run

```bash
# Development (auto-reload on file changes)
npm run dev

# Production
npm start
```

### 5. Deploy (systemd)

```ini
[Unit]
Description=Cofounder Slack Bot
After=network.target

[Service]
Type=simple
User=slacker
WorkingDirectory=/home/slacker/slacker
ExecStart=/usr/bin/node --import tsx src/app.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=HOME=/home/slacker

[Install]
WantedBy=multi-user.target
```

## Features

- **Chat in threads** — DM or @mention to start. Reply in the thread to continue. Context is preserved across messages.
- **Image support** — Drag images into a thread and the bot can see and analyze them.
- **File uploads** — Drag any file type (PDFs, code, CSVs, etc.) and it's downloaded to the workspace.
- **Code execution** — Reads, writes, edits files and runs shell commands in a sandboxed workspace per channel.
- **Session persistence** — Thread conversations resume across restarts via stored Claude session IDs.
- **Auto-resume** — If interrupted by a restart, in-flight queries automatically resume on startup.
- **Task queue** — Break big requests into tasks that execute autonomously via the background worker.
- **Activity cards** — Real-time Block Kit cards showing tool-by-tool progress as Claude works.
- **Slash commands** — `/ping`, `/version`, `/changelog`, `/tasks`
- **Multi-tenant** — OAuth mode supports multiple Slack workspaces from a single instance.

## Database

All state lives in a single SQLite database at `~/.slacker/installations.db` with WAL mode:

- **installations** — OAuth tokens (optionally encrypted)
- **sessions** — Active query tracking and auto-resume state
- **thread_sessions** — Claude session ID → thread mapping for conversation continuity
- **tasks** — Proactive task queue

## Slash commands

| Command | Description |
|---------|-------------|
| `/ping` | Health check — returns "pong!" |
| `/version` | Shows git commit, date, and uptime |
| `/changelog` | Recent 15 git commits |
| `/tasks` | Lists pending and active tasks in the queue |

## Task queue

The bot can plan and execute multi-step work autonomously. When given a big request, it:

1. Breaks it into discrete tasks
2. Posts the plan to the thread
3. Queues each task in SQLite
4. A background worker picks them up one by one (every 15s)
5. Each task runs as a full Claude session with status updates

Manage tasks via CLI (from within a Claude session):

```bash
# Add a task
node --import tsx src/task-cli.ts add \
  --team TEAM_ID --channel CHANNEL_ID --thread THREAD_TS --user USER_ID \
  --desc "Description" --priority 0

# List pending tasks
node --import tsx src/task-cli.ts pending

# Mark done
node --import tsx src/task-cli.ts done --id 1 --result "What was done"

# Cancel
node --import tsx src/task-cli.ts cancel --id 1
```
