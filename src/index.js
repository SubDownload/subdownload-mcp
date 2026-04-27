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

const READ_OPEN = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const WRITE_OPEN = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const READ_PRIVATE = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const ASYNC_OPEN = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const TOOLS = [
  {
    name: "search_youtube",
    description:
      "Search YouTube globally for videos matching a keyword query. Returns up to 25 results, each with video ID, title, channel name and ID, duration, view count, publish date, and thumbnail URL. Use this for topic-based discovery when the user has not specified a channel. For searching within a known channel, use search_channel_videos instead.",
    annotations: { title: "Search YouTube videos", ...READ_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search keywords (e.g., 'rust async tutorial', 'lex fridman dario amodei'). Same syntax as YouTube's search bar.",
          minLength: 1,
        },
        limit: {
          type: "integer",
          description: "Maximum number of results to return (default 10, max 25).",
          minimum: 1,
          maximum: 25,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_video_info",
    description:
      "Fetch metadata for a single YouTube video by ID or URL. Returns title, channel, duration in seconds, view count, publish date, thumbnail, description, and whether captions are available. Does NOT include the transcript itself — call fetch_transcript or transcribe_video for that. Cheap and fast; safe to call repeatedly.",
    annotations: { title: "Get YouTube video metadata", ...READ_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        video_id_or_url: {
          type: "string",
          description:
            "YouTube video ID (e.g., 'dQw4w9WgXcQ') or any YouTube URL form (watch URL, youtu.be short link, or shorts URL). Both formats are accepted.",
          minLength: 5,
        },
      },
      required: ["video_id_or_url"],
    },
  },
  {
    name: "fetch_transcript",
    description:
      "Fetch the existing official transcript (closed captions) of a YouTube video, with per-segment timestamps. Returns an array of segments shaped like `{ start, duration, text }` plus the detected language. Errors with `transcript_not_available` if the video has no captions — fall back to transcribe_video in that case to generate one with AI ASR. This call is free and does not consume credits.",
    annotations: { title: "Fetch YouTube transcript (existing captions)", ...READ_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        video_id_or_url: {
          type: "string",
          description: "YouTube video ID or any URL form (watch / youtu.be / shorts).",
          minLength: 5,
        },
        language: {
          type: "string",
          description:
            "Optional ISO 639-1 language code to select among multilingual captions (e.g., 'en', 'zh', 'es', 'ja'). If omitted, the video's primary caption track is returned.",
        },
      },
      required: ["video_id_or_url"],
    },
  },
  {
    name: "transcribe_video",
    description:
      "Start an asynchronous AI ASR job to generate a transcript from a YouTube video's audio. Returns immediately with a `task_id`; the actual transcription typically completes in 10-60 seconds for short videos and a few minutes for long ones. Poll status with get_asr_task. Use this for videos that have no official captions — try fetch_transcript first when captions exist (it's faster and free). Costs 5 credits per video.",
    annotations: { title: "Start AI transcription job", ...ASYNC_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        video_id_or_url: {
          type: "string",
          description: "YouTube video ID or any URL form. Caption-less videos benefit most from this tool.",
          minLength: 5,
        },
      },
      required: ["video_id_or_url"],
    },
  },
  {
    name: "get_asr_task",
    description:
      "Check the status of an async AI transcription task started by transcribe_video. Returns a status string of `queued`, `downloading`, `transcribing`, `finalizing`, `done`, or `failed`. When status is `done`, the response also includes the full transcript with timestamps. Recommended polling interval: 3-5 seconds. Does not consume credits.",
    annotations: { title: "Poll AI transcription status", ...READ_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Task ID returned from a previous transcribe_video call.",
          minLength: 1,
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "resolve_channel",
    description:
      "Look up a YouTube channel from any common identifier (handle like '@mkbhd', vanity URL, full channel URL, or raw channel ID starting with 'UC'). Returns the canonical channel ID, display name, handle, subscriber count, total video count, and avatar URL. Call this first when you only have a handle or URL but need a channel ID for the other channel-scoped tools.",
    annotations: { title: "Resolve YouTube channel identifier", ...READ_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description:
            "Channel identifier in any common form: handle (`@mkbhd`), vanity URL (`youtube.com/@mkbhd`), channel URL (`youtube.com/channel/UC...`), or raw channel ID (`UC...`).",
          minLength: 1,
        },
      },
      required: ["identifier"],
    },
  },
  {
    name: "list_channel_videos",
    description:
      "List videos uploaded by a YouTube channel, ordered by publish date (newest first), with pagination. Returns up to 30 videos per page along with a `next_page_token` if more results exist. For just the most recent handful, prefer get_channel_latest_videos for simplicity.",
    annotations: { title: "List videos on a channel (paginated)", ...READ_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Canonical channel ID starting with 'UC' (use resolve_channel if you only have a handle).",
          pattern: "^UC[A-Za-z0-9_-]+$",
        },
        page_token: {
          type: "string",
          description: "Opaque pagination cursor from a previous response's `next_page_token`. Omit for the first page.",
        },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "get_channel_latest_videos",
    description:
      "Get the N most recent videos from a YouTube channel. Convenience wrapper over list_channel_videos with no pagination — best for 'what did this creator publish recently?' style queries.",
    annotations: { title: "Get channel's latest videos", ...READ_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Canonical channel ID starting with 'UC'.",
          pattern: "^UC[A-Za-z0-9_-]+$",
        },
        limit: {
          type: "integer",
          description: "Max number of recent videos to return (default 10, max 50).",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "search_channel_videos",
    description:
      "Search videos within a single YouTube channel by keyword. Restricts results to the given channel_id. Use after resolve_channel if starting from a handle. Useful for queries like 'find Andrej Karpathy's video about backpropagation'.",
    annotations: { title: "Search videos within a channel", ...READ_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Canonical channel ID starting with 'UC'.",
          pattern: "^UC[A-Za-z0-9_-]+$",
        },
        query: {
          type: "string",
          description: "Search keywords (matched against video title and description within the channel).",
          minLength: 1,
        },
      },
      required: ["channel_id", "query"],
    },
  },
  {
    name: "list_playlist_videos",
    description:
      "List the videos in a YouTube playlist in order. Returns video IDs, titles, durations, channel info, and position within the playlist. Works for any public or unlisted playlist that the playlist URL exposes.",
    annotations: { title: "List videos in a playlist", ...READ_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        playlist_id: {
          type: "string",
          description: "YouTube playlist ID (typically starts with 'PL', 'UU', 'LL', or 'FL').",
          minLength: 2,
        },
      },
      required: ["playlist_id"],
    },
  },
  {
    name: "save_to_library",
    description:
      "Save a video to the authenticated user's personal SubDownload knowledge base for cross-session recall. If a transcript or AI summary already exists for this video, it is saved together; otherwise a stub entry is created and content can be filled in later. Idempotent: saving the same video twice updates the existing entry rather than duplicating. Optional `tags` for organization.",
    annotations: { title: "Save a video to your knowledge base", ...WRITE_OPEN },
    inputSchema: {
      type: "object",
      properties: {
        video_id_or_url: {
          type: "string",
          description: "YouTube video ID or any URL form for the video being saved.",
          minLength: 5,
        },
        tags: {
          type: "array",
          description: "Optional tags for organizing the saved item (e.g., ['ai', 'paper-review']).",
          items: { type: "string", minLength: 1 },
        },
      },
      required: ["video_id_or_url"],
    },
  },
  {
    name: "list_library",
    description:
      "Browse the authenticated user's saved SubDownload knowledge base. Supports free-text search across title and tags, exact tag filter, and pagination. Returns recently saved items first by default. Scoped to the calling user's data only — never exposes other users' libraries.",
    annotations: { title: "Browse your knowledge base", ...READ_PRIVATE },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional free-text search; matched against item title, channel, and tags.",
        },
        tag: {
          type: "string",
          description: "Optional exact-match tag filter (single tag).",
        },
        limit: {
          type: "integer",
          description: "Max items to return (default 20, max 100).",
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
  {
    name: "get_library_item",
    description:
      "Fetch a single saved knowledge base item by its ID, including the full video metadata, AI summary, transcript (if any), and user-applied tags. Use this after list_library returns matching items when you need the complete content rather than just the listing fields.",
    annotations: { title: "Get knowledge base item", ...READ_PRIVATE },
    inputSchema: {
      type: "object",
      properties: {
        item_id: {
          type: "string",
          description: "Library item ID (returned by list_library or save_to_library).",
          minLength: 1,
        },
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
