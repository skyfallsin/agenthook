#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_BODY_BYTES = 1024 * 1024;
const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function config(env = process.env) {
  const dataDir = env.AGENTHOOK_DATA_DIR || path.join(os.homedir(), '.agenthook');
  return {
    dataDir,
    eventFile: path.join(dataDir, 'events.json'),
    tokenFile: path.join(dataDir, 'token'),
    host: env.AGENTHOOK_HOST || '127.0.0.1',
    port: Number(env.AGENTHOOK_PORT || 3210),
    token: env.AGENTHOOK_TOKEN,
    maxEvents: Number(env.AGENTHOOK_MAX_EVENTS || 1000),
    ttlMs: Number(env.AGENTHOOK_EVENT_TTL_MS || 86_400_000),
  };
}

function ensureToken(options) {
  if (options.token) return options.token;
  if (!LOOPBACK_HOSTS.has(options.host)) {
    throw new Error('AGENTHOOK_TOKEN is required when AGENTHOOK_HOST is not loopback');
  }
  fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  try {
    return fs.readFileSync(options.tokenFile, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(options.tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  }
}

class Inbox {
  constructor(options) {
    this.options = options;
    this.events = this.load();
    this.waiters = new Map();
    this.prune();
  }

  load() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.options.eventFile, 'utf8'));
      return Array.isArray(stored) ? stored : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`could not read event store: ${error.message}`);
    }
  }

  save() {
    fs.mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
    const temp = `${this.options.eventFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.events), { mode: 0o600 });
    fs.renameSync(temp, this.options.eventFile);
  }

  prune() {
    const oldest = Date.now() - this.options.ttlMs;
    const before = this.events.length;
    this.events = this.events.filter((event) => event.receivedAt >= oldest);
    if (this.events.length !== before) this.save();
  }

  enqueue(topic, payload, source = 'webhook') {
    this.prune();
    const event = { id: crypto.randomUUID(), topic, payload, source, receivedAt: Date.now() };
    const waiting = this.waiters.get(topic)?.shift();
    if (waiting) {
      waiting(event);
      return event;
    }
    this.events.push(event);
    if (this.events.length > this.options.maxEvents) this.events.splice(0, this.events.length - this.options.maxEvents);
    this.save();
    return event;
  }

  take(topic) {
    this.prune();
    const index = this.events.findIndex((event) => event.topic === topic);
    if (index < 0) return undefined;
    const [event] = this.events.splice(index, 1);
    this.save();
    return event;
  }

  wait(topic, timeoutMs, onEvent, onTimeout) {
    const existing = this.take(topic);
    if (existing) return onEvent(existing);
    const waiters = this.waiters.get(topic) || [];
    waiters.push(onEvent);
    this.waiters.set(topic, waiters);
    return setTimeout(() => {
      this.removeWaiter(topic, onEvent);
      onTimeout();
    }, timeoutMs);
  }

  removeWaiter(topic, waiter) {
    const waiters = this.waiters.get(topic);
    if (!waiters) return;
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    if (!waiters.length) this.waiters.delete(topic);
  }

  topics() {
    this.prune();
    const counts = {};
    for (const event of this.events) counts[event.topic] = (counts[event.topic] || 0) + 1;
    return counts;
  }
}

function authorized(request, token) {
  const supplied = request.headers.authorization;
  const expected = `Bearer ${token}`;
  return typeof supplied === 'string' && supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(value)}\n`);
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export function createAgenthookServer(options = config()) {
  options.token = ensureToken(options);
  const inbox = new Inbox(options);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });
    if (!authorized(request, options.token)) return json(response, 401, { error: 'unauthorized' });

    if (request.method === 'GET' && url.pathname === '/v1/topics') return json(response, 200, { topics: inbox.topics() });
    const webhook = url.pathname.match(/^\/v1\/webhooks\/([^/]+)$/);
    if (request.method === 'POST' && webhook) {
      const topic = decodeURIComponent(webhook[1]);
      if (!TOPIC_RE.test(topic)) return json(response, 404, { error: 'invalid topic' });
      try {
        const event = inbox.enqueue(topic, await requestBody(request));
        return json(response, 202, { accepted: true, id: event.id });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    const wait = url.pathname.match(/^\/v1\/wait\/([^/]+)$/);
    if (request.method === 'GET' && wait) {
      const topic = decodeURIComponent(wait[1]);
      const timeout = Math.min(Math.max(Number(url.searchParams.get('timeout') || 300), 1), 1800) * 1000;
      if (!TOPIC_RE.test(topic)) return json(response, 404, { error: 'invalid topic' });
      let timer;
      const finish = (event) => { clearTimeout(timer); if (!response.writableEnded) json(response, 200, event); };
      timer = inbox.wait(topic, timeout, finish, () => {
        if (!response.writableEnded) json(response, 408, { error: 'timeout' });
      });
      request.on('close', () => { clearTimeout(timer); inbox.removeWaiter(topic, finish); });
      return;
    }
    return json(response, 404, { error: 'not found' });
  });
  return { server, options, inbox };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, options } = createAgenthookServer();
  server.listen(options.port, options.host, () => console.log(`agenthook listening on http://${options.host}:${options.port}`));
}
