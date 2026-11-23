const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
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

async function fixture(t) {
  const bridge = createDesktopServer();
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
      res.setHeader('Set-Cookie', cookieName + '=' + fakeCookie + '; Path=/; HttpOnly; SameSite=Lax');
      res.end('{}');
    } else if (addressed === '/api/auth') {
      res.end(JSON.stringify({ verified: cookieVerified }));
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
  return { bridge, window, invoke, stripHeaders, events, cookieCalls };
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
