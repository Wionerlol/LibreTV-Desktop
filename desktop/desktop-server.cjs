const { randomBytes, timingSafeEqual } = require('node:crypto');
const { once } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const { Readable } = require('node:stream');
const { setTimeout: wait } = require('node:timers/promises');

const HOST = '127.0.0.1';
const PORT = 17888;
const AUTHORITY = HOST + ':' + PORT;
const ORIGIN = 'http://' + AUTHORITY;
const ADMISSION = 'x-libretv-desktop-admission';
const SESSION_COOKIE = 'ltv_session';
const SESSION_VALUE = /^[0-9]{13}\.[a-f0-9]{64}$/;
const JSON_LIMIT = 2 * 1024 * 1024;
const READ = new Set(['GET', 'HEAD']);
const WRITE = new Set(['/api/search', '/api/quality', '/api/live/probe', '/api/source/test', '/api/publish']);
const APP_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'cache-control', 'content-type', 'if-match', 'if-modified-since',
  'if-none-match', 'if-range', 'if-unmodified-since', 'next-router-prefetch', 'next-router-segment-prefetch',
  'next-router-state-tree', 'next-url', 'origin', 'pragma', 'range', 'referer', 'rsc',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'user-agent',
]);
const PRIVATE = new Set([
  ADMISSION, 'cookie', 'cookie2', 'authorization', 'proxy-authorization', 'host', 'connection',
  'content-length', 'accept-encoding', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer', 'expect',
  'forwarded', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
]);
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: http: data: blob:", "media-src 'self' https: http: blob:",
  "connect-src 'self' https: http:", "worker-src 'self' blob:", "font-src 'self' data:",
  "frame-ancestors 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

function urlFor(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isAppUrl(value) {
  return urlFor(value)?.origin === ORIGIN;
}

function isExternalUrl(url) {
  if (!url || url.origin === ORIGIN) return false;
  const hostname = url.hostname.replace(/\.$/, '');
  if (hostname.startsWith('[')) {
    return /^\[[23][a-f0-9]{3}:/.test(hostname) &&
      !/^\[(?:2002:|2001:(?:0|db8):)/.test(hostname);
  }
  if (net.isIPv4(hostname)) {
    const [first, second, third] = hostname.split('.').map(Number);
    return first > 0 && first < 224 && first !== 10 && first !== 127 &&
      !(first === 100 && second >= 64 && second <= 127) &&
      !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31) &&
      !(first === 192 && (second === 168 || (second === 0 && (third === 0 || third === 2)))) && !(first === 198 && (second === 18 || second === 19));
  }
  return hostname.includes('.') && !/\.(?:localhost|local|internal|lan|home\.arpa)$/.test(hostname);
}

function response(status) {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

function pathnameAllowed(method, pathname, bootstrap) {
  if (pathname.startsWith('/.libretv-session/') || /%5c|%00/i.test(pathname)) return false;
  if (bootstrap) return (method === 'POST' || method === 'GET') && pathname === '/api/auth';
  return READ.has(method) || (method === 'POST' && WRITE.has(pathname)) ||
    (method === 'DELETE' && pathname === '/api/auth');
}

function trustedRequest(request, navigation) {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin && origin !== ORIGIN) || (site && !['same-origin', 'none'].includes(site))) return false;
  if (request.initiatorOrigin === ORIGIN) return true;
  return request.initiatorOrigin === undefined && request.method === 'GET' && request.url === navigation;
}

function allowedRedirect(location, base, allow) {
  try {
    return allow(new URL(location, base).href);
  } catch {
    return false;
  }
}

function cleanRequestHeaders(headers) {
  return Object.fromEntries([...headers].filter(([name]) => APP_REQUEST_HEADERS.has(name)));
}

function cleanResponseHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if ((!PRIVATE.has(name) || name === 'content-length') && name !== 'set-cookie' && name !== 'set-cookie2') result.set(name, value);
  }
  return result;
}

async function boundedBody(request) {
  if (request.method !== 'POST') return undefined;
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('Only JSON requests are supported'), { status: 415 });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > JSON_LIMIT) throw Object.assign(new Error('JSON request exceeds the limit'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function createDesktopServer() {
  const admission = randomBytes(32).toString('base64url');
  const expected = Buffer.from(admission);
  const peers = new Map();
  const admitted = new WeakMap();
  let handleRequest;
  let navigation;
  let cookieUrl;
  let appSession;

  const server = http.createServer({
    headersTimeout: 10_000, requestTimeout: 30_000, shouldUpgradeCallback: () => false,
  }, async (req, res) => {
    const authority = admitted.get(req.socket);
    admitted.delete(req.socket);
    const supplied = Buffer.from(req.headers[ADMISSION] ?? '');
    const pathname = req.url?.split('?', 1)[0] ?? '';
    if (!authority || req.headers.host !== AUTHORITY || !pathname.startsWith('/') ||
        pathname.startsWith('//') || pathname.includes('\\') || req.headers.upgrade ||
        supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403, { 'Cache-Control': 'no-store', Connection: 'close' }).end();
      return;
    }
    if (!pathnameAllowed(req.method, pathname, authority.bootstrap)) {
      res.writeHead(405, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    if (!handleRequest) {
      res.writeHead(503, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    delete req.headers[ADMISSION];
    // The Main append is the only source of this header. Next still verifies its
    // existing HMAC session through guardRequest.
    if (authority.cookie) req.headers.cookie = SESSION_COOKIE + '=' + authority.cookie;
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (req.rawHeaders[i].toLowerCase() === ADMISSION) req.rawHeaders.splice(i, 2);
    }
    res.setHeader('Content-Security-Policy', CSP);
    try {
      await handleRequest(req, res);
    } catch {
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    }
  });
  server.maxConnections = 128;
  server.on('connection', (socket) => {
    const port = socket.remotePort;
    if (socket.remoteAddress !== HOST || !port) return;
    peers.set(port, socket);
    socket.once('close', () => {
      if (peers.get(port) === socket) peers.delete(port);
    });
  });

  async function localRequest(method, url, { headers = {}, body, cookie, bootstrap = false, signal } = {}) {
    if (!server.listening || url.origin !== ORIGIN) throw new Error('Desktop listener unavailable');
    const port = server.address().port;
    const timeout = AbortSignal.timeout(2_000);
    const opening = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const socket = net.createConnection({ host: HOST, port });
    socket.on('error', () => {});
    try {
      await once(socket, 'connect', { signal: opening });
      let peer = peers.get(socket.localPort);
      while (!peer && server.listening && !socket.destroyed) {
        await wait(5, undefined, { signal: opening });
        peer = peers.get(socket.localPort);
      }
      opening.throwIfAborted();
      if (!peer || peer.destroyed || socket.destroyed || !server.listening ||
          peer.localPort !== port || peer.remotePort !== socket.localPort) {
        throw new Error('Desktop connection is not owned');
      }
      // Only write the admission credential after both ends of this live TCP
      // connection have been correlated inside Main. No automatic retry.
      admitted.set(peer, { bootstrap, cookie });
      return await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: HOST, port, path: url.pathname + url.search, method, signal,
          createConnection: () => socket,
          headers: { ...headers, Host: AUTHORITY, Connection: 'close', [ADMISSION]: admission,
            ...(body ? { 'Content-Length': body.length } : {}) },
        }, resolve);
        req.once('error', reject);
        req.setTimeout(60_000, () => req.destroy(new Error('Desktop request stalled')));
        req.end(body);
      });
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  async function sessionValue() {
    const cookies = await appSession.cookies.get({ url: cookieUrl, name: SESSION_COOKIE });
    return cookies.find((cookie) => cookie.httpOnly && cookie.hostOnly &&
      cookie.path === new URL(cookieUrl).pathname && SESSION_VALUE.test(cookie.value))?.value;
  }

  async function bootstrap(session, password) {
    if (appSession) throw new Error('Desktop session already initialized');
    appSession = session;
    cookieUrl = ORIGIN + '/.libretv-session/' + randomBytes(24).toString('hex');
    const authUrl = new URL('/api/auth', ORIGIN);
    const login = await localRequest('POST', authUrl, {
      headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ password })),
      bootstrap: true, signal: AbortSignal.timeout(8_000),
    });
    const issued = (login.headers['set-cookie'] ?? []).find((entry) =>
      entry.startsWith(SESSION_COOKIE + '=') && /;\s*httponly(?:;|$)/i.test(entry));
    const value = issued?.split(';', 1)[0].slice(SESSION_COOKIE.length + 1);
    for await (const _ of login) { /* Drain the small local auth response. */ }
    if (login.statusCode !== 200 || !value || !SESSION_VALUE.test(value)) throw new Error('Desktop login was rejected');
    // Electron cookies are host scoped. This unused, random path keeps the
    // browser from automatically attaching the session to application requests.
    await session.cookies.set({
      url: cookieUrl, path: new URL(cookieUrl).pathname, name: SESSION_COOKIE, value,
      httpOnly: true, sameSite: 'strict', secure: false,
    });
    const stored = await sessionValue();
    if (stored !== value) throw new Error('Desktop session could not be installed');
    const verified = await localRequest('GET', authUrl, {
      bootstrap: true, cookie: stored, signal: AbortSignal.timeout(8_000),
    });
    const result = await new Response(Readable.toWeb(verified)).json();
    if (verified.statusCode !== 200 || result.verified !== true) throw new Error('Desktop session verification failed');
  }

  async function serve(request, url) {
    if (!trustedRequest(request, navigation)) return response(403);
    if (!pathnameAllowed(request.method, url.pathname, false)) return response(405);
    try {
      const cookie = await sessionValue();
      if (!cookie) return response(401);
      const reply = await localRequest(request.method, url, {
        headers: cleanRequestHeaders(request.headers), body: await boundedBody(request),
        cookie, signal: request.signal,
      });
      const headers = cleanResponseHeaders(reply.headers);
      const location = headers.get('location');
      if (location && !allowedRedirect(location, url, isAppUrl)) {
        reply.destroy();
        return response(502);
      }
      if (request.method === 'DELETE' && url.pathname === '/api/auth' && reply.statusCode === 200) {
        await appSession.cookies.remove(cookieUrl, SESSION_COOKIE);
      }
      const noBody = request.method === 'HEAD' || [204, 205, 304].includes(reply.statusCode);
      if (noBody) reply.resume();
      return new Response(noBody ? null : Readable.toWeb(reply), { status: reply.statusCode, headers });
    } catch (error) {
      return response(error.status === 413 || error.status === 415 ? error.status : 502);
    }
  }

  async function external(request, url) {
    if (!isExternalUrl(url) || request.initiatorOrigin !== ORIGIN ||
        (!READ.has(request.method) && request.method !== 'OPTIONS')) return response(403);
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const family = net.isIP(hostname);
      const addresses = family ? [{ address: hostname, family }] : await dns.lookup(hostname, { all: true });
      if (!addresses.length || addresses.some(({ address, family }) =>
        !isExternalUrl(urlFor('https://' + (family === 6 ? '[' + address + ']' : address))))) return response(403);

      const allowed = ['accept', 'accept-language', 'access-control-request-headers',
        'access-control-request-method', 'if-none-match', 'if-modified-since', 'range', 'user-agent'];
      const outgoing = Object.fromEntries([...request.headers].filter(([name]) => allowed.includes(name)));
      const cors = request.headers.get('sec-fetch-mode') === 'cors' || request.headers.has('origin');
      if (cors) outgoing.origin = ORIGIN;
      outgoing['accept-encoding'] = 'identity';
      const address = addresses[0];
      const client = url.protocol === 'https:' ? https : http;
      const reply = await new Promise((resolve, reject) => {
        const req = client.request(url, {
          method: request.method, agent: false, headers: outgoing, signal: request.signal,
          // Pin the exact validated peer. Another DNS answer cannot be used to connect.
          autoSelectFamily: false, lookup: (_name, _options, done) => done(null, address.address, address.family),
        }, resolve);
        req.once('error', reject);
        req.setTimeout(30_000, () => req.destroy(new Error('Media request stalled')));
        req.end();
      });
      const headers = cleanResponseHeaders(reply.headers);
      const allowedOrigin = headers.get('access-control-allow-origin');
      if (cors && allowedOrigin !== ORIGIN && allowedOrigin !== '*') {
        reply.destroy();
        return Response.error();
      }
      const location = headers.get('location');
      if (location && !allowedRedirect(location, url, (value) => isExternalUrl(urlFor(value)))) {
        reply.destroy();
        return response(502);
      }
      const noBody = request.method === 'HEAD' || [204, 205, 304].includes(reply.statusCode);
      if (noBody) reply.resume();
      return new Response(noBody ? null : Readable.toWeb(reply), { status: reply.statusCode, headers });
    } catch {
      return response(502);
    }
  }

  function bindWindow(window) {
    const { webContents } = window;
    if (appSession !== webContents.session) throw new Error('Unexpected desktop session');
    appSession.setPermissionCheckHandler(() => false);
    appSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    appSession.setDevicePermissionHandler(() => false);
    appSession.on('will-download', (event) => event.preventDefault());
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.on('will-attach-webview', (event) => event.preventDefault());
    webContents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame || !isAppUrl(event.url)) event.preventDefault();
    });
    webContents.on('will-redirect', (event) => {
      if (!event.isMainFrame || !isAppUrl(event.url)) event.preventDefault();
    });
    // Native requests, including any request that bypasses protocol interception,
    // never carry an app secret. Filter cookies case-insensitively.
    appSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders;
      for (const name of Object.keys(headers)) {
        if ([ADMISSION, 'cookie', 'cookie2'].includes(name.toLowerCase())) delete headers[name];
      }
      callback({ requestHeaders: headers });
    });
    const intercept = (request) => {
      const url = urlFor(request.url);
      return url?.origin === ORIGIN ? serve(request, url) : external(request, url);
    };
    appSession.protocol.handle('http', intercept);
    appSession.protocol.handle('https', intercept);
  }

  async function load(window, route) {
    const url = new URL(route, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error('Unexpected desktop navigation');
    navigation = url.href;
    try {
      await window.loadURL(navigation);
    } finally {
      navigation = undefined;
    }
  }

  return { server, bindWindow, load, bootstrap, enable: (handler) => { handleRequest = handler; } };
}

module.exports = { HOST, PORT, ORIGIN, createDesktopServer };
