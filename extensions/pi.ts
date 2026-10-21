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

function eventState(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const event = payload as { stage?: unknown; status?: unknown; state?: unknown };
  if (typeof event.stage === "string") return event.stage;
  if (typeof event.status === "string") return event.status;
  return typeof event.state === "string" ? event.state : undefined;
}

const TERMINAL_STATES = new Set(["completed", "success", "failed", "error", "cancelled"]);
function isTerminalEvent(payload: unknown) {
  const state = eventState(payload);
  return typeof state === "string" && TERMINAL_STATES.has(state);
}

function eventTitle(payload: unknown) {
  if (!payload || typeof payload !== "object") return "External event";
  const command = payload as { kind?: unknown; stage?: unknown; elapsedSeconds?: unknown; progressSequence?: unknown; exitCode?: unknown; label?: unknown };
  const labelPrefix = typeof command.label === "string" && command.label ? `${command.label} · ` : "";
  if (command.kind !== "command" || typeof command.stage !== "string") {
    const state = eventState(payload);
    const elapsed = typeof command.elapsedSeconds === "number" ? ` · ${command.elapsedSeconds}s` : "";
    const heartbeat = typeof command.progressSequence === "number" ? ` · heartbeat ${command.progressSequence}` : "";
    return state ? `${labelPrefix}${state}${elapsed}${heartbeat}` : (labelPrefix ? `${command.label}` : "External event");
  }
  const elapsed = typeof command.elapsedSeconds === "number" ? ` · ${command.elapsedSeconds}s` : "";
  if (command.stage === "started") return `${labelPrefix}Started`;
  if (command.stage === "progress") return `${labelPrefix}Running${elapsed}${typeof command.progressSequence === "number" ? ` · heartbeat ${command.progressSequence}` : ""}`;
  if (command.stage === "completed") return `${labelPrefix}Completed${typeof command.exitCode === "number" ? ` · exit ${command.exitCode}` : ""}${elapsed}`;
  if (command.stage === "failed") return `${labelPrefix}Failed${typeof command.exitCode === "number" ? ` · exit ${command.exitCode}` : ""}${elapsed}`;
  if (command.stage === "cancelled") return `${labelPrefix}Cancelled${elapsed}`;
  return `${labelPrefix}Update`;
}

function eventColor(payload: unknown) {
  if (!payload || typeof payload !== "object") return "accent";
  const state = eventState(payload);
  if (state === "completed" || state === "success") return "success";
  if (state === "failed" || state === "error") return "error";
  if (state === "cancelled") return "warning";
  if (state === "progress") return "accent";
  return "warning";
}

function formatPayload(payload: unknown) {
  try { return JSON.stringify(payload, null, 2); } catch { return "[payload could not be displayed]"; }
}

function truncate(text: string, width: number) {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

function eventCard(title: string, topic: string, payload: unknown, expanded: boolean, outputPad: number, theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string; bold: (text: string) => string }) {
  return {
    render(width: number) {
      const prefix = " ".repeat(Math.min(outputPad, width));
      const contentWidth = Math.max(width - prefix.length, 1);
      const rawLines: Array<[string, (value: string) => string]> = [
        [`agenthook · ${topic}  ◆ ${title}`, (value) => theme.fg(eventColor(payload), theme.bold(value))],
      ];
      if (expanded) rawLines.push(...formatPayload(payload).split("\n").map((value) => [`  ${value}`, (item: string) => theme.fg("dim", item)]));
      const cardWidth = Math.min(contentWidth, Math.max(...rawLines.map(([text]) => text.length)) + 2);
      return rawLines.map(([text, style]) => prefix + theme.bg("customMessageBg", style(truncate(text, cardWidth).padEnd(cardWidth))));
    },
    invalidate() {},
  };
}

function startListener(pi: ExtensionAPI, ctx: ExtensionContext, topic: string, options: { stopOnTerminal?: boolean; onTerminal?: () => void } = {}) {
  const { stopOnTerminal = false, onTerminal } = options;
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
        if (stopOnTerminal && isTerminalEvent(event.payload)) {
          controller.abort();
          onTerminal?.();
          return;
        }
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
  const workerLibUrl = pathToFileURL(path.resolve(path.dirname(entrypoint), "../lib/pi-workers.js"));
  // Cache-bust so /reload re-imports the lib instead of serving the module cached at session start.
  workerLibUrl.searchParams.set("v", String(fs.statSync(fileURLToPath(workerLibUrl)).mtimeMs));
  const { createWorkerManager } = await import(workerLibUrl.href);
  let stop = () => {};
  let activeTopic: string | undefined;
  let activeMode: "terminal" | "stream" | undefined;
  let reloadTopic: string | undefined;
  let reloadMode: "terminal" | "stream" | undefined;
  let workers: ReturnType<typeof createWorkerManager> | undefined;
  const workerTopic = `workers.${crypto.randomUUID()}`;

  pi.registerMessageRenderer("agenthook", (message, { expanded, outputPad }, theme) => {
    const event = message.details as Partial<AgenthookEvent> | undefined;
    return eventCard(eventTitle(event?.payload), event?.topic || "unknown topic", event?.payload, expanded, outputPad, theme);
  });

  const restoreSubscription = (ctx: ExtensionContext): { topic: string; mode: "terminal" | "stream" } | undefined => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== RELOAD_STATE_ENTRY) continue;
      const saved = entry.data as { version?: unknown; topic?: unknown; mode?: unknown } | undefined;
      if (saved?.version !== 1) return undefined;
      if (saved.topic === null) return undefined;
      if (typeof saved.topic !== "string" || !TOPIC_RE.test(saved.topic)) return undefined;
      const mode = saved.mode === "stream" ? "stream" : "terminal";
      return { topic: saved.topic, mode };
    }
    return undefined;
  };

  const subscribe = (ctx: ExtensionContext, topic: string, saveForReload = true, mode: "terminal" | "stream" = "terminal") => {
    if (!TOPIC_RE.test(topic)) throw new Error("agenthook topic is invalid");
    try {
      const { token } = config();
      if (!token) throw new Error("empty token");
    } catch {
      throw new Error("agenthook token unavailable; start the local server first");
    }
    if (saveForReload) { reloadTopic = topic; reloadMode = mode; }
    if (activeTopic === topic && activeMode === mode) return;
    stop();
    activeTopic = topic;
    activeMode = mode;
    const stopOnTerminal = mode === "terminal";
    stop = startListener(pi, ctx, topic, {
      stopOnTerminal,
      onTerminal: () => {
        activeTopic = undefined;
        activeMode = undefined;
        reloadTopic = undefined;
        reloadMode = undefined;
        ctx.ui.setStatus("agenthook", undefined);
        ctx.ui.notify(`agenthook received a terminal event for ${topic}; listener stopped`, "info");
      },
    });
    ctx.ui.setStatus("agenthook", `agenthook: ${topic}${stopOnTerminal ? "" : " (streaming)"}`);
    ctx.ui.notify(`agenthook listening for ${topic}${stopOnTerminal ? " until it finishes" : " (streaming)"}`, "info");
  };

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "startup" && process.env.AGENTHOOK_TOPIC) {
      const mode = process.env.AGENTHOOK_MODE === "stream" ? "stream" : "terminal";
      subscribe(ctx, process.env.AGENTHOOK_TOPIC, true, mode);
    } else if (event.reason === "reload") {
      const restored = restoreSubscription(ctx);
      if (restored) subscribe(ctx, restored.topic, true, restored.mode);
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") pi.appendEntry(RELOAD_STATE_ENTRY, { version: 1, topic: reloadTopic ?? null, mode: reloadMode ?? null });
    stop();
    activeTopic = undefined;
    activeMode = undefined;
    reloadTopic = undefined;
    reloadMode = undefined;
    await workers?.close();
    workers = undefined;
  });

  const unsubscribe = (ctx: ExtensionContext) => {
    stop();
    activeTopic = undefined;
    activeMode = undefined;
    reloadTopic = undefined;
    reloadMode = undefined;
    ctx.ui.setStatus("agenthook", undefined);
  };

  pi.registerTool({
    name: "agenthook",
    label: "Agenthook",
    description: "Subscribe this Pi session to an agenthook topic without waiting for an event. Returns immediately; incoming events arrive later as untrusted external messages. By default the listener stops after the first terminal event (completed, success, failed, error, or cancelled), which fits a one-shot job. Pass stream=true to keep listening for every event on a topic that carries multiple or ongoing events. Use status to inspect this session's listener or unsubscribe to stop it. One topic per session; subscribing to a different topic replaces the current listener. Do not poll the inbox or use a blocking shell wait after subscribing.",
    // Plain JSON Schema keeps the extension importable without runtime dependencies.
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["subscribe", "status", "unsubscribe"] },
        topic: { type: "string", pattern: TOPIC_RE.source, description: "Required for subscribe; must match the sender's topic" },
        stream: { type: "boolean", description: "Optional; with subscribe, keep listening for every event instead of stopping after the first terminal event" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id, input: unknown, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { action, topic, stream } = (input ?? {}) as { action?: unknown; topic?: unknown; stream?: unknown };
      if (action === "subscribe") {
        if (typeof topic !== "string") throw new Error("subscribe requires a topic");
        if (stream !== undefined && typeof stream !== "boolean") throw new Error("stream must be a boolean when provided");
        subscribe(ctx, topic, true, stream ? "stream" : "terminal");
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
    description: "Start a Pi worker without waiting for completion. Uses claude-opus-4-8 with medium reasoning. Automatically uses this session's agenthook topic (creates a private topic if none). Completion arrives later as untrusted agenthook data with a private report path; continue working, do not poll. Actions: start (task, optional cwd, optional label), status (optional id), cancel (id), forget (id; retains files). Always pass a short human-readable label on start describing the task (for example \"fix login crash\"); it is shown on the worker's event cards so several workers can be told apart. Workers are cancelled when this session closes or reloads. Include scope, allowed files, constraints, tests, and commit policy in task. Status reports inbox acceptance separately from completion.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "cancel", "forget"] },
        task: { type: "string", description: "Required for start; explicit bounded assignment" },
        label: { type: "string", description: "Short human-readable description of the task shown on event cards; strongly recommended on start" },
        cwd: { type: "string", description: "Worker directory; defaults to current directory" },
        id: { type: "string", description: "Worker ID for status, cancel, or forget" },
      },
      required: ["action"], additionalProperties: false,
    },
    renderResult(result, { expanded }, theme) {
      const worker = result.details as { topic?: unknown; label?: unknown } | undefined;
      return eventCard(
        typeof worker?.label === "string" && worker.label ? `Worker started · ${worker.label}` : "Worker started",
        typeof worker?.topic === "string" ? worker.topic : "unknown topic",
        result.details,
        expanded,
        0,
        theme,
      );
    },
    async execute(_id, input: unknown, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { action, task, label, cwd, id } = (input ?? {}) as { action?: string; task?: string; label?: string; cwd?: string; id?: string };
      if (!workers) workers = createWorkerManager({
        ...workerOptions,
        onDeliveryError: () => ctx.ui.notify("Worker report was not accepted by agenthook. Inspect agenthook_subagent status; no automatic redelivery.", "warning"),
      });
      let result;
      if (action === "start") {
        const topic = activeTopic || workerTopic;
        const { url, token } = config();
        result = await workers.start({ task, label, cwd: path.resolve(ctx.cwd, cwd || "."), topic, url, token, signal,
          beforeSpawn: () => {
            if (activeTopic && activeTopic !== topic) throw new Error("Subscription changed before worker launch; retry with the current topic");
            // Worker completions can arrive repeatedly on one topic, so stay in streaming mode.
            subscribe(ctx, topic, false, "stream");
          } });
      } else if (action === "status") result = workers.status(id);
      else if (action === "cancel" && id) result = workers.cancel(id);
      else if (action === "forget" && id) result = workers.remove(id);
      else throw new Error("Expected start, status, cancel with id, or forget with id");
      return {
        content: [{ type: "text", text: action === "start"
          ? "Worker started.\nCompletion will arrive via agenthook; continue working."
          : JSON.stringify(result) }],
        details: result,
      };
    },
  });

  pi.registerCommand("agenthook", {
    description: "Listen for an agenthook topic: /agenthook <topic> [stream], or /agenthook off",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "off") {
        unsubscribe(ctx);
        ctx.ui.notify("agenthook listener stopped", "info");
        return;
      }
      if (parts.length === 0) {
        ctx.ui.notify(activeTopic ? `agenthook listening for ${activeTopic}` : "Usage: /agenthook <topic> [stream]", "info");
        return;
      }
      const stream = parts[parts.length - 1] === "stream";
      const topic = stream ? parts[parts.length - 2] : parts[parts.length - 1];
      if (!topic) {
        ctx.ui.notify("Usage: /agenthook <topic> [stream]", "info");
        return;
      }
      subscribe(ctx, topic, true, stream ? "stream" : "terminal");
    },
  });
}
