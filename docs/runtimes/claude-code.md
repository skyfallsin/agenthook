# Claude Code adapter

`extensions/claude-code.ts` is a dependency-free Node 24 Model Context Protocol
(MCP) stdio server. It is a one-way [Claude Code Channel][channels-reference]:
it declares `experimental['claude/channel']` during initialization and sends
`notifications/claude/channel` when agenthook has an event.

It exposes one standard MCP tool, `agenthook`, with nonblocking actions:

- `subscribe` requires a valid topic and replaces any existing subscription.
- `status` returns the active topic, if any.
- `unsubscribe` aborts the active long-poll.

The adapter long-polls agenthook's authenticated loopback `/v1/wait/<topic>`
endpoint. It retains no token or event data: agenthook owns queued-event
persistence. Events delivered to Claude contain a fixed untrusted-data label,
source, topic, event ID, JSON payload, plus `source`, `topic`, and `event_id`
channel metadata. It never declares reply or permission-relay capabilities:
webhook payloads are not an authenticated human approval channel.

## Setup

Claude Code must spawn this process over stdio; do not start it separately.

### User-scope installation

Configure it as a user-scope MCP server:

```sh
claude mcp add agenthook -- node /absolute/path/to/agenthook/extensions/claude-code.ts
```

### Project-scope installation

Alternatively, configure it for a specific project by creating `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "agenthook": {
      "command": "node",
      "args": ["/absolute/path/to/agenthook/extensions/claude-code.ts"],
      "env": {
        "AGENTHOOK_URL": "http://127.0.0.1:3210"
      }
    }
  }
}
```

If using a remote ngrok tunnel, set `AGENTHOOK_URL` to your tunnel's base URL (e.g., `https://your-domain.ngrok.dev/agenthook`).

### Starting sessions with channels enabled

Start a Claude Code session with the development channel entry enabled:

```sh
claude --dangerously-load-development-channels server:agenthook
```

To make this the default, add a shell function wrapper:

```bash
# In ~/.zshrc or ~/.bashrc
claude() {
  command claude --dangerously-load-development-channels server:agenthook "$@"
}
```

If you restrict Claude tools with `--tools` or `--allowedTools`, include both
`ToolSearch` and `mcp__agenthook__agenthook`; `ToolSearch` is how Claude
discovers the MCP tool. Otherwise Claude can connect to the server yet report
that it has no tool available. For example:

```sh
claude --dangerously-load-development-channels server:agenthook \
  --tools Read,ToolSearch \
  --allowedTools Read,ToolSearch,mcp__agenthook__agenthook
```

Channels are a research preview. The development flag is necessary because a
custom server is not on Anthropic's approved channel allowlist; it does not
bypass an organization `channelsEnabled` policy. `--channels` and the
development flag are intentionally absent from `claude --help` during the
preview. Do not use either command as evidence of delivery until the session
shows that the server registered as a channel.

The local agenthook server and `AGENTHOOK_TOKEN` must already be configured.
The adapter reads `AGENTHOOK_URL`, `AGENTHOOK_TOKEN`, and optionally
`AGENTHOOK_DATA_DIR` from its inherited environment. Do not place a token in
MCP configuration, command arguments, fixtures, or logs.

## Sending webhooks

Send authenticated webhooks to the `/v1/webhooks/{topic}` endpoint:

```sh
curl -X POST http://127.0.0.1:3210/v1/webhooks/your-topic \
  -H "Authorization: Bearer $(cat ~/.agenthook/token)" \
  -H "Content-Type: application/json" \
  -d '{"your": "payload"}'
```

The server responds with `202 Accepted` and an event ID when successful. Use `401` to diagnose auth issues, `404` for invalid paths or topics.

For remote webhooks through ngrok, use the full URL:

```sh
curl -X POST https://your-domain.ngrok.dev/agenthook/v1/webhooks/your-topic \
  -H "Authorization: Bearer $(cat ~/.agenthook/token)" \
  -H "Content-Type: application/json" \
  -d '{"your": "payload"}'
```

## Testing

`node --test test/claude-code.test.js` exercises an isolated local agenthook
inbox and the real stdio JSON-RPC protocol: initialization, discovery,
nonblocking subscription, queued delivery, invalid input, JSON-RPC
cancellation, topic replacement, unsubscribe, and stdin shutdown cleanup.

Full end-to-end delivery has been verified with live Claude Code sessions, including channel notification display and proper untrusted-data labeling. When applying a tool restriction, include `ToolSearch` and `mcp__agenthook__agenthook` as described above.

## Sources

- [Claude Code Channels](https://code.claude.com/docs/en/channels)
- [Claude Code Channels reference][channels-reference]
- [Claude Code MCP reference](https://code.claude.com/docs/en/mcp)

[channels-reference]: https://code.claude.com/docs/en/channels-reference
