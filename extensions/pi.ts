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

type WorkerView = {
  id: string;
  title?: string;
  topic: string;
  status: string;
  delivery: string;
  model: string;
  thinking: string;
  pid: number | null;
  report: string;
};

type ListenerState = "listening" | "reconnecting";

function textComponent(text: string) {
  // A tool renderer needs only the public Pi TUI Component shape. Keeping this
  // structural avoids a runtime dependency when this extension is symlinked.
  return { render: () => text.split("\n") };
}

function shortTitle(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "Background worker";
  return text.length > 56 ? `${text.slice(0, 53)}...` : text;
}

function workerLabel(worker: WorkerView): string {
  const title = shortTitle(worker.title);
  return title === "Background worker" ? `Worker ${worker.id.slice(0, 8)}` : title;
}

function asWorkers(value: unknown): WorkerView[] {
  if (Array.isArray(value)) return value.filter((item): item is WorkerView => !!item && typeof item === "object" && typeof item.id === "string");
  return value && typeof value === "object" && typeof (value as WorkerView).id === "string" ? [value as WorkerView] : [];
}

const DEFAULT_URL = "http://127.0.0.1:3210";
const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function config() {
  const dataDir = process.env.AGENTHOOK_DATA_DIR || path.join(os.homedir(), ".agenthook");
  const url = (process.env.AGENTHOOK_URL || DEFAULT_URL).replace(/\/$/, "");
  const token = process.env.AGENTHOOK_TOKEN || fs.readFileSync(path.join(dataDir, "token"), "utf8").trim();
  return { url, token };
}

function startListener(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  topic: string,
  onStateChange: (state: ListenerState) => void,
) {
  const controller = new AbortController();
  onStateChange("listening");
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
        onStateChange("listening");
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
        onStateChange("reconnecting");
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
  let listenerState: ListenerState = "listening";
  let statusContext: ExtensionContext | undefined;
  let workers: ReturnType<typeof createWorkerManager> | undefined;
  const workerTopic = `workers.${crypto.randomUUID()}`;

  const updateStatus = () => {
    const ctx = statusContext;
    if (!ctx) return;
    const jobs = workers?.status() ?? [];
    const activeJobs = jobs.filter((job: { status: string }) =>
      ["starting", "running", "cancelling"].includes(job.status),
    );
    const active = activeJobs.length;
    const deliveryPending = jobs.filter((job: { delivery: string }) => job.delivery === "pending").length;
    if (!active && !activeTopic) {
      ctx.ui.setStatus("agenthook", undefined);
      ctx.ui.setWidget("agenthook", undefined);
      return;
    }
    const topic = activeTopic && (activeTopic.length > 36 ? `${activeTopic.slice(0, 33)}...` : activeTopic);
    const listener = listenerState === "reconnecting" ? "Reconnecting" : "Listening";
    const workerText = active
      ? `${active} background worker${active === 1 ? "" : "s"}`
      : "no background workers";
    const deliveryText = deliveryPending ? ` · ${deliveryPending} report${deliveryPending === 1 ? "" : "s"} sending` : "";
    ctx.ui.setStatus("agenthook", `agenthook: ${workerText}${deliveryText} · ${listener.toLowerCase()}${topic ? ` ${topic}` : ""}`);

    const panelLines = [
      "Agenthook",
      `${listener}${topic ? ` · ${topic}` : ""}`,
      active ? `${active} active worker${active === 1 ? "" : "s"}${deliveryPending ? ` · ${deliveryPending} report${deliveryPending === 1 ? "" : "s"} sending` : ""}` : "No active workers",
      ...activeJobs.slice(0, 4).map((job: WorkerView) => `  ${workerLabel(job)} · ${job.status}`),
    ];
    if (activeJobs.length > 4) panelLines.push(`  +${activeJobs.length - 4} more active workers`);
    ctx.ui.setWidget("agenthook", panelLines, { placement: "aboveEditor" });
  };

  const subscribe = (ctx: ExtensionContext, topic: string) => {
    if (!TOPIC_RE.test(topic)) throw new Error("agenthook topic is invalid");
    try {
      const { token } = config();
      if (!token) throw new Error("empty token");
    } catch {
      throw new Error("agenthook token unavailable; start the local server first");
    }
    statusContext = ctx;
    if (activeTopic === topic) {
      updateStatus();
      return;
    }
    stop();
    activeTopic = topic;
    stop = startListener(pi, ctx, topic, (state) => {
      listenerState = state;
      updateStatus();
    });
    updateStatus();
    ctx.ui.notify(`agenthook listening for ${topic}`, "info");
  };

  pi.on("session_start", (_event, ctx) => {
    statusContext = ctx;
    const topic = process.env.AGENTHOOK_TOPIC;
    if (topic) subscribe(ctx, topic);
    else updateStatus();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stop();
    activeTopic = undefined;
    await workers?.close();
    workers = undefined;
    statusContext = undefined;
    ctx.ui.setStatus("agenthook", undefined);
  });

  const unsubscribe = (ctx: ExtensionContext) => {
    stop();
    activeTopic = undefined;
    statusContext = ctx;
    updateStatus();
  };

  const subagentParameters = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start", "status", "cancel", "forget"] },
      task: { type: "string", description: "Required for start; explicit bounded assignment" },
      title: { type: "string", description: "Required for start: a concise 2-6 word leaf-work title naming this specific pending unit (for example, 'Verify staging deploy'). Never omit it." },
      cwd: { type: "string", description: "Worker directory; defaults to current directory" },
      id: { type: "string", description: "Worker ID for status, cancel, or forget" },
    },
    required: ["action"], additionalProperties: false,
  };

  const executeSubagent = async (_id: string, input: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
    signal?.throwIfAborted();
    const { action, task, title, cwd, id } = (input ?? {}) as { action?: string; task?: string; title?: string; cwd?: string; id?: string };
    if (action === "start" && (typeof title !== "string" || !title.trim())) {
      throw new Error("start requires a concise leaf-work title so pending workers are identifiable");
    }
    statusContext = ctx;
    if (!workers) workers = createWorkerManager({
      ...workerOptions,
      onStatusChange: () => updateStatus(),
      onDeliveryError: () => {
        updateStatus();
        statusContext?.ui.notify("Worker report was not accepted by agenthook. Inspect subagent status; no automatic redelivery.", "warning");
      },
    });
    let result;
    if (action === "start") {
      const topic = activeTopic || workerTopic;
      const { url, token } = config();
      result = await workers.start({ task, title, cwd: path.resolve(ctx.cwd, cwd || "."), topic, url, token, signal,
        beforeSpawn: () => {
          if (activeTopic && activeTopic !== topic) throw new Error("Subscription changed before worker launch; retry with the current topic");
          subscribe(ctx, topic);
        } });
    } else if (action === "status") result = workers.status(id);
    else if (action === "cancel" && id) result = workers.cancel(id);
    else if (action === "forget" && id) result = workers.remove(id);
    else throw new Error("Expected start, status, cancel with id, or forget with id");
    updateStatus();
    return {
      content: [{ type: "text", text: action === "start"
        ? `Worker process started; this is not completion. Continue working; agenthook will deliver its result.\n${JSON.stringify(result)}`
        : JSON.stringify(result) }],
      details: result,
    };
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

  const subagentDescription = "Start one explicitly titled Pi worker without waiting for completion. Every start must include title: a concise 2-6 word description of its specific leaf task, so pending work stays identifiable in the live panel and card. Uses GPT-5.6-terra with medium reasoning. Automatically uses this session's agenthook topic (creates a private topic if none). Completion arrives later as untrusted agenthook data with a private report path; continue working, do not poll. Actions: start (task, required title and optional cwd), status (optional id), cancel (id), forget (id; retains files). Workers are cancelled when this session closes or reloads. Include scope, allowed files, constraints, tests, and commit policy in task. Status reports inbox acceptance separately from completion.";
  const renderSubagentCall = (args: { action?: string; task?: string; title?: string }, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }) => {
    const label = args.action === "start" ? shortTitle(args.title || args.task) : args.action || "status";
    return textComponent(`${theme.fg("toolTitle", theme.bold("subagent"))}${theme.fg("muted", " · ")}${theme.fg("accent", label)}`);
  };
  const renderSubagentResult = (result: { details?: unknown }, options: { expanded?: boolean }, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }) => {
    const liveWorkers = workers ? asWorkers(workers.status()) : [];
    const listedWorkers = liveWorkers.length ? liveWorkers : asWorkers(result.details);
    if (!listedWorkers.length) return textComponent(theme.fg("muted", "No workers in this session."));
    if (!options.expanded) {
      const worker = listedWorkers[0];
      const summary = listedWorkers.length === 1
        ? `${workerLabel(worker)} · ${worker.status}${worker.delivery === "pending" ? " · reporting" : ""}`
        : `${listedWorkers.length} workers · ${listedWorkers.filter((item) => ["starting", "running", "cancelling"].includes(item.status)).length} active`;
      return textComponent(`${theme.fg("accent", summary)}${theme.fg("dim", " (click or Ctrl+E to expand)")}`);
    }
    const lines = listedWorkers.map((worker) => {
      const stateColor = worker.status === "completed" ? "success" : worker.status === "failed" ? "error" : "warning";
      const delivery = worker.delivery === "accepted" ? "reported" : worker.delivery === "failed" ? "report failed" : "report pending";
      return `${theme.fg(stateColor, worker.status)} ${theme.fg("accent", workerLabel(worker))}\n  ${theme.fg("muted", `${delivery} · ${worker.model} · ${worker.thinking}`)}`;
    });
    return textComponent(`${theme.fg("toolTitle", theme.bold(`Workers (${listedWorkers.length})`))}\n${lines.join("\n")}`);
  };
  pi.registerTool({ name: "subagent", label: "Background subagent", description: subagentDescription, parameters: subagentParameters, execute: executeSubagent, renderCall: renderSubagentCall, renderResult: renderSubagentResult });
  // Existing sessions and saved calls can continue using the prior explicit name.
  pi.registerTool({ name: "agenthook_subagent", label: "Agenthook background subagent", description: `Compatibility alias for subagent. ${subagentDescription}`, parameters: subagentParameters, execute: executeSubagent, renderCall: renderSubagentCall, renderResult: renderSubagentResult });

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
