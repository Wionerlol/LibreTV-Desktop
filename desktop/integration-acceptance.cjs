const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const checkedFixtures = {
  'sources.json': '2cb60e5b455466ab02811d99217f03f0e65077382502e45a5b0000cad2b81ddd',
  'clip.m3u8': '193d66737016855888c6c869980417a0d4132cd08ab454e5df6042032d27d995',
  'clip-000.ts': '01edd1d4405dceb6c0dcff181f700e2e8bbb49fd528ff643c72c6dbfaa70e765',
  'clip-001.ts': '1c0449ffe3cdc9e268c0f207325ed026ddcab98586d3f82f287b675c506c5656',
  'clip-002.ts': '3037b8078028a12bd160ea9856eab4e456de53449cdb85d63433c094daf928f9',
};
const outputPrefix = 'acceptance-output-';
const videoFile = 'synthetic-download.mp4';
const maxOutputBytes = 1024 * 1024;

function verifySmokeProfile(profile) {
  if (path.basename(path.dirname(profile)) !== 'LibreTVDesktop-smoke' || !/^[a-f0-9]{32}$/.test(path.basename(profile))) {
    throw Object.assign(new Error('Integration requires an isolated smoke profile'), { code: 'INTEGRATION_PROFILE' });
  }
}

async function readContainedFile(folder, name, limit) {
  const parent = await fs.lstat(folder).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!parent) return null;
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Invalid fixture directory');
  const file = path.join(folder, name);
  const input = await fs.lstat(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!input) return null;
  if (!input.isFile() || input.isSymbolicLink() || input.size === 0 || input.size > limit || input.nlink !== 1) {
    throw new Error('Invalid fixture file');
  }
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== input.dev || opened.ino !== input.ino || opened.size !== input.size) throw new Error('Fixture changed before reading');
    const buffer = Buffer.alloc(input.size);
    const { bytesRead } = await handle.read(buffer, 0, input.size, 0);
    if (bytesRead !== input.size) throw new Error('Fixture changed while reading');
    return buffer;
  } finally {
    await handle.close();
  }
}

async function fixturePayload(profile) {
  const folder = path.join(profile, 'acceptance-fixtures');
  const entries = await Promise.all(Object.entries(checkedFixtures).map(async ([name, expected]) => {
    const bytes = await readContainedFile(folder, name, 256 * 1024);
    if (!bytes) return null;
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Fixture hash mismatch');
    return [name, name === 'sources.json' ? JSON.parse(bytes.toString('utf8')) : bytes.toString('base64')];
  }));
  const fixtures = Object.fromEntries(entries.filter(Boolean));
  return {
    sources: fixtures['sources.json'] ?? null,
    media: Object.keys(checkedFixtures).slice(1).every((name) => fixtures[name])
      ? Object.fromEntries(Object.entries(fixtures).filter(([name]) => name !== 'sources.json'))
      : null,
  };
}

function createIntegrationSaveDialog(profile) {
  verifySmokeProfile(profile);
  return {
    async showSaveDialog() {
      const folder = await fs.mkdtemp(path.join(profile, outputPrefix));
      return { canceled: false, filePath: path.join(folder, videoFile) };
    },
  };
}

async function inspectDownload(profile) {
  const folders = (await fs.readdir(profile, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(outputPrefix));
  if (folders.length !== 1) return null;
  const bytes = await readContainedFile(path.join(profile, folders[0].name), videoFile, maxOutputBytes);
  if (!bytes || bytes.length < 1024 || bytes.toString('ascii', 4, 8) !== 'ftyp') return null;
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

// This routine runs inside the existing smoke profile only. It exercises the
// real renderer with bounded local fixture replies; production routes keep their
// normal networking, provenance, and private-address checks.
async function rendererBusiness({ sourceList, media, phase, origin, previous }) {
  const checks = [];
  const title = 'LibreTV 集成验收合成短片';
  const settingsKey = 'libretv-settings';
  const fixtureOrigin = 'https://libretv-integration.invalid';
  const subscriptionURL = fixtureOrigin + '/sources.json';
  const source = { name: '集成验收合成源', url: fixtureOrigin + '/vod' };
  const vodId = '3442026';
  const playlistURL = fixtureOrigin + '/clip.m3u8';
  const settings = () => JSON.parse(localStorage.getItem(settingsKey) || '{}').state || {};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const eventually = async (probe, timeout = 5000) => {
    const deadline = performance.now() + timeout;
    do {
      const result = await probe();
      if (result) return result;
      await sleep(80);
    } while (performance.now() < deadline);
    throw new Error('Check timed out');
  };
  const note = (name, status, detail, metrics) => checks.push({ name, status, detail, ...(metrics && { metrics }) });
  const run = async (name, action, status, detail) => {
    try {
      const metrics = await action();
      note(name, status, detail, metrics);
      return true;
    } catch (error) {
      note(name, 'FAIL', detail + '。' + (error instanceof Error ? error.message : '未完成'));
      return false;
    }
  };
  const button = (name, scope = document) => Array.from(scope.querySelectorAll('button')).find((element) =>
    element.textContent.trim() === name || element.getAttribute('aria-label') === name ||
    element.getAttribute('title') === name);
  const setText = (field, text) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const readDatabase = async (table) => {
    if (!(await indexedDB.databases()).some((info) => info.name === 'libretv')) return [];
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('libretv');
      open.onerror = () => reject(new Error('应用数据库无法读取'));
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(table)) {
          db.close();
          resolve([]);
          return;
        }
        const request = db.transaction(table).objectStore(table).getAll();
        request.onsuccess = () => { db.close(); resolve(request.result); };
        request.onerror = () => { db.close(); reject(new Error('应用数据库表无法读取')); };
      };
    });
  };
  const getRecords = async () => ({
    history: (await readDatabase('history')).some((item) => item.title === title && item.vodId === vodId),
    progress: (await readDatabase('progress')).some((item) => String(item.key).endsWith('_' + vodId + '_0') && item.position > 0),
    download: (await readDatabase('downloads')).find((item) => item.title === title && item.status === 'completed')?.id,
  });
  const presetState = async () => {
    const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    const data = await response.json();
    if (!Array.isArray(data.desktopInitialSources)) return;
    const state = await eventually(() => {
      const value = settings();
      return value.desktopInitialSourcesApplied === true && value;
    });
    const presetRows = (state.customAPIs || []).filter((row) => row.key.startsWith('desktop_vod_'));
    if (data.desktopInitialSources.length !== 22) throw new Error('个人版点播源清单数量异常');
    return { presetRows, state, declared: data.desktopInitialSources.length };
  };

  if (phase === 'restart') {
    if (!previous) {
      note('business-persistence', 'NOT RUN', '首轮没有可核对的业务数据');
      return { checks };
    }
    if (!previous.sources && !previous.history && !previous.progress && !previous.download) {
      note('business-persistence', 'NOT RUN', '首轮只观察到预置源，没有业务数据可核对');
    } else await run('business-persistence', async () => {
      const observed = await eventually(async () => {
        const rows = await getRecords();
        return (!previous.history || rows.history) && (!previous.progress || rows.progress) &&
          (!previous.download || rows.download === previous.download) && rows;
      });
      if (previous.download) {
        const receipts = await window.libretvDownloads.reconcile();
        if (!receipts.some((row) => row.taskId === previous.download && row.status === 'completed')) {
          throw new Error('原生下载清单缺少完成状态');
        }
      }
      if (previous.sources && !(settings().customAPIs || []).some((item) => item.url === source.url)) {
        throw new Error('合成点播源重启后未保存');
      }
      return { history: observed.history, progress: observed.progress, download: Boolean(observed.download) };
    }, previous.history && previous.progress && previous.downloadSha256 && previous.sources ? 'PASS' : 'PARTIAL',
    '复查上一轮实际写入的观看、进度、源设置和下载状态');
    if (previous.presets) {
      await run('preset-restart', async () => {
        const result = await presetState();
        if (!result || result.presetRows.length !== previous.presets.count) throw new Error('重启后预置点播源数量变化');
        return { count: result.presetRows.length };
      }, 'PASS', '同一隔离配置第二次启动保持预置点播源数量');
    }
    return { checks };
  }

  let presets;
  try {
    const result = await presetState();
    if (result) {
      if (result.presetRows.length !== 22) throw new Error('全新隔离配置未写入 22 个预置点播源');
      presets = { count: result.presetRows.length };
      note('preset-initial', 'PASS', '真实认证状态和新配置持久标记均包含预期个人版预置', { count: presets.count });
    } else {
      note('preset-initial', 'NOT RUN', '当前安装包未启用个人版预置');
    }
  } catch (error) {
    note('preset-initial', 'FAIL', error instanceof Error ? error.message : '个人版预置测试失败');
  }

  if (!sourceList && !media) {
    note('source-import', 'NOT RUN', '验收文件夹未提供历史源清单');
    note('vod-search', 'NOT RUN', '验收文件夹未提供合成媒体');
    note('media-playback', 'NOT RUN', '验收文件夹未提供合成媒体');
    note('native-download', 'NOT RUN', '验收文件夹未提供合成媒体');
    return { checks, observed: presets ? { presets } : undefined };
  }

  const bytesFrom = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const virtual = new Map();
  for (const [name, body] of Object.entries(media || {})) {
    const url = fixtureOrigin + '/' + name;
    const bytes = bytesFrom(body);
    const type = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    const content = name.endsWith('.m3u8')
      ? new TextDecoder().decode(bytes).replace(/^clip-\d{3}\.ts$/gm, (line) => fixtureOrigin + '/' + line)
      : bytes;
    virtual.set(url, new Blob([content], { type }));
  }
  const blobUrls = new Map();
  const sourceRows = [...(!presets && sourceList?.sources || []), source];
  const nativeFetch = window.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const cover = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const hits = { search: 0, detail: 0, media: 0 };
  window.fetch = async function (input, init) {
    const url = new URL(input instanceof Request ? input.url : input, origin);
    const asset = virtual.get(url.href);
    if (asset) {
      hits.media += 1;
      return new Response(asset, { headers: { 'Content-Type': asset.type } });
    }
    if (url.origin === origin && url.pathname === '/api/source-list' && url.searchParams.get('url') === subscriptionURL) {
      return Response.json({ name: '集成验收', version: 2, sources: sourceRows, liveSources: [] });
    }
    if (url.origin === origin && url.pathname === '/api/search') {
      const data = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (data?.wd === title) {
        const selected = data.sources.find((row) => row.url === source.url);
        if (!selected) throw new Error('合成源未参与搜索');
        hits.search += 1;
        const list = [{ sourceKey: selected.key, sourceName: source.name, sourceUrl: source.url,
          vodId, name: title, pic: cover, year: '2026' }];
        return new Response(JSON.stringify({ type: 'done', list, failures: [] }) + '\n',
          { headers: { 'Content-Type': 'application/x-ndjson' } });
      }
    }
    if (url.origin === origin && url.pathname === '/api/detail' && url.searchParams.get('id') === vodId) {
      const params = JSON.parse(url.searchParams.get('source') || '{}');
      if (params.url !== source.url) throw new Error('详情源身份不符');
      hits.detail += 1;
      return Response.json({ episodes: [playlistURL], episodeNames: ['合成第一集'],
        videoInfo: { title, cover, desc: '合成测试画面', sourceKey: params.key, sourceName: source.name } });
    }
    return nativeFetch.call(this, input, init);
  };
  XMLHttpRequest.prototype.open = function (method, url, ...options) {
    const address = new URL(url, origin).href;
    const asset = virtual.get(address);
    if (method === 'GET' && asset) {
      if (!blobUrls.has(address)) blobUrls.set(address, URL.createObjectURL(asset));
      hits.media += 1;
      return nativeOpen.call(this, method, blobUrls.get(address), ...options);
    }
    return nativeOpen.call(this, method, url, ...options);
  };

  try {
    const imported = await run('source-import', async () => {
      (await eventually(() => button('设置') || button('打开设置'))).click();
      const section = await eventually(() => button('数据源订阅') || button('源管理'));
      if (section === button('源管理')) {
        section.click();
        (await eventually(() => button('数据源订阅'))).click();
      } else section.click();
      const subscription = await eventually(() => Array.from(document.querySelectorAll('input')).find((field) =>
        /订阅.*地址|https?:\/\/.*json/i.test(field.placeholder)));
      setText(subscription, subscriptionURL);
      const container = subscription.closest('form') || subscription.parentElement.parentElement;
      const submit = await eventually(() => {
        const candidate = button('添加订阅', container) || button('添加', container) || button('订阅', container)
          || Array.from(container.querySelectorAll('button')).find((element) => element.type === 'submit');
        return candidate && !candidate.disabled && candidate;
      });
      submit.click();
      const current = await eventually(() => {
        const parsed = settings();
        return (parsed.customAPIs || []).some((item) => item.url === source.url) && parsed;
      });
      const normalize = (value) => new URL(value).href.replace(/\/+$/, '');
      const keys = new Set(current.customAPIs.map((item) => item.key));
      if (keys.size !== current.customAPIs.length) throw new Error('导入后的源身份重复');
      for (const expected of sourceRows) {
        const matching = current.customAPIs.filter((item) => normalize(item.url) === normalize(expected.url));
        if (matching.length !== 1 || matching[0].name !== expected.name || matching[0].detail !== expected.detail) {
          throw new Error('导入后的源字段或去重结果不符');
        }
      }
      const close = button('关闭设置') || button('关闭', subscription.closest('[role="dialog"]') || document);
      if (close) close.click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { historicalImported: sourceRows.length - 1, historicalAlreadySeeded: presets?.count || 0, syntheticSources: 1 };
    }, 'PARTIAL', '打包设置界面导入经校验的本地清单，订阅 HTTP 返回由隔离夹具提供');

    if (imported && presets) {
      // Use the ordinary settings operations and preserve their results for restart.
      // No fixture directly assigns product storage.
      presets.count = (settings().customAPIs || []).filter((row) => row.key.startsWith('desktop_vod_')).length;
    }
    if (!imported || !media) {
      note('vod-search', 'NOT RUN', '需要先完成合成源导入并提供媒体文件');
      note('media-playback', 'NOT RUN', '需要先通过搜索和详情');
      note('native-download', 'NOT RUN', '需要先进入合成播放页面');
      return { checks, observed: imported || presets ? { sources: imported, presets } : undefined };
    }

    const searched = await run('vod-search', async () => {
      const field = await eventually(() => document.querySelector('input[aria-label="搜索影片"]'));
      setText(field, title);
      await sleep(150);
      if (field.form) field.form.requestSubmit();
      else field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const card = await eventually(() => {
        const area = document.querySelector('section[aria-label="搜索结果"]');
        return area && (button(title, area) || Array.from(area.querySelectorAll('button')).find((item) =>
          item.getAttribute('aria-label')?.includes(title) || item.textContent.includes(title)));
      });
      card.click();
      const modal = await eventually(() => Array.from(document.querySelectorAll('[role="dialog"]')).find((item) =>
        item.getAttribute('aria-label')?.includes(title)));
      const episode = await eventually(() => Array.from(modal.querySelectorAll('button')).find((item) =>
        /^(?:1|第\s*1\s*集|合成第一集)$/.test(item.textContent.trim())));
      if (hits.search === 0 || hits.detail === 0) throw new Error('缺少搜索或详情请求观察');
      episode.click();
      await eventually(() => location.pathname === '/watch');
      return { searches: hits.search, details: hits.detail };
    }, 'PARTIAL', '真实搜索卡片、详情剧集和进入播放页，应用 API 返回由隔离夹具提供');

    if (searched) {
      await run('media-playback', async () => {
        const video = await eventually(() => document.querySelector('video'));
        await eventually(() => video.readyState >= 2 && Number.isFinite(video.duration));
        if (video.paused) {
          video.muted = true;
          await Promise.race([video.play(), sleep(2500)]);
        }
        await eventually(() => video.currentTime > 0.15 && video.videoWidth > 0);
        const duration = video.duration;
        const seekTime = Math.max(1.5, duration - 0.85);
        video.currentTime = seekTime;
        await eventually(() => !video.seeking && video.currentTime >= seekTime - 0.2);
        video.pause();
        if (!video.paused || hits.media === 0) throw new Error('实际合成媒体未观测到播放和暂停');
        return { durationSeconds: Math.round(duration * 100) / 100, mediaReads: hits.media };
      }, 'PASS', 'ArtPlayer 实际解码并播放有权使用的合成 HLS，验证时间进度、跳转和暂停');

      await run('native-download', async () => {
        const trigger = await eventually(() => button('下载本集'));
        trigger.click();
        const completed = await eventually(async () => (await getRecords()).download, 14000);
        const receipts = await window.libretvDownloads.reconcile();
        if (!receipts.some((item) => item.taskId === completed && item.status === 'completed')) {
          throw new Error('下载 UI 完成但未找到原生下载回执');
        }
        return { completed: true };
      }, 'PASS', '下载按钮经过生产下载器、IPC 和磁盘写入，原生完成回执可核对');
    } else {
      note('media-playback', 'NOT RUN', '未进入合成播放页面');
      note('native-download', 'NOT RUN', '未进入合成播放页面');
    }
    const observed = { ...(await getRecords()), sources: imported, presets };
    return { checks, observed };
  } finally {
    window.fetch = nativeFetch;
    XMLHttpRequest.prototype.open = nativeOpen;
    for (const url of blobUrls.values()) URL.revokeObjectURL(url);
  }
}

async function verifyPlaybackFile(base64) {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const video = document.createElement('video');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  let timer;
  let interval;
  try {
    video.muted = true;
    video.src = url;
    return await new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 6000);
      interval = setInterval(() => {
        if (video.currentTime > 0.15 && video.videoWidth > 0) resolve(true);
      }, 80);
      video.play().catch(() => resolve(false));
    });
  } finally {
    clearTimeout(timer);
    clearInterval(interval);
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function observeBusiness(window, log, { profile, phase, origin }) {
  verifySmokeProfile(profile);
  if (phase !== 'initial' && phase !== 'restart') throw new Error('Invalid integration phase');
  const names = phase === 'initial' ? ['preset-initial', 'source-import', 'vod-search', 'media-playback', 'native-download']
    : ['business-persistence', 'preset-restart'];
  let args;
  let observed;
  try {
    const inspection = phase === 'initial' ? await fixturePayload(profile) : {};
    const previous = phase === 'restart' ? await readContainedFile(profile, 'acceptance-observed.json', 2048) : null;
    args = {
      sourceList: inspection.sources, media: inspection.media, origin, phase,
      previous: previous ? JSON.parse(previous.toString('utf8')) : undefined,
    };
    observed = await window.webContents.executeJavaScript('(' + rendererBusiness.toString() + ')(' + JSON.stringify(args) + ')', true);
  } catch (error) {
    for (const name of names) log('integration-check', { name, status: 'NOT RUN', code: error.code || error.name,
      detail: '验收文件加载或打包渲染器执行失败' });
    return;
  }
  try {
    if (phase === 'initial' && observed.observed) {
      const download = observed.checks.find((check) => check.name === 'native-download');
      if (download?.status === 'PASS') {
        const output = await inspectDownload(profile);
        const playable = output && await window.webContents.executeJavaScript(
          '(' + verifyPlaybackFile.toString() + ')(' + JSON.stringify(output.bytes.toString('base64')) + ')', true);
        if (!playable) {
          download.status = 'FAIL';
          observed.observed.download = undefined;
          download.detail = '下载完成回执存在，输出文件读取或 Chromium 解码未通过';
        } else {
          observed.observed.downloadSha256 = output.sha256;
          Object.assign(download.metrics, { bytes: output.bytes.length, sha256: output.sha256 });
          download.detail += '。文件实际读回、计算 SHA-256 并解码。';
        }
      }
      await fs.writeFile(path.join(profile, 'acceptance-observed.json'), JSON.stringify(observed.observed), { flag: 'wx' });
    } else if (phase === 'restart' && args.previous?.downloadSha256) {
      const output = await inspectDownload(profile);
      const persistence = observed.checks.find((check) => check.name === 'business-persistence');
      if (output?.sha256 !== args.previous.downloadSha256) {
        persistence.status = 'FAIL';
        persistence.detail = '重启后原生下载文件摘要未保持';
      } else {
        persistence.detail += '。输出文件 SHA-256 保持。';
      }
    }

  } catch (error) {
    const name = phase === 'initial' ? 'native-download' : 'business-persistence';
    const existing = observed.checks.find((check) => check.name === name);
    const failure = { name, status: 'FAIL', code: error.code || error.name, detail: '业务证据读回或写入失败' };
    if (existing) Object.assign(existing, failure);
    else observed.checks.push(failure);
  }
  for (const check of observed.checks) log('integration-check', check);
}

module.exports = { createIntegrationSaveDialog, observeBusiness };
