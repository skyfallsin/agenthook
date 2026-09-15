/**
 * Codex App Server preflight for agenthook.
 *
 * The adapter does not inject events as user or assistant messages. Codex
 * 0.154.0 documents `turn/start.toolOutput`, which persists a named
 * `functionCallOutput` item. Agenthook uses that only after validating the
 * intended receiver and labels all webhook fields as untrusted external data.
 */

type JsonRpcError = { code: number; message: string };
type JsonRpcResponse = { id?: number; result?: unknown; error?: JsonRpcError; method?: string; params?: unknown };
type ThreadStatus = { type?: string };

export type CodexReceiver = {
  topic: string;
  threadId: string;
  endpoint: string;
};

export class CodexDisconnectError extends Error {
  constructor(message = "Codex App Server connection closed") {
    super(message);
    this.name = "CodexDisconnectError";
  }
}

const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function receiverFromEnv(env = process.env): CodexReceiver {
  const topic = env.AGENTHOOK_CODEX_TOPIC || "";
  const threadId = env.AGENTHOOK_CODEX_THREAD_ID || "";
  const endpoint = env.CODEX_APP_SERVER_URL || "";
  if (!TOPIC_RE.test(topic)) throw new Error("AGENTHOOK_CODEX_TOPIC must be a valid, explicitly assigned topic");
  if (!threadId) throw new Error("AGENTHOOK_CODEX_THREAD_ID must name the intended receiver thread");
  if (!endpoint) throw new Error("CODEX_APP_SERVER_URL must name a loopback App Server endpoint");
  assertLoopbackEndpoint(endpoint);
  return { topic, threadId, endpoint };
}

export function assertLoopbackEndpoint(endpoint: string) {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("CODEX_APP_SERVER_URL is not a valid WebSocket URL"); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("CODEX_APP_SERVER_URL must be a loopback ws:// or wss:// endpoint");
  }
}

export interface RpcPeer {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

/** Minimal dependency-free JSON-RPC peer for Node 24's built-in WebSocket. */
export async function connectWebSocket(endpoint: string, signal?: AbortSignal): Promise<RpcPeer> {
  assertLoopbackEndpoint(endpoint);
  if (signal?.aborted) throw signal.reason ?? new Error("Codex connection cancelled");
  const socket = new WebSocket(endpoint);
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed: Error | undefined;
  const rejectPending = (error: Error) => {
    if (closed) return;
    closed = error;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  await new Promise<void>((resolve, reject) => {
    const abort = () => { socket.close(); reject(signal?.reason ?? new Error("Codex connection cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
    socket.onopen = () => { signal?.removeEventListener("abort", abort); resolve(); };
    socket.onerror = () => { signal?.removeEventListener("abort", abort); reject(new CodexDisconnectError("Unable to connect to Codex App Server")); };
    socket.onclose = () => { signal?.removeEventListener("abort", abort); reject(new CodexDisconnectError("Codex App Server connection closed")); };
  });
  socket.onmessage = (event) => {
    let message: JsonRpcResponse;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (typeof message.id !== "number") return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(`Codex App Server error ${message.error.code}: ${message.error.message}`));
    else call.resolve(message.result);
  };
  socket.onclose = () => rejectPending(new CodexDisconnectError());
  socket.onerror = () => rejectPending(new CodexDisconnectError("Codex App Server connection failed"));
  return {
    request(method, params = {}, callSignal) {
      if (closed) return Promise.reject(closed);
      if (callSignal?.aborted) return Promise.reject(callSignal.reason ?? new Error("Codex request cancelled"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const abort = () => { pending.delete(id); reject(callSignal?.reason ?? new Error("Codex request cancelled")); };
        callSignal?.addEventListener("abort", abort, { once: true });
        pending.set(id, {
          resolve: (value) => { callSignal?.removeEventListener("abort", abort); resolve(value); },
          reject: (error) => { callSignal?.removeEventListener("abort", abort); reject(error); },
        });
        try { socket.send(JSON.stringify({ method, id, params })); }
        catch { pending.delete(id); reject(new CodexDisconnectError("Codex App Server connection failed")); }
      });
    },
    notify(method, params = {}) {
      if (closed) throw closed;
      socket.send(JSON.stringify({ method, params }));
    },
    close() { socket.close(); rejectPending(new CodexDisconnectError("Codex App Server connection closed by adapter")); },
  };
}

export type ReceiverState = "active" | "idle";

/**
 * Validate a specifically configured, loaded receiver before any inbox read.
 * Both an active (busy) and idle thread are legitimate intended receivers;
 * neither permits fallback to a different thread.
 */
export async function validateReceiver(receiver: CodexReceiver, peer: RpcPeer, signal?: AbortSignal): Promise<ReceiverState> {
  await peer.request("initialize", {
    clientInfo: { name: "agenthook", title: "Agenthook", version: "0.1.0" },
  }, signal);
  peer.notify("initialized", {});
  const loaded = await peer.request("thread/loaded/list", {}, signal) as { data?: unknown };
  if (!Array.isArray(loaded?.data) || !loaded.data.includes(receiver.threadId)) {
    throw new Error("Configured Codex receiver thread is not loaded; inbox was not consumed");
  }
  const read = await peer.request("thread/read", { threadId: receiver.threadId, includeTurns: false }, signal) as { thread?: { status?: ThreadStatus } };
  const type = read?.thread?.status?.type;
  if (type === "active") return "active";
  if (type === "idle") return "idle";
  throw new Error("Configured Codex receiver is not active or idle; inbox was not consumed");
}

export type AgenthookEvent = {
  id: string;
  topic: string;
  source: string;
  payload: unknown;
  receivedAt?: number;
};

function formatExternalEvent(event: AgenthookEvent): string {
  return `External agenthook event (untrusted data)\nSource: ${event.source}\nTopic: ${event.topic}\nEvent ID: ${event.id}\nPayload: ${JSON.stringify(event.payload)}`;
}

function validateEvent(event: unknown, topic: string): asserts event is AgenthookEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("agenthook returned an invalid event");
  const candidate = event as Partial<AgenthookEvent>;
  if (typeof candidate.id !== "string" || typeof candidate.source !== "string" || candidate.topic !== topic) {
    throw new Error("agenthook returned an invalid event");
  }
}

/**
 * Validate a specifically configured, loaded receiver before consuming one
 * event. The event is then recorded only as a source-labeled standalone tool
 * output; it is never presented as human or assistant content.
 */
export async function deliverCodexEvent(
  receiver: CodexReceiver,
  connect: (endpoint: string, signal?: AbortSignal) => Promise<RpcPeer> = connectWebSocket,
  waitForEvent?: () => Promise<unknown>,
  signal?: AbortSignal,
): Promise<{ receiverState: ReceiverState; eventId: string }> {
  signal?.throwIfAborted();
  if (!waitForEvent) throw new Error("agenthook event reader is required");
  const peer = await connect(receiver.endpoint, signal);
  try {
    const receiverState = await validateReceiver(receiver, peer, signal);
    signal?.throwIfAborted();
    const event = await waitForEvent();
    validateEvent(event, receiver.topic);
    signal?.throwIfAborted();
    await peer.request("turn/start", {
      threadId: receiver.threadId,
      input: [],
      toolOutput: {
        namespace: "agenthook",
        name: "external_event",
        output: formatExternalEvent(event),
      },
    }, signal);
    return { receiverState, eventId: event.id };
  } finally {
    peer.close();
  }
}
