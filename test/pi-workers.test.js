import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkerManager, WORKER_MODEL } from '../lib/pi-workers.js';
import { createAgenthookServer } from '../server.js';
import extension from '../extensions/pi.ts';

async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); }
  assert.fail('worker did not settle');
}
async function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthook-workers-'));
  const fixture = path.join(dir, 'fake-pi.mjs');
  fs.writeFileSync(fixture, `
import fs from 'node:fs';
let task = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => task += chunk);
process.stdin.on('end', () => {
 const timer = setInterval(() => {}, 1000);
 const finish = () => {
  clearInterval(timer);
  if (task !== 'empty') {
   console.log(JSON.stringify({type:'message_end', message:{role:'assistant', model:'gpt-5.6-terra', stopReason:task === 'error' ? 'error' : 'stop', content:[{type:'text',text:'fixture result\\u2028line'}]}}));
   console.log(JSON.stringify({type:'agent_end', messages:[]}));
  }
 };
 process.on('SIGUSR1', finish);
 fs.writeFileSync(process.env.FIXTURE_READY, JSON.stringify({task,topic:process.env.AGENTHOOK_TOPIC ?? null, goalId: process.env.PI_GOAL_ID ?? null, goalStore: process.env.PI_GOALS_STORE ?? null, contextWindowId: process.env.PI_CONTEXT_WINDOW_ID ?? null, parentContextWindowId: process.env.PI_PARENT_CONTEXT_WINDOW_ID ?? null, role: process.env.PI_GOAL_ROLE ?? null, capabilityFile: process.env.PI_SPRITE_CONTEXT_CAPABILITY_FILE ?? null}));
 if (task !== 'hold') finish();
});
`);
  const app = createAgenthookServer({ dataDir: dir, eventFile: path.join(dir, 'events.json'), tokenFile: path.join(dir, 'token'),
    host: '127.0.0.1', port: 0, token: 'synthetic-token', maxEvents: 1000, ttlMs: 86400000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const launches = [];
  const workerOptions = { dataDir: dir, spawnProcess(command, args, options) {
    const ready = path.join(dir, `ready-${launches.length}.json`);
    launches.push({ command, args, options, ready });
    return spawn(process.execPath, [fixture], { ...options, env: { ...options.env, FIXTURE_READY: ready } });
  }, ...overrides };
  const manager = createWorkerManager(workerOptions);
  t.after(async () => {
    await manager.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { manager, launches, app, dir, url, workerOptions, start: (task = 'hold', extra = {}) => manager.start({ task, cwd: dir, topic: 'parent.reports', url, token: 'synthetic-token', ...extra }) };
}

test('Pi subagent tool returns immediately and concurrent completions use its single untrusted listener', async t => {
  const { launches, app, dir, url, workerOptions } = await setup(t);
  const keys = ['AGENTHOOK_URL', 'AGENTHOOK_TOKEN', 'AGENTHOOK_TOPIC'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AGENTHOOK_URL = url;
  process.env.AGENTHOOK_TOKEN = 'synthetic-token';
  delete process.env.AGENTHOOK_TOPIC;
  const tools = new Map();
  const handlers = new Map();
  const messages = [];
  const emittedEvents = [];
  const eventHandlers = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
    on(name, handler) { handlers.set(name, handler); },
    events: {
      on(name, handler) { eventHandlers.set(name, handler); return () => eventHandlers.delete(name); },
      emit(name, payload) { emittedEvents.push({ name, payload }); eventHandlers.get(name)?.(payload); },
    },
    sendMessage(message, options) { messages.push({ message, options }); },
  };
  const statusUpdates = [];
  const widgetUpdates = [];
  const ctx = {
    cwd: dir,
    ui: {
      notify() {},
      setStatus(_key, value) { statusUpdates.push(value); },
      setWidget(key, value, options) { widgetUpdates.push({ key, value, options }); },
    },
  };
  await extension(pi, workerOptions);
  t.after(async () => {
    await handlers.get('session_shutdown')({}, ctx);
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  });
  const call = input => tools.get('subagent').execute('test', input, undefined, undefined, ctx);
  assert.ok(tools.has('agenthook_subagent'), 'the former explicit tool name remains available as an alias');
  const started = await Promise.all([call({ action: 'start', task: 'hold', title: 'Hold first worker' }), call({ action: 'start', task: 'hold', title: 'Hold second worker' })]);
  assert.deepEqual(started.map(result => result.details.title), ['Hold first worker', 'Hold second worker']);
  assert.equal(started[0].details.topic, started[1].details.topic);
  assert.equal(messages.length, 0);
  assert.ok(started.every(result => result.details.status === 'running'));
  await until(() => statusUpdates.some(value => /2 background workers/.test(value || '')));
  await until(() => launches.every(launch => fs.existsSync(launch.ready)));
  for (const result of started) process.kill(result.details.pid, 'SIGUSR1');
  await until(() => messages.length === 2);
  for (const { message, options } of messages) {
    assert.equal(message.customType, 'agenthook');
    assert.match(message.content, /untrusted data/);
    assert.equal(message.details.payload.kind, 'subagent');
    assert.equal(message.details.payload.status, 'completed');
    assert.match(message.details.payload.title, /^Hold (first|second) worker$/);
    assert.deepEqual(options, { deliverAs: 'steer', triggerTurn: true });
  }
  assert.deepEqual(app.inbox.topics(), {});
  const status = await call({ action: 'status', id: started[0].details.id });
  assert.equal(status.details.status, 'completed');
  await handlers.get('session_shutdown')({}, ctx);
});

test('pi-bot goal worker requests launch persisted goal-bound sessions and report only their registered parent', async t => {
  const { launches, dir, url, workerOptions } = await setup(t);
  const handlers = new Map();
  const eventHandlers = new Map();
  const emitted = [];
  const pi = {
    registerTool() {}, registerCommand() {}, on(name, handler) { handlers.set(name, handler); }, sendMessage() {},
    events: {
      on(name, handler) { eventHandlers.set(name, handler); return () => eventHandlers.delete(name); },
      emit(name, payload) { emitted.push({ name, payload }); },
    },
  };
  const ctx = { cwd: dir, ui: { notify() {}, setStatus() {}, setWidget() {} } };
  await extension(pi, workerOptions);
  t.after(() => handlers.get('session_shutdown')({}, ctx));

  const request = {
    version: 1, requestId: 'request-1', task: 'hold', title: 'Inspect goal worker', cwd: dir,
    goal: { id: 'goal-child', parentId: 'goal-parent', storePath: path.join(dir, 'goals.json'), contextWindowId: '42', parentContextWindowId: '41', capabilityFile: path.join(dir, 'capability'), role: 'planner' },
  };
  await eventHandlers.get('pi-bot:goal-worker:request:v1')(request);
  const started = emitted.find(event => event.name === 'pi-bot:goal-worker:started:v1');
  assert.ok(started);
  assert.equal(started.payload.requestId, request.requestId);
  assert.equal(started.payload.parentGoalId, 'goal-parent');
  assert.ok(!launches[0].args.includes('--no-session'));
  assert.match(launches[0].args[launches[0].args.indexOf('--exclude-tools') + 1], /spawn/);
  assert.match(launches[0].args[launches[0].args.indexOf('--exclude-tools') + 1], /subagent/);
  assert.doesNotMatch(launches[0].args[launches[0].args.indexOf('--exclude-tools') + 1], /goal_delegate/);
  await until(() => fs.existsSync(launches[0].ready));
  assert.deepEqual(JSON.parse(fs.readFileSync(launches[0].ready, 'utf8')), {
    task: 'hold', topic: null, goalId: 'goal-child', goalStore: path.join(dir, 'goals.json'), contextWindowId: '42', parentContextWindowId: '41', role: 'planner', capabilityFile: path.join(dir, 'capability'),
  });
  process.kill(started.payload.pid, 'SIGUSR1');
  await until(() => emitted.some(event => event.name === 'pi-bot:goal-worker:report:v1'));
  const report = emitted.find(event => event.name === 'pi-bot:goal-worker:report:v1').payload;
  assert.deepEqual({ requestId: report.requestId, workerId: report.workerId, goalId: report.goalId, parentGoalId: report.parentGoalId, title: report.title, status: report.status }, {
    requestId: 'request-1', workerId: started.payload.workerId, goalId: 'goal-child', parentGoalId: 'goal-parent', title: 'Inspect goal worker', status: 'completed',
  });
  assert.match(report.report, /workers\//);
  assert.equal(emitted.some(event => event.name === 'pi-bot:goal-worker:failed:v1'), false);

  await eventHandlers.get('pi-bot:goal-worker:request:v1')({ version: 1, requestId: 'bad', task: 'x', title: 'Bad', cwd: dir, goal: { id: 'goal-child', parentId: '../forged', storePath: '/relative', contextWindowId: 'bad' } });
  const failed = emitted.at(-1);
  assert.equal(failed.name, 'pi-bot:goal-worker:failed:v1');
  assert.deepEqual(failed.payload, { version: 1, requestId: null, goalId: null, parentGoalId: null, title: null, error: 'Goal worker binding v1 is invalid' });
});

test('worker returns before completion, pins model, and reports via the authenticated inbox', async t => {
  const { manager, launches, app, start } = await setup(t);
  const job = await start('hold', { title: 'Verify inbox delivery' });
  assert.equal(job.title, 'Verify inbox delivery');
  assert.equal(job.status, 'running');
  assert.equal(manager.status(job.id).delivery, 'pending');
  assert.deepEqual(app.inbox.topics(), {});
  assert.equal(launches[0].args[launches[0].args.indexOf('--model') + 1], WORKER_MODEL);
  assert.equal(launches[0].args[launches[0].args.indexOf('--thinking') + 1], 'medium');
  assert.ok(!launches[0].args.includes('hold'), 'task must go over stdin, not process arguments');
  assert.equal(launches[0].options.env.AGENTHOOK_TOPIC, undefined);
  assert.equal(launches[0].options.env.AGENTHOOK_TOKEN, undefined);
  await until(() => fs.existsSync(launches[0].ready));
  process.kill(job.pid, 'SIGUSR1');
  await until(() => manager.status(job.id).delivery === 'accepted');
  const event = app.inbox.take('parent.reports');
  assert.equal(event.payload.workerId, job.id);
  assert.equal(event.payload.status, 'completed');
  assert.equal(event.payload.title, 'Verify inbox delivery');
  assert.equal(event.payload.text, undefined, 'completion callback carries no raw model output');
  const report = JSON.parse(fs.readFileSync(event.payload.report, 'utf8'));
  assert.equal(report.text, 'fixture result\u2028line');
  assert.equal(report.title, 'Verify inbox delivery');
  assert.equal(fs.statSync(event.payload.report).mode & 0o777, 0o600);
});

test('workers launch concurrently and never consume their parent reports', async t => {
  const { manager, launches, app, start } = await setup(t);
  app.inbox.enqueue('parent.reports', { previous: true });
  const jobs = await Promise.all([start(), start()]);
  assert.equal(app.inbox.topics()['parent.reports'], 1);
  assert.equal(manager.status().length, 2);
  await until(() => launches.every(launch => fs.existsSync(launch.ready)));
  for (const job of jobs) process.kill(job.pid, 'SIGUSR1');
  await until(() => manager.status().every(job => job.delivery === 'accepted'));
  assert.equal(app.inbox.topics()['parent.reports'], 3);
});

test('failed authentication and pre-aborted launches create no workers', async t => {
  const { launches, start } = await setup(t);
  await assert.rejects(start('hold', { token: 'wrong' }), /authentication/);
  await assert.rejects(start('hold', { signal: AbortSignal.abort() }));
  assert.equal(launches.length, 0);
});

test('cancel and session shutdown terminate owned workers; forget retains report artifacts', async t => {
  const { manager, start } = await setup(t);
  const first = await start();
  await assert.rejects(async () => manager.remove(first.id), /finish/);
  manager.cancel(first.id);
  await until(() => manager.status(first.id).delivery === 'accepted');
  assert.equal(manager.status(first.id).status, 'cancelled');
  const forgotten = manager.remove(first.id);
  assert.ok(fs.existsSync(forgotten.report));
  assert.throws(() => manager.status(first.id), /Unknown/);
  const second = await start();
  await manager.close();
  assert.equal(manager.status(second.id).status, 'cancelled');
});

test('zero exit without a successful completed assistant turn is a failure', async t => {
  const { manager, start } = await setup(t);
  for (const task of ['error', 'empty']) {
    const job = await start(task);
    await until(() => manager.status(job.id).delivery === 'accepted');
    assert.equal(manager.status(job.id).status, 'failed');
  }
});

test('spawn failure is reported and never presented as a started worker', async t => {
  const { manager, start } = await setup(t, { spawnProcess: (_command, args, options) => spawn('/nonexistent-agenthook-test-pi', args, options) });
  await assert.rejects(start(), /could not start/);
  await until(() => manager.status()[0]?.delivery === 'accepted');
  assert.equal(manager.status()[0].status, 'failed');
});

test('callback failure is separate from worker completion and is not silently retried', async t => {
  let notifications = 0;
  let callbacks = 0;
  const { manager, start } = await setup(t, {
    onDeliveryError() { notifications++; },
    request(url, options) {
      if (options.method === 'POST') { callbacks++; return Promise.resolve(new Response('', { status: 503 })); }
      return fetch(url, options);
    },
  });
  const job = await start('done');
  await until(() => manager.status(job.id).delivery === 'failed');
  assert.equal(manager.status(job.id).status, 'completed');
  assert.equal(callbacks, 1);
  assert.equal(notifications, 1);
});
