#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const host = process.env.AGENTHOOK_HOST || '127.0.0.1';
const port = process.env.AGENTHOOK_PORT || '3210';
const base = `http://${host}:${port}`;
const tokenFile = path.join(process.env.AGENTHOOK_DATA_DIR || path.join(os.homedir(), '.agenthook'), 'token');
const args = process.argv.slice(2);
const [command, topic, ...rest] = args;

function token() {
  if (process.env.AGENTHOOK_TOKEN) return process.env.AGENTHOOK_TOKEN;
  return fs.readFileSync(tokenFile, 'utf8').trim();
}
function usage() {
  console.error('Usage: agenthook <token|topics|wait <topic> [--timeout seconds]|send <topic> <JSON>|github configure <owner/repo> --url <https-url> [--topic <topic>] --confirm>');
  process.exit(2);
}
function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function configureGithub(args) {
  const [repository] = args;
  const url = option(args, '--url');
  const webhookTopic = option(args, '--topic') || `github.${repository?.replace('/', '.')}`;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !url || !/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(url) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(webhookTopic) || !args.includes('--confirm')) usage();
  const setSecret = (name, value) => {
    const result = spawnSync('gh', ['secret', 'set', name, '--repo', repository], {
      input: `${value}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) throw new Error(`could not run gh: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`could not set ${name}: ${result.stderr.trim() || `gh exited ${result.status}`}`);
  };
  setSecret('AGENTHOOK_URL', url.replace(/\/$/, ''));
  setSecret('AGENTHOOK_TOKEN', token());
  setSecret('AGENTHOOK_TOPIC', webhookTopic);
  process.stdout.write(`${JSON.stringify({ configured: true, repository, secrets: ['AGENTHOOK_URL', 'AGENTHOOK_TOKEN', 'AGENTHOOK_TOPIC'], topic: webhookTopic }, null, 2)}\n`);
}
async function call(endpoint, options = {}) {
  return fetch(`${base}${endpoint}`, { ...options, headers: { authorization: `Bearer ${token()}`, ...options.headers } });
}

if (command === 'token') {
  process.stdout.write(`${token()}\n`);
} else if (command === 'topics') {
  const response = await call('/v1/topics');
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
} else if (command === 'wait' && topic) {
  const index = rest.indexOf('--timeout');
  const timeout = index < 0 ? 300 : Number(rest[index + 1]);
  if (!Number.isFinite(timeout) || timeout < 1) usage();
  const response = await call(`/v1/wait/${encodeURIComponent(topic)}?timeout=${timeout}`);
  if (response.status === 408) process.exit(3);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
} else if (command === 'send' && topic && rest.length === 1) {
  let payload;
  try { payload = JSON.parse(rest[0]); } catch { throw new Error('send payload must be valid JSON'); }
  const response = await call(`/v1/webhooks/${encodeURIComponent(topic)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
} else if (command === 'github' && topic === 'configure') {
  configureGithub(rest);
} else {
  usage();
}
