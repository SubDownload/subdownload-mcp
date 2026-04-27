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
 * Schemas mirror the upstream tool definitions exactly (parameter names,
 * required fields, types) so calls round-trip without parameter remapping.
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

// Annotation hints mirror the per-tool justifications in the upstream
// manager (internal/handler/mcp.go). YouTube-facing reads are NOT idempotent
// because YouTube returns different results over time (view counts change,
// search results re-rank, channel metadata updates, etc.). Library reads
// are NOT openWorld because they only touch our database.
const ANN = {
  // YouTube read paths — public data changes over time
  YT_READ: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  // ASR job creation — coalesces on (video, lang) within cache TTL
  ASR_START: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  // ASR poll — hits our backend only, status changes over time
  ASR_POLL: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // Library read — user's private data, mutates as user saves/edits
  LIB_READ: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // Library write — overwrites latest summary on same (video, locale),
  // intended "latest-only" UX, not destructive
  LIB_WRITE: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const TOOLS = [
  {
    name: "search_youtube",
    description:
      "Search YouTube globally for videos, channels, or playlists on any topic. Returns up to 50 results with metadata. Use this for topic-based discovery when the user has not specified a channel — for searching within a known channel use search_channel_videos instead.",
    annotations: { title: "Search YouTube", ...ANN.YT_READ },
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description:
            "Search query (same syntax as YouTube's search bar, e.g. 'rust async tutorial', 'lex fridman dario amodei').",
          minLength: 1,
        },
        type: {
          type: "string",
          description:
            "Search type: 'video', 'channel', or 'playlist'. Default: 'video'.",
          enum: ["video", "channel", "playlist"],
        },
        limit: {
          type: "number",
          description: "Max results (1-50, default 20).",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["q"],
    },
  },
  {
    name: "fetch_video_info",
    description:
      "Fetch consolidated YouTube video metadata with numeric types — title, channel, duration, view count, publish date, thumbnail, description, captions availability. Does NOT include the transcript itself; call fetch_transcript or transcribe_video for that. Cheap, fast, free.",
    annotations: { title: "Fetch YouTube Video Info", ...ANN.YT_READ },
    inputSchema: {
      type: "object",
      properties: {
        video_id: {
          type: "string",
          description:
            "11-char YouTube video ID (e.g. 'dQw4w9WgXcQ') or full URL (watch, youtu.be, shorts, embed, live).",
          minLength: 5,
        },
      },
      required: ["video_id"],
    },
  },
  {
    name: "fetch_transcript",
    description:
      "Fetch the existing official transcript (subtitles/captions) of a YouTube video, with per-segment timestamps and language detected. Errors with NO_CAPTIONS if the video has no captions — fall back to transcribe_video in that case to generate one with AI ASR. This call is free.",
    annotations: { title: "Fetch YouTube Video Transcript", ...ANN.YT_READ },
    inputSchema: {
      type: "object",
      properties: {
        video_id: {
          type: "string",
          description: "YouTube video ID (e.g. 'dQw4w9WgXcQ') or full YouTube URL.",
          minLength: 5,
        },
        lang: {
          type: "string",
          description:
            "ISO 639-1 language code to select among multilingual captions (e.g. 'en', 'zh', 'ja'). Omit for the video's default language.",
        },
        save: {
          type: "boolean",
          description:
            "When true, also save the video to the user's Library in the same call. Bookmarks the meta row and flips has_asr when the transcript was produced by our ASR. Does NOT upload a summary — use save_to_library with kind='summary' or kind='both' for that.",
        },
      },
      required: ["video_id"],
    },
  },
  {
    name: "transcribe_video",
    description:
      "Start an asynchronous AI ASR (Whisper) transcription of a YouTube video. Returns immediately with a task_id and estimated_wait_seconds; the actual transcription runs in the background. Poll status with get_asr_task. Use this when fetch_transcript returned NO_CAPTIONS or when the video has no captions. Costs 5 credits, debited only on successful completion.",
    annotations: { title: "Transcribe YouTube Video (Async)", ...ANN.ASR_START },
    inputSchema: {
      type: "object",
      properties: {
        video_url: {
          type: "string",
          description:
            "YouTube URL (watch, youtu.be, shorts, or embed form). Full URL preferred.",
          minLength: 5,
        },
        lang: {
          type: "string",
          description:
            "Optional language hint (ISO 639-1, e.g. 'en', 'zh'). Omit to auto-detect.",
        },
      },
      required: ["video_url"],
    },
  },
  {
    name: "get_asr_task",
    description:
      "Poll the status of an ASR task created by transcribe_video. Returns one of `queued`, `downloading`, `transcribing`, `finalizing`, `done`, or `failed`. When status is `done`, includes the full transcript with timestamps. Recommended polling interval: 3-5 seconds. Free — does not consume credits.",
    annotations: { title: "Get ASR Task Status", ...ANN.ASR_POLL },
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Task ID returned by transcribe_video.",
          minLength: 1,
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "resolve_channel",
    description:
      "Resolve a YouTube @handle, channel URL, video URL, or raw channel ID into canonical channel info (channel ID, name, handle, subscriber count, video count, avatar). Call this first when you only have a handle or URL but need a channel ID for the other channel-scoped tools.",
    annotations: { title: "Resolve YouTube Channel", ...ANN.YT_READ },
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description:
            "@handle (e.g. '@MrBeast'), channel URL, video URL, or UC... channel ID. All common forms are accepted.",
          minLength: 1,
        },
      },
      required: ["input"],
    },
  },
  {
    name: "list_channel_videos",
    description:
      "List all videos from a YouTube channel ordered by publish date (newest first), with pagination. Returns up to 30 per page plus a `continuation` token if more results exist. For just the most recent handful, prefer get_channel_latest_videos for simplicity.",
    annotations: { title: "List Channel Videos", ...ANN.YT_READ },
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description:
            "@handle, channel URL, or UC... channel ID. Required for the first page; omit on subsequent pages and pass `continuation` instead.",
        },
        continuation: {
          type: "string",
          description:
            "Pagination token from a previous response's `continuation` field. Omit for the first page.",
        },
      },
    },
  },
  {
    name: "get_channel_latest_videos",
    description:
      "Get the most recent videos from a YouTube channel — convenience wrapper over list_channel_videos with no pagination. Best for 'what did this creator publish recently?' style queries.",
    annotations: { title: "Get Channel Latest Videos", ...ANN.YT_READ },
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "@handle (e.g. '@mkbhd'), channel URL, or UC... channel ID.",
          minLength: 1,
        },
      },
      required: ["channel"],
    },
  },
  {
    name: "search_channel_videos",
    description:
      "Search for specific videos within a single YouTube channel. Restricts results to the given channel. Use after resolve_channel if starting from a handle. Useful for 'find Karpathy's video about backpropagation' style queries.",
    annotations: { title: "Search Channel Videos", ...ANN.YT_READ },
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "@handle, channel URL, or UC... channel ID.",
          minLength: 1,
        },
        q: {
          type: "string",
          description: "Search query (matched against video title and description within the channel).",
          minLength: 1,
        },
        limit: {
          type: "number",
          description: "Max results (1-50, default 30).",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["channel", "q"],
    },
  },
  {
    name: "list_playlist_videos",
    description:
      "List videos in a YouTube playlist in order, with pagination. Returns video metadata and position within the playlist. Works for any public or unlisted playlist exposed by its URL/ID.",
    annotations: { title: "List Playlist Videos", ...ANN.YT_READ },
    inputSchema: {
      type: "object",
      properties: {
        playlist: {
          type: "string",
          description:
            "Playlist URL or ID (typically starts with 'PL', 'UU', 'LL', or 'FL'). Required for the first page.",
        },
        continuation: {
          type: "string",
          description: "Pagination token from a previous response's `continuation` field. Omit for the first page.",
        },
      },
    },
  },
  {
    name: "save_to_library",
    description:
      "Save a video to the authenticated user's Library. Three modes via `kind`: 'asr' bookmarks the video and flips has_asr (use after a successful transcribe_video → fetch_transcript flow); 'summary' uploads a summary blob; 'both' does both at once. Idempotent: saving the same video twice updates the existing entry.",
    annotations: { title: "Save to Library", ...ANN.LIB_WRITE },
    inputSchema: {
      type: "object",
      properties: {
        video_id: {
          type: "string",
          description: "YouTube video ID (11 chars).",
          minLength: 5,
        },
        kind: {
          type: "string",
          description:
            "'asr' (bookmark + flip has_asr), 'summary' (upload summary text), or 'both'.",
          enum: ["asr", "summary", "both"],
        },
        title: {
          type: "string",
          description: "Video title (for display in the user's Library list).",
        },
        author: {
          type: "string",
          description: "Channel / author name.",
        },
        thumbnail: {
          type: "string",
          description: "Thumbnail URL.",
        },
        video_url: {
          type: "string",
          description: "Full YouTube URL.",
        },
        language: {
          type: "string",
          description: "Video language code (ISO 639-1).",
        },
        text: {
          type: "string",
          description:
            "Summary text. REQUIRED when kind='summary' or kind='both'. Plain text or markdown — use the `format` param to declare which.",
        },
        locale: {
          type: "string",
          description:
            "Summary locale (e.g. 'en', 'zh'). Used with kind='summary' or kind='both'.",
        },
        format: {
          type: "string",
          description:
            "Summary format: 'markdown' (default) or 'text'. Use 'markdown' if your text contains **bold**, bullets, headings, or code fences so the web UI renders it; use 'text' for plain prose.",
          enum: ["markdown", "text"],
        },
        model: {
          type: "string",
          description: "Optional model identifier, e.g. 'claude-opus-4'.",
        },
      },
      required: ["video_id", "kind"],
    },
  },
  {
    name: "list_library",
    description:
      "List videos the user has saved to their Library (transcripts + summaries). Supports substring search on title/author, favorites filter, and pagination. Returns recently saved items first. Scoped to the calling user's data only.",
    annotations: { title: "List Saved Library", ...ANN.LIB_READ },
    inputSchema: {
      type: "object",
      properties: {
        favorite: {
          type: "boolean",
          description: "When true, return only items the user has favorited.",
        },
        q: {
          type: "string",
          description: "Substring match on title and author.",
        },
        limit: {
          type: "number",
          description: "Max items per page (1-100, default 20).",
          minimum: 1,
          maximum: 100,
        },
        offset: {
          type: "number",
          description: "Pagination offset (number of items to skip).",
          minimum: 0,
        },
      },
    },
  },
  {
    name: "get_library_item",
    description:
      "Read a saved Library item with its transcript and AI summary inline (when available). Use after list_library to fetch the full content the user saved. Free.",
    annotations: { title: "Get Library Item", ...ANN.LIB_READ },
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Library item id (returned by list_library or save_to_library).",
        },
        locale: {
          type: "string",
          description: "Summary locale to fetch (e.g. 'en', 'zh'). Defaults to 'en'.",
        },
      },
      required: ["id"],
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
