import type { WebClient } from "@slack/web-api";

/**
 * Posts activity events to a designated #bot-activity channel.
 * Auto-discovers the channel by name. Silently no-ops if the channel doesn't exist.
 */

const ACTIVITY_CHANNEL_NAME = process.env.ACTIVITY_CHANNEL || "bot-activity";
// Direct channel ID override — skips discovery entirely
const ACTIVITY_CHANNEL_ID = process.env.ACTIVITY_CHANNEL_ID || "";

// Cache the resolved channel ID per team
const channelIdCache = new Map<string, string | null>();

async function resolveActivityChannel(client: WebClient, teamId: string): Promise<string | null> {
  // If a channel ID is set directly, use it (fastest path)
  if (ACTIVITY_CHANNEL_ID) return ACTIVITY_CHANNEL_ID;

  const cached = channelIdCache.get(teamId);
  if (cached !== undefined) return cached;

  try {
    // Try listing channels the bot is a member of
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    });
    const ch = (result.channels || []).find((c: any) => c.name === ACTIVITY_CHANNEL_NAME);
    const id = ch ? (ch as any).id : null;
    channelIdCache.set(teamId, id);
    if (id) return id;
  } catch {
    // conversations.list failed — try a direct lookup by name
  }

  // Fallback: if we know the channel exists, try posting anyway (will fail gracefully)
  channelIdCache.set(teamId, null);
  return null;
}

/** Clear the cache (e.g. after creating the channel) */
export function clearActivityChannelCache(teamId?: string) {
  if (teamId) channelIdCache.delete(teamId);
  else channelIdCache.clear();
}

async function post(client: WebClient, teamId: string, text: string) {
  const channelId = await resolveActivityChannel(client, teamId);
  if (!channelId) return;
  try {
    await client.chat.postMessage({ channel: channelId, text });
  } catch {
    // Silently fail — activity feed is best-effort
  }
}

export const activity = {
  // --- Lifecycle ---
  async startup(client: WebClient, teamId: string, commit: string) {
    await post(client, teamId, `:rocket: *Bot started* — commit \`${commit}\``);
  },

  async shutdown(client: WebClient, teamId: string) {
    await post(client, teamId, `:stop_sign: *Bot shutting down*`);
  },

  // --- Incoming events ---
  async newDM(client: WebClient, teamId: string, channel: string, userId: string) {
    await post(client, teamId, `:envelope: New DM from <@${userId}> in <#${channel}>`);
  },

  async newThread(client: WebClient, teamId: string, channel: string, userId: string) {
    await post(client, teamId, `:thread: New thread from <@${userId}> in <#${channel}>`);
  },

  async threadReply(client: WebClient, teamId: string, channel: string, userId: string) {
    await post(client, teamId, `:left_speech_bubble: Thread reply from <@${userId}> in <#${channel}>`);
  },

  async fileReceived(client: WebClient, teamId: string, channel: string, userId: string, fileCount: number) {
    const s = fileCount === 1 ? "1 file" : `${fileCount} files`;
    await post(client, teamId, `:paperclip: ${s} received from <@${userId}> in <#${channel}>`);
  },

  // --- Message processing ---
  async messageStart(client: WebClient, teamId: string, channel: string, threadTs: string, userId: string, prompt: string) {
    const snippet = prompt.length > 100 ? prompt.slice(0, 100) + "…" : prompt;
    await post(client, teamId, `:speech_balloon: Working on request from <@${userId}> in <#${channel}>\n> ${snippet}`);
  },

  async messageDone(client: WebClient, teamId: string, channel: string, meta: { turns?: number; durationMs?: number; costUsd?: number }) {
    const parts: string[] = [];
    if (meta.turns) parts.push(`${meta.turns} turns`);
    if (meta.durationMs) parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
    if (meta.costUsd) parts.push(`$${meta.costUsd.toFixed(4)}`);
    const summary = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
    await post(client, teamId, `:white_check_mark: Done in <#${channel}>${summary}`);
  },

  async messageError(client: WebClient, teamId: string, channel: string, error?: string) {
    const detail = error ? ` — ${error}` : "";
    await post(client, teamId, `:x: Error in <#${channel}>${detail}`);
  },

  async messageAborted(client: WebClient, teamId: string, channel: string) {
    await post(client, teamId, `:fast_forward: Aborted previous query in <#${channel}> (new message received)`);
  },

  // --- Session resume ---
  async sessionResumed(client: WebClient, teamId: string, channel: string, threadTs: string) {
    await post(client, teamId, `:arrows_counterclockwise: Resuming interrupted session in <#${channel}>`);
  },

  // --- Tasks ---
  async taskQueued(client: WebClient, teamId: string, taskId: number, description: string) {
    await post(client, teamId, `:inbox_tray: *Task #${taskId}* queued — ${description}`);
  },

  async taskStart(client: WebClient, teamId: string, taskId: number, description: string) {
    await post(client, teamId, `:gear: *Task #${taskId}* started — ${description}`);
  },

  async taskDone(client: WebClient, teamId: string, taskId: number, result?: string) {
    const detail = result ? ` — ${result.slice(0, 150)}` : "";
    await post(client, teamId, `:white_check_mark: *Task #${taskId}* done${detail}`);
  },

  async taskError(client: WebClient, teamId: string, taskId: number, error?: string) {
    const detail = error ? ` — ${error.slice(0, 150)}` : "";
    await post(client, teamId, `:x: *Task #${taskId}* failed${detail}`);
  },

  async taskCancelled(client: WebClient, teamId: string, taskId: number) {
    await post(client, teamId, `:no_entry_sign: *Task #${taskId}* cancelled`);
  },
};
