import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createDevRouter } from '../bin/dev-router.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function setup(t, joHandler, agenthookHandler) {
  const jo = http.createServer(joHandler);
  const agenthook = http.createServer(agenthookHandler);
  const joPort = await listen(jo);
  const agenthookPort = await listen(agenthook);
  const router = createDevRouter({ port: 0, joPort, agenthookPort });
  const routerPort = await listen(router.server);
  t.after(async () => Promise.all([close(router.server), close(jo), close(agenthook)]));
  return { jo, agenthook, base: `http://127.0.0.1:${routerPort}` };
}

function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = Buffer.alloc(0);
    socket.once('connect', () => socket.write(request));
    socket.on('data', chunk => { data = Buffer.concat([data, chunk]); });
    socket.once('error', reject);
    resolve({ socket, data: () => data });
  });
}

async function until(predicate) {
  const deadline = Date.now() + 1_500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not settle');
    await delay(10);
  }
}

test('routes agenthook health and authenticated POSTs with their original path, query, body, and headers', async t => {
  const received = [];
  const { base } = await setup(t, (_request, response) => response.end('jo'), (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({ url: request.url, method: request.method, authorization: request.headers.authorization, cookie: request.headers.cookie, body: Buffer.concat(chunks).toString() });
      response.end(request.url === '/health' ? 'healthy' : 'accepted');
    });
  });
  assert.equal(await (await fetch(`${base}/agenthook/health`)).text(), 'healthy');
  const response = await fetch(`${base}/agenthook/v1/webhooks/topic?wait=1`, {
    method: 'POST', headers: { authorization: 'Bearer local-token', cookie: 'session=one', 'content-type': 'application/json' }, body: '{"ready":true}',
  });
  assert.equal(await response.text(), 'accepted');
  assert.deepEqual(received, [
    { url: '/health', method: 'GET', authorization: undefined, cookie: undefined, body: '' },
    { url: '/v1/webhooks/topic?wait=1', method: 'POST', authorization: 'Bearer local-token', cookie: 'session=one', body: '{"ready":true}' },
  ]);
});

test('keeps ordinary Jo paths and end-to-end streaming intact', async t => {
  let release;
  let received;
  const waiting = new Promise(resolve => { release = resolve; });
  const { base } = await setup(t, (request, response) => {
    received = { url: request.url, host: request.headers.host, forwarded: request.headers['x-forwarded-for'], cookie: request.headers.cookie };
    response.writeHead(200, { 'set-cookie': ['one=1', 'two=2'], 'x-jo': 'yes' });
    response.write('first');
    waiting.then(() => response.end('second'));
  }, (_request, response) => response.end('agenthook'));
  const address = new URL(base);
  const response = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: address.hostname, port: address.port, path: '/vite/client?x=1', headers: { host: 'example.test', 'x-forwarded-for': '198.51.100.2', cookie: 'jo=present' } }, resolve);
    request.once('error', reject);
  });
  assert.equal(response.headers['x-jo'], 'yes');
  assert.deepEqual(response.headers['set-cookie'], ['one=1', 'two=2']);
  const chunks = [];
  let firstChunk;
  const first = new Promise(resolve => { firstChunk = resolve; });
  const ended = new Promise((resolve, reject) => {
    response.on('data', chunk => { chunks.push(chunk); firstChunk?.(); firstChunk = undefined; });
    response.once('end', resolve);
    response.once('error', reject);
  });
  await first;
  assert.equal(Buffer.concat(chunks).toString(), 'first');
  release();
  await ended;
  assert.equal(Buffer.concat(chunks).toString(), 'firstsecond');
  assert.deepEqual(received, { url: '/vite/client?x=1', host: 'example.test', forwarded: '198.51.100.2', cookie: 'jo=present' });
});

test('rejects bare and lookalike agenthook paths without reaching Jo', async t => {
  let joRequests = 0;
  const { base } = await setup(t, (_request, response) => { joRequests++; response.end('jo'); }, (_request, response) => response.end('agenthook'));
  for (const path of ['/agenthook', '/agenthookx', '/agenthooks/health', '/agenthook%2Fhealth']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  assert.equal(joRequests, 0);
});

test('passes redirect responses through without following them', async t => {
  const { base } = await setup(t, (_request, response) => response.end('jo'), (_request, response) => {
    response.writeHead(302, { location: '/other' });
    response.end();
  });
  const response = await fetch(`${base}/agenthook/redirect`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/other');
});

test('forwards Jo WebSocket upgrades, initial buffered bytes, and bidirectional data', async t => {
  let joData = Buffer.alloc(0);
  let joSocket;
  const jo = http.createServer();
  jo.on('upgrade', (request, socket, head) => {
    joSocket = socket;
    assert.equal(request.url, '/vite');
    joData = Buffer.concat([joData, head]);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nserver-head');
    socket.on('data', chunk => {
      joData = Buffer.concat([joData, chunk]);
      socket.write(`echo:${chunk}`);
    });
  });
  const agenthook = http.createServer();
  const joPort = await listen(jo);
  const agenthookPort = await listen(agenthook);
  const router = createDevRouter({ port: 0, joPort, agenthookPort });
  const port = await listen(router.server);
  t.after(async () => Promise.all([close(router.server), close(jo), close(agenthook)]));
  const { socket, data } = await rawRequest(port, 'GET /vite HTTP/1.1\r\nHost: jo.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nclient-head');
  await until(() => data().toString().includes('server-head'));
  assert.match(data().toString(), /^HTTP\/1\.1 101 Switching Protocols/);
  await until(() => joData.toString().includes('client-head'));
  socket.write('ping');
  await until(() => joData.toString().includes('ping') && data().toString().includes('echo:'));
  const socketClosed = new Promise(resolve => socket.once('close', resolve));
  socket.destroy();
  await socketClosed;
  if (joSocket && !joSocket.destroyed) {
    const joClosed = new Promise(resolve => joSocket.once('close', resolve));
    joSocket.destroy();
    await joClosed;
  }
});

test('propagates a disconnected long-poll client to Jo', async t => {
  let closed;
  const closedPromise = new Promise(resolve => { closed = resolve; });
  const { base } = await setup(t, (request, response) => {
    response.writeHead(200);
    response.write('waiting');
    request.once('close', closed);
  }, (_request, response) => response.end('agenthook'));
  await new Promise((resolve, reject) => {
    const request = http.get(`${base}/long-poll`, response => {
      response.once('data', () => { request.destroy(); resolve(); });
    });
    request.once('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  await Promise.race([closedPromise, delay(1_000).then(() => assert.fail('Jo request remained open'))]);
});

test('returns 502 for an unavailable agenthook upstream without falling back or exposing credentials', async t => {
  let joRequests = 0;
  const jo = http.createServer((_request, response) => { joRequests++; response.end('jo'); });
  const joPort = await listen(jo);
  const unused = net.createServer();
  const agenthookPort = await listen(unused);
  await close(unused);
  const router = createDevRouter({ port: 0, joPort, agenthookPort });
  const port = await listen(router.server);
  t.after(async () => Promise.all([close(router.server), close(jo)]));
  const secret = 'Bearer must-not-leak';
  const response = await fetch(`http://127.0.0.1:${port}/agenthook/v1/topics`, { headers: { authorization: secret } });
  const output = `${await response.text()}\n${JSON.stringify([...response.headers])}`;
  assert.equal(response.status, 502);
  assert.ok(!output.includes(secret));
  assert.equal(joRequests, 0);
});
