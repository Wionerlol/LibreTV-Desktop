const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { test } = require('node:test');
const { registerDesktopDownloads } = require('./native-downloads.cjs');
const { fileIdentity, openDownloadJournal } = require('./download-journal.cjs');

const ORIGIN = 'http://127.0.0.1:17888';
const PREFIX = 'libretv:download:';

async function harness(t, prepare) {
  const parent = path.resolve(__dirname, '..', 'artifacts', 'validation', 'round3');
  await fs.mkdir(parent, { recursive: true });
  const container = await fs.mkdtemp(path.join(parent, 'native-download-test-'));
  const root = path.join(container, 'output');
  const profilePath = path.join(container, 'profile');
  const manifest = path.join(profilePath, 'DownloadJournal', 'manifest.json');
  await Promise.all([fs.mkdir(root), fs.mkdir(profilePath)]);
  const handlers = new Map();
  const frame = { url: ORIGIN + '/' };
  const webContents = Object.assign(new EventEmitter(), { mainFrame: frame });
  const window = { isDestroyed: () => false, webContents };
  const event = { sender: webContents, senderFrame: frame };
  let selected;
  const options = {
    ipcMain: {
      handle(name, fn) { handlers.set(name, fn); },
      removeHandler(name) { handlers.delete(name); },
    },
    dialog: {
      async showSaveDialog() {
        return { canceled: false, filePath: selected };
      },
    },
    getWindow: () => window,
    origin: ORIGIN,
    profilePath,
  };
  let stop;
  function file(name) {
    const result = path.join(root, name);
    assert.equal(path.dirname(result), root);
    return result;
  }
  t.after(async () => {
    if (stop) await stop();
    for (const name of await fs.readdir(root)) {
      await fs.unlink(file(name));
    }
    const journalDirectory = path.dirname(manifest);
    const contents = await fs.readdir(journalDirectory).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (contents) {
      for (const name of contents) await fs.unlink(path.join(journalDirectory, name));
      await fs.rmdir(journalDirectory);
    }
    await fs.rmdir(root);
    await fs.rmdir(profilePath);
    await fs.rmdir(container);
  });
  const invoke = (name, ...args) => handlers.get(PREFIX + name)(event, ...args);
  const pick = async (index, name) => {
    selected = file(name);
    const lease = await invoke('pick', 'dl_123_' + index, name);
    return lease.leaseId;
  };
  if (prepare) await prepare({ file, profilePath, manifest });
  stop = registerDesktopDownloads(options);
  const restart = async () => {
    await stop();
    stop = registerDesktopDownloads(options);
  };
  const records = async () => JSON.parse(await fs.readFile(manifest, 'utf8')).tasks;
  return { root, file, pick, invoke, event, handlers, frame, webContents, restart, records, manifest };
}

test('three native tasks write isolated partials while five leases stay queued', async (t) => {
  const h = await harness(t);
  const leases = [];
  for (let index = 0; index < 8; index++) leases.push(await h.pick(index, 'stage-' + index + '.ts'));
  const active = leases.slice(0, 3);
  await Promise.all(active.map((lease, index) => h.invoke('write', lease, Uint8Array.of(index, 0x47).buffer)));
  await assert.rejects(h.invoke('write', leases[3], Uint8Array.of(0x47).buffer), /任务正在排队/);
  assert.deepEqual((await fs.readdir(h.root)).sort(), active.map((id) => '.libretv-' + id + '.partial').sort());
  for (const [index, lease] of active.entries()) {
    assert.deepEqual(await fs.readFile(path.join(h.root, '.libretv-' + lease + '.partial')), Buffer.from([index, 0x47]));
  }
  const records = await h.records();
  assert.equal(records.filter((item) => item.phase === 'DOWNLOADING').length, 3);
  assert.equal(records.filter((item) => item.phase === 'PREPARING').length, 5);
  await Promise.all(leases.map((lease) => h.invoke('abort', lease)));
  assert.deepEqual(await fs.readdir(h.root), []);
});

test('eight leases hold independent destinations, finish isolated outputs, and deny foreign IPC', async (t) => {
  const h = await harness(t);
  const leases = [];
  for (let index = 0; index < 8; index++) leases.push(await h.pick(index, 'video-' + index + '.mp4'));
  await assert.rejects(h.pick(8, 'video-8.mp4'), /当前的保存选择/);
  const data = Uint8Array.of(5).buffer;
  const write = h.handlers.get(PREFIX + 'write');
  await assert.rejects(write({ ...h.event, senderFrame: { url: ORIGIN + '/' } }, leases[0], data), /来源无效/);
  await assert.rejects(write({ ...h.event, sender: {} }, leases[0], data), /来源无效/);
  const reconcile = h.handlers.get(PREFIX + 'reconcile');
  await assert.rejects(reconcile({ ...h.event, senderFrame: { url: ORIGIN + '/' } }), /来源无效/);
  h.frame.url = 'http://127.0.0.1:17889/';
  await assert.rejects(h.invoke('write', leases[0], data), /来源无效/);
  h.frame.url = ORIGIN + '/';
  await assert.rejects(h.invoke('write', leases[0], new ArrayBuffer(1024 * 1024 + 1)), /大小无效/);

  await Promise.all(leases.slice(0, 3).map((lease, index) => h.invoke('write', lease, Uint8Array.of(index, 7, 8).buffer)));
  await Promise.all(leases.slice(0, 3).map((lease) => h.invoke('finish', lease)));
  await Promise.all(leases.slice(3).map((lease) => h.invoke('abort', lease)));
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await fs.readFile(h.file('video-' + index + '.mp4')), Buffer.from([index, 7, 8]));
  }
  assert.deepEqual((await fs.readdir(h.root)).sort(), ['video-0.mp4', 'video-1.mp4', 'video-2.mp4']);
});

test('in-page navigation preserves a lease while document navigation revokes it', async (t) => {
  const h = await harness(t);
  const lease = await h.pick(0, 'reload.ts');
  h.webContents.emit('did-start-navigation', { isInPlace: true, isMainFrame: true });
  await h.invoke('write', lease, Uint8Array.of(1).buffer);
  h.webContents.emit('did-start-navigation', { isInPlace: false, isMainFrame: true });
  await assert.rejects(h.invoke('write', lease, Uint8Array.of(2).buffer), /句柄无效/);
});

test('staged cancellation cleans the lease and an intervening destination is preserved', async (t) => {
  const h = await harness(t);
  const cancelled = await h.pick(1, 'cancel.ts');
  await h.invoke('write', cancelled, Uint8Array.of(1, 2, 3).buffer);
  await h.invoke('abort', cancelled);
  assert.equal((await fs.readdir(h.root)).length, 0);

  const lease = await h.pick(2, 'existing.ts');
  await assert.rejects(h.pick(3, 'existing.ts'), /另一个下载任务/);
  const destination = h.file('existing.ts');
  await fs.writeFile(destination, 'original fixture', { flag: 'wx' });
  await h.invoke('write', lease, Uint8Array.of(42).buffer);
  await assert.rejects(h.invoke('finish', lease), /校验或落盘/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'original fixture');
  await h.invoke('abort', lease);
  assert.deepEqual(await fs.readdir(h.root), ['existing.ts']);
  assert.equal((await h.records()).find((item) => item.taskId === 'dl_123_1').phase, 'CANCELLED');
  assert.equal((await h.records()).find((item) => item.taskId === 'dl_123_2').phase, 'FAILED');
});

test('an unsupported hardlink uses a no-replace OS move and preserve unusual local filenames', async (t) => {
  const h = await harness(t);
  const link = t.mock.method(fs, 'link', async () => {
    throw Object.assign(new Error('fixture filesystem has no hardlinks'), { code: 'ENOTSUP' });
  });
  const name = "authorized 回归 & ' (1).ts";
  const lease = await h.pick(1, name);
  const bytes = Uint8Array.of(42, 71, 12);
  await h.invoke('write', lease, bytes.buffer);
  await h.invoke('finish', lease);
  assert.deepEqual(await fs.readFile(h.file(name)), Buffer.from(bytes));
  assert.deepEqual(await h.invoke('reconcile'), [{ taskId: 'dl_123_1', status: 'completed' }]);

  const collision = await h.pick(2, 'collision.ts');
  const output = h.file('collision.ts');
  await fs.writeFile(output, 'original fixture', { flag: 'wx' });
  await h.invoke('write', collision, bytes.buffer);
  await assert.rejects(h.invoke('finish', collision), /EEXIST/);
  assert.equal(await fs.readFile(output, 'utf8'), 'original fixture');
  await h.invoke('abort', collision);
  assert.equal(link.mock.callCount(), 2);
  assert.deepEqual((await fs.readdir(h.root)).sort(), [name, 'collision.ts']);
});

test('disk capacity rejection does not leave output or report completion', async (t) => {
  const h = await harness(t);
  const lease = await h.pick(1, 'quota.ts');
  t.mock.method(fs, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }));
  await assert.rejects(h.invoke('write', lease, Uint8Array.of(1).buffer), /检查空间/);
  await h.invoke('abort', lease);
  assert.deepEqual(await fs.readdir(h.root), []);
  assert.equal((await h.records())[0].phase, 'FAILED');
  assert.deepEqual(await h.invoke('reconcile'), []);
});

test('the same task requires explicit destination selection after a writing checkpoint is interrupted', async (t) => {
  let leaseId;
  const h = await harness(t, async ({ profilePath, file }) => {
    const journal = await openDownloadJournal(profilePath);
    leaseId = randomUUID();
    const partial = file('.libretv-' + leaseId + '.partial');
    await fs.writeFile(partial, 'incomplete fixture', { flag: 'wx' });
    await journal.remember({
      taskId: 'dl_123_1', leaseId, destination: file('incomplete.ts'),
      identity: fileIdentity(await fs.lstat(partial, { bigint: true })), phase: 'DOWNLOADING',
    });
  });
  assert.deepEqual(await h.invoke('reconcile'), [{ taskId: 'dl_123_1', status: 'paused_needs_target' }]);
  assert.deepEqual(await fs.readdir(h.root), []);
  await assert.rejects(h.invoke('write', leaseId, Uint8Array.of(1).buffer), /句柄无效/);
  assert.notEqual(await h.pick(1, 'new.ts'), leaseId);
});

test('forcing the isolated writer process to exit preserves its checkpoint for safe restart', async (t) => {
  const origin = ORIGIN;
  const h = await harness(t, async ({ profilePath, file }) => {
    const childProgram = [
      'const { EventEmitter } = require("node:events");',
      'const { registerDesktopDownloads } = require(process.argv[1]);',
      'const [profilePath, destination, origin] = process.argv.slice(2);',
      'const handlers = new Map();',
      'const frame = { url: origin + "/" };',
      'const webContents = Object.assign(new EventEmitter(), { mainFrame: frame });',
      'const window = { isDestroyed: () => false, webContents };',
      'const event = { sender: webContents, senderFrame: frame };',
      'registerDesktopDownloads({',
      '  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },',
      '  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) },',
      '  getWindow: () => window, origin, profilePath,',
      '});',
      'process.stdin.resume();',
      '(async () => {',
      '  const { leaseId } = await handlers.get("libretv:download:pick")(event, "dl_123_1", "crash.ts");',
      '  await handlers.get("libretv:download:write")(event, leaseId, Uint8Array.of(0x47, 55).buffer);',
      '  console.log(leaseId);',
      '})().catch(() => process.exit(1));',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', childProgram, path.join(__dirname, 'native-downloads.cjs'),
      profilePath, file('crash.ts'), origin], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const ended = once(child, 'exit');
    const output = createInterface({ input: child.stdout });
    const killTimeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      const leaseId = await Promise.race([
        once(output, 'line').then(([line]) => line),
        ended.then(() => { throw new Error('writer exited before its checkpoint'); }),
      ]);
      assert.match(leaseId, /^[a-f0-9-]{36}$/);
      assert.equal((await fs.stat(file('.libretv-' + leaseId + '.partial'))).size, 2);
      assert.equal(child.kill('SIGKILL'), true);
      const [, signal] = await ended;
      assert.equal(signal, 'SIGKILL');
    } finally {
      clearTimeout(killTimeout);
      output.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await ended.catch(() => {});
    }
  });
  assert.deepEqual(await h.invoke('reconcile'), [{ taskId: 'dl_123_1', status: 'paused_needs_target' }]);
  assert.deepEqual(await fs.readdir(h.root), []);
  const lease = await h.pick(1, 'retry.ts');
  await h.invoke('write', lease, Uint8Array.of(1, 2, 3).buffer);
  await h.invoke('finish', lease);
  assert.deepEqual(await fs.readFile(h.file('retry.ts')), Buffer.from([1, 2, 3]));
});

test('staged data changed before finish fails integrity verification', async (t) => {
  const h = await harness(t);
  const lease = await h.pick(1, 'changed.ts');
  await h.invoke('write', lease, Uint8Array.of(1, 2, 3).buffer);
  await fs.writeFile(h.file('.libretv-' + lease + '.partial'), Buffer.from([4, 5, 6]));
  await assert.rejects(h.invoke('finish', lease), /校验或落盘/);
  await h.invoke('abort', lease);
  assert.deepEqual(await fs.readdir(h.root), []);
  assert.deepEqual(await h.invoke('reconcile'), []);
});

test('post-publication journal failure is reconciled with the published identity and digest', async (t) => {
  const h = await harness(t);
  const lease = await h.pick(1, 'published.ts');
  const rename = fs.rename;
  const fault = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === h.manifest) {
      const { tasks } = JSON.parse(await fs.readFile(from, 'utf8'));
      if (tasks[0].phase === 'COMPLETED') throw Object.assign(new Error('fixture profile full'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  });
  const bytes = Uint8Array.of(0x47, 20, 40);
  await h.invoke('write', lease, bytes.buffer);
  await assert.rejects(h.invoke('finish', lease), /ENOSPC/);
  assert.deepEqual(await fs.readFile(h.file('published.ts')), Buffer.from(bytes));
  assert.equal((await h.records())[0].phase, 'FINALIZING');
  await h.invoke('abort', lease);
  fault.mock.restore();
  await h.restart();
  assert.deepEqual(await h.invoke('reconcile'), [{ taskId: 'dl_123_1', status: 'completed' }]);
  assert.deepEqual(await fs.readdir(h.root), ['published.ts']);
});

test('a same-digest destination collision at restart stays unverified and preserves both files', async (t) => {
  const h = await harness(t, async ({ profilePath, file }) => {
    const journal = await openDownloadJournal(profilePath);
    const leaseId = randomUUID();
    const destination = file('same-content.ts');
    const partial = file('.libretv-' + leaseId + '.partial');
    const bytes = Buffer.from('identical independent fixtures');
    await Promise.all([fs.writeFile(destination, bytes, { flag: 'wx' }), fs.writeFile(partial, bytes, { flag: 'wx' })]);
    await journal.remember({
      taskId: 'dl_123_1', leaseId, destination,
      identity: fileIdentity(await fs.lstat(partial, { bigint: true })), phase: 'FINALIZING',
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });
  assert.deepEqual(await h.invoke('reconcile'), [{ taskId: 'dl_123_1', status: 'needs_reconcile' }]);
  assert.equal((await fs.readdir(h.root)).length, 2);
  assert.equal((await h.records())[0].reason, 'publication_unverified');
  await assert.rejects(h.pick(1, 'other.ts'), /上一次保存需要核对/);
});

test('an invalid manifest stays untouched and disables native saving with an explicit error', async (t) => {
  const malformed = '{"version":1,"tasks":[{"phase":"COMPLETED"}]}';
  const h = await harness(t, async ({ manifest }) => {
    await fs.mkdir(path.dirname(manifest));
    await fs.writeFile(manifest, malformed, { flag: 'wx' });
  });
  await assert.rejects(h.invoke('reconcile'), /下载任务清单不可用/);
  await assert.rejects(h.pick(1, 'untrusted.ts'), /下载任务清单不可用/);
  assert.equal(await fs.readFile(h.manifest, 'utf8'), malformed);
});

test('1 GiB synthetic fixture is staged and finalized with matching SHA-256', {
  skip: process.env.LIBRETV_NATIVE_LARGE_FIXTURE !== '1',
}, async (t) => {
  const h = await harness(t);
  const lease = await h.pick(1, 'large.ts');
  const block = new Uint8Array(1024 * 1024).fill(73);
  const expected = createHash('sha256');
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  for (let index = 0; index < 1024; index++) {
    await h.invoke('write', lease, block.buffer);
    expected.update(block);
    if (index % 16 === 0) rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
  const [partial] = (await fs.readdir(h.root)).filter((name) => name.endsWith('.partial'));
  const staged = path.join(h.root, partial);
  assert.equal((await fs.stat(staged)).size, 1024 ** 3);
  const actual = createHash('sha256');
  for await (const chunk of createReadStream(staged)) {
    actual.update(chunk);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
  const digest = actual.digest('hex');
  assert.equal(digest, expected.digest('hex'));
  const sample = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 20);
  try {
    await h.invoke('finish', lease);
    const finalFile = h.file('large.ts');
    assert.equal((await fs.stat(finalFile)).size, 1024 ** 3);
    const final = createHash('sha256');
    for await (const chunk of createReadStream(finalFile)) final.update(chunk);
    assert.equal(final.digest('hex'), digest);
  } finally {
    clearInterval(sample);
  }
  t.diagnostic('staged and final bytes=' + 1024 ** 3 + ' sha256=' + digest +
    ' rssStart=' + rssStart + ' rssPeak=' + rssPeak + ' rssIncrease=' + (rssPeak - rssStart));
  assert.ok(rssPeak - rssStart < 256 * 1024 ** 2, '1 GiB stream stays within 256 MiB of the fixture baseline');
});
