import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgenthookServer } from '../server.js';
import extension from '../extensions/pi.ts';

function mockPi(entries = []) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const messages = [];
  return {
    handlers, commands, tools, messages, entries,
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendMessage(message, options) { messages.push({ message, options }); },
  };
}

async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not settle');
    await delay(10);
  }
}

async function setup(t, startupTopic) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthook-pi-'));
  const app = createAgenthookServer({
    dataDir, eventFile: path.join(dataDir, 'events.json'), tokenFile: path.join(dataDir, 'token'),
    host: '127.0.0.1', port: 0, token: 'test-token', maxEvents: 1000, ttlMs: 86_400_000,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const keys = ['AGENTHOOK_URL', 'AGENTHOOK_TOKEN', 'AGENTHOOK_TOPIC'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  process.env.AGENTHOOK_URL = url;
  process.env.AGENTHOOK_TOKEN = 'test-token';
  if (startupTopic) process.env.AGENTHOOK_TOPIC = startupTopic;
  else delete process.env.AGENTHOOK_TOPIC;
  const pi = mockPi();
  const ctx = { ui: { notify() {}, setStatus() {} }, sessionManager: { getBranch: () => pi.entries } };
  await extension(pi);
  t.after(async () => {
    await pi.handlers.get('session_shutdown')({}, ctx);
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
  return {
    app, pi, ctx,
    call: (input, signal) => pi.tools.get('agenthook').execute('test-call', input, signal, undefined, ctx),
    async send(topic, payload = { status: 'success' }) {
      const response = await fetch(`${url}/v1/webhooks/${topic}`, {
        method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 202);
    },
  };
}

function assertExternalMessage(pi) {
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0].message.customType, 'agenthook');
  assert.match(pi.messages[0].message.content, /External agenthook event \(untrusted data\)/);
  assert.deepEqual(pi.messages[0].message.details.payload, { status: 'success' });
  assert.deepEqual(pi.messages[0].options, { deliverAs: 'steer', triggerTurn: true });
}

test('environment subscription still delivers a webhook as an external custom message', async (t) => {
  const { pi, send } = await setup(t, 'github.test.deploy');
  await send('github.test.deploy');
  await until(() => pi.messages.length === 1);
  assertExternalMessage(pi);
});

test('agent subscribes without waiting, then receives the webhook through Pi', async (t) => {
  const { pi, app, call, send } = await setup(t);
  assert.deepEqual((await call({ action: 'status' })).details, { listening: false, topic: null });
  const started = await call({ action: 'subscribe', topic: 'agent.test' });
  assert.deepEqual(started.details, { listening: true, topic: 'agent.test' });
  assert.equal(pi.messages.length, 0); // Tool returned before any event was sent.
  await until(() => app.inbox.waiters.get('agent.test')?.length === 1);
  await call({ action: 'subscribe', topic: 'agent.test' });
  assert.equal(app.inbox.waiters.get('agent.test').length, 1);
  await send('agent.test');
  await until(() => pi.messages.length === 1);
  assertExternalMessage(pi);
});

test('agent subscription delivers an already queued event', async (t) => {
  const { pi, call, send } = await setup(t);
  await send('queued.test');
  await call({ action: 'subscribe', topic: 'queued.test' });
  await until(() => pi.messages.length === 1);
  assertExternalMessage(pi);
});

test('invalid or aborted subscriptions leave the existing listener unchanged', async (t) => {
  const { call } = await setup(t);
  await call({ action: 'subscribe', topic: 'original' });
  for (const input of [{ action: 'subscribe' }, { action: 'subscribe', topic: '../bad' }, { action: 'wrong' }]) {
    await assert.rejects(call(input));
  }
  await assert.rejects(call({ action: 'subscribe', topic: 'other' }, AbortSignal.abort()));
  assert.equal((await call({ action: 'status' })).details.topic, 'original');
});

test('changing topics, unsubscribe, and shutdown cancel old listeners', async (t) => {
  const { app, pi, ctx, call, send } = await setup(t);
  await call({ action: 'subscribe', topic: 'old' });
  await until(() => app.inbox.waiters.has('old'));
  await call({ action: 'subscribe', topic: 'new' });
  await until(() => !app.inbox.waiters.has('old') && app.inbox.waiters.has('new'));
  await send('old');
  assert.equal(app.inbox.topics().old, 1);
  const stopped = await call({ action: 'unsubscribe' });
  assert.deepEqual(stopped.details, { listening: false, topic: null });
  await until(() => !app.inbox.waiters.has('new'));
  await send('new');
  assert.equal(app.inbox.topics().new, 1);
  assert.equal(pi.messages.length, 0);
  await call({ action: 'subscribe', topic: 'shutdown' });
  await until(() => app.inbox.waiters.has('shutdown'));
  await pi.handlers.get('session_shutdown')({}, ctx);
  await until(() => !app.inbox.waiters.has('shutdown'));
  assert.equal((await call({ action: 'status' })).details.listening, false);
});

test('reload restores an explicit subscription from the current session', async (t) => {
  const { pi, ctx, call, send } = await setup(t);
  await call({ action: 'subscribe', topic: 'restore.me' });
  await pi.handlers.get('session_shutdown')({ reason: 'reload' }, ctx);
  assert.deepEqual(pi.entries.at(-1), { type: 'custom', customType: 'agenthook-reload-state', data: { version: 1, topic: 'restore.me' } });

  const reloaded = mockPi(pi.entries);
  const reloadedCtx = { ui: { notify() {}, setStatus() {} }, sessionManager: { getBranch: () => reloaded.entries } };
  await extension(reloaded);
  await reloaded.handlers.get('session_start')({ reason: 'reload' }, reloadedCtx);
  const status = await reloaded.tools.get('agenthook').execute('reload-status', { action: 'status' }, undefined, undefined, reloadedCtx);
  assert.deepEqual(status.details, { listening: true, topic: 'restore.me' });
  await send('restore.me');
  await until(() => reloaded.messages.length === 1);
  assertExternalMessage(reloaded);
  await reloaded.handlers.get('session_shutdown')({ reason: 'reload' }, reloadedCtx);
});

test('manual command uses the same subscription as the agent tool', async (t) => {
  const { pi, ctx, call } = await setup(t);
  await pi.commands.get('agenthook').handler('manual', ctx);
  assert.equal((await call({ action: 'status' })).details.topic, 'manual');
  await pi.commands.get('agenthook').handler('off', ctx);
  assert.equal((await call({ action: 'status' })).details.listening, false);
});

test('unsubscribe prevents late responses from entering the session', async (t) => {
  const { pi, call } = await setup(t);
  let resolveBody;
  const body = new Promise(resolve => { resolveBody = resolve; });
  let bodyRequested = false;
  t.mock.method(globalThis, 'fetch', async () => ({
    status: 200, ok: true,
    json() { bodyRequested = true; return body; },
  }));
  await call({ action: 'subscribe', topic: 'late' });
  await until(() => bodyRequested);
  await call({ action: 'unsubscribe' });
  resolveBody({ id: 'late-event', topic: 'late', payload: {}, source: 'webhook', receivedAt: Date.now() });
  await delay(0);
  assert.equal(pi.messages.length, 0);
});
