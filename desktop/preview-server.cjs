const { randomBytes, timingSafeEqual } = require('node:crypto');
const http = require('node:http');

const HOST = '127.0.0.1';
const PORT = 17888;
const AUTHORITY = HOST + ':' + PORT;
const ORIGIN = 'http://' + AUTHORITY;
const ADMISSION_HEADER = 'x-libretv-desktop-admission';

function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.origin === ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

function createPreviewServer() {
  const capability = randomBytes(32).toString('base64url');
  const expected = Buffer.from(capability);
  let handleRequest;

  const server = http.createServer({
    headersTimeout: 10_000,
    requestTimeout: 30_000,
    shouldUpgradeCallback: () => false,
  }, async (req, res) => {
    const presented = Buffer.from(req.headers[ADMISSION_HEADER] ?? '');
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    const validTarget = req.url?.startsWith('/') && !req.url.startsWith('//') && !req.url.includes('\\');
    if (req.headers.host !== AUTHORITY || !validTarget ||
        (origin && origin !== ORIGIN) || (fetchSite && !['same-origin', 'none'].includes(fetchSite)) ||
        presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      res.writeHead(403, {
        'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close',
      });
      res.end('Forbidden');
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (!handleRequest) {
      res.writeHead(503, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const privateHeaders = [ADMISSION_HEADER, 'cookie', 'forwarded', 'x-forwarded-host',
      'x-forwarded-port', 'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip'];
    for (const name of privateHeaders) {
      delete req.headers[name];
    }
    for (let index = req.rawHeaders.length - 2; index >= 0; index -= 2) {
      if (privateHeaders.includes(req.rawHeaders[index].toLowerCase())) req.rawHeaders.splice(index, 2);
    }
    res.setHeader('Content-Security-Policy',
      "frame-ancestors 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; worker-src 'none'; connect-src 'self'");
    try {
      await handleRequest(req, res);
    } catch {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(500);
        res.end();
      }
    }
  });

  function bindWindow(window, onDenied) {
    const { webContents } = window;
    const { session } = webContents;
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    session.setDevicePermissionHandler(() => false);
    session.on('will-download', (event) => event.preventDefault());
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame || !isAppUrl(event.url)) event.preventDefault();
    });
    webContents.on('will-redirect', (event) => {
      if (!event.isMainFrame || !isAppUrl(event.url)) event.preventDefault();
    });

    session.webRequest.onBeforeRequest((details, respond) => {
      respond({ cancel: !isAppUrl(details.url) });
    });
    session.webRequest.onBeforeSendHeaders((details, respond) => {
      const mainFrame = !webContents.isDestroyed() && webContents.mainFrame;
      const topFrame = mainFrame && details.frame === mainFrame && isAppUrl(mainFrame.url);
      const initialNavigation = details.resourceType === 'mainFrame' &&
        (details.initiatorOrigin === undefined || details.initiatorOrigin === ORIGIN);
      if (!isAppUrl(details.url) || details.webContentsId !== webContents.id ||
          (!initialNavigation && !topFrame)) {
        onDenied(details.resourceType);
        respond({ cancel: true });
        return;
      }
      const headers = details.requestHeaders;
      for (const name of Object.keys(headers)) {
        if ([ADMISSION_HEADER, 'cookie'].includes(name.toLowerCase())) delete headers[name];
      }
      headers[ADMISSION_HEADER] = capability;
      respond({ requestHeaders: headers });
    });
  }

  return { server, bindWindow, enable: (handler) => { handleRequest = handler; } };
}

module.exports = { HOST, PORT, ORIGIN, createPreviewServer };
