import "dotenv/config";
import { readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bolt from "@slack/bolt";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSlackTools } from "./slack-tools.js";

const { App, LogLevel } = bolt;

// Load bot persona from AGENT.md at startup
const __dirname = dirname(fileURLToPath(import.meta.url));
const botPersona = readFileSync(resolve(__dirname, "../AGENT.md"), "utf-8");

// Workspaces root — each channel gets its own directory
const WORKSPACES_ROOT = resolve(process.env.HOME || "/home/slacker", ".slacker", "workspaces");
mkdirSync(WORKSPACES_ROOT, { recursive: true });

// Channel name cache (resolved lazily)
const channelNameCache = new Map<string, string>();

async function resolveChannelName(client: any, channelId: string): Promise<string> {
  const cached = channelNameCache.get(channelId);
  if (cached) return cached;
  try {
    const info = await client.conversations.info({ channel: channelId });
    const name = info.channel?.name || channelId;
    channelNameCache.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}

function getWorkspacePath(channelName: string): string {
  const wsPath = resolve(WORKSPACES_ROOT, channelName);
  mkdirSync(wsPath, { recursive: true });
  return wsPath;
}

function listWorkspaces(): string[] {
  if (!existsSync(WORKSPACES_ROOT)) return [];
  return readdirSync(WORKSPACES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// Track session IDs per thread for conversation continuity
const threadSessions = new Map<string, string>();

// Track active queries so we can clean up on shutdown
type ActiveQuery = { channel: string; msgTs: string; abort: AbortController };
const activeQueries = new Map<string, ActiveQuery>();

function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  console[level](JSON.stringify(entry));
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.WARN,
});

const slackTools = createSlackTools(app.client);

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
) {
  const prompt = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!prompt) {
    log("warn", "empty prompt after stripping mention", { channel, threadTs });
    return;
  }

  // Resolve channel name for workspace directory
  const channelName = await resolveChannelName(client, channel);
  const isDM = channelName === channel; // couldn't resolve = DM
  const workspace = isDM ? resolve(WORKSPACES_ROOT, "_dm") : getWorkspacePath(channelName);
  const otherWorkspaces = listWorkspaces()
    .filter((w) => w !== channelName && w !== "_dm")
    .map((w) => resolve(WORKSPACES_ROOT, w));

  log("info", "handling message", { prompt, channel, channelName, threadTs, userId, workspace });

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
    `Each channel has its own workspace under \`${WORKSPACES_ROOT}/\`.`,
    otherWorkspaces.length > 0
      ? `Other channel workspaces you can access: ${otherWorkspaces.map((w) => `\`${w}\``).join(", ")}`
      : `No other channel workspaces exist yet.`,
  ].join("\n");

  const fullPrompt = threadContext
    ? `${slackContext}\n\nHere is the conversation so far:\n\n${threadContext}\n\nNow respond to:\n${prompt}`
    : `${slackContext}\n\n${prompt}`;

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

  type Activity = { tool: string; label: string; ts: number };
  const activities: Activity[] = [];
  let status: "thinking" | "working" | "done" | "error" = "thinking";
  let resultMeta: { turns?: number; durationMs?: number; costUsd?: number; subtype?: string } = {};
  let lastCardUpdate = 0;

  function buildBlocks(): any[] {
    const blocks: any[] = [];

    // Status header
    const statusIcon = status === "thinking" ? "⏳" : status === "working" ? "⚙️" : status === "done" ? "✅" : "❌";
    const statusText = status === "thinking" ? "Thinking..." : status === "working" ? "Working..." : status === "done" ? "Done" : "Error";
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `${statusIcon}  *${statusText}*` }],
    });

    // Activity log (last 10 to stay under block limits)
    const shown = activities.slice(-10);
    if (shown.length > 0) {
      blocks.push({ type: "divider" });
      for (const a of shown) {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: `\`▸\` ${a.label}` }],
        });
      }
    }

    // Result metadata
    if (status === "done" || status === "error") {
      blocks.push({ type: "divider" });
      const parts: string[] = [];
      if (resultMeta.turns) parts.push(`${resultMeta.turns} turns`);
      if (resultMeta.durationMs) parts.push(`${(resultMeta.durationMs / 1000).toFixed(1)}s`);
      if (resultMeta.costUsd) parts.push(`$${resultMeta.costUsd.toFixed(4)}`);
      if (resultMeta.subtype && resultMeta.subtype !== "success") parts.push(resultMeta.subtype);
      if (parts.length > 0) {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: parts.join("  ·  ") }],
        });
      }
    }

    return blocks;
  }

  // Post activity card
  const cardPost = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "⏳ Thinking...",
    blocks: buildBlocks(),
  });
  const cardTs = cardPost.ts;

  async function updateCard(force = false) {
    const now = Date.now();
    if (!force && now - lastCardUpdate < 1000) return;
    lastCardUpdate = now;
    const blocks = buildBlocks();
    await client.chat.update({
      channel,
      ts: cardTs,
      text: status === "done" ? "✅ Done" : status === "error" ? "❌ Error" : "⚙️ Working...",
      blocks,
    });
  }

  // Resume previous session for this thread if one exists
  const previousSessionId = threadSessions.get(threadTs);
  const abortController = new AbortController();
  const queryKey = `${channel}:${threadTs}`;
  activeQueries.set(queryKey, { channel, msgTs: cardTs!, abort: abortController });

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
          threadSessions.set(threadTs, message.session_id);
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
          const label = toolLabel((tu as any).name, (tu as any).input);
          activities.push({ tool: (tu as any).name, label, ts: Date.now() });
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
    log("error", "claude query failed", { error: String(error), threadTs });
    status = "error";
    await updateCard(true);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: fullText || "Something went wrong, try again.",
    });
  } finally {
    activeQueries.delete(queryKey);
  }
}

app.command("/ping", async ({ ack, respond }) => {
  await ack();
  await respond("pong!");
});

app.event("app_mention", async ({ event, client, context }) => {
  log("info", "app_mention event", { user: event.user, channel: event.channel });
  const threadTs = event.thread_ts || event.ts;
  handleMessage(
    event.text,
    event.channel,
    threadTs,
    context.teamId!,
    event.user,
    client,
  );
});

app.message(async ({ message, client, context }) => {
  const msg = message as any;
  log("info", "message event", { channelType: msg.channel_type, subtype: msg.subtype, user: msg.user });
  if (msg.subtype) return;

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
  );
});

// Graceful shutdown: update any in-flight "thinking..." messages
async function shutdown(signal: string) {
  log("info", "shutting down", { signal, activeQueries: activeQueries.size });
  for (const [key, { channel, msgTs, abort }] of activeQueries) {
    abort.abort();
    try {
      await app.client.chat.update({
        channel,
        ts: msgTs,
        text: "_Restarting — send your message again._",
      });
    } catch {}
    activeQueries.delete(key);
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

(async () => {
  await app.start();
  log("info", "cofounder started");
  console.log("\n--- AGENT.md ---\n" + botPersona + "--- END ---\n");
})();
