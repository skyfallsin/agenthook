import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WORKER_MODEL = 'jo-llm-proxy/gpt-5.6-terra';
const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const GUIDANCE = `You are a delegated coding worker. Read repository instructions before acting. Stay within the assigned scope and preserve unrelated work. Do not commit, push, install, launch apps, change live configuration, or send external messages unless the task explicitly authorizes it. Do not delegate further or subscribe to agenthook: your supervisor sends your completion to the parent. Never include secrets or private data in your final report. Report changed paths, tests actually run, findings and blockers. First verify PI_MODEL=gpt-5.6-terra and PI_REASONING_LEVEL=medium with bash; stop on a mismatch.`;

function workerTitle(title, task) {
  const text = (typeof title === 'string' && title.trim() ? title : task).replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function createWorkerManager({
  dataDir = process.env.AGENTHOOK_DATA_DIR || path.join(os.homedir(), '.agenthook'),
  command = 'pi', spawnProcess = spawn, request = fetch, onDeliveryError = () => {}, onStatusChange = () => {},
} = {}) {
  const jobs = new Map();
  let closed = false;
  const view = job => ({ id: job.id, title: job.title, topic: job.topic, status: job.status, delivery: job.delivery,
    model: WORKER_MODEL, thinking: 'medium', pid: job.child?.pid ?? null, report: job.report });
  const notifyStatusChange = job => {
    try { onStatusChange(view(job)); } catch { /* Status rendering must never affect worker lifecycle. */ }
  };
  const save = job => {
    fs.writeFileSync(path.join(job.dir, 'status.json'), JSON.stringify(view(job), null, 2), { mode: 0o600 });
    notifyStatusChange(job);
  };
  const get = id => {
    const job = jobs.get(id);
    if (!job) throw new Error('Unknown worker in this session');
    return job;
  };
  const cancel = id => {
    const job = get(id);
    if (!['starting', 'running', 'cancelling'].includes(job.status)) return view(job);
    job.status = 'cancelling';
    const kill = signal => {
      try {
        if (process.platform !== 'win32' && job.child.pid) process.kill(-job.child.pid, signal);
        else job.child.kill(signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    kill('SIGTERM');
    if (!job.killTimer) job.killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    save(job);
    return view(job);
  };
  return {
    async start({ task, title, cwd, topic, url, token, signal, beforeSpawn = () => {} }) {
      if (closed) throw new Error('Worker manager is closed');
      if (typeof task !== 'string' || !task.trim()) throw new Error('start requires a task');
      if (title !== undefined && (typeof title !== 'string' || !title.trim())) throw new Error('title must be a non-empty string when provided');
      if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) throw new Error('Invalid report topic');
      if (typeof cwd !== 'string' || !fs.statSync(cwd).isDirectory()) throw new Error('Worker cwd must be a directory');
      signal?.throwIfAborted();
      // Authenticate without consuming an event; do not launch blind into a broken inbox.
      const check = await request(`${url}/v1/topics`, {
        headers: { authorization: `Bearer ${token}` }, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });
      if (!check.ok) throw new Error('Agenthook is unavailable or authentication failed; worker not started');
      await check.arrayBuffer();
      signal?.throwIfAborted();
      if (closed) throw new Error('Worker manager is closed');
      beforeSpawn();
      const id = crypto.randomUUID();
      const dir = path.join(dataDir, 'workers', id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const report = path.join(dir, 'report.json');
      const stdout = fs.openSync(path.join(dir, 'events.jsonl'), 'wx', 0o600);
      const stderr = fs.openSync(path.join(dir, 'stderr.log'), 'wx', 0o600);
      const env = { ...process.env };
      // No inherited subscription or stale parent session identity in the worker.
      for (const key of ['AGENTHOOK_TOPIC', 'AGENTHOOK_TOKEN', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL']) delete env[key];
      const args = ['--mode', 'json', '-p', '--no-session', '--model', WORKER_MODEL, '--thinking', 'medium',
        '--exclude-tools', 'agenthook,agenthook_subagent,subagent,legacy_subagent,goal_delegate', '--append-system-prompt', GUIDANCE];
      const job = { id, title: workerTitle(title, task), dir, report, topic, status: 'starting', delivery: 'pending', child: null };
      jobs.set(id, job);
      let finalMessage;
      let ended = false;
      let buffer = '';
      let finishResolve;
      job.finished = new Promise(resolve => { finishResolve = resolve; });
      let finalized = false;
      const finalize = async (code, spawnError = false) => {
        if (finalized) return;
        finalized = true;
        clearTimeout(job.killTimer);
        fs.closeSync(stdout);
        fs.closeSync(stderr);
        job.status = job.status === 'cancelling' ? 'cancelled'
          : !spawnError && code === 0 && ended && finalMessage?.stopReason === 'stop' ? 'completed' : 'failed';
        try {
          fs.writeFileSync(report, JSON.stringify({ ...view(job), exitCode: code,
            text: (finalMessage?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n'),
            stopReason: finalMessage?.stopReason ?? null,
            observedModel: finalMessage?.model ?? null,
          }, null, 2), { mode: 0o600 });
          save(job);
          // Compact metadata only. The parent can read the private full report locally.
          const response = await request(`${url}/v1/webhooks/${encodeURIComponent(topic)}`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'subagent', workerId: id, title: job.title, status: job.status, report, model: WORKER_MODEL, thinking: 'medium' }),
          });
          if (response.status !== 202 || !(await response.json()).accepted) throw new Error('Callback not accepted');
          job.delivery = 'accepted'; // Inbox acceptance, not proof the parent received it.
        } catch {
          job.delivery = 'failed';
          if (!closed) onDeliveryError(id);
        } finally {
          try { save(job); } finally { finishResolve(); }
        }
      };
      try {
        job.child = spawnProcess(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        await finalize(null, true);
        throw new Error(`Worker could not start; inspect ${report}`);
      }
      const child = job.child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        fs.writeSync(stdout, chunk);
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'message_end' && event.message?.role === 'assistant') finalMessage = event.message;
            if (event.type === 'agent_end') ended = true;
          } catch { /* Non-protocol startup diagnostics stay in the private log. */ }
        }
      });
      child.stderr.on('data', chunk => fs.writeSync(stderr, chunk));
      child.stdin.on('error', () => {}); // Early process exit is classified by close/error.
      child.once('close', code => { void finalize(code); });
      await new Promise((resolve, reject) => {
        child.once('error', () => {
          void finalize(null, true);
          reject(new Error(`Worker could not start; inspect ${report}`));
        });
        child.once('spawn', () => {
          if (job.status === 'cancelling' || closed || signal?.aborted) {
            cancel(id);
            reject(new Error(`Worker launch cancelled; inspect ${report}`));
            return;
          }
          job.status = 'running';
          save(job);
          child.stdin.end(task);
          resolve(); // Do not await output or completion.
        });
      });
      return view(job);
    },
    status(id) { return id ? view(get(id)) : [...jobs.values()].map(view); },
    cancel,
    remove(id) {
      const job = get(id);
      if (['starting', 'running', 'cancelling'].includes(job.status) || job.delivery === 'pending') throw new Error('Cancel or finish the worker before forgetting it');
      jobs.delete(id); // Private artifacts remain available; no implicit file deletion.
      return { id, forgotten: true, report: job.report };
    },
    async close() {
      closed = true;
      for (const job of jobs.values()) cancel(job.id);
      await Promise.all([...jobs.values()].map(job => job.finished));
    },
  };
}
