#!/usr/bin/env node
import http from 'node:http';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

function connectionTokens(headers) {
  return String(headers.connection || headers.Connection || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
}

function headersForUpstream(headers, upgrade = false) {
  const remove = new Set([...HOP_BY_HOP, ...connectionTokens(headers)]);
  if (upgrade) {
    remove.delete('connection');
    remove.delete('upgrade');
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !remove.has(name.toLowerCase())));
}

function rawHeadersForClient(rawHeaders, headers, upgrade = false) {
  const remove = new Set([...HOP_BY_HOP, ...connectionTokens(headers)]);
  if (upgrade) {
    remove.delete('connection');
    remove.delete('upgrade');
  }
  const kept = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (!remove.has(rawHeaders[index].toLowerCase())) kept.push(rawHeaders[index], rawHeaders[index + 1]);
  }
  return kept;
}

function route(url) {
  if (!url.startsWith('/')) return null;
  const question = url.indexOf('?');
  const pathname = question < 0 ? url : url.slice(0, question);
  if (pathname === '/agenthook' || pathname.startsWith('/agenthook')) {
    if (!pathname.startsWith('/agenthook/')) return { reject: true };
    return { agenthook: true, path: `${pathname.slice('/agenthook'.length)}${question < 0 ? '' : url.slice(question)}` };
  }
  return { agenthook: false, path: url };
}

function badGateway(response) {
  if (!response.headersSent && !response.destroyed) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
  if (!response.destroyed) response.end('Bad Gateway\n');
}

export function createDevRouter({
  host = process.env.DEV_ROUTER_HOST || '127.0.0.1',
  port = Number(process.env.DEV_ROUTER_PORT || 3211),
  joPort = 10000,
  agenthookPort = 3210,
} = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Development router must bind to loopback');
  const upstreamFor = target => ({ host: '127.0.0.1', port: target.agenthook ? agenthookPort : joPort, path: target.path });
  const server = http.createServer((request, response) => {
    const target = route(request.url);
    if (!target || target.reject) {
      response.writeHead(404).end();
      return;
    }
    const upstream = http.request({ ...upstreamFor(target), method: request.method, headers: headersForUpstream(request.headers) });
    let failed = false;
    let responseStarted = false;
    const fail = error => {
      if (failed) return;
      failed = true;
      if (responseStarted) {
        response.destroy(error);
        return;
      }
      badGateway(response);
    };
    upstream.once('response', upstreamResponse => {
      responseStarted = true;
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage, headersForUpstream(upstreamResponse.headers));
      upstreamResponse.once('error', fail);
      upstreamResponse.pipe(response);
    });
    upstream.once('error', fail);
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });

  server.on('upgrade', (request, socket, head) => {
    const target = route(request.url);
    if (!target || target.reject || target.agenthook) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = http.request({ ...upstreamFor(target), method: request.method, headers: headersForUpstream(request.headers, true) });
    socket.once('error', () => upstream.destroy());
    let handedOff = false;
    const closeBoth = () => {
      if (!upstream.destroyed) upstream.destroy();
      if (!socket.destroyed) socket.destroy();
    };
    upstream.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      handedOff = true;
      const rawHeaders = rawHeadersForClient(upstreamResponse.rawHeaders, upstreamResponse.headers, true);
      let response = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
      for (let index = 0; index < rawHeaders.length; index += 2) response += `${rawHeaders[index]}: ${rawHeaders[index + 1]}\r\n`;
      socket.write(`${response}\r\n`);
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
      socket.once('error', closeBoth);
      upstreamSocket.once('error', closeBoth);
      socket.once('close', () => { if (!upstreamSocket.destroyed) upstreamSocket.destroy(); });
      upstreamSocket.once('close', () => { if (!socket.destroyed) socket.destroy(); });
    });
    upstream.once('response', upstreamResponse => {
      handedOff = true;
      let response = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
      const rawHeaders = rawHeadersForClient(upstreamResponse.rawHeaders, upstreamResponse.headers);
      for (let index = 0; index < rawHeaders.length; index += 2) response += `${rawHeaders[index]}: ${rawHeaders[index + 1]}\r\n`;
      socket.write(`${response}\r\n`);
      upstreamResponse.pipe(socket);
    });
    upstream.once('error', () => {
      if (!handedOff && !socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    socket.once('close', () => upstream.destroy());
    upstream.end();
  });
  return { server, host, port };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const router = createDevRouter();
  router.server.listen(router.port, router.host, () => console.log(`dev router listening on http://${router.host}:${router.port}`));
}
