import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCommandRunner } from '../lib/command-runner.js';
import { createAgenthookServer } from '../server.js';

async function runningInbox(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthook-command-runner-'));
  const app = createAgenthookServer({
    dataDir,
    eventFile: path.join(dataDir, 'events.json'),
    tokenFile: path.join(dataDir, 'token'),
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    maxEvents: 1000,
    ttlMs: 86_400_000,
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    url: `http://127.0.0.1:${app.server.address().port}`,
    token: 'test-token',
    async events(topic, count) {
      const headers = { authorization: 'Bearer test-token' };
      const events = [];
      for (let index = 0; index < count; index += 1) {
        const response = await fetch(`http://127.0.0.1:${app.server.address().port}/v1/wait/${topic}?timeout=1`, { headers });
        assert.equal(response.status, 200);
        events.push(await response.json());
      }
      return events;
    },
  };
}

function fixture(t, name, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthook-command-fixture-'));
  const file = path.join(directory, `${name}.mjs`);
  fs.writeFileSync(file, source);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return file;
}

test('command runner publishes ordered progress and terminal events without leaking command details', async (t) => {
  const inbox = await runningInbox(t);
  const child = fixture(t, 'succeeds', 'setTimeout(() => process.exit(0), 1_250);\n');
  const runCommand = createCommandRunner();

  const result = await runCommand({
    topic: 'command.success',
    command: process.execPath,
    args: [child, 'private-argument'],
    heartbeatEverySeconds: 1,
    url: inbox.url,
    token: inbox.token,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.match(result.runId, /^[0-9a-f-]{36}$/);
  const payloads = (await inbox.events('command.success', 3)).map(event => event.payload);
  assert.deepEqual(payloads.map(payload => payload.stage), ['started', 'progress', 'completed']);
  assert.deepEqual(payloads.map(payload => payload.runId), [result.runId, result.runId, result.runId]);
  assert.equal(payloads[1].progressSequence, 1);
  assert.equal(payloads[2].progressSequence, 1);
  for (const payload of payloads) {
    assert.equal(Object.hasOwn(payload, 'command'), false);
    assert.equal(Object.hasOwn(payload, 'args'), false);
    assert.equal(Object.hasOwn(payload, 'output'), false);
    assert.doesNotMatch(JSON.stringify(payload), /private-argument/);
  }
});

test('command runner reports a nonzero fixture exit as failed', async (t) => {
  const inbox = await runningInbox(t);
  const child = fixture(t, 'fails', 'process.exit(7);\n');
  const runCommand = createCommandRunner();

  const result = await runCommand({
    topic: 'command.failure', command: process.execPath, args: [child], heartbeatEverySeconds: 0, url: inbox.url, token: inbox.token,
  });

  assert.deepEqual({ status: result.status, exitCode: result.exitCode }, { status: 'failed', exitCode: 7 });
  const payloads = (await inbox.events('command.failure', 2)).map(event => event.payload);
  assert.deepEqual(payloads.map(payload => payload.stage), ['started', 'failed']);
  assert.deepEqual(payloads.map(payload => payload.runId), [result.runId, result.runId]);
  assert.equal(payloads[1].exitCode, 7);
});

test('command runner validates input before spawning or publishing', async (t) => {
  const inbox = await runningInbox(t);
  let spawned = false;
  const runCommand = createCommandRunner({
    spawnProcess() { spawned = true; throw new Error('should not spawn'); },
  });
  const base = { command: process.execPath, args: [], heartbeatEverySeconds: 0, url: inbox.url, token: inbox.token };

  await assert.rejects(runCommand({ ...base, topic: '../invalid' }), /valid topic/);
  await assert.rejects(runCommand({ ...base, topic: 'command.validation', heartbeatEverySeconds: -1 }), /non-negative integer/);
  await assert.rejects(runCommand({ ...base, topic: 'command.validation', command: '' }), /program after --/);
  assert.equal(spawned, false);
  assert.deepEqual((await fetch(`${inbox.url}/v1/topics`, { headers: { authorization: 'Bearer test-token' } })).status, 200);
});
