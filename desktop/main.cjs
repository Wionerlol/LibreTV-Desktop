const { app, BrowserWindow, dialog, Menu, session, ipcMain } = require('electron');
const { randomBytes } = require('node:crypto');
const { appendFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { verifyRuntime } = require('./runtime.cjs');
const { HOST, PORT, ORIGIN, createDesktopServer } = require('./desktop-server.cjs');
const { registerDesktopDownloads } = require('./native-downloads.cjs');
const { waitForSmokeClose } = require('./smoke-control.cjs');
const { observeRenderer } = require('./renderer-acceptance.cjs');

const smoke = process.argv.find((arg) => /^--libretv-smoke=[a-f0-9]{32}$/.test(arg))?.split('=')[1];
const profile = smoke
  ? path.join(app.getPath('temp'), 'LibreTVDesktop-smoke', smoke)
  : path.join(app.getPath('appData'), 'LibreTVDesktop');
const sessionPath = path.join(profile, 'Session');
const partition = 'persist:libretv-desktop-v1';
let window;
let listener;
let closeDownloads;
let nextApp;
let logPath;
let shuttingDown = false;
let shutdownFinished = false;
let exitCode = 0;

function log(stage, details = {}) {
  try {
    appendFileSync(logPath, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, stage, ...details }) + '\n');
  } catch (error) {
    console.warn('Unable to write desktop diagnostics:', error.code);
  }
}

function configureNext() {
  process.env.NODE_ENV = 'production';
  process.env.NEXT_TELEMETRY_DISABLED = '1';
  process.env.PASSWORD = randomBytes(32).toString('base64url');
  process.env.PROXY_SECRET = randomBytes(32).toString('base64url');
  process.env.LIVE_ALLOW_PRIVATE = 'false';
  for (const name of [
    'DOCKER_BUILD', 'DEFAULT_SOURCES', 'DEFAULT_LIVE_SOURCES', 'DEFAULT_SUBSCRIPTIONS',
    'DEFAULT_RECOMMEND_SOURCE', 'DEFAULT_IMAGE_MODE', 'FALLBACK_CORS_PROXY',
  ]) {
    delete process.env[name];
  }
  return process.env.PASSWORD;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: HOST, port: PORT, exclusive: true }, resolve);
  });
}

async function shutdown() {
  shuttingDown = true;
  const drain = new Promise((resolve) => {
    if (!listener?.listening) {
      resolve();
      return;
    }
    listener.close(resolve);
  });
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => {
      log('shutdown-deadline');
      listener?.closeAllConnections();
      resolve();
    }, 4_000);
  });
  await Promise.race([Promise.allSettled([drain, nextApp?.close(), closeDownloads?.()]), limit]);
  clearTimeout(timer);
  log('shutdown', { listenerClosed: !listener?.listening });
  shutdownFinished = true;
  if (exitCode) app.exit(exitCode);
  else app.quit();
}

async function smokeRenderer() {
  const observed = await window.webContents.executeJavaScript(
    "(async () => {" +
    "const status = await fetch('/api/status', { cache: 'no-store' });" +
    "const state = await status.json();" +
    "const auth = await fetch('/api/auth', { cache: 'no-store' });" +
    "const authState = await auth.json();" +
    "const secured = await fetch('/api/live/playlist', { cache: 'no-store' });" +
    "const search = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }," +
    "  body: JSON.stringify({ wd: 'Desktop smoke', sources: [] }) });" +
    "return { status: status.status, auth: auth.status, secured: secured.status, search: search.status," +
    " authVerified: authState.verified === true," +
    " passwordRequired: state.passwordRequired === true, verified: state.verified === true," +
    " scripts: performance.getEntriesByType('resource').filter((entry) =>" +
    "  entry.name.startsWith(location.origin + '/_next/static/') && entry.initiatorType === 'script').length," +
    " stylesheets: document.styleSheets.length," +
    " isolated: typeof require === 'undefined' && typeof process === 'undefined' };" +
    "})()");
  log('smoke-renderer', observed);
  if (observed.status !== 200 || observed.auth !== 200 || observed.secured !== 400 || observed.search !== 400 ||
      !observed.passwordRequired || !observed.verified || !observed.authVerified || !observed.isolated ||
      !observed.scripts || !observed.stylesheets) {
    throw Object.assign(new Error('Packaged renderer smoke check failed'), { code: 'RENDERER_SMOKE' });
  }
}

async function start() {
  const runtime = path.join(process.resourcesPath, 'libretv-runtime');
  const { manifest, runtimeRequire } = verifyRuntime(runtime);
  const password = configureNext();

  const desktop = createDesktopServer();
  listener = desktop.server;
  await listen(listener);
  log('owned-listener', { origin: ORIGIN });

  process.chdir(runtime);
  nextApp = runtimeRequire('next')({ dev: false, dir: runtime, hostname: HOST, port: PORT });
  await nextApp.prepare();
  if (shuttingDown) return;
  desktop.enable(nextApp.getRequestHandler());
  log('next-prepared', {
    buildId: manifest.buildId, commit: manifest.commit, next: manifest.next,
    electron: process.versions.electron, node: process.versions.node, arch: process.arch,
  });

  app.setAppUserModelId('org.libretv.desktop');
  Menu.setApplicationMenu(null);
  const appSession = session.fromPartition(partition);
  try {
    await desktop.bootstrap(appSession, password);
  } catch (cause) {
    throw Object.assign(new Error('Desktop auth bootstrap failed', { cause }), { code: 'DESKTOP_AUTH' });
  }
  if (shuttingDown) return;
  log('desktop-auth-ready');
  window = new BrowserWindow({
    title: 'LibreTV Desktop',
    icon: path.join(runtime, 'public', 'favicon.ico'),
    width: 1280,
    height: 840,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'download-preload.cjs'),
      session: appSession, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, devTools: false, webviewTag: false,
    },
  });
  desktop.bindWindow(window);
  closeDownloads = registerDesktopDownloads({ ipcMain, dialog, getWindow: () => window, origin: ORIGIN, profilePath: profile });
  window.on('closed', () => { window = undefined; });
  await desktop.load(window, '/');
  log('renderer-loaded', { route: '/' });
  if (!smoke) {
    window.show();
    return;
  }

  await smokeRenderer();
  await observeRenderer(window.webContents, log);
  await desktop.load(window, '/live');
  log('renderer-loaded', { route: '/live' });
  await smokeRenderer();
  log('smoke-ready', { control: 'file-v1' });
  await waitForSmokeClose(profile);
  log('smoke-close-requested');
  window?.close();
}

try {
  mkdirSync(sessionPath, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', sessionPath);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    logPath = path.join(profile, 'startup-' + Date.now() + '-' + process.pid + '.jsonl');
    log('starting');
    app.on('second-instance', () => {
      log('second-instance');
      if (window && (!smoke || window.isVisible())) {
        if (window.isMinimized()) window.restore();
        window.focus();
      }
    });
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', (event) => {
      if (shutdownFinished) return;
      event.preventDefault();
      if (!shuttingDown) void shutdown();
    });
    app.whenReady().then(start).catch((error) => {
      const known = ['EADDRINUSE', 'RUNTIME_ASSETS', 'DESKTOP_AUTH', 'RENDERER_SMOKE', 'SMOKE_CONTROL', 'SMOKE_CONTROL_TIMEOUT'];
      const code = known.includes(error.code) ? error.code : 'STARTUP';
      exitCode = 1;
      log('boot-failed', { code });
      if (!smoke) {
        const message = code === 'EADDRINUSE'
          ? '端口 17888 已被占用。请关闭占用它的程序后重试。'
          : code === 'RUNTIME_ASSETS'
            ? '桌面运行资源不完整。请重新解压完整的应用文件夹。'
            : code === 'DESKTOP_AUTH'
              ? '桌面登录初始化失败。请查看应用配置目录中的启动日志。'
            : 'LibreTV Desktop 无法启动。请查看应用配置目录中的启动日志。';
        dialog.showErrorBox('LibreTV Desktop', message);
      }
      app.quit();
    });
  }
} catch {
  if (!smoke) dialog.showErrorBox('LibreTV Desktop', '无法初始化桌面配置目录。请检查当前用户的写入权限。');
  app.exit(1);
}
