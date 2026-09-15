import { pathToFileURL } from 'node:url';

export async function notifyAgenthook(env = process.env, request = fetch) {
  const required = ['AGENTHOOK_URL', 'AGENTHOOK_TOKEN', 'AGENTHOOK_TOPIC',
    'TEST_RESULT', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME', 'GITHUB_SHA',
    'GITHUB_SERVER_URL', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'];
  if (required.some((key) => !env[key])) throw new Error('Missing callback configuration');
  const url = new URL(env.AGENTHOOK_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Callback requires a plain HTTPS URL');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(env.AGENTHOOK_TOPIC)) {
    throw new Error('Invalid callback topic');
  }
  const response = await request(`${url.href.replace(/\/$/, '')}/v1/webhooks/${env.AGENTHOOK_TOPIC}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${env.AGENTHOOK_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'test',
      status: env.TEST_RESULT,
      repository: env.GITHUB_REPOSITORY,
      branch: env.GITHUB_REF_NAME,
      sha: env.GITHUB_SHA,
      run_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      run_attempt: env.GITHUB_RUN_ATTEMPT,
    }),
  });
  if (response.status !== 202) throw new Error('Callback was not accepted');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await notifyAgenthook();
    console.log('Test result accepted by agenthook');
  } catch {
    // Do not print request errors: they may include the configured URL or headers.
    console.error('Agenthook callback failed; check configuration and listener availability');
    process.exitCode = 1;
  }
}
