import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgenthookServer } from '../server.js';

async function running(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthook-'));
  const app = createAgenthookServer({
    dataDir, eventFile: path.join(dataDir, 'events.json'), tokenFile: path.join(dataDir, 'token'),
    host: '127.0.0.1', port: 0, token: 'test-token', maxEvents: 1000, ttlMs: 86_400_000,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => { app.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { app, base, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' } };
}

test('accepts a webhook and delivers it once to its topic', async (t) => {
  const { base, headers } = await running(t);
  const posted = await fetch(`${base}/v1/webhooks/build-42`, { method: 'POST', headers, body: '{"ready":true}' });
  assert.equal(posted.status, 202);
  const first = await fetch(`${base}/v1/wait/build-42?timeout=1`, { headers });
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).payload, { ready: true });
  const topics = await fetch(`${base}/v1/topics`, { headers });
  assert.deepEqual((await topics.json()).topics, {});
});

test('requires the bearer token before accepting webhooks', async (t) => {
  const { base } = await running(t);
  const response = await fetch(`${base}/v1/webhooks/private`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 401);
});

test('returns a timeout when no event arrives', async (t) => {
  const { base, headers } = await running(t);
  const response = await fetch(`${base}/v1/wait/empty?timeout=1`, { headers });
  assert.equal(response.status, 408);
});
