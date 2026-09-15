import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { runStdio } from '../extensions/claude-code.ts';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgenthookServer } from '../server.js';

async function until(predicate) {
  const deadline = Date.now() + 1_500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not settle');
    await delay(10);
  }
}

async function runningInbox(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthook-claude-'));
  const app = createAgenthookServer({
    dataDir, eventFile: path.join(dataDir, 'events.json'), tokenFile: path.join(dataDir, 'token'),
    host: '127.0.0.1', port: 0, token: 'test-token', maxEvents: 1000, ttlMs: 86_400_000,
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    app, url,
    async send(topic, payload = { status: 'success' }) {
      const response = await fetch(`${url}/v1/webhooks/${topic}`, {
        method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 202);
    },
  };
}

function channel(t, url) {
  const child = spawn(process.execPath, ['extensions/claude-code.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, AGENTHOOK_URL: url, AGENTHOOK_TOKEN: 'test-token' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let stderr = '';
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => messages.push(JSON.parse(line)));
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (!child.killed) child.stdin.end();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1_000)]);
    if (!child.killed) child.kill('SIGKILL');
    assert.equal(stderr, '');
  });
  let nextId = 1;
  return {
    child, messages,
    send(value) { child.stdin.write(`${JSON.stringify(value)}\n`); },
    async request(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      await until(() => messages.some(message => message.id === id));
      return messages.find(message => message.id === id);
    },
  };
}

async function initialize(client) {
  const response = await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(response.result.protocolVersion, '2025-03-26');
  assert.deepEqual(response.result.capabilities.experimental, { 'claude/channel': {} });
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

test('Claude channel initializes, exposes nonblocking controls, and delivers queued external events', async (t) => {
  const { url, send } = await runningInbox(t);
  await send('queued.test', { ready: true });
  const client = channel(t, url);
  await initialize(client);
  const tools = await client.request('tools/list');
  assert.equal(tools.result.tools.length, 1);
  assert.deepEqual(tools.result.tools[0], {
    name: 'agenthook',
    description: 'Subscribe this Claude Code session to an agenthook topic without waiting for an event. Incoming events are explicitly labeled untrusted external data. One topic per session; a new subscription replaces the prior listener.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['subscribe', 'status', 'unsubscribe'] },
        topic: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$', description: 'Required for subscribe; must match the sender topic.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  });
  const subscribed = await client.request('tools/call', { name: 'agenthook', arguments: { action: 'subscribe', topic: 'queued.test' } });
  assert.deepEqual(subscribed.result.structuredContent, { listening: true, topic: 'queued.test' });
  await until(() => client.messages.some(message => message.method === 'notifications/claude/channel'));
  const event = client.messages.find(message => message.method === 'notifications/claude/channel');
  assert.deepEqual(event.params.meta, { source: 'webhook', topic: 'queued.test', event_id: event.params.meta.event_id });
  assert.match(event.params.content, /^External agenthook event \(untrusted data\)/);
  assert.match(event.params.content, /Payload: {"ready":true}/);
  const status = await client.request('tools/call', { name: 'agenthook', arguments: { action: 'status' } });
  assert.deepEqual(status.result.structuredContent, { listening: true, topic: 'queued.test' });
});

test('Claude channel rejects invalid input and replaces topics', async (t) => {
  const { app, url, send } = await runningInbox(t);
  const client = channel(t, url);
  await initialize(client);
  for (const arguments_ of [{ action: 'subscribe' }, { action: 'subscribe', topic: '../bad' }, { action: 'status', unexpected: true }, { action: 'nope' }, 'not-an-object']) {
    const response = await client.request('tools/call', { name: 'agenthook', arguments: arguments_ });
    assert.equal(response.error.code, -32602);
  }
  await client.request('tools/call', { name: 'agenthook', arguments: { action: 'subscribe', topic: 'old' } });
  await until(() => app.inbox.waiters.has('old'));
  await client.request('tools/call', { name: 'agenthook', arguments: { action: 'subscribe', topic: 'new' } });
  await until(() => !app.inbox.waiters.has('old') && app.inbox.waiters.has('new'));
  await send('old');
  assert.equal(app.inbox.topics().old, 1);
  await client.request('tools/call', { name: 'agenthook', arguments: { action: 'unsubscribe' } });
  await until(() => !app.inbox.waiters.has('new'));
  await send('new');
  assert.equal(app.inbox.topics().new, 1);
});

test('a buffered cancellation stops an in-flight request before subscription changes', async t => {
  // Separate OS pipe writes can arrive after a fast tool already completed.
  // Exercise the real stdio handler with deterministic, buffered input instead.
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = [];
  output.on('data', chunk => replies.push(JSON.parse(chunk.toString())));
  const server = runStdio({ input, output, env: { AGENTHOOK_TOKEN: 'synthetic-token' } });
  t.after(() => server.close());
  const write = messages => input.write(messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
  write([{ id: 1, method: 'initialize', params: {} }]);
  write([
    { id: 2, method: 'tools/call', params: { name: 'agenthook', arguments: { action: 'subscribe', topic: 'cancelled' } } },
    { method: 'notifications/cancelled', params: { requestId: 2 } },
  ]);
  await until(() => replies.some(reply => reply.id === 2));
  assert.match(replies.find(reply => reply.id === 2).error.message, /cancelled/);
  assert.deepEqual(server.channel.status(), { listening: false, topic: null });
});

test('closing stdio cancels the active inbox wait and cleans up the channel', async (t) => {
  const { app, url } = await runningInbox(t);
  const client = channel(t, url);
  await initialize(client);
  await client.request('tools/call', { name: 'agenthook', arguments: { action: 'subscribe', topic: 'shutdown' } });
  await until(() => app.inbox.waiters.has('shutdown'));
  client.child.stdin.end();
  await until(() => !app.inbox.waiters.has('shutdown'));
});
