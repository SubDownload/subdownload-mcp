# SubDownload MCP Server

SubDownload exposes YouTube as an MCP-native data source. Connect once via OAuth and your AI agent gets tools to summarize videos, fetch full transcripts (including videos without captions, via AI ASR), search channels and playlists, and save everything into a per-user knowledge base for cross-session recall.

- **Hosted endpoint**: `https://api.subdownload.com/mcp`
- **Homepage**: https://subdownload.com?utm_source=gthb_awesome_9jqqed&utm_medium=code&utm_campaign=Awesome
- **Docs**: https://api.subdownload.com/docs/mcp
- **Glama (connector)**: https://glama.ai/mcp/connectors/com.subdownload.api/sub-download
- **Glama (server)**: https://glama.ai/mcp/servers/SubDownload/subdownload-mcp

> The recommended setup is to point your MCP client directly at the hosted endpoint above and authenticate via OAuth — see "Quick connect" below. This repo also ships a thin stdio proxy (Node + Docker) for environments that prefer a local subprocess.

## Auth

OAuth 2.1 with Dynamic Client Registration (RFC 7591). No pre-shared `client_id` or `client_secret` — your MCP client registers itself on first connect.

Discovery (RFC 9728):

1. POST to `/mcp` without a token returns `401` plus a `WWW-Authenticate` header pointing to `/.well-known/oauth-protected-resource`
2. That document points to the authorization server (`https://api.subdownload.com`)
3. The MCP client follows the standard authorize → callback → token flow with PKCE

**API-key alternative**: every account at https://subdownload.com/account exposes a Bearer token for clients that don't support OAuth.

## Tools

| Tool | What it does |
|---|---|
| `search_youtube` | Keyword search across YouTube |
| `fetch_video_info` | Video metadata (title, channel, duration, view count) |
| `fetch_transcript` | Full transcript with timestamps |
| `transcribe_video` | Generate a transcript with AI ASR for videos that have no captions |
| `get_asr_task` | Poll an in-progress AI transcription job |
| `resolve_channel` | Look up a channel by handle, URL, or ID |
| `list_channel_videos` | List videos on a channel |
| `get_channel_latest_videos` | Latest videos for a channel |
| `search_channel_videos` | Search within a single channel |
| `list_playlist_videos` | List the contents of a playlist |
| `save_to_library` | Save a video summary or transcript to your personal knowledge base |
| `list_library` | Browse your saved knowledge base |
| `get_library_item` | Fetch a single saved item |

## Quick connect

### Claude Desktop / Cursor / Windsurf / any OAuth-capable MCP client

```json
{
  "mcpServers": {
    "subdownload": {
      "url": "https://api.subdownload.com/mcp"
    }
  }
}
```

The first time you use it, the client triggers OAuth and you sign in with Google or LINUX DO. Free credits on signup — no card required.

### Bearer-token clients

```json
{
  "mcpServers": {
    "subdownload": {
      "url": "https://api.subdownload.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Grab your API key from your [account page](https://subdownload.com/account).

### Local stdio proxy (Docker / npm)

For clients that prefer a subprocess transport, this repo ships a thin Node proxy that forwards `tools/call` to the hosted endpoint with your API key.

```bash
# Docker
docker build -t subdownload-mcp .
docker run --rm -i -e SUBDOWNLOAD_API_KEY=YOUR_API_KEY subdownload-mcp

# Or via Node directly
npm install
SUBDOWNLOAD_API_KEY=YOUR_API_KEY npm start
```

Client config example:

```json
{
  "mcpServers": {
    "subdownload": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "SUBDOWNLOAD_API_KEY", "subdownload-mcp"],
      "env": { "SUBDOWNLOAD_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

Tool schemas are declared inline so introspection (`initialize`, `tools/list`) works without credentials; `tools/call` requires `SUBDOWNLOAD_API_KEY`.

## Pricing

Free credits on signup. Pro: 5,000 credits per month. See https://subdownload.com/pricing.

## Support

- Email: contact@subdownload.com
- Status: https://subdownload.com/status

## License

MIT (applies to this documentation repository; the SubDownload service itself is hosted SaaS — see https://subdownload.com/terms).
