import "dotenv/config";
import { readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bolt from "@slack/bolt";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSlackTools } from "./slack-tools.js";

const { App, LogLevel } = bolt;

// Load bot persona from BOT.md at startup
const __dirname = dirname(fileURLToPath(import.meta.url));
const botPersona = readFileSync(resolve(__dirname, "../BOT.md"), "utf-8");

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

  // Post a placeholder immediately so the user sees something
  const posted = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "_thinking..._",
  });
  const msgTs = posted.ts;
  let fullText = "";
  let statusText = "_thinking..._";
  let lastUpdate = 0;

  // Tool name → human-readable status
  function toolStatus(toolName: string): string {
    if (toolName === "Bash") return "_running command..._";
    if (toolName === "Read") return "_reading file..._";
    if (toolName === "Glob") return "_searching files..._";
    if (toolName === "Grep") return "_searching code..._";
    if (toolName === "Write") return "_writing file..._";
    if (toolName === "Edit") return "_editing file..._";
    if (toolName === "Agent") return "_working on subtask..._";
    if (toolName.startsWith("mcp__slack__")) return "_using slack..._";
    return `_using ${toolName}..._`;
  }

  async function updateMessage(force = false) {
    const now = Date.now();
    if (!force && now - lastUpdate < 500) return;
    lastUpdate = now;
    await client.chat.update({
      channel,
      ts: msgTs,
      text: fullText || statusText,
    });
  }

  // Resume previous session for this thread if one exists
  const previousSessionId = threadSessions.get(threadTs);

  try {
    const response = query({
      prompt: fullPrompt,
      options: {
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
          "mcp__slack__create_canvas",
          "mcp__slack__edit_canvas",
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
        // Track session ID for thread continuity
        if (message.session_id) {
          threadSessions.set(threadTs, message.session_id);
        }
        log("info", "sdk init", {
          sessionId: message.session_id,
          model: (message as any).model,
          tools: (message as any).tools,
        });
      } else if (message.type === "assistant") {
        const blocks = message.message.content;
        const textContent = blocks
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        const toolUses = blocks
          .filter((b: any) => b.type === "tool_use")
          .map((b: any) => b.name);

        // Update status with what tool is being used
        if (toolUses.length > 0 && !fullText) {
          statusText = toolStatus(toolUses[0]);
          await updateMessage();
        }

        log("info", "sdk assistant", {
          textLength: textContent.length,
          toolUses: toolUses.length ? toolUses : undefined,
        });

        if (textContent) {
          fullText += textContent;
          await updateMessage();
        }
      } else if (message.type === "result") {
        const result = message as any;
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
      } else if (message.type === "tool_use_summary") {
        log("info", "tool summary", { summary: (message as any).summary });
      } else {
        log("info", "sdk message", { type: message.type, subtype: (message as any).subtype });
      }
    }

    // Final update with complete text
    await updateMessage(true);
    log("info", "stream complete", { threadTs });
  } catch (error) {
    log("error", "claude query failed", { error: String(error), threadTs });
    await client.chat.update({
      channel,
      ts: msgTs,
      text: "Something went wrong, try again.",
    });
  }
}

app.command("/ping", async ({ ack, respond }) => {
  await ack();
  await respond("pong!");
});

app.event("app_mention", async ({ event, client, context }) => {
  log("info", "app_mention event", { user: event.user, channel: event.channel });
  const threadTs = event.thread_ts || event.ts;
  await handleMessage(
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
  await handleMessage(
    msg.text,
    msg.channel,
    threadTs,
    context.teamId!,
    msg.user,
    client,
  );
});

(async () => {
  await app.start();
  log("info", "slacker started");
  console.log("\n--- BOT.md ---\n" + botPersona + "--- END ---\n");
})();
