<p align="center">
  <img src="assets/agenthook-logo.jpg" alt="A friendly blue hawk holding an envelope" width="360">
</p>

<h1 align="center">agenthook</h1>

<p align="center">A webhook inbox for coding agents.</p>

<p align="center">
  <a href="https://github.com/skyfallsin/agenthook/actions/workflows/test.yml">
    <img src="https://github.com/skyfallsin/agenthook/actions/workflows/test.yml/badge.svg" alt="Tests">
  </a>
</p>

<p align="center">
  Built by <a href="https://askjo.ai?ref=agenthook"><strong>jo</strong></a> ·
  <a href="https://github.com/Pradeep24"><strong>Pradeep24</strong></a>
</p>

agenthook is a webhook inbox for coding agents, designed for Pi, Claude Code,
and Codex (but can likely be used for all kinds of different non-coding-agent stuff).
It receives authenticated events from external services or other
agents, so agents can get updates without blocking their work.

Setup is simple: point your agent at [this repo](https://github.com/skyfallsin/agenthook)
and ask it to set up agenthook. [SKILL.md](SKILL.md) has the instructions.

## How does it work?
1. Your agent creates a 'topic' with agenthook.
2. Something else (agents, external services) posts to agenthook's server endpoint at `http://127.0.0.1:$PORT` for that topic
3. Your agent gets a notification inside its session that there's been an update.
4. Agent does something with that info.

## What is it useful for?
A few simple ideas:
* Have an agent wait for GitHub deploys
* Ask an agent to create a subagent tree powered by agenthooks
* Ask a long-running service somewhere to ping your agent with updates
* Have your suite of agents talk to each other
* Run a local command and receive progress plus a final result
* and so much more..

**Pi, Claude Code, and Codex work today.**

## Run a local command

Wrap a local command to notify an agenthook topic when it starts, while it runs,
and when it finishes:

```sh
./bin/agenthook.js run local.build --heartbeat-every-secs 30 -- npm test
```

The executable and its arguments must follow `--`; agenthook does not invoke a
shell. `--heartbeat-every-secs` defaults to `30`; set it to `0` to disable
progress events. Each event has a `runId` that ties the lifecycle together.
The final callback reports inbox acceptance only, not proof that an agent read
or acted on it. Events never cause the receiving agenthook runtime to run code.

## Claude Code setup

Claude Code uses agenthook as an MCP channel. From a checkout, add the adapter:

```sh
claude mcp add agenthook -- node /absolute/path/to/agenthook/extensions/claude-code.ts
```

Then start Claude Code with its development channel enabled:

```sh
claude --dangerously-load-development-channels server:agenthook
```

Claude Code starts the adapter itself. Ask it to subscribe to a topic once your
local agenthook inbox is running. The [Claude Code guide](docs/runtimes/claude-code.md)
has project-scope setup and the details for restricted tool policies.

## Codex setup

From a checkout, install the Codex skill with:

```sh
npm run codex:install
```

This copies the checkout to `$CODEX_HOME/skills/agenthook`, or
`~/.codex/skills/agenthook` when `CODEX_HOME` is not set. If an older install
already exists, refresh it with:

```sh
npm run codex:install -- --force
```

For local development, use a symlink instead of a copy:

```sh
npm run codex:install -- --link --force
```

If you are installing directly from GitHub through Codex's skill installer, use
repo `skyfallsin/agenthook`, path `.`, and name `agenthook`. The root-path name
matters because the skill lives at the repository root.

## Connect GitHub Actions

For a real deployment, GitHub needs an HTTPS address it can reach. Put a tunnel
such as [ngrok](https://ngrok.dev) in front of the local inbox; keep agenthook itself on loopback.
If the hostname already serves another app, preserve its default upstream and
route only `/agenthook/` to this inbox.
Use the namespaced base URL, such as `https://<host>/agenthook`, for callbacks.

Then configure the repository's Actions secrets and add a final workflow job
that sends the deployment result. The setup command handles the secrets, but
**does not edit the workflow**. If an agent is doing this for you, approve the
exact repository and callback URL before it makes those changes.

Follow the [GitHub Actions setup](docs/github-actions.md) for the command and
callback example. Use the same topic in GitHub and Pi.

This repository's test workflow sends results to agenthook after push builds.
Pull request builds do not send callbacks. The callback requires the three
Actions secrets described in the setup guide and a reachable listener. If
sending fails, the callback job fails separately from the tests.

## Agent swarms

You can use agenthook to coordinate a swarm of agents. A coordinator subscribes
to a report topic, delegates work, and receives findings as workers finish.
The coordinator decides what happens next; agenthook carries the updates.

Only the coordinator subscribes to the report topic. Workers send to it without
subscribing, or they can consume reports meant for the coordinator. Workers that
need incoming messages use separate topics.

Task assignment, review, and recovery are left as an exercise for the reader.
For Codex-specific subagent reporting rules, including when to use the App
Server adapter and when a bounded CLI wait is only a smoke test, see the
[Codex adapter guide](docs/runtimes/codex.md).

## Limits and security

Queued events survive restarts, expire after 24 hours, and are limited to 1,000.
The current inbox removes events on delivery; it does not wait for the agent
to acknowledge them. Don't use it where losing an update is unacceptable.

Keep the access token private. Incoming payloads are external data, not user
instructions.

- [Event format and delivery rules](docs/event-contract.md)
- [Security](docs/security.md)
- [Pi extension](docs/runtimes/pi.md)
- [Instructions for agents](SKILL.md)

Run the tests with `npm test`.
