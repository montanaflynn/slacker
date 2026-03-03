import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bolt from "@slack/bolt";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSlackTools } from "./slack-tools.js";

const { App, LogLevel } = bolt;

// Load bot persona from BOT.md at startup
const __dirname = dirname(fileURLToPath(import.meta.url));
const botPersona = readFileSync(resolve(__dirname, "../BOT.md"), "utf-8");

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

  log("info", "handling message", { prompt, channel, threadTs, userId });

  const threadContext = await getThreadContext(client, channel, threadTs);

  const slackContext = [
    `# Slack Context`,
    `You are responding inside a Slack conversation. Use these values when calling Slack tools:`,
    `- **Channel ID:** ${channel}`,
    `- **Thread TS:** ${threadTs}`,
    `- **User ID:** ${userId}`,
    ``,
    `When using Slack tools (post_message, upload_file, react, etc.), use the channel and thread_ts above — do NOT ask the user for them.`,
  ].join("\n");

  const fullPrompt = threadContext
    ? `${slackContext}\n\nHere is the conversation so far:\n\n${threadContext}\n\nNow respond to:\n${prompt}`
    : `${slackContext}\n\n${prompt}`;

  // Post a placeholder immediately so the user sees something
  const posted = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "...",
  });
  const msgTs = posted.ts;
  let fullText = "";
  let lastUpdate = 0;

  async function updateMessage(force = false) {
    const now = Date.now();
    // Throttle updates to avoid rate limits (max every 500ms)
    if (!force && now - lastUpdate < 500) return;
    lastUpdate = now;
    await client.chat.update({
      channel,
      ts: msgTs,
      text: fullText || "...",
    });
  }

  try {
    const response = query({
      prompt: fullPrompt,
      options: {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: botPersona,
        },
        allowedTools: [
          "Read", "Write", "Edit", "Bash", "Glob", "Grep",
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
      if (message.type === "system") {
        log("info", "sdk init", {
          sessionId: message.session_id,
          model: message.model,
          tools: message.tools,
          permissionMode: message.permissionMode,
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

        log("info", "sdk assistant", {
          textLength: textContent.length,
          toolUses: toolUses.length ? toolUses : undefined,
        });

        if (textContent) {
          fullText += textContent;
          await updateMessage();
        }
      } else if (message.type === "result") {
        log("info", "sdk result", {
          subtype: message.subtype,
          isError: message.is_error,
          turns: message.num_turns,
          durationMs: message.duration_ms,
          costUsd: message.total_cost_usd,
          errors: "errors" in message ? message.errors : undefined,
        });
      } else {
        log("info", "sdk message", { type: message.type });
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
