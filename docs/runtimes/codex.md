# Codex adapter

**Status: working. Source-labeled event delivery was verified in a bounded local
Codex App Server session using synthetic data.**

Agenthook has a dependency-free Node 24 adapter in
[`extensions/codex.ts`](../../extensions/codex.ts). It connects only to an
already-running loopback Codex App Server. It never starts Codex, modifies
Codex configuration, attaches to a terminal, or reads an agenthook event before
validating the designated receiver.

## Install the Codex skill

From an agenthook checkout:

```sh
npm run codex:install
```

The installer copies the checkout to `$CODEX_HOME/skills/agenthook`, or
`~/.codex/skills/agenthook` when `CODEX_HOME` is not set. It refuses to replace
an existing install unless `--force` is supplied:

```sh
npm run codex:install -- --force
```

Use `--link` for local development when you want Codex to read this checkout
directly:

```sh
npm run codex:install -- --link --force
```

When installing from GitHub through Codex's skill installer, choose repository
`skyfallsin/agenthook`, path `.`, and installed name `agenthook`. A new Codex
turn may be required before the skill appears in the available skills list.

## Explicit ownership and transport

A host must supply all three values; there are no discovery defaults:

- `CODEX_APP_SERVER_URL` — `ws://` or `wss://` endpoint whose host is exactly
  `127.0.0.1`, `::1`, or `localhost`.
- `AGENTHOOK_CODEX_TOPIC` — the one sender-assigned agenthook topic.
- `AGENTHOOK_CODEX_THREAD_ID` — the one intended, App-Server-loaded thread.

The adapter performs the documented JSON-RPC handshake (`initialize`, then
`initialized`), calls `thread/loaded/list`, and calls `thread/read` for that
exact thread. Only `active` (busy) and `idle` statuses pass receiver validation.
A missing, unloaded, closed, or disconnected receiver rejects and leaves the
inbox untouched. Connection and request cancellation also reject rather than
falling back to another thread.

This is deliberately a one-topic/one-thread ownership mapping. It does not
scan or select a recent thread. The documented WebSocket transport is
experimental; use loopback only. Codex documents Unix sockets too, but Node's
built-in WebSocket client does not support Unix-socket WebSocket connections,
so this no-dependency adapter does not claim that transport.

## Provenance-preserving delivery

Codex 0.154.0 documents `turn/start.toolOutput` as a named tool output and
persists it as a `functionCallOutput` item. After receiver validation, the
adapter reads exactly one matched agenthook event and starts a turn with:

```json
{
  "input": [],
  "toolOutput": {
    "namespace": "agenthook",
    "name": "external_event",
    "output": "External agenthook event (untrusted data)\n..."
  }
}
```

The fixed envelope labels the external source, topic, event ID, and payload as
untrusted data. The adapter never calls `thread/inject_items`, `turn/steer`, or
supplies user or assistant content. An accepted event is therefore retained by
Codex as a named tool result rather than represented as a human or model
message. It does not use terminal keystrokes or edit transcripts.

The tool-output start request is an App Server turn and may cause Codex to
produce its ordinary reasoning or agent response. Treat that response as model
output, not as authenticated event data. The event itself remains identifiable
as `agenthook.external_event` in the thread item history.

## Codex App operating notes

Codex has its own task and subagent notification mechanisms. Use those native
signals when they are enough. Use agenthook when a Codex task must receive the
same authenticated webhook events as external systems, or when subagents should
exercise the webhook path that deployments and other services will use.

For a subagent report topic, the coordinator owns the topic. The coordinator is
the only participant that subscribes, runs the Codex adapter, or performs a
bounded terminal wait. Worker subagents only send to the topic. They must not
subscribe, wait, inspect `events.json`, or reuse the report topic for their own
inbound messages.

When the live Codex adapter is available, configure the App Server endpoint,
topic, and intended thread ID explicitly, then start the adapter before
triggering external work. If no `agenthook` tool or Codex App Server adapter is
available in the current runtime, do not describe the setup as live delivery.
For a user-requested smoke test, it is acceptable to run a bounded CLI wait for
the exact number of expected events, as long as the result is labeled as a
blocking test path rather than the non-blocking adapter path.

Subagents should read the token from `AGENTHOOK_TOKEN` or the local token file,
send a compact JSON payload, and report only non-secret response metadata such
as HTTP status and accepted event ID. The coordinator verifies delivery by
matching that accepted ID to the delivered event ID, then closes completed
subagents if the host runtime keeps them open.

## Verified local session

With Codex CLI 0.154.0 and a temporary loopback App Server, a synthetic
agenthook event was delivered to a newly created read-only thread. After the
turn settled, Codex's `thread/turns/list` reported a completed turn containing:

- `functionCallOutput` with `namespace: "agenthook"` and
  `name: "external_event"`;
- no `user` or `assistant` message item for the event.

The demo used synthetic data only. The temporary App Server can be stopped
after review.

## Official evidence

- [Codex App Server documentation](https://developers.openai.com/codex/app-server.md):
  JSON-RPC handshake, loopback WebSocket guidance, `thread/loaded/list`,
  `thread/read`, runtime statuses, and `turn/start.toolOutput`.
- [OpenAI Codex App Server source](https://github.com/openai/codex/tree/main/codex-rs/app-server):
  implementation linked by the official documentation.

The adapter has isolated protocol tests for busy and idle receiver states,
source-labeled tool-output delivery, unloaded/disconnected/cancelled errors,
explicit loopback configuration, and real local agenthook inbox consumption.
The bounded live demo verifies the actual Codex persisted item type.
