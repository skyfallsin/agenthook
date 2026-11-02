#!/usr/bin/env node
// Durable deploy fan-out listener.
//
// Topology:
//   GitHub Actions (jo_bot fly.yml notify-agenthook) --POST--> agenthook topic
//     github.skyfallsin.jo_bot.deploy
//   This process is the ONLY subscriber to that topic (stream mode). It never
//   competes with your herdr sessions. On each terminal deploy event it finds
//   which registered sessions were waiting on a commit that shipped in this
//   deploy, and forwards the event to each session's own private topic. Those
//   sessions subscribe only to their own topic, so they never race each other.
//
// Why a fan-out: jojo now does most jo_bot merges/deploys, and a plain
//   one-shot subscription on the shared deploy topic only ever catches one
//   event and then expires. Sessions instead register "tell me when <sha>
//   deploys" and get forwarded exactly their own result.
//
// Ancestry is resolved with GitHub's compare API (authoritative, no local
// clone, no fetch, no working tree touched):
//   GET /repos/<repo>/compare/<deployed_sha>...<watched_sha>
//   status "identical" or "behind" => watched_sha shipped in <deployed_sha>.
//
// Registry: ~/.agenthook/deploy-watch.json  (array of entries, see deploy-watch).
// Events are untrusted; only status/sha/branch/repository/run_url are read, and
// a watched sha is only ever used in an authenticated API path after a strict
// hex check. Nothing from an event is executed.
//
// Usage:
//   AGENTHOOK_TOKEN="$(./bin/agenthook.js token)" \
//   GITHUB_TOKEN="$(gh auth token)" \
//   node examples/deploy-fanout.mjs github.skyfallsin.jo_bot.deploy skyfallsin/jo_bot

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.env.AGENTHOOK_URL || 'http://127.0.0.1:3210';
const token = process.env.AGENTHOOK_TOKEN;
const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const topic = process.argv[2];
const repo = process.argv[3]; // owner/repo, e.g. skyfallsin/jo_bot

if (!token || !topic || !repo) {
  console.error('usage: AGENTHOOK_TOKEN=... GITHUB_TOKEN=... node examples/deploy-fanout.mjs <topic> <owner/repo>');
  process.exit(2);
}
if (!ghToken) {
  console.error('deploy-fanout: GITHUB_TOKEN (or GH_TOKEN) is required for ancestry checks; set it from `gh auth token`');
  process.exit(2);
}

const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const REGISTRY = path.join(os.homedir(), '.agenthook', 'deploy-watch.json');
const TTL_MS = Number(process.env.DEPLOY_WATCH_TTL_MS) || 24 * 60 * 60 * 1000; // drop stale watches after 24h

function loadRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function saveRegistry(entries) {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true, mode: 0o700 });
  const tmp = `${REGISTRY}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, REGISTRY);
}

// Is `watched` contained in the deploy at `deployed`? Authoritative, via GitHub.
async function shippedIn(deployed, watched, cache) {
  if (deployed === watched || deployed.startsWith(watched) || watched.startsWith(deployed)) return true;
  const key = `${deployed}:${watched}`;
  if (cache.has(key)) return cache.get(key);
  let result = false;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/compare/${deployed}...${watched}`, {
      headers: {
        authorization: `Bearer ${ghToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'deploy-fanout',
      },
    });
    if (res.ok) {
      const j = await res.json();
      // base=deployed, head=watched: "identical"/"behind" => watched is an ancestor of deployed.
      result = j.status === 'identical' || j.status === 'behind';
    } else {
      console.warn(`compare ${deployed.slice(0, 7)}...${watched.slice(0, 7)}: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`compare failed: ${String(e)}`);
  }
  cache.set(key, result);
  return result;
}

async function forward(forwardTopic, event, watched) {
  const res = await fetch(`${url}/v1/webhooks/${encodeURIComponent(forwardTopic)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...event.payload, kind: 'deployment', watched_sha: watched, forwarded_by: 'deploy-fanout' }),
  }).catch((e) => ({ ok: false, status: 0, statusText: String(e) }));
  return res.ok;
}

async function onDeploy(event) {
  const p = event.payload ?? {};
  const deployed = String(p.sha ?? '').toLowerCase();
  const status = String(p.status ?? '');
  if (!SHA_RE.test(deployed)) { console.warn(`deploy event missing a valid sha; ignoring`); return; }

  const entries = loadRegistry();
  const now = Date.now();
  const cache = new Map();
  const kept = [];
  let matched = 0;

  for (const e of entries) {
    const watched = String(e.sha ?? '').toLowerCase();
    const fwd = String(e.forward_topic ?? '');
    const age = now - Date.parse(e.registered_at ?? 0);
    if (!SHA_RE.test(watched) || !TOPIC_RE.test(fwd)) continue;      // drop malformed
    if (Number.isFinite(age) && age > TTL_MS) { console.log(`drop stale watch ${watched.slice(0, 7)} -> ${fwd}`); continue; }

    if (await shippedIn(deployed, watched, cache)) {
      const ok = await forward(fwd, event, watched);
      matched++;
      console.log(`${status} ${deployed.slice(0, 7)} contains ${watched.slice(0, 7)} -> ${fwd} (${ok ? 'forwarded' : 'FORWARD FAILED'})${e.note ? ` [${e.note}]` : ''}`);
      // Forwarded a terminal status for this watch: done. Drop it.
      continue;
    }
    kept.push(e); // not in this deploy yet; keep waiting
  }

  if (matched || kept.length !== entries.length) saveRegistry(kept);
  console.log(`deploy ${status} ${deployed.slice(0, 7)} (${p.branch ?? '?'}): ${matched} forwarded, ${kept.length} still waiting`);
}

console.log(`deploy-fanout: listening on ${topic} for ${repo}; registry ${REGISTRY}`);
for (;;) {
  let res;
  try {
    res = await fetch(`${url}/v1/wait/${encodeURIComponent(topic)}?timeout=25`, { headers: { authorization: `Bearer ${token}` } });
  } catch (e) {
    console.error(`inbox unreachable: ${String(e)}`); await new Promise((r) => setTimeout(r, 5000)); continue;
  }
  if (res.status === 408) continue;            // long-poll timeout, re-arm
  if (!res.ok) { console.error(`inbox ${res.status}`); await new Promise((r) => setTimeout(r, 5000)); continue; }
  const event = await res.json();
  const p = event.payload ?? {};
  if (p.kind === 'deployment') { await onDeploy(event); }
  else console.log(`${event.topic}: non-deployment payload (ignored)`);
}
