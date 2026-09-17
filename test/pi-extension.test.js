import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgenthookServer } from '../server.js';
import extension from '../extensions/pi.ts';

function mockPi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const messages = [];
  return {
    handlers, commands, tools, messages,
    on(name, handler) { handlers.set(name, handler); },
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
  const statusUpdates = [];
  const widgetUpdates = [];
  const ctx = {
    ui: {
      notify() {},
      setStatus(_key, value) { statusUpdates.push(value); },
      setWidget(key, value, options) { widgetUpdates.push({ key, value, options }); },
    },
  };
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
  await pi.handlers.get('session_start')({}, ctx);
  return {
    app, pi, ctx, statusUpdates, widgetUpdates,
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

test('manual command uses the same subscription as the agent tool', async (t) => {
  const { pi, ctx, call } = await setup(t);
  await pi.commands.get('agenthook').handler('manual', ctx);
  assert.equal((await call({ action: 'status' })).details.topic, 'manual');
  await pi.commands.get('agenthook').handler('off', ctx);
  assert.equal((await call({ action: 'status' })).details.listening, false);
});

test('subagent requires a concise title for each leaf worker', async (t) => {
  const { pi, ctx } = await setup(t);
  const tool = pi.tools.get('subagent');
  assert.match(tool.description, /Every start must include title/);
  assert.match(tool.parameters.properties.title.description, /leaf-work title/);
  await assert.rejects(
    tool.execute('test-call', { action: 'start', task: 'Check deployment health' }, undefined, undefined, ctx),
    /requires a concise leaf-work title/,
  );
});

test('agenthook renders a live listener panel above the editor', async (t) => {
  const { call, widgetUpdates } = await setup(t);
  assert.equal(widgetUpdates.at(-1).value, undefined);

  await call({ action: 'subscribe', topic: 'workers.live' });
  const panel = widgetUpdates.at(-1);
  assert.equal(panel.key, 'agenthook');
  assert.deepEqual(panel.options, { placement: 'aboveEditor' });
  assert.deepEqual(panel.value, [
    'Agenthook',
    'Listening · workers.live',
    'No active workers',
  ]);
});

test('subagent cards use a short title and expand worker lists', async (t) => {
  const { pi } = await setup(t);
  const tool = pi.tools.get('subagent');
  const theme = { fg: (_color, text) => text, bold: text => text };
  const workers = [
    { id: 'one', title: 'Check the release notes', topic: 'workers.test', status: 'running', delivery: 'pending', model: 'jo-llm-proxy/gpt-5.6-terra', thinking: 'medium', pid: 1, report: '/tmp/one' },
    { id: 'two', title: 'Verify the demo', topic: 'workers.test', status: 'completed', delivery: 'accepted', model: 'jo-llm-proxy/gpt-5.6-terra', thinking: 'medium', pid: 2, report: '/tmp/two' },
  ];
  const call = tool.renderCall({ action: 'start', title: workers[0].title }, theme).render(120).join('\n');
  const collapsed = tool.renderResult({ details: workers }, { expanded: false }, theme).render(120).join('\n');
  const expanded = tool.renderResult({ details: workers }, { expanded: true }, theme).render(120).join('\n');
  assert.match(call, /subagent.*Check the release notes/);
  assert.match(collapsed, /2 workers.*1 active.*click or Ctrl\+E to expand/);
  assert.match(expanded, /Workers \(2\).*running Check the release notes.*completed Verify the demo/s);
  const legacy = tool.renderResult({ details: { id: 'missing-title-worker', status: 'completed', delivery: 'accepted', model: 'jo-llm-proxy/gpt-5.6-terra', thinking: 'medium' } }, { expanded: true }, theme).render(120).join('\n');
  assert.match(legacy, /completed Worker missing-/);
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
