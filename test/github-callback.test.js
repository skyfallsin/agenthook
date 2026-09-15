import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { notifyAgenthook } from '../.github/scripts/notify-agenthook.mjs';

const env = {
  AGENTHOOK_URL: 'https://callback.example.com',
  AGENTHOOK_TOKEN: 'synthetic-test-token',
  AGENTHOOK_TOPIC: 'github.example.app',
  TEST_RESULT: 'success',
  GITHUB_REPOSITORY: 'example/app',
  GITHUB_REF_NAME: 'main',
  GITHUB_SHA: 'abc123',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
};

for (const status of ['success', 'failure', 'cancelled', 'skipped']) {
  test(`callback sends ${status} with compact run metadata`, async () => {
    let calls = 0;
    await notifyAgenthook({ ...env, TEST_RESULT: status }, async (url, options) => {
      calls++;
      assert.equal(url, 'https://callback.example.com/v1/webhooks/github.example.app');
      assert.equal(options.headers.authorization, `Bearer ${env.AGENTHOOK_TOKEN}`);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body), {
        kind: 'test', status, repository: 'example/app', branch: 'main', sha: 'abc123',
        run_url: 'https://github.com/example/app/actions/runs/123', run_attempt: '1',
      });
      return { status: 202 };
    });
    assert.equal(calls, 1);
  });
}

test('callback rejects missing or unsafe configuration before sending', async () => {
  for (const overrides of [
    { AGENTHOOK_TOKEN: '' }, { AGENTHOOK_URL: 'http://callback.example.com' },
    { AGENTHOOK_URL: 'https://user:password@callback.example.com' },
    { AGENTHOOK_URL: 'https://callback.example.com?token=value' },
    { AGENTHOOK_TOPIC: '../other' },
  ]) {
    await assert.rejects(notifyAgenthook({ ...env, ...overrides }, () => {
      assert.fail('must not send invalid configuration');
    }));
  }
});

test('callback reports rejection and network failure without retrying', async () => {
  for (const status of [200, 301, 401, 500]) {
    let calls = 0;
    await assert.rejects(notifyAgenthook(env, async () => { calls++; return { status }; }));
    assert.equal(calls, 1);
  }
  await assert.rejects(notifyAgenthook(env, async () => { throw new Error('network failure'); }));
});

test('callback command exits nonzero without exposing configured values', () => {
  const result = spawnSync(process.execPath, ['.github/scripts/notify-agenthook.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...env, AGENTHOOK_URL: 'invalid-private-url' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Agenthook callback failed/);
  assert.ok(!result.stderr.includes('invalid-private-url'));
  assert.ok(!result.stderr.includes(env.AGENTHOOK_TOKEN));
});
