import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function validate({ topic, command, args, heartbeatEverySeconds, url, token }) {
  if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) throw new Error('run requires a valid topic');
  if (typeof command !== 'string' || !command) throw new Error('run requires a program after --');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('run arguments must be strings');
  if (!Number.isSafeInteger(heartbeatEverySeconds) || heartbeatEverySeconds < 0) throw new Error('--heartbeat-every-secs must be a non-negative integer');
  if (typeof url !== 'string' || typeof token !== 'string' || !token) throw new Error('agenthook URL or token is unavailable');
}

export function createCommandRunner({ spawnProcess = spawn, request = fetch, now = Date.now } = {}) {
  return async function runCommand({ topic, command, args = [], heartbeatEverySeconds = 30, url, token }) {
    validate({ topic, command, args, heartbeatEverySeconds, url, token });
    const runId = crypto.randomUUID();
    const startedAt = now();
    let sequence = 0;
    let terminal = false;
    let timer;
    let child;
    let cancelled = false;
    let sending = Promise.resolve();

    const publish = (stage, extra = {}) => {
      const payload = {
        kind: 'command', runId, stage,
        elapsedSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
        ...extra,
      };
      // Serialize sends so a slow callback cannot reorder progress and final events.
      sending = sending.catch(() => {}).then(async () => {
        try {
          const response = await request(`${url}/v1/webhooks/${encodeURIComponent(topic)}`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (response.status !== 202) throw new Error('agenthook did not accept event');
          await response.arrayBuffer();
        } catch {
          // Reporting is best effort; it must not alter the wrapped command's result.
        }
      });
      return sending;
    };
    const finish = async ({ stage, exitCode = null, signal = null }) => {
      if (terminal) return;
      terminal = true;
      clearInterval(timer);
      await publish(stage, { exitCode, signal, progressSequence: sequence });
    };

    try {
      child = spawnProcess(command, args, { shell: false, stdio: 'inherit' });
    } catch {
      await finish({ stage: 'failed' });
      return { runId, status: 'failed', exitCode: null };
    }

    const terminate = () => {
      if (!child || terminal || cancelled) return;
      cancelled = true;
      child.kill('SIGTERM');
    };
    const signals = ['SIGINT', 'SIGTERM'];
    for (const name of signals) process.once(name, terminate);
    const removeSignals = () => { for (const name of signals) process.removeListener(name, terminate); };

    return await new Promise((resolve) => {
      child.once('error', async () => {
        removeSignals();
        await finish({ stage: 'failed' });
        resolve({ runId, status: 'failed', exitCode: null });
      });
      child.once('spawn', () => {
        void publish('started');
        if (heartbeatEverySeconds > 0) {
          timer = setInterval(() => {
            if (!terminal) void publish('progress', { progressSequence: ++sequence });
          }, heartbeatEverySeconds * 1000);
        }
      });
      child.once('close', async (exitCode, signal) => {
        removeSignals();
        const status = cancelled ? 'cancelled' : exitCode === 0 && !signal ? 'completed' : 'failed';
        await finish({ stage: status, exitCode, signal });
        resolve({ runId, status, exitCode });
      });
    });
  };
}

export const runCommand = createCommandRunner();
