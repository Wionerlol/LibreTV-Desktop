const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { registerDesktopDownloads } = require('./native-downloads.cjs');

const ORIGIN = 'http://127.0.0.1:17888';
const PREFIX = 'libretv:download:';

async function harness(t) {
  const parent = path.resolve(__dirname, '..', 'artifacts', 'validation');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'native-download-test-'));
  const outputFiles = new Set();
  const handlers = new Map();
  const frame = { url: ORIGIN + '/' };
  const webContents = Object.assign(new EventEmitter(), { mainFrame: frame });
  const window = { isDestroyed: () => false, webContents };
  const event = { sender: webContents, senderFrame: frame };
  let selected;
  const stop = registerDesktopDownloads({
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
  });
  function file(name) {
    const result = path.join(root, name);
    assert.equal(path.dirname(result), root);
    outputFiles.add(result);
    return result;
  }
  t.after(async () => {
    await stop();
    for (const filename of outputFiles) {
      await fs.unlink(filename).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    }
    await fs.rmdir(root);
  });
  const invoke = (name, ...args) => handlers.get(PREFIX + name)(event, ...args);
  const pick = async (index, name) => {
    selected = file(name);
    const lease = await invoke('pick', 'dl_123_' + index, name);
    return lease.leaseId;
  };
  return { root, file, pick, invoke, event, handlers, frame, webContents };
}

test('three native tasks write isolated partials while five leases stay queued', async (t) => {
  const h = await harness(t);
  const leases = [];
  for (let index = 0; index < 8; index++) leases.push(await h.pick(index, 'stage-' + index + '.ts'));
  const active = leases.slice(0, 3);
  await Promise.all(active.map((lease, index) => h.invoke('write', lease, Uint8Array.of(index, 0x47).buffer)));
  assert.deepEqual((await fs.readdir(h.root)).sort(), active.map((id) => '.libretv-' + id + '.partial').sort());
  for (const [index, lease] of active.entries()) {
    assert.deepEqual(await fs.readFile(path.join(h.root, '.libretv-' + lease + '.partial')), Buffer.from([index, 0x47]));
  }
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
  t.diagnostic('staged bytes=' + 1024 ** 3 + ' sha256=' + digest + ' rssStart=' + rssStart + ' rssPeak=' + rssPeak);
  await h.invoke('finish', lease);
  assert.equal((await fs.stat(h.file('large.ts'))).size, 1024 ** 3);
});
