# agenthook — thread draft

Agents running locally do odd cli things to get status updates. Like polling github actions runs, for example. 

The ideal state is it triggers something that needs a status update and goes off to do the next thing while it waits (or at the least doesn’t burn tokens)

There are two problems here: 

1. Agents are running locally, so something online needs to reach your local machine.

2. Once they’re reached, something local has to route the message to the right agent.

1 is solved using tailscale or ngrok and setting up urls like pradeep.ngrok.dev

2 is a bit trickier. an agent has to register itself as waiting for a status update, and then unregister itself after it gets one.

---

The thing I've been testing is a little webhook inbox that runs on your machine. The agent subscribes to a topic and goes off to do other work. When the deploy finishes, GitHub pings the inbox and the result shows up in the agent's session as a message.

So far that's felt nicer than a polling loop.

---

Here's roughly how it flows from GitHub Actions to the agent on my laptop.

A CI job POSTs the result to an ngrok tunnel with a bearer token. The tunnel forwards /agenthook to the inbox, which only listens on loopback. The inbox checks the token and queues the event. The agent already has an open long-poll on that topic, so it comes back with the result.

One authenticated path in, nothing else exposed. That's the intent anyway, it's early.

---

One choice I keep going back and forth on. Right now it's a queue, not a broadcast, so each event goes to one listener.

Felt limiting at first, but it means a few workers can share a topic and split the work instead of all reacting to the same event. Not sure it's the right call yet.

---

I've been trying it across Pi, Claude Code, and Codex. Same inbox each time, only the last hop in differs.

Pi has a native extension that holds the long-poll and drops events in as messages. Claude Code runs a little MCP server as a subprocess and gets events over channel notifications. Codex uses an App Server adapter that lands the event as tool output.

Each one treats the payload as untrusted data.

---

Still rough and pretty early, but it's been fun to actually use. If you want to poke at it, it's here.

github.com/skyfallsin/agenthook
