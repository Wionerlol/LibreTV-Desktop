const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const { setTimeout: wait } = require('node:timers/promises');
const { test } = require('node:test');
const { HOST, ORIGIN, createDesktopServer } = require('./desktop-server.cjs');

const fakeCookie = '9999999999999.' + 'a'.repeat(64);
const fixturePassword = 'fixture-password';
const cookieName = 'ltv_session';
const admissionHeader = 'x-libretv-desktop-admission';

function request(route, init, initiator = ORIGIN) {
  return Object.assign(new Request(new URL(route, ORIGIN), init), { initiatorOrigin: initiator });
}

function anonymousRequest(server) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: HOST, port: server.address().port, path: '/api/status',
      headers: { Host: new URL(ORIGIN).host },
    }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
      res.once('error', reject);
    });
    req.setTimeout(2_000, () => req.destroy(new Error('Fixture client stalled')));
    req.once('error', reject);
  });
}

async function fixture(t, { serverOptions, routes = {}, beforeLogin } = {}) {
  const bridge = createDesktopServer(serverOptions);
  const { server } = bridge;
  try {
    const ready = once(server, 'listening');
    server.listen({ host: HOST, port: 0 });
    await ready;
  } catch (error) {
    if (error.code !== 'EACCES') throw error;
    t.skip('ENVIRONMENT_BLOCKED: loopback listener returned EACCES');
    return;
  }
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });

  const events = [];
  bridge.enable(async (req, res) => {
    const addressed = req.url;
    const cookieVerified = req.headers.cookie === cookieName + '=' + fakeCookie;
    const admissionRemoved = !req.headers[admissionHeader] &&
      !req.rawHeaders.some((field, index) => index % 2 === 0 && field.toLowerCase() === admissionHeader);
    events.push({ method: req.method, addressed, cookieVerified, admissionRemoved,
      authorizationRemoved: !req.headers.authorization });
    if (addressed === '/api/auth' && req.method === 'POST') {
      const body = await new Response(ReadableStreamFromRequest(req)).json();
      assert.equal(body.password === fixturePassword, true);
      await beforeLogin?.();
      res.setHeader('Set-Cookie', cookieName + '=' + fakeCookie + '; Path=/; HttpOnly; SameSite=Lax');
      res.end('{}');
    } else if (addressed === '/api/auth') {
      res.end(JSON.stringify({ verified: cookieVerified }));
    } else if (Object.hasOwn(routes, addressed) && cookieVerified) {
      await routes[addressed](req, res);
    } else {
      res.statusCode = cookieVerified ? 200 : 401;
      res.setHeader('Set-Cookie', 'fixture_visible=ignored');
      res.end('{}');
    }
  });

  try {
    assert.equal(await anonymousRequest(server), 403);
  } catch (error) {
    if (error.code !== 'EACCES') throw error;
    t.skip('ENVIRONMENT_BLOCKED: loopback client returned EACCES');
    return;
  }
  assert.equal(events.length, 0);

  const handlers = new Map();
  const cookieCalls = [];
  let savedCookie;
  let stripHeaders;
  const session = Object.assign(new EventEmitter(), {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    setDevicePermissionHandler() {},
    webRequest: { onBeforeSendHeaders(callback) { stripHeaders = callback; } },
    protocol: { handle(scheme, handler) { handlers.set(scheme, handler); } },
    cookies: {
      async set(cookie) {
        cookieCalls.push({ path: cookie.path, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, name: cookie.name });
        savedCookie = { ...cookie, hostOnly: true };
      },
      async get({ url, name }) {
        return savedCookie?.url === url && savedCookie.name === name ? [savedCookie] : [];
      },
      async remove() { savedCookie = undefined; },
    },
  });
  await bridge.bootstrap(session, fixturePassword);
  const window = { webContents: Object.assign(new EventEmitter(), {
    session, setWindowOpenHandler() {},
  }) };
  bridge.bindWindow(window);
  const invoke = (req) => handlers.get(new URL(req.url).protocol.slice(0, -1))(req);
  return { bridge, window, invoke, stripHeaders, events, cookieCalls,
    forgetCookie: () => { savedCookie = undefined; },
    tamperCookie: () => { savedCookie = { ...savedCookie, value: fakeCookie.replace(/a$/, 'b') }; },
  };
}

function ReadableStreamFromRequest(req) {
  return require('node:stream').Readable.toWeb(req);
}

test('Main bootstraps a scoped HttpOnly cookie and admits only the policy-approved request', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  assert.deepEqual(f.events.map(({ method, addressed, cookieVerified }) => [method, addressed, cookieVerified]),
    [['POST', '/api/auth', false], ['GET', '/api/auth', true]]);
  assert.equal(f.cookieCalls.length, 1);
  const [stored] = f.cookieCalls;
  assert.equal(stored.name, cookieName);
  assert.equal(stored.httpOnly, true);
  assert.equal(stored.sameSite, 'strict');
  assert.match(stored.path, /^\/\.libretv-session\/[a-f0-9]{48}$/);

  const reply = await f.invoke(request('/api/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Cookie: 'fixture=other', Authorization: 'fixture',
      [admissionHeader]: 'fixture',
    },
    body: '{}',
  }));
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.has('set-cookie'), false);
  assert.match(reply.headers.get('content-security-policy'), /^sandbox;/);
  await reply.text();
  assert.equal(f.events.at(-1).cookieVerified, true);
  assert.equal(f.events.every((entry) => entry.admissionRemoved && entry.authorizationRemoved), true);
});

test('protocol refuses foreign or missing initiators and limits app writes', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  assert.equal((await f.invoke(new Request(ORIGIN + '/'))).status, 403);
  assert.equal((await f.invoke(request('/api/status', {}, 'https://another.example'))).status, 403);
  assert.equal((await f.invoke(request('/api/auth', { method: 'POST' }))).status, 405);
  assert.equal((await f.invoke(request('/api/search', { method: 'POST', body: '{}' }))).status, 415);
  assert.equal((await f.invoke(request('/api/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(2 * 1024 * 1024 + 1),
  }))).status, 413);
  assert.equal((await f.invoke(request('http://127.0.0.1:17889/media.m3u8'))).status, 403);
  assert.equal((await f.invoke(request('https://another.example/media.m3u8', {}, 'https://foreign.example'))).status, 403);
  assert.equal(f.events.length, 2);

  f.window.loadURL = async (url) => {
    const reply = await f.invoke(new Request(url));
    assert.equal(reply.status, 200);
    await reply.text();
  };
  await f.bridge.load(f.window, '/');
  assert.equal((await f.invoke(new Request(ORIGIN + '/'))).status, 403);
  assert.equal((await f.invoke(new Request(ORIGIN + '/fixture-worker.js'))).status, 403);
  assert.equal((await f.invoke(request('/fixture-worker.js', {}, null))).status, 403);
  const worker = await f.invoke(request('/fixture-worker.js'));
  assert.equal(worker.status, 200);
  await worker.text();
});

test('native webRequest never attaches desktop credentials to an outgoing request', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  for (const url of [ORIGIN + '/', 'http://127.0.0.1:17889/', 'https://another.example/']) {
    const headers = await new Promise((resolve) => f.stripHeaders({
      url,
      requestHeaders: { Cookie: 'fixture', Cookie2: 'fixture', 'X-LibreTV-Desktop-Admission': 'fixture', Range: 'bytes=0-1' },
    }, ({ requestHeaders }) => resolve(requestHeaders)));
    assert.deepEqual(headers, { Range: 'bytes=0-1' });
  }
});

test('external media fails closed when a hostname resolves to loopback', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const dns = require('node:dns/promises');
  const lookup = t.mock.method(dns, 'lookup', async (name, options) => {
    assert.equal(name, 'media.fixture.test');
    assert.equal(options.all, true);
    return [{ address: HOST, family: 4 }];
  });
  const port = f.bridge.server.address().port;
  const reply = await f.invoke(request('http://media.fixture.test:' + port + '/fixture.m3u8'));
  assert.equal(reply.status, 403);
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(f.events.length, 2);
});

test('authenticated media reads retain encoded paths and writes require an exact route', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const route = '/api/proxy/https%3A%2F%2Fmedia.fixture.test%2Fplaylist.m3u8';
  const reply = await f.invoke(request(route));
  assert.equal(reply.status, 200);
  await reply.text();
  assert.equal(f.events.at(-1).addressed, route);
  assert.equal(f.events.at(-1).cookieVerified, true);
  const method = 'POST';
  const headers = { 'Content-Type': 'application/json' };
  const rejected = await f.invoke(request('/api/search%2F', { method, headers, body: '{}' }));
  assert.equal(rejected.status, 405);
  assert.equal(f.events.length, 3);
});

test('only trusted requests trigger a single reauthentication, and logout survives further requests', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  if (!f) return;
  f.tamperCookie();
  assert.equal((await f.invoke(new Request(ORIGIN + '/api/status'))).status, 403);
  assert.equal(f.events.length, 2);
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.invoke(request('/api/status'))));
  await Promise.all(replies.map(async (reply) => {
    assert.equal(reply.status, 200);
    await reply.text();
  }));
  assert.equal(f.events.filter((event) => event.method === 'POST' && event.addressed === '/api/auth').length, 2);
  assert.equal(f.cookieCalls.length, 2);
  assert.equal(f.cookieCalls[0].path, f.cookieCalls[1].path);
  f.forgetCookie();
  const restored = await f.invoke(request('/api/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }));
  assert.equal(restored.status, 200);
  await restored.text();
  assert.equal(f.events.filter((event) => event.addressed === '/api/search').length, 1);
  assert.equal(f.cookieCalls.length, 3);
  const logout = await f.invoke(request('/api/auth', { method: 'DELETE' }));
  assert.equal(logout.status, 200);
  await logout.text();
  assert.equal((await f.invoke(request('/api/status'))).status, 401);
  assert.equal(f.cookieCalls.length, 3);
  assert.equal(f.events.at(-1).method, 'DELETE');
  assert.equal(f.events.at(-1).cookieVerified, true);
});

test('RSC and range requests preserve required headers and app redirects cannot escape the origin', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t, { routes: {
    '/watch?_rsc=fixture': (req, res) => {
      assert.equal(req.headers.rsc, '1');
      assert.equal(req.headers['next-router-state-tree'], 'fixture');
      res.setHeader('Content-Type', 'text/x-component');
      res.end('fixture-rsc');
    },
    '/api/proxy?url=fixture-piece.ts': (req, res) => {
      assert.equal(req.headers.range, 'bytes=1-3');
      res.writeHead(206, { 'Content-Range': 'bytes 1-3/4', 'Content-Length': 3,
        'Content-Type': 'video/mp2t', 'Accept-Ranges': 'bytes' });
      res.end(Buffer.from([1, 2, 3]));
    },
    '/redirect-app': (_req, res) => res.writeHead(302, { Location: '/live' }).end(),
    '/redirect-port': (_req, res) => res.writeHead(307, { Location: 'http://127.0.0.1:17889/fake' }).end(),
    '/redirect-external': (_req, res) => res.writeHead(302, { Location: 'https://other.example/fake' }).end(),
  } });
  if (!f) return;
  const rsc = await f.invoke(request('/watch?_rsc=fixture', { headers: { RSC: '1', 'Next-Router-State-Tree': 'fixture' } }));
  assert.equal(rsc.headers.get('content-type'), 'text/x-component');
  assert.doesNotMatch(rsc.headers.get('content-security-policy'), /^sandbox/);
  assert.equal(await rsc.text(), 'fixture-rsc');
  const partial = await f.invoke(request('/api/proxy?url=fixture-piece.ts', { headers: { Range: 'bytes=1-3' } }));
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-security-policy'), "sandbox; default-src 'none'; frame-ancestors 'none'");
  assert.equal(partial.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(partial.headers.get('content-range'), 'bytes 1-3/4');
  assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [1, 2, 3]);
  const same = await f.invoke(request('/redirect-app'));
  assert.equal(same.status, 302);
  assert.equal(same.headers.get('location'), '/live');
  await same.text();
  for (const target of ['/redirect-port', '/redirect-external']) {
    const blocked = await f.invoke(request(target));
    assert.equal(blocked.status, 502);
    assert.equal(blocked.headers.has('location'), false);
  }
});

test('cancel and timeout close app sockets before and after response headers', { timeout: 8_000 }, async (t) => {
  const lifecycle = new EventEmitter();
  let bytesWritten = 0;
  const targetTotal = 16 * 1024 * 1024;
  const f = await fixture(t, { serverOptions: { appHeaderTimeout: 350 }, routes: {
    '/abort-before-headers': (_req, res) => {
      res.once('close', () => lifecycle.emit('abort-closed'));
      lifecycle.emit('waiting');
    },
    '/never-headers': (_req, res) => {
      res.once('close', () => lifecycle.emit('timeout-closed'));
    },
    '/slow-reader.flv': async (_req, res) => {
      res.once('close', () => lifecycle.emit('reader-closed'));
      res.writeHead(200, { 'Content-Type': 'video/x-flv' });
      const chunk = Buffer.alloc(16 * 1024);
      while (bytesWritten < targetTotal && !res.destroyed) {
        bytesWritten += chunk.length;
        if (!res.write(chunk)) {
          const aborted = AbortSignal.timeout(2_000);
          try { await once(res, 'drain', { signal: aborted }); }
          catch { break; }
        }
      }
      if (!res.destroyed) res.end();
    },
  } });
  if (!f) return;
  const waiting = once(lifecycle, 'waiting');
  const abortClosed = once(lifecycle, 'abort-closed');
  const controller = new AbortController();
  const first = f.invoke(request('/abort-before-headers', { signal: controller.signal }));
  await waiting;
  controller.abort();
  assert.equal((await first).status, 502);
  await abortClosed;

  const timeoutClosed = once(lifecycle, 'timeout-closed');
  assert.equal((await f.invoke(request('/never-headers'))).status, 504);
  await timeoutClosed;

  const readerClosed = once(lifecycle, 'reader-closed');
  const stream = await f.invoke(request('/slow-reader.flv'));
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  assert.equal((await reader.read()).done, false);
  await wait(60);
  assert.ok(bytesWritten < targetTotal);
  await reader.cancel();
  await readerClosed;
  const status = await f.invoke(request('/api/status'));
  assert.equal(status.status, 200);
  await status.text();
});

test('public redirect hops are resolved independently and receive only media headers', { timeout: 6_000 }, async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ path: req.url, headers: req.headers });
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin, 'Set-Cookie': 'fixture=ignored' };
    if (req.url === '/playlist.m3u8') {
      res.writeHead(302, { ...cors, Location: 'http://second.media.fixture.test/piece.ts' }).end();
    } else if (req.url === '/private-redirect') {
      res.writeHead(307, { ...cors, Location: 'http://127.0.0.1:17889/fake' }).end();
    } else {
      res.writeHead(206, { ...cors, 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-1/2' }).end('ok');
    }
  });
  const started = once(upstream, 'listening');
  upstream.listen({ host: HOST, port: 0 });
  await started;
  t.after(async () => {
    const closed = once(upstream, 'close');
    upstream.close();
    upstream.closeAllConnections();
    await closed;
  });
  const resolutions = [];
  t.mock.method(require('node:dns/promises'), 'lookup', async (name) => {
    resolutions.push(name);
    return [{ address: name.startsWith('second') ? '8.8.4.4' : '8.8.8.8', family: 4 }];
  });
  const pins = [];
  // Replace only the fixture's final transport. No public address is contacted.
  const nativeRequest = http.request;
  t.mock.method(http, 'request', (url, settings, respond) => {
    settings.lookup(url.hostname, {}, (error, address) => {
      assert.equal(error, null);
      pins.push(address);
    });
    return nativeRequest({
      host: HOST, port: upstream.address().port, path: url.pathname + url.search,
      headers: settings.headers, method: settings.method, agent: false, signal: settings.signal,
    }, respond);
  });

  const headers = { Origin: ORIGIN, Range: 'bytes=0-1', Cookie: 'fixture', Authorization: 'fixture',
    Referer: ORIGIN + '/watch', [admissionHeader]: 'fixture' };
  const first = await f.invoke(request('http://first.media.fixture.test/playlist.m3u8', { headers }));
  assert.equal(first.status, 302);
  assert.equal(first.headers.has('set-cookie'), false);
  const location = first.headers.get('location');
  await first.text();
  const piece = await f.invoke(request(location, { headers: { ...headers, Origin: 'null' } }));
  assert.equal(piece.status, 206);
  assert.equal(piece.headers.get('content-range'), 'bytes 0-1/2');
  assert.equal(await piece.text(), 'ok');
  const blocked = await f.invoke(request('http://first.media.fixture.test/private-redirect', { headers }));
  assert.equal(blocked.status, 502);
  assert.equal(blocked.headers.has('location'), false);
  assert.deepEqual(resolutions, ['first.media.fixture.test', 'second.media.fixture.test', 'first.media.fixture.test']);
  assert.deepEqual(pins, ['8.8.8.8', '8.8.4.4', '8.8.8.8']);
  assert.equal(received.length, 3);
  for (const { headers: outbound } of received) {
    assert.equal(outbound.cookie, undefined);
    assert.equal(outbound.authorization, undefined);
    assert.equal(outbound[admissionHeader], undefined);
    assert.equal(outbound.referer, undefined);
    assert.equal(outbound.range, 'bytes=0-1');
  }
  assert.equal(received[1].headers.origin, 'null');
});

test('slow system lookup times out, holds finite slots and releases them on settlement', { timeout: 6_000 }, async (t) => {
  const f = await fixture(t, { serverOptions: { mediaHeaderTimeout: 400 } });
  if (!f) return;
  const pending = [];
  const lookup = t.mock.method(require('node:dns/promises'), 'lookup',
    () => new Promise((resolve) => pending.push(resolve)));
  const url = 'https://slow.media.fixture.test/asset.jpg';
  const stalled = Array.from({ length: 33 }, () => f.invoke(request(url)));
  assert.equal((await stalled.at(-1)).status, 429);
  assert.equal(lookup.mock.callCount(), 32);
  await Promise.all(stalled.slice(0, -1).map(async (call) => assert.equal((await call).status, 504)));
  assert.equal((await f.invoke(request(url))).status, 429);
  for (const finish of pending) finish([{ address: HOST, family: 4 }]);
  await Promise.resolve();
  lookup.mock.mockImplementation(async () => [{ address: HOST, family: 4 }]);
  assert.equal((await f.invoke(request(url))).status, 403);
});

test('sign-out interrupts renewal in flight and never reinstalls the cookie', { timeout: 5_000 }, async (t) => {
  const renewal = new EventEmitter();
  let attempts = 0;
  let finish;
  const f = await fixture(t, { beforeLogin: async () => {
    attempts += 1;
    if (attempts === 1) return;
    finish = () => renewal.emit('finish');
    const completed = once(renewal, 'finish');
    renewal.emit('started');
    await completed;
  } });
  if (!f) return;
  t.after(() => finish?.());
  f.forgetCookie();
  const started = once(renewal, 'started');
  const restoring = f.invoke(request('/api/status'));
  await started;
  const logout = await f.invoke(request('/api/auth', { method: 'DELETE' }));
  assert.equal(logout.status, 401);
  assert.equal((await restoring).status, 502);
  finish();
  assert.equal((await f.invoke(request('/api/status'))).status, 401);
  assert.equal(f.cookieCalls.length, 1);
});

test('aborting a streaming JSON POST cancels the upload and leaves Next untouched', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const lifecycle = new EventEmitter();
  let bodyStarted = false;
  const body = new ReadableStream({
    pull() {
      if (!bodyStarted) {
        bodyStarted = true;
        lifecycle.emit('reading');
      }
      return new Promise(() => {});
    },
    cancel() { lifecycle.emit('cancelled'); },
  }, { highWaterMark: 0 });
  const reading = once(lifecycle, 'reading');
  const cancelled = once(lifecycle, 'cancelled');
  const sender = new AbortController();
  const outgoing = f.invoke(request('/api/search', { method: 'POST', body, duplex: 'half',
    headers: { 'Content-Type': 'application/json' }, signal: sender.signal,
  }));
  await reading;
  sender.abort();
  assert.equal((await outgoing).status, 502);
  await cancelled;
  assert.equal(f.events.length, 2);
});
