import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createDevRouter } from '../bin/dev-router.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

test('Apple override preserves other Jo and agenthook routes', async () => {
  const canonical = http.createServer((req, res) => res.end(`jo:${req.url}`));
  const hooks = http.createServer((req, res) => res.end(`hooks:${req.url}`));
  const apple = http.createServer((req, res) => res.end(`apple:${req.url}`));
  const joPort = await listen(canonical);
  const agenthookPort = await listen(hooks);
  const appleMessagesPort = await listen(apple);
  const { server } = createDevRouter({ port: 0, joPort, agenthookPort, appleMessagesPort });
  const port = await listen(server);
  try {
    for (const [path, expected] of [
      ['/v1/apple-messages/contact', 'apple:/v1/apple-messages/contact'],
      ['/v1/apple-messages/stream-event?x=1', 'apple:/v1/apple-messages/stream-event?x=1'],
      ['/__apple-support/dist/panel.js', 'apple:/__apple-support/dist/panel.js'],
      ['/v1/apple-messages/linq/webhook', 'jo:/v1/apple-messages/linq/webhook'],
      ['/v1/apple-messages/contact-extra', 'jo:/v1/apple-messages/contact-extra'],
      ['/v1/telegram', 'jo:/v1/telegram'],
      ['/agenthook/health', 'hooks:/health'],
    ]) {
      assert.equal(await (await fetch(`http://127.0.0.1:${port}${path}`)).text(), expected);
    }
  } finally {
    await Promise.all([server, canonical, hooks, apple].map(close));
  }
});
