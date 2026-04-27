#!/usr/bin/env node
/**
 * SubDownload MCP proxy.
 *
 * Exposes SubDownload's hosted MCP server (https://api.subdownload.com/mcp) as
 * a local stdio MCP server suitable for Docker deployment. Tool schemas are
 * declared inline so introspection (initialize, tools/list) works without auth;
 * tools/call forwards to the upstream endpoint with a Bearer token from
 * SUBDOWNLOAD_API_KEY.
 *
 * For most users it's simpler to point your MCP client directly at
 * https://api.subdownload.com/mcp with OAuth — see the project README.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const UPSTREAM_URL =
  process.env.SUBDOWNLOAD_MCP_URL || "https://api.subdownload.com/mcp";
const API_KEY = process.env.SUBDOWNLOAD_API_KEY;

const TOOLS = [
  {
    name: "search_youtube",
    description: "Keyword search across YouTube.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_video_info",
    description:
      "Fetch metadata for a YouTube video (title, channel, duration, view count, publish date).",
    inputSchema: {
      type: "object",
      properties: {
        video_id_or_url: {
          type: "string",
          description: "YouTube video ID or full URL",
        },
      },
      required: ["video_id_or_url"],
    },
  },
  {
    name: "fetch_transcript",
    description:
      "Fetch the full transcript of a YouTube video with timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        video_id_or_url: { type: "string" },
        language: {
          type: "string",
          description: "Optional language code (default: video's primary)",
        },
      },
      required: ["video_id_or_url"],
    },
  },
  {
    name: "transcribe_video",
    description:
      "Generate a transcript for a YouTube video that has no captions, using AI ASR. Returns a task ID; poll with get_asr_task.",
    inputSchema: {
      type: "object",
      properties: {
        video_id_or_url: { type: "string" },
      },
      required: ["video_id_or_url"],
    },
  },
  {
    name: "get_asr_task",
    description: "Poll an in-progress AI transcription job by task ID.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "resolve_channel",
    description:
      "Resolve a YouTube channel handle, URL, or ID to canonical channel info.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Channel handle (@name), URL, or ID",
        },
      },
      required: ["identifier"],
    },
  },
  {
    name: "list_channel_videos",
    description: "List videos on a YouTube channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        page_token: { type: "string" },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "get_channel_latest_videos",
    description: "Get the latest videos for a YouTube channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        limit: { type: "integer", description: "Max items (default 10)" },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "search_channel_videos",
    description: "Search videos within a single YouTube channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        query: { type: "string" },
      },
      required: ["channel_id", "query"],
    },
  },
  {
    name: "list_playlist_videos",
    description: "List videos in a YouTube playlist.",
    inputSchema: {
      type: "object",
      properties: {
        playlist_id: { type: "string" },
      },
      required: ["playlist_id"],
    },
  },
  {
    name: "save_to_library",
    description:
      "Save a video summary or transcript to your personal SubDownload knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        video_id_or_url: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["video_id_or_url"],
    },
  },
  {
    name: "list_library",
    description:
      "Browse your saved SubDownload knowledge base. Supports search and tag filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tag: { type: "string" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "get_library_item",
    description: "Fetch a single saved knowledge base item by ID.",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string" },
      },
      required: ["item_id"],
    },
  },
];

async function callUpstream(name, args) {
  if (!API_KEY) {
    throw new Error(
      "SUBDOWNLOAD_API_KEY env var is not set. Get one at https://subdownload.com/account, then run with -e SUBDOWNLOAD_API_KEY=<your-key>."
    );
  }
  const res = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Upstream returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`
    );
  }
  if (body.error) {
    throw new Error(body.error.message || JSON.stringify(body.error));
  }
  return body.result;
}

const server = new Server(
  { name: "subdownload", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await callUpstream(
      request.params.name,
      request.params.arguments || {}
    );
  } catch (err) {
    return {
      content: [{ type: "text", text: err.message || String(err) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
