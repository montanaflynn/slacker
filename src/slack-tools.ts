import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";

export function createSlackTools(client: WebClient) {
  const postMessage = tool(
    "post_message",
    "Post a message to a Slack channel or thread",
    {
      channel: z.string().describe("Channel ID to post to"),
      text: z.string().describe("Message text"),
      thread_ts: z.string().optional().describe("Thread timestamp to reply in"),
    },
    async (args) => {
      const result = await client.chat.postMessage({
        channel: args.channel,
        text: args.text,
        thread_ts: args.thread_ts,
      });
      return {
        content: [{ type: "text" as const, text: `Message posted (ts: ${result.ts})` }],
      };
    },
  );

  const react = tool(
    "react",
    "Add an emoji reaction to a message",
    {
      channel: z.string().describe("Channel ID containing the message"),
      timestamp: z.string().describe("Timestamp of the message to react to"),
      name: z.string().describe("Emoji name without colons (e.g. 'thumbsup')"),
    },
    async (args) => {
      await client.reactions.add({
        channel: args.channel,
        timestamp: args.timestamp,
        name: args.name,
      });
      return {
        content: [{ type: "text" as const, text: `Reaction :${args.name}: added` }],
      };
    },
  );

  const uploadFile = tool(
    "upload_file",
    "Upload a file to a Slack channel. Provide either content (text) or file_path (binary file on disk), but not both.",
    {
      channel: z.string().describe("Channel ID to upload to"),
      filename: z.string().describe("Name of the file"),
      content: z.string().optional().describe("File content as text"),
      file_path: z.string().optional().describe("Absolute path to a file on disk to upload (for binary files like images, videos, etc.)"),
      thread_ts: z.string().optional().describe("Thread timestamp to upload in"),
    },
    async (args) => {
      if (!args.content && !args.file_path) {
        return {
          content: [{ type: "text" as const, text: "Error: either content or file_path must be provided" }],
        };
      }
      const dest = args.thread_ts
        ? { channel_id: args.channel, thread_ts: args.thread_ts }
        : { channel_id: args.channel };
      const result = await client.filesUploadV2({
        ...dest,
        filename: args.filename,
        ...(args.file_path ? { file: args.file_path } : { content: args.content! }),
      });
      return {
        content: [{ type: "text" as const, text: `File "${args.filename}" uploaded (ok: ${result.ok})` }],
      };
    },
  );

  const deleteFile = tool(
    "delete_file",
    "Delete a file from Slack",
    {
      file: z.string().describe("File ID to delete"),
    },
    async (args) => {
      await client.files.delete({ file: args.file });
      return {
        content: [{ type: "text" as const, text: `File ${args.file} deleted` }],
      };
    },
  );

  const fileInfo = tool(
    "file_info",
    "Get info about a Slack file",
    {
      file: z.string().describe("File ID to look up"),
    },
    async (args) => {
      const result = await client.files.info({ file: args.file });
      const f = result.file as any;
      const info = {
        id: f.id,
        name: f.name,
        title: f.title,
        mimetype: f.mimetype,
        size: f.size,
        user: f.user,
        created: f.created,
        url_private: f.url_private,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
      };
    },
  );

  const listFiles = tool(
    "list_files",
    "List files in Slack, optionally filtered by channel, user, or type",
    {
      channel: z.string().optional().describe("Filter by channel ID"),
      user: z.string().optional().describe("Filter by user ID"),
      types: z.string().optional().describe("Filter by type: all, spaces, snippets, images, gdocs, zips, pdfs (comma-separated)"),
      count: z.number().optional().describe("Number of files to return (default 20)"),
    },
    async (args) => {
      const result = await client.files.list({
        channel: args.channel,
        user: args.user,
        types: args.types,
        count: args.count ?? 20,
      });
      const files = (result.files || []).map(
        (f: any) => `${f.name} (${f.id}) - ${f.size} bytes, by ${f.user}`,
      );
      return {
        content: [{ type: "text" as const, text: files.join("\n") || "No files found" }],
      };
    },
  );

  const listChannels = tool(
    "list_channels",
    "List Slack channels the bot is a member of",
    {},
    async () => {
      const result = await client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
      });
      const channels = (result.channels || []).map(
        (c: any) => `#${c.name} (${c.id})`,
      );
      return {
        content: [{ type: "text" as const, text: channels.join("\n") || "No channels found" }],
      };
    },
  );

  const userInfo = tool(
    "user_info",
    "Look up a Slack user by their ID",
    {
      user: z.string().describe("User ID to look up"),
    },
    async (args) => {
      const result = await client.users.info({ user: args.user });
      const u = result.user as any;
      const info = {
        name: u.real_name || u.name,
        display_name: u.profile?.display_name,
        email: u.profile?.email,
        title: u.profile?.title,
        tz: u.tz,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
      };
    },
  );

  const pinMessage = tool(
    "pin_message",
    "Pin a message in a Slack channel",
    {
      channel: z.string().describe("Channel ID containing the message"),
      timestamp: z.string().describe("Timestamp of the message to pin"),
    },
    async (args) => {
      await client.pins.add({
        channel: args.channel,
        timestamp: args.timestamp,
      });
      return {
        content: [{ type: "text" as const, text: "Message pinned" }],
      };
    },
  );

  return createSdkMcpServer({
    name: "slack",
    version: "1.0.0",
    tools: [
      postMessage, react, uploadFile, deleteFile, fileInfo, listFiles,
      listChannels, userInfo, pinMessage,
    ],
  });
}
