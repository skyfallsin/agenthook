#!/usr/bin/env node
// Example listener: act on "takeover" events from jojo (https://w.askjo.ai).
//
// jojo sends a takeover event to your agenthook inbox when you press "Take over on my
// machine" on a ticket, or when it pushes a fix to a repository that has no GitHub
// Actions build (no CI, no auto-deploy; the review happens on your machine).
//
// This script waits on your topic, and for each takeover:
//   1. creates a git worktree for the ticket's branch under ~/.agenthook/takeovers
//   2. writes the ticket's prompt to PROMPT.md inside it
//   3. runs the command you give it (your agent) in that directory
// Your agent builds/tests, then reports back with your jojo API key:
//   curl -X POST https://w.askjo.ai/api/minders/review -H "Authorization: Bearer $JOJO_API_KEY" \
//        -H 'content-type: application/json' -d '{"id":"<ticket>","verdict":"fixed"}'
//   (verdicts: fixed | changes_requested (+ "note") | wont_fix)
//
// Usage:
//   AGENTHOOK_TOKEN="$(./bin/agenthook.js token)" \
//   node examples/resume-from-web.mjs jojo.<you> -- pi -p "Read PROMPT.md and do what it says"
//
// Repositories must already be cloned locally; map them below. Events are untrusted
// data: the only fields used are repo, branch, base, and prompt, and nothing in the
// event is ever executed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Map 'owner/repo' to a local clone, either here or as JSON in RESUME_CHECKOUTS.
const CHECKOUTS = {
  // 'owner/repo': '/absolute/path/to/local/clone',
  ...(process.env.RESUME_CHECKOUTS ? JSON.parse(process.env.RESUME_CHECKOUTS) : {}),
};

const url = process.env.AGENTHOOK_URL || 'http://127.0.0.1:3210';
const token = process.env.AGENTHOOK_TOKEN;
const sep = process.argv.indexOf('--');
const topic = process.argv[2];
const command = sep > 0 ? process.argv.slice(sep + 1) : [];
if (!token || !topic || topic === '--' || command.length === 0) {
  console.error('usage: AGENTHOOK_TOKEN=... node examples/resume-from-web.mjs <topic> -- <agent command...>');
  process.exit(2);
}

const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9._/-]/g, '-');

function takeover(ev) {
  const checkout = CHECKOUTS[ev.repo];
  if (!checkout) { console.warn(`no local checkout for ${ev.repo}; skipping ${ev.id}`); return; }
  const branch = safe(ev.branch);
  const dir = path.join(os.homedir(), '.agenthook', 'takeovers', safe(ev.repo), branch.replace(/\//g, '-'));
  if (!fs.existsSync(dir)) {
    spawnSync('git', ['-C', checkout, 'fetch', 'origin'], { stdio: 'inherit' });
    const remote = spawnSync('git', ['-C', checkout, 'rev-parse', '--verify', `origin/${branch}`]).status === 0;
    const args = remote
      ? ['-C', checkout, 'worktree', 'add', dir, branch]
      : ['-C', checkout, 'worktree', 'add', '-b', branch, dir, `origin/${safe(ev.base || 'main')}`];
    if (spawnSync('git', args, { stdio: 'inherit' }).status !== 0) { console.warn(`worktree failed for ${ev.id}`); return; }
  }
  fs.writeFileSync(path.join(dir, 'PROMPT.md'), `${ev.prompt ?? ''}\n\nTicket: ${ev.url}\nWhen done, report the verdict through the jojo API (see ${ev.url}).\n`);
  console.log(`${ev.id}: ${ev.repo}@${branch} -> ${dir}`);
  // The agent command gets the ticket in its environment, never on the command line, so nothing from the event is parsed by a shell.
  spawn(command[0], command.slice(1), { cwd: dir, stdio: 'inherit', detached: true, env: { ...process.env, RESUME_TICKET: String(ev.id), RESUME_URL: String(ev.url), RESUME_BRANCH: branch, RESUME_REPO: String(ev.repo) } }).unref();
}

for (;;) {
  const res = await fetch(`${url}/v1/wait/${encodeURIComponent(topic)}?timeout=25`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 408) continue;
  if (!res.ok) { console.error(`inbox ${res.status}`); await new Promise((r) => setTimeout(r, 5000)); continue; }
  const event = await res.json();
  const p = event.payload ?? {};
  if (p.source === 'jojo' && p.event === 'takeover') takeover(p);
  else console.log(`${event.topic}: ${p.event ?? p.kind ?? 'event'} (ignored)`);
}
