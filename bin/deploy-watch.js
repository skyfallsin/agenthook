#!/usr/bin/env node
// deploy-watch: register interest in a jo_bot deploy from a session.
//
// A session that just pushed (or whose change jojo will merge) registers the
// commit it cares about plus its OWN private agenthook topic. The durable
// deploy-fanout listener forwards the terminal deploy event (success OR
// failure) to that topic when the commit ships. The session subscribes only to
// its own topic (stream mode) and keeps working.
//
//   deploy-watch add <sha> <my-topic> [note]   register a watch
//   deploy-watch list                          show pending watches
//   deploy-watch rm <sha|topic>                remove matching watches
//
// Registry: ~/.agenthook/deploy-watch.json
//
// Typical use inside a Pi session:
//   1) subscribe to your own topic in stream mode (Pi agenthook tool):
//        {"action":"subscribe","topic":"deploy.<you>.<task>","stream":true}
//   2) register the watch:
//        deploy-watch add <your pushed sha> deploy.<you>.<task> "fix X"
//   3) keep working; the deploy result arrives as an agenthook event.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const REGISTRY = path.join(os.homedir(), '.agenthook', 'deploy-watch.json');

function load() {
  try { const r = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); return Array.isArray(r) ? r : []; }
  catch { return []; }
}
function save(entries) {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true, mode: 0o700 });
  const tmp = `${REGISTRY}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, REGISTRY);
}

const [cmd, a, b, ...rest] = process.argv.slice(2);

if (cmd === 'add') {
  const sha = String(a ?? '').toLowerCase();
  const topic = String(b ?? '');
  const note = rest.join(' ');
  if (!SHA_RE.test(sha)) { console.error('sha must be 7-40 hex chars'); process.exit(2); }
  if (!TOPIC_RE.test(topic)) { console.error('topic: letters, digits, . _ - (<=128 chars)'); process.exit(2); }
  const entries = load().filter((e) => !(e.sha === sha && e.forward_topic === topic));
  entries.push({ sha, forward_topic: topic, note: note || null, registered_at: new Date().toISOString() });
  save(entries);
  console.log(`watching ${sha.slice(0, 7)} -> ${topic}${note ? ` [${note}]` : ''}`);
} else if (cmd === 'list') {
  const entries = load();
  if (!entries.length) { console.log('(no pending watches)'); process.exit(0); }
  for (const e of entries) console.log(`${e.sha.slice(0, 7)}  ${e.forward_topic}  ${e.registered_at}${e.note ? `  [${e.note}]` : ''}`);
} else if (cmd === 'rm') {
  const key = String(a ?? '');
  const before = load();
  const after = before.filter((e) => e.sha !== key && !e.sha.startsWith(key) && e.forward_topic !== key);
  save(after);
  console.log(`removed ${before.length - after.length} watch(es)`);
} else {
  console.error('usage: deploy-watch add <sha> <my-topic> [note] | list | rm <sha|topic>');
  process.exit(2);
}
