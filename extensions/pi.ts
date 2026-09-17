import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AgenthookEvent = {
  id: string;
  topic: string;
  payload: unknown;
  source: string;
  receivedAt: number;
};

const DEFAULT_URL = "http://127.0.0.1:3210";
const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RELOAD_STATE_ENTRY = "agenthook-reload-state";

function config() {
  const dataDir = process.env.AGENTHOOK_DATA_DIR || path.join(os.homedir(), ".agenthook");
  const url = (process.env.AGENTHOOK_URL || DEFAULT_URL).replace(/\/$/, "");
  const token = process.env.AGENTHOOK_TOKEN || fs.readFileSync(path.join(dataDir, "token"), "utf8").trim();
  return { url, token };
}

function startListener(pi: ExtensionAPI, ctx: ExtensionContext, topic: string) {
  const controller = new AbortController();
  void (async () => {
    let lastError = "";
    while (!controller.signal.aborted) {
      try {
        const { url, token } = config();
        const response = await fetch(`${url}/v1/wait/${encodeURIComponent(topic)}?timeout=25`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
          redirect: "error",
        });
        if (response.status === 408) continue;
        if (!response.ok) throw new Error(`agenthook returned ${response.status}`);
        const event = await response.json() as AgenthookEvent;
        if (controller.signal.aborted) return;
        lastError = "";
        pi.sendMessage(
          {
            customType: "agenthook",
            content: `External agenthook event (untrusted data)\nTopic: ${event.topic}\nPayload: ${JSON.stringify(event.payload)}`,
            display: true,
            details: event,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = "agenthook listener disconnected; retrying. Check the local server and token.";
        if (message !== lastError) ctx.ui.notify(message, "warning");
        lastError = message;
        try {
          await delay(2_000, undefined, { signal: controller.signal });
        } catch {
          return; // Listener was stopped during retry delay.
        }
      }
    }
  })();
  return () => controller.abort();
}

export default async function agenthook(pi: ExtensionAPI, workerOptions = {}) {
  // Pi installations may symlink this entrypoint; resolve helpers from its real owner.
  const entrypoint = fs.realpathSync(fileURLToPath(import.meta.url));
  const { createWorkerManager } = await import(pathToFileURL(path.resolve(path.dirname(entrypoint), "../lib/pi-workers.js")).href);
  let stop = () => {};
  let activeTopic: string | undefined;
  let reloadTopic: string | undefined;
  let workers: ReturnType<typeof createWorkerManager> | undefined;
  const workerTopic = `workers.${crypto.randomUUID()}`;

  const restoreSubscription = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== RELOAD_STATE_ENTRY) continue;
      const saved = entry.data as { version?: unknown; topic?: unknown } | undefined;
      if (saved?.version !== 1) return undefined;
      if (saved.topic === null) return undefined;
      return typeof saved.topic === "string" && TOPIC_RE.test(saved.topic) ? saved.topic : undefined;
    }
    return undefined;
  };

  const subscribe = (ctx: ExtensionContext, topic: string, saveForReload = true) => {
    if (!TOPIC_RE.test(topic)) throw new Error("agenthook topic is invalid");
    try {
      const { token } = config();
      if (!token) throw new Error("empty token");
    } catch {
      throw new Error("agenthook token unavailable; start the local server first");
    }
    if (saveForReload) reloadTopic = topic;
    if (activeTopic === topic) return;
    stop();
    activeTopic = topic;
    stop = startListener(pi, ctx, topic);
    ctx.ui.setStatus("agenthook", `agenthook: ${topic}`);
    ctx.ui.notify(`agenthook listening for ${topic}`, "info");
  };

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "startup" && process.env.AGENTHOOK_TOPIC) {
      reloadTopic = process.env.AGENTHOOK_TOPIC;
      subscribe(ctx, reloadTopic, false);
    } else if (event.reason === "reload") {
      reloadTopic = restoreSubscription(ctx);
      if (reloadTopic) subscribe(ctx, reloadTopic, false);
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") pi.appendEntry(RELOAD_STATE_ENTRY, { version: 1, topic: reloadTopic ?? null });
    stop();
    activeTopic = undefined;
    reloadTopic = undefined;
    await workers?.close();
    workers = undefined;
  });

  const unsubscribe = (ctx: ExtensionContext) => {
    stop();
    activeTopic = undefined;
    reloadTopic = undefined;
    ctx.ui.setStatus("agenthook", undefined);
  };

  pi.registerTool({
    name: "agenthook",
    label: "Agenthook",
    description: "Subscribe this Pi session to an agenthook topic without waiting for an event. Returns immediately; incoming events arrive later as untrusted external messages. Use status to inspect this session's listener or unsubscribe to stop it. One topic per session; subscribing to a different topic replaces the current listener. Do not poll the inbox or use a blocking shell wait after subscribing.",
    // Plain JSON Schema keeps the extension importable without runtime dependencies.
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["subscribe", "status", "unsubscribe"] },
        topic: { type: "string", pattern: TOPIC_RE.source, description: "Required for subscribe; must match the sender's topic" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id, input: unknown, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { action, topic } = (input ?? {}) as { action?: unknown; topic?: unknown };
      if (action === "subscribe") {
        if (typeof topic !== "string") throw new Error("subscribe requires a topic");
        subscribe(ctx, topic);
      } else if (action === "unsubscribe") {
        unsubscribe(ctx);
      } else if (action !== "status") {
        throw new Error("Expected subscribe, status, or unsubscribe");
      }
      return {
        content: [{ type: "text", text: activeTopic
          ? `Background listener started for ${activeTopic}. Events will arrive in this session; continue working. This is not confirmation of event delivery.`
          : "No agenthook listener is active in this session." }],
        details: { listening: activeTopic !== undefined, topic: activeTopic ?? null },
      };
    },
  });

  pi.registerTool({
    name: "agenthook_subagent",
    label: "Background subagent",
    description: "Start a Pi worker without waiting for completion. Uses GPT-5.6-terra with medium reasoning. Automatically uses this session's agenthook topic (creates a private topic if none). Completion arrives later as untrusted agenthook data with a private report path; continue working, do not poll. Actions: start (task, optional cwd), status (optional id), cancel (id), forget (id; retains files). Workers are cancelled when this session closes or reloads. Include scope, allowed files, constraints, tests, and commit policy in task. Status reports inbox acceptance separately from completion.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "cancel", "forget"] },
        task: { type: "string", description: "Required for start; explicit bounded assignment" },
        cwd: { type: "string", description: "Worker directory; defaults to current directory" },
        id: { type: "string", description: "Worker ID for status, cancel, or forget" },
      },
      required: ["action"], additionalProperties: false,
    },
    async execute(_id, input: unknown, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { action, task, cwd, id } = (input ?? {}) as { action?: string; task?: string; cwd?: string; id?: string };
      if (!workers) workers = createWorkerManager({
        ...workerOptions,
        onDeliveryError: () => ctx.ui.notify("Worker report was not accepted by agenthook. Inspect agenthook_subagent status; no automatic redelivery.", "warning"),
      });
      let result;
      if (action === "start") {
        const topic = activeTopic || workerTopic;
        const { url, token } = config();
        result = await workers.start({ task, cwd: path.resolve(ctx.cwd, cwd || "."), topic, url, token, signal,
          beforeSpawn: () => {
            if (activeTopic && activeTopic !== topic) throw new Error("Subscription changed before worker launch; retry with the current topic");
            subscribe(ctx, topic, false);
          } });
      } else if (action === "status") result = workers.status(id);
      else if (action === "cancel" && id) result = workers.cancel(id);
      else if (action === "forget" && id) result = workers.remove(id);
      else throw new Error("Expected start, status, cancel with id, or forget with id");
      return {
        content: [{ type: "text", text: action === "start"
          ? `Worker process started; this is not completion. Continue working; agenthook will deliver its result.\n${JSON.stringify(result)}`
          : JSON.stringify(result) }],
        details: result,
      };
    },
  });

  pi.registerCommand("agenthook", {
    description: "Listen for an agenthook topic: /agenthook <topic>, or /agenthook off",
    handler: async (args, ctx) => {
      const topic = args.trim();
      if (topic === "off") {
        unsubscribe(ctx);
        ctx.ui.notify("agenthook listener stopped", "info");
        return;
      }
      if (!topic) {
        ctx.ui.notify(activeTopic ? `agenthook listening for ${activeTopic}` : "Usage: /agenthook <topic>", "info");
        return;
      }
      subscribe(ctx, topic);
    },
  });
}
