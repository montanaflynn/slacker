import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bolt from "@slack/bolt";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSlackTools } from "./slack-tools.js";
import {
  createInstallationStore,
  migrateFromEnv,
} from "./installation-store.js";
import { createSessionStore } from "./session-store.js";
import { createTaskStore, type TaskRecord } from "./task-store.js";

const { App, LogLevel } = bolt;

// Load bot persona from AGENT.md at startup
const __dirname = dirname(fileURLToPath(import.meta.url));
const botPersona = readFileSync(resolve(__dirname, "../AGENT.md"), "utf-8");

// Capture git info at startup
const repoRoot = resolve(__dirname, "..");
const git = (cmd: string) => execSync(cmd, { cwd: repoRoot, encoding: "utf-8" }).trim();
const gitCommit = git("git rev-parse --short HEAD");
const gitDate = git("git log -1 --format=%ci");
const gitChangelog = git("git log --oneline -15");
const startedAt = new Date();

// Workspaces root — each team+channel gets its own directory
const WORKSPACES_ROOT = resolve(process.env.HOME || "/home/slacker", ".slacker", "workspaces");
mkdirSync(WORKSPACES_ROOT, { recursive: true });

// Channel name cache (resolved lazily), keyed by teamId:channelId
const channelNameCache = new Map<string, string>();

async function resolveChannelName(client: any, teamId: string, channelId: string): Promise<string> {
  const cacheKey = `${teamId}:${channelId}`;
  const cached = channelNameCache.get(cacheKey);
  if (cached) return cached;
  try {
    const info = await client.conversations.info({ channel: channelId });
    const name = info.channel?.name || channelId;
    channelNameCache.set(cacheKey, name);
    return name;
  } catch {
    return channelId;
  }
}

function getWorkspacePath(teamId: string, channelName: string): string {
  const wsPath = resolve(WORKSPACES_ROOT, teamId, channelName);
  mkdirSync(wsPath, { recursive: true });
  return wsPath;
}

function listWorkspaces(teamId: string): string[] {
  const teamRoot = resolve(WORKSPACES_ROOT, teamId);
  if (!existsSync(teamRoot)) return [];
  return readdirSync(teamRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// File support — download Slack-hosted files to workspace
const IMAGE_MIMETYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function downloadSlackFiles(
  files: any[] | undefined,
  token: string,
  workspace: string,
): Promise<{ images: string[]; other: string[] }> {
  if (!files?.length) return { images: [], other: [] };

  const attachDir = resolve(workspace, ".attachments");
  mkdirSync(attachDir, { recursive: true });

  const images: string[] = [];
  const other: string[] = [];
  for (const file of files) {
    const url = file.url_private_download || file.url_private;
    if (!url) continue;

    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        log("warn", "failed to download file", { fileId: file.id, status: resp.status });
        continue;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const safeName = `${file.id}_${file.name}`;
      const filePath = resolve(attachDir, safeName);
      writeFileSync(filePath, buffer);
      if (IMAGE_MIMETYPES.has(file.mimetype)) {
        images.push(filePath);
      } else {
        other.push(filePath);
      }
    } catch (error) {
      log("warn", "failed to download file", { fileId: file.id, error: String(error) });
    }
  }
  return { images, other };
}

// Persistent session tracking (SQLite-backed, survives restarts)
const sessionStore = createSessionStore();

// Task queue (SQLite-backed, drives the proactive worker loop)
const taskStore = createTaskStore();

// In-memory abort controllers for active queries (can't persist these)
type ActiveQuery = { channel: string; msgTs: string; abort: AbortController; client: any };
const activeQueries = new Map<string, ActiveQuery>();

function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  console[level](JSON.stringify(entry));
}

// --- Installation store (SQLite-backed) ---
const installationStore = createInstallationStore();

// --- Build App with OAuth config or legacy token ---
const clientId = process.env.SLACK_CLIENT_ID;
const clientSecret = process.env.SLACK_CLIENT_SECRET;
const useOAuth = !!(clientId && clientSecret);

const app = new App({
  // OAuth config (when clientId/clientSecret are set, Bolt uses InstallationStore for auth)
  ...(useOAuth
    ? {
        clientId,
        clientSecret,
        stateSecret: process.env.STATE_SECRET || "slacker-state-secret",
        installationStore,
        scopes: [
          "chat:write",
          "app_mentions:read",
          "channels:history",
          "groups:history",
          "im:history",
          "mpim:history",
          "commands",
          "files:read",
          "files:write",
          "reactions:write",
          "pins:write",
          "channels:read",
          "users:read",
          "canvases:write",
        ],
        installerOptions: {
          directInstall: true,
          callbackOptions: {
            success: (_installation, _options, _req, res) => {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(`
                <!DOCTYPE html>
                <html>
                <head><title>Installed</title><style>
                  body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #1a1a2e; color: #fff; }
                  .card { text-align: center; padding: 48px; }
                  h1 { font-size: 24px; margin-bottom: 8px; }
                  p { color: #999; }
                </style></head>
                <body><div class="card"><h1>Slacker installed!</h1><p>Head back to Slack and mention @Slacker to get started.</p></div></body>
                </html>
              `);
            },
            failure: (error, _options, _req, res) => {
              res.writeHead(500, { "Content-Type": "text/html" });
              res.end(`
                <!DOCTYPE html>
                <html>
                <head><title>Installation Failed</title><style>
                  body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #1a1a2e; color: #fff; }
                  .card { text-align: center; padding: 48px; }
                  h1 { font-size: 24px; margin-bottom: 8px; }
                  p { color: #999; }
                  code { background: #333; padding: 2px 8px; border-radius: 4px; font-size: 14px; }
                </style></head>
                <body><div class="card"><h1>Installation failed</h1><p><code>${error.message}</code></p><p>Please try again.</p></div></body>
                </html>
              `);
            },
          },
        },
      }
    : {
        // Legacy single-workspace mode
        token: process.env.SLACK_BOT_TOKEN,
      }),

  // Always required
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  ...(useOAuth && process.env.OAUTH_REDIRECT_URI
    ? { redirectUri: process.env.OAUTH_REDIRECT_URI }
    : {}),
  logLevel: LogLevel.WARN,
});

async function getThreadContext(client: any, channel: string, threadTs: string): Promise<string> {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      oldest: threadTs,
    });

    if (!result.messages || result.messages.length <= 1) return "";

    // Skip the current message (last one) — it's already the prompt
    const history = result.messages.slice(0, -1);
    return history
      .map((m: any) => {
        const role = m.bot_id ? "assistant" : "user";
        const text = (m.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
        return `[${role}]: ${text}`;
      })
      .join("\n\n");
  } catch (error) {
    log("warn", "failed to fetch thread history", { error: String(error), channel, threadTs });
    return "";
  }
}

async function handleMessage(
  text: string,
  channel: string,
  threadTs: string,
  teamId: string,
  userId: string,
  client: any,
  files?: any[],
) {
  const prompt = (text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  const hasFiles = files?.length && files.length > 0;
  if (!prompt && !hasFiles) {
    log("warn", "empty prompt after stripping mention", { channel, threadTs });
    return;
  }

  // Create per-event Slack tools using the workspace-scoped client
  const slackTools = createSlackTools(client);

  // Resolve channel name for workspace directory (team-scoped)
  const channelName = await resolveChannelName(client, teamId, channel);
  const isDM = channelName === channel; // couldn't resolve = DM
  const workspace = isDM
    ? getWorkspacePath(teamId, "_dm")
    : getWorkspacePath(teamId, channelName);
  const otherWorkspaces = listWorkspaces(teamId)
    .filter((w) => w !== channelName && w !== "_dm")
    .map((w) => resolve(WORKSPACES_ROOT, teamId, w));

  // Download any attached files to workspace
  const { images: imagePaths, other: otherPaths } = await downloadSlackFiles(files, client.token, workspace);
  const allFilePaths = [...imagePaths, ...otherPaths];

  log("info", "handling message", { prompt, channel, channelName, threadTs, userId, teamId, workspace, files: allFilePaths.length });

  const threadContext = await getThreadContext(client, channel, threadTs);

  const slackContext = [
    `# Slack Context`,
    `You are responding inside a Slack conversation. Use these values when calling Slack tools:`,
    `- **Channel:** #${channelName} (${channel})`,
    `- **Thread TS:** ${threadTs}`,
    `- **User ID:** ${userId}`,
    ``,
    `When using Slack tools (post_message, upload_file, react, etc.), use the channel and thread_ts above — do NOT ask the user for them.`,
    ``,
    `# Workspace`,
    `Your working directory is \`${workspace}\` — this is #${channelName}'s workspace.`,
    `Each channel has its own workspace under \`${resolve(WORKSPACES_ROOT, teamId)}/\`.`,
    otherWorkspaces.length > 0
      ? `Other channel workspaces you can access: ${otherWorkspaces.map((w) => `\`${w}\``).join(", ")}`
      : `No other channel workspaces exist yet.`,
  ].join("\n");

  const attachmentParts: string[] = [];
  if (imagePaths.length > 0) {
    attachmentParts.push(
      `The user attached ${imagePaths.length} image(s). Use the Read tool to view them:\n` +
      imagePaths.map((p) => `- \`${p}\``).join("\n")
    );
  }
  if (otherPaths.length > 0) {
    attachmentParts.push(
      `The user attached ${otherPaths.length} file(s). These are saved in the workspace and you can read/use them:\n` +
      otherPaths.map((p) => `- \`${p}\``).join("\n")
    );
  }
  const fileContext = attachmentParts.length > 0
    ? "\n\n" + attachmentParts.join("\n\n")
    : "";

  const userMessage = prompt || "The user sent file(s) without any text.";
  const fullPrompt = threadContext
    ? `${slackContext}\n\nHere is the conversation so far:\n\n${threadContext}\n\nNow respond to:\n${userMessage}${fileContext}`
    : `${slackContext}\n\n${userMessage}${fileContext}`;

  // --- Block Kit activity card ---
  // Tool label helper
  function toolLabel(name: string, input?: Record<string, any>): string {
    if (name === "Bash") return `Bash: \`${truncate(input?.command || "...", 60)}\``;
    if (name === "Read") return `Read \`${input?.file_path || "..."}\``;
    if (name === "Glob") return `Glob \`${input?.pattern || "..."}\``;
    if (name === "Grep") return `Grep \`${truncate(input?.pattern || "...", 40)}\``;
    if (name === "Write") return `Write \`${input?.file_path || "..."}\``;
    if (name === "Edit") return `Edit \`${input?.file_path || "..."}\``;
    if (name === "Agent") return `Agent: ${truncate(input?.description || "subtask", 50)}`;
    if (name.startsWith("mcp__slack__")) return `Slack: ${name.replace("mcp__slack__", "")}`;
    return name;
  }

  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  type Activity = { tool: string; label: string; ts: number; status: "pending" | "in_progress" | "complete" | "error" };
  const activities: Activity[] = [];
  let status: "thinking" | "working" | "done" | "error" = "thinking";
  let resultMeta: { turns?: number; durationMs?: number; costUsd?: number; subtype?: string } = {};
  let lastCardUpdate = 0;

  function buildPlanBlock(): any {
    const statusMap = { thinking: "pending", working: "in_progress", done: "complete", error: "error" };

    // Each activity becomes a task_card in the plan
    const shown = activities.slice(-10);
    const tasks: any[] = shown.length > 0
      ? shown.map((a, i) => ({
          type: "task_card",
          task_id: `${threadTs}_${i}`,
          title: a.label,
          status: a.status,
        }))
      : [{
          type: "task_card",
          task_id: `${threadTs}_init`,
          title: "Thinking...",
          status: statusMap[status],
        }];

    // On completion, add a summary task with result metadata
    if (status === "done" || status === "error") {
      const parts: string[] = [];
      if (resultMeta.turns) parts.push(`${resultMeta.turns} turns`);
      if (resultMeta.durationMs) parts.push(`${(resultMeta.durationMs / 1000).toFixed(1)}s`);
      if (resultMeta.costUsd) parts.push(`$${resultMeta.costUsd.toFixed(4)}`);
      if (resultMeta.subtype && resultMeta.subtype !== "success") parts.push(resultMeta.subtype);
      if (parts.length > 0) {
        tasks.push({
          type: "task_card",
          task_id: `${threadTs}_summary`,
          title: parts.join("  ·  "),
          status: status === "done" ? "complete" : "error",
        });
      }
    }

    return {
      type: "plan",
      title: status === "done" ? "Done" : status === "error" ? "Error" : "Working...",
      tasks,
    };
  }

  // Post activity card
  const cardPost = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "Thinking...",
    blocks: [buildPlanBlock()],
  });
  const cardTs = cardPost.ts;

  async function updateCard(force = false) {
    const now = Date.now();
    if (!force && now - lastCardUpdate < 1000) return;
    lastCardUpdate = now;
    sessionStore.heartbeat(queryKey);
    await client.chat.update({
      channel,
      ts: cardTs,
      text: status === "done" ? "Done" : status === "error" ? "Error" : "Working...",
      blocks: [buildPlanBlock()],
    });
  }

  // Resume previous session for this thread if one exists (team-scoped key)
  const sessionKey = `${teamId}:${threadTs}`;
  const previousSessionId = sessionStore.getThreadSession(sessionKey);
  const queryKey = `${teamId}:${channel}:${threadTs}`;

  // Cancel any in-flight query for this thread before starting a new one
  const existing = activeQueries.get(queryKey);
  if (existing) {
    log("info", "aborting previous query for thread", { queryKey });
    existing.abort.abort();
    try {
      await client.chat.update({
        channel: existing.channel,
        ts: existing.msgTs,
        text: "Done",
        blocks: [{
          type: "plan",
          title: "Done",
          tasks: [{
            type: "task_card",
            task_id: `${queryKey}_cancelled`,
            title: "Interrupted by new message",
            status: "complete",
          }],
        }],
      });
    } catch {}
    sessionStore.complete(queryKey, "done");
    activeQueries.delete(queryKey);
  }

  const abortController = new AbortController();
  activeQueries.set(queryKey, { channel, msgTs: cardTs!, abort: abortController, client });
  sessionStore.register(queryKey, teamId, channel, threadTs, cardTs!, text, userId);

  let fullText = "";

  try {
    const response = query({
      prompt: fullPrompt,
      options: {
        abortController,
        cwd: workspace,
        additionalDirectories: otherWorkspaces,
        ...(previousSessionId ? { resume: previousSessionId } : {}),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: botPersona,
        },
        allowedTools: [
          "Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent",
          "mcp__slack__post_message",
          "mcp__slack__react",
          "mcp__slack__upload_file",
          "mcp__slack__delete_file",
          "mcp__slack__file_info",
          "mcp__slack__list_files",
          "mcp__slack__list_channels",
          "mcp__slack__user_info",
          "mcp__slack__pin_message",
        ],
        mcpServers: { slack: slackTools },
        permissionMode: "bypassPermissions",
      },
    });

    for await (const message of response) {
      if (message.type === "system" && "subtype" in message && message.subtype === "init") {
        if (message.session_id) {
          sessionStore.setThreadSession(sessionKey, message.session_id);
          sessionStore.setSessionId(queryKey, message.session_id);
        }
        log("info", "sdk init", {
          sessionId: message.session_id,
          model: (message as any).model,
        });
      } else if (message.type === "assistant") {
        const blocks = message.message.content;
        const textContent = blocks
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        const toolUses = blocks.filter((b: any) => b.type === "tool_use");

        for (const tu of toolUses) {
          // Mark previous activity as complete
          if (activities.length > 0) {
            activities[activities.length - 1].status = "complete";
          }
          const label = toolLabel((tu as any).name, (tu as any).input);
          activities.push({ tool: (tu as any).name, label, ts: Date.now(), status: "in_progress" });
          status = "working";
          await updateCard();
        }

        log("info", "sdk assistant", {
          textLength: textContent.length,
          toolUses: toolUses.length ? toolUses.map((t: any) => t.name) : undefined,
        });

        if (textContent) {
          fullText += textContent;
        }
      } else if (message.type === "result") {
        const result = message as any;
        resultMeta = {
          turns: result.num_turns,
          durationMs: result.duration_ms,
          costUsd: result.total_cost_usd,
          subtype: result.subtype,
        };
        status = result.subtype === "success" ? "done" : "error";
        sessionStore.complete(queryKey, status);
        // Mark all remaining activities as complete (or error)
        for (const a of activities) {
          if (a.status !== "complete") a.status = status === "done" ? "complete" : "error";
        }

        log("info", "sdk result", {
          subtype: result.subtype,
          isError: result.is_error,
          turns: result.num_turns,
          durationMs: result.duration_ms,
          costUsd: result.total_cost_usd,
          errors: result.errors,
        });

        if (result.subtype === "error_max_turns") {
          fullText += "\n\n_Hit the max turns limit — reply in this thread to continue._";
        } else if (result.subtype === "error_during_execution") {
          const errors = result.errors?.join(", ") || "unknown error";
          fullText += `\n\n_Error: ${errors}_`;
        } else if (result.subtype === "error_max_budget_usd") {
          fullText += "\n\n_Hit the budget limit for this request._";
        }
      } else {
        log("info", "sdk message", { type: message.type, subtype: (message as any).subtype });
      }
    }

    // Final card update
    await updateCard(true);

    // Post response as a separate message (not edited)
    if (fullText) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: fullText,
      });
    }

    log("info", "stream complete", { threadTs });
  } catch (error) {
    const isAbort = abortController.signal.aborted || String(error).includes("aborted");
    if (isAbort) {
      // Intentional abort (new message in thread or shutdown) — don't post error message.
      // The aborting code already updated the card.
      log("info", "query aborted", { threadTs });
    } else {
      log("error", "claude query failed", { error: String(error), threadTs });
      status = "error";
      sessionStore.complete(queryKey, "error");
      await updateCard(true);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: fullText || "Something went wrong, try again.",
      });
    }
  } finally {
    activeQueries.delete(queryKey);
  }
}

app.command("/ping", async ({ ack, respond }) => {
  await ack();
  await respond("pong!");
});

app.command("/version", async ({ ack, respond }) => {
  await ack();
  const uptime = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const uptimeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
  await respond(
    `*Cofounder* v${process.env.npm_package_version || "1.0.0"}\n` +
    `Commit: \`${gitCommit}\` (${gitDate})\n` +
    `Uptime: ${uptimeStr}`,
  );
});

app.command("/changelog", async ({ ack, respond }) => {
  await ack();
  const lines = gitChangelog.split("\n").map(l => `• ${l}`).join("\n");
  await respond(`*Recent changes:*\n${lines}`);
});

app.command("/tasks", async ({ ack, respond, command }) => {
  await ack();
  const pending = taskStore.getAllPending();
  if (pending.length === 0) {
    await respond("No pending or active tasks. Queue is empty.");
    return;
  }
  const lines = pending.map((t: TaskRecord) => {
    const icon = t.status === "active" ? ":large_blue_circle:" : ":white_circle:";
    const age = Math.floor((Date.now() - new Date(t.started_at || t.created_at).getTime()) / 60000);
    return `${icon} *#${t.id}* (${t.status}) — ${t.description}  _${age}m ago_`;
  });
  await respond(`*Task Queue (${pending.length}):*\n${lines.join("\n")}`);
});

app.event("app_mention", async ({ event, client, context }) => {
  log("info", "app_mention event", { user: event.user, channel: event.channel });
  const threadTs = event.thread_ts || event.ts;
  handleMessage(
    event.text,
    event.channel,
    threadTs,
    context.teamId!,
    event.user!,
    client,
    (event as any).files,
  );
});

app.message(async ({ message, client, context }) => {
  const msg = message as any;
  log("info", "message event", { channelType: msg.channel_type, subtype: msg.subtype, user: msg.user });
  if (msg.subtype && msg.subtype !== "file_share") return;

  const isDM = msg.channel_type === "im";
  const isThreadReply = !!msg.thread_ts;

  // DMs: always respond
  // Channel threads: respond if the bot already participated in the thread
  if (!isDM) {
    if (!isThreadReply) return; // not a thread reply in a channel, skip (use @mention for new threads)
    try {
      const replies = await client.conversations.replies({
        channel: msg.channel,
        ts: msg.thread_ts,
      });
      const botUserId = context.botUserId;
      const botInThread = replies.messages?.some((m: any) => m.user === botUserId || m.bot_id);
      if (!botInThread) return;
    } catch {
      return;
    }
  }

  const threadTs = msg.thread_ts || msg.ts;
  handleMessage(
    msg.text,
    msg.channel,
    threadTs,
    context.teamId!,
    msg.user,
    client,
    msg.files,
  );
});

// --- Uninstall handling ---
app.event("app_uninstalled" as any, async ({ context }: any) => {
  const teamId = context.teamId;
  if (!teamId) return;
  log("info", "app_uninstalled", { teamId });
  try {
    await installationStore.deleteInstallation!({
      teamId,
      enterpriseId: context.enterpriseId,
      isEnterpriseInstall: false,
    } as any);
  } catch (error) {
    log("error", "failed to delete installation on uninstall", { error: String(error), teamId });
  }
});

app.event("tokens_revoked" as any, async ({ event, context }: any) => {
  const teamId = context.teamId;
  if (!teamId) return;
  log("info", "tokens_revoked", { teamId, tokens: event.tokens });
  // If bot tokens were revoked, remove the installation
  if (event.tokens?.bot?.length > 0) {
    try {
      await installationStore.deleteInstallation!({
        teamId,
        enterpriseId: context.enterpriseId,
        isEnterpriseInstall: false,
      } as any);
    } catch (error) {
      log("error", "failed to delete installation on token revocation", { error: String(error), teamId });
    }
  }
});

// Graceful shutdown: abort in-flight queries but leave them "active" in DB
// so cleanupStaleSessions() can auto-resume them on next startup.
async function shutdown(signal: string) {
  log("info", "shutting down", { signal, activeQueries: activeQueries.size });
  for (const [key, { channel, msgTs, abort, client }] of activeQueries) {
    abort.abort();
    try {
      await client.chat.update({
        channel,
        ts: msgTs,
        text: "Restarting — will resume automatically.",
        blocks: [{
          type: "plan",
          title: "Restarting — will resume automatically.",
          tasks: [{
            type: "task_card",
            task_id: `${key}_restart`,
            title: "Restarting...",
            status: "in_progress",
          }],
        }],
      });
    } catch {}
    // DON'T mark as complete — leave as "active" so startup cleanup will resume them
    activeQueries.delete(key);
  }
  stopWorker();
  taskStore.close();
  sessionStore.close();
  installationStore.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// On startup, find any sessions that were "active" when the process last died
// and auto-resume them instead of making the user resend.
async function cleanupStaleSessions() {
  const stale = sessionStore.getActiveSessions();
  if (stale.length === 0) return;

  log("info", "resuming stale sessions from previous run", { count: stale.length });

  // Group by team_id to minimize token lookups
  const byTeam = new Map<string, typeof stale>();
  for (const s of stale) {
    const arr = byTeam.get(s.team_id) || [];
    arr.push(s);
    byTeam.set(s.team_id, arr);
  }

  const { WebClient } = await import("@slack/web-api");

  for (const [teamId, sessions] of byTeam) {
    let token: string | undefined;

    if (!useOAuth && process.env.SLACK_BOT_TOKEN) {
      token = process.env.SLACK_BOT_TOKEN;
    } else {
      try {
        const installation = await installationStore.fetchInstallation!({
          teamId,
          isEnterpriseInstall: false,
        } as any);
        token = (installation as any).bot?.token;
      } catch {
        log("warn", "could not fetch token for stale session cleanup", { teamId });
      }
    }

    if (!token) {
      // Can't resume without a token — just mark them done in DB
      for (const s of sessions) sessionStore.complete(s.query_key, "error");
      continue;
    }

    const slackClient = new WebClient(token);

    for (const session of sessions) {
      // Mark the old session as interrupted in DB first
      sessionStore.complete(session.query_key, "error");

      // Update the old card to show it was interrupted
      try {
        await slackClient.chat.update({
          channel: session.channel,
          ts: session.card_ts,
          text: "Restarting — resuming automatically.",
          blocks: [{
            type: "plan",
            title: "Restarting — resuming automatically.",
            tasks: [{
              type: "task_card",
              task_id: `${session.query_key}_stale`,
              title: "Interrupted by restart — resuming",
              status: "complete",
            }],
          }],
        });
      } catch (error) {
        log("warn", "failed to update stale session card", { queryKey: session.query_key, error: String(error) });
      }

      // Auto-resume: if we have the original prompt and user_id, re-invoke handleMessage
      if (session.prompt && session.user_id) {
        log("info", "auto-resuming interrupted query", {
          queryKey: session.query_key,
          channel: session.channel,
          threadTs: session.thread_ts,
        });
        // Fire and forget — handleMessage manages its own lifecycle
        handleMessage(
          session.prompt,
          session.channel,
          session.thread_ts,
          session.team_id,
          session.user_id,
          slackClient,
        );
      } else {
        log("warn", "cannot auto-resume — missing prompt or user_id", { queryKey: session.query_key });
        // Fall back to asking the user to resend
        try {
          await slackClient.chat.postMessage({
            channel: session.channel,
            thread_ts: session.thread_ts,
            text: "I restarted and couldn't auto-resume this one. Send your message again and I'll pick up where I left off.",
          });
        } catch {}
      }
    }
  }
}

// --- Proactive worker loop (the "daemon" side) ---
let workerRunning = false;
const WORKER_INTERVAL_MS = 15_000; // Check for tasks every 15 seconds

async function processNextTask() {
  if (workerRunning) return; // Only one task at a time

  const task = taskStore.getNext();
  if (!task) return;

  workerRunning = true;
  log("info", "worker picking up task", { taskId: task.id, description: task.description });

  taskStore.claim(task.id);

  // Get a Slack client for this team
  let token: string | undefined;
  if (!useOAuth && process.env.SLACK_BOT_TOKEN) {
    token = process.env.SLACK_BOT_TOKEN;
  } else {
    try {
      const installation = await installationStore.fetchInstallation!({
        teamId: task.team_id,
        isEnterpriseInstall: false,
      } as any);
      token = (installation as any).bot?.token;
    } catch {
      log("warn", "could not fetch token for task", { taskId: task.id, teamId: task.team_id });
      taskStore.complete(task.id, "error", "Could not fetch Slack token");
      workerRunning = false;
      return;
    }
  }

  if (!token) {
    taskStore.complete(task.id, "error", "No Slack token available");
    workerRunning = false;
    return;
  }

  const { WebClient } = await import("@slack/web-api");
  const slackClient = new WebClient(token);

  try {
    // Post a status update in the thread
    await slackClient.chat.postMessage({
      channel: task.channel,
      thread_ts: task.thread_ts,
      text: `Working on task #${task.id}: ${task.description}`,
    });

    // Run the task through handleMessage — same pipeline as reactive messages
    const taskPrompt = `[TASK #${task.id}] ${task.description}\n\nThis is a queued task from the proactive worker. Execute it, then when done, mark it complete by running:\nnode --import tsx /home/slacker/slacker/src/task-cli.ts done --id ${task.id} --result "summary of what you did"`;

    await handleMessage(
      taskPrompt,
      task.channel,
      task.thread_ts,
      task.team_id,
      task.user_id,
      slackClient,
    );

    // If handleMessage didn't mark it done via CLI, mark it done now
    const updated = taskStore.getById(task.id);
    if (updated && updated.status === "active") {
      taskStore.complete(task.id, "done", "Completed by worker");
    }
  } catch (error) {
    log("error", "worker task failed", { taskId: task.id, error: String(error) });
    taskStore.complete(task.id, "error", String(error));
    try {
      await slackClient.chat.postMessage({
        channel: task.channel,
        thread_ts: task.thread_ts,
        text: `Task #${task.id} failed: ${String(error)}`,
      });
    } catch {}
  } finally {
    workerRunning = false;
  }
}

let workerTimer: ReturnType<typeof setInterval> | null = null;

function startWorker() {
  if (workerTimer) return;
  log("info", "starting proactive worker loop", { intervalMs: WORKER_INTERVAL_MS });
  workerTimer = setInterval(processNextTask, WORKER_INTERVAL_MS);
  // Also run immediately on start
  processNextTask();
}

function stopWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

(async () => {
  // Migrate existing SLACK_BOT_TOKEN: always migrate workspace dirs,
  // only store installation record when in OAuth mode
  await migrateFromEnv(installationStore, useOAuth);

  await app.start();
  log("info", "cofounder started", { mode: useOAuth ? "oauth" : "legacy" });

  // Clean up any cards left as "Working..." from a previous crash/restart
  await cleanupStaleSessions();

  // Start the proactive worker loop (daemon mode)
  startWorker();

  console.log("\n--- AGENT.md ---\n" + botPersona + "--- END ---\n");
})();
