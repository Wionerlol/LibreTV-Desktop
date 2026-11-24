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
const mediaPrefix = '/__libretv-acceptance-media/';
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

async function prepareIntegrationFixtures(profile) {
  try {
    verifySmokeProfile(profile);
    const folder = path.join(profile, 'acceptance-fixtures');
    const entries = await Promise.all(Object.entries(checkedFixtures).map(async ([name, expected]) => {
      const bytes = await readContainedFile(folder, name, 256 * 1024);
      if (!bytes) return null;
      if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Fixture hash mismatch');
      return [name, bytes];
    }));
    const files = Object.fromEntries(entries.filter(Boolean));
    const names = Object.keys(checkedFixtures).filter((name) => name !== 'sources.json');
    return {
      sources: files['sources.json'] ? JSON.parse(files['sources.json'].toString('utf8')) : null,
      media: names.every((name) => files[name])
        ? new Map(names.map((name) => [mediaPrefix + name, files[name]])) : null,
    };
  } catch {
    return { sources: null, media: null, error: 'INTEGRATION_FIXTURE_INVALID' };
  }
}

function serveIntegrationMedia(fixture, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const bytes = fixture?.media?.get(request.url);
  if (!bytes) return false;
  response.writeHead(200, {
    'Content-Type': request.url.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
  });
  response.end(request.method === 'HEAD' ? undefined : bytes);
  return true;
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
async function rendererBusiness({ sourceList, media, playlistURL, phase, origin, previous }) {
  const checks = [];
  const title = 'LibreTV 集成验收合成短片';
  const settingsKey = 'libretv-settings';
  const fixtureOrigin = 'https://libretv-integration.invalid';
  const subscriptionURL = fixtureOrigin + '/sources.json';
  const source = { name: '集成验收合成源', url: fixtureOrigin + '/vod' };
  const vodId = '3442026';
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
  const note = (name, status, detail, metrics, code) => checks.push({ name, status, detail,
    ...(metrics && { metrics }), ...(code && { code }) });
  const run = async (name, action, status, detail, snapshot) => {
    try {
      const metrics = await action();
      note(name, status, detail, metrics);
      return true;
    } catch (error) {
      note(name, 'FAIL', detail + '。' + (error instanceof Error ? error.message : '未完成'), snapshot?.(), error?.code);
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
  const getDownload = async () => (await readDatabase('downloads')).find((item) => item.title === title);
  const getRecords = async () => {
    const download = await getDownload();
    return {
      history: (await readDatabase('history')).some((item) => item.title === title && item.vodId === vodId),
      progress: (await readDatabase('progress')).some((item) => String(item.key).endsWith('_' + vodId + '_0') && item.position > 0),
      download: download?.status === 'completed' ? download.id : undefined,
    };
  };
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

  const sourceRows = [...(!presets && sourceList?.sources || []), source];
  const nativeFetch = window.fetch;
  const cover = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const hits = { search: 0, detail: 0 };
  window.fetch = async function (input, init) {
    const url = new URL(input instanceof Request ? input.url : input, origin);
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

    const searchWait = async (stage, probe) => {
      try {
        return await eventually(probe);
      } catch {
        throw new Error(stage + '超时（合成搜索请求 ' + hits.search + '，合成详情请求 ' + hits.detail + '）');
      }
    };
    const searched = await run('vod-search', async () => {
      const field = await searchWait('等待搜索框', () => document.querySelector('input[aria-label="搜索影片"]'));
      setText(field, title);
      await sleep(150);
      if (field.form) field.form.requestSubmit();
      else field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const card = await searchWait('等待搜索结果卡片', () => {
        const area = document.querySelector('section[aria-label="搜索结果"]');
        return area && Array.from(area.querySelectorAll('button, [role="button"]')).find((item) =>
          item.getAttribute('aria-label')?.includes(title) || item.textContent.includes(title));
      });
      card.click();
      const modal = await searchWait('等待详情对话框', () => Array.from(document.querySelectorAll('[role="dialog"]')).find((item) =>
        item.getAttribute('aria-label')?.includes(title)));
      const episode = await searchWait('等待合成剧集', () => Array.from(modal.querySelectorAll('button')).find((item) =>
        /^(?:1|第\s*1\s*集|合成第一集)$/.test(item.textContent.trim())));
      if (hits.search === 0 || hits.detail === 0) throw new Error('缺少搜索或详情请求观察');
      episode.click();
      await searchWait('等待进入播放页', () => location.pathname === '/watch');
      return { searches: hits.search, details: hits.detail };
    }, 'PARTIAL', '真实搜索卡片、详情剧集和进入播放页，应用 API 返回由隔离夹具提供');

    if (searched) {
      const fault = (code) => Object.assign(new Error(code), { code });
      const waitStage = (code, probe, timeout) => eventually(probe, timeout).catch((error) => {
        throw error.code ? error : fault(code);
      });
      const segmentUrls = new Set(Array.from({ length: 3 }, (_, index) =>
        new URL('clip-00' + index + '.ts', playlistURL).href));
      const mediaRequests = (initiatorType) => {
        const entries = performance.getEntriesByType('resource').filter((entry) => entry.initiatorType === initiatorType);
        return {
          manifestReads: entries.filter(({ name }) => name === playlistURL).length,
          segmentReads: entries.filter(({ name }) => segmentUrls.has(name)).length,
        };
      };
      let video;
      let playRejected = false;
      const videoMetrics = () => ({
        ...mediaRequests('xmlhttprequest'), videoPresent: Boolean(video), playRejected,
        readyState: video?.readyState ?? -1, networkState: video?.networkState ?? -1,
        mediaError: video?.error?.code ?? 0, videoWidth: video?.videoWidth ?? 0,
        currentTimeMs: Math.round((video?.currentTime ?? 0) * 1000),
      });
      await run('media-playback', async () => {
        video = await waitStage('MEDIA_ELEMENT_TIMEOUT', () => document.querySelector('main video'));
        const checkVideo = () => { if (video.error) throw fault('MEDIA_ELEMENT_ERROR'); };
        await waitStage('MEDIA_METADATA_TIMEOUT', () => {
          checkVideo();
          return video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0;
        });
        if (video.paused) {
          video.muted = true;
          void video.play().catch(() => { playRejected = true; });
        }
        await waitStage('MEDIA_PLAYBACK_TIMEOUT', () => {
          checkVideo();
          return video.currentTime > 0.15 && video.videoWidth > 0;
        });
        const duration = video.duration;
        const seekTime = duration / 2;
        video.currentTime = seekTime;
        await waitStage('MEDIA_SEEK_TIMEOUT', () => {
          checkVideo();
          return !video.seeking && Math.abs(video.currentTime - seekTime) < 0.4;
        });
        video.pause();
        const metrics = videoMetrics();
        if (!video.paused || !metrics.manifestReads || !metrics.segmentReads) throw fault('MEDIA_TRANSPORT_UNOBSERVED');
        return { ...metrics, durationSeconds: Math.round(duration * 100) / 100 };
      }, 'PASS', 'ArtPlayer 实际解码并播放有权使用的合成 HLS，验证时间进度、跳转和暂停', videoMetrics);

      let task;
      let beforeDownload = mediaRequests('fetch');
      const downloadMetrics = () => {
        const current = mediaRequests('fetch');
        return {
          manifestReads: Math.max(0, current.manifestReads - beforeDownload.manifestReads),
          segmentReads: Math.max(0, current.segmentReads - beforeDownload.segmentReads),
          taskObserved: Boolean(task), taskFailed: task?.status === 'error',
          finishedSegments: task?.finished ?? 0, totalSegments: task?.total ?? 0,
        };
      };
      const readTask = async () => {
        task = await getDownload();
        if (task?.status === 'error') throw fault('DOWNLOAD_TASK_ERROR');
        return task;
      };
      await run('native-download', async () => {
        const trigger = await waitStage('DOWNLOAD_BUTTON_TIMEOUT', () => button('下载本集'));
        beforeDownload = mediaRequests('fetch');
        trigger.click();
        await waitStage('DOWNLOAD_QUEUE_TIMEOUT', readTask);
        const completed = await waitStage('DOWNLOAD_COMPLETE_TIMEOUT', async () => {
          const entry = await readTask();
          return entry?.status === 'completed' && entry.id;
        }, 14000);
        const receipts = await window.libretvDownloads.reconcile();
        if (!receipts.some((item) => item.taskId === completed && item.status === 'completed')) {
          throw fault('DOWNLOAD_RECEIPT_MISSING');
        }
        return { ...downloadMetrics(), completed: true };
      }, 'PASS', '下载按钮经过生产下载器、IPC 和磁盘写入，原生完成回执可核对', downloadMetrics);
    } else {
      note('media-playback', 'NOT RUN', '未进入合成播放页面');
      note('native-download', 'NOT RUN', '未进入合成播放页面');
    }
    const observed = { ...(await getRecords()), sources: imported, presets };
    return { checks, observed };
  } finally {
    window.fetch = nativeFetch;
  }
}

function observeIndexedDb() {
  const metrics = { opened: false, wrote: false, readBack: false };
  return new Promise((resolve) => {
    let database;
    let transaction;
    let done = false;
    let phase = 'OPEN';
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      database?.close();
      resolve({ name: 'indexeddb', status: code ? 'FAIL' : 'PASS',
        detail: '隔离 IndexedDB 事务提交及独立事务读回', metrics, ...(code && { code }) });
    };
    const timer = setTimeout(() => {
      finish('INDEXEDDB_' + phase + '_TIMEOUT');
      try { transaction?.abort(); } catch { /* Transaction already settled. */ }
    }, 4000);
    try {
      const open = indexedDB.open('libretv-acceptance-storage', 1);
      open.onerror = () => finish('INDEXEDDB_OPEN_ERROR');
      open.onblocked = () => finish('INDEXEDDB_OPEN_BLOCKED');
      open.onupgradeneeded = () => {
        if (done) open.transaction.abort();
        else open.result.createObjectStore('probe');
      };
      open.onsuccess = () => {
        database = open.result;
        if (done) { database.close(); return; }
        metrics.opened = true;
        phase = 'WRITE';
        try {
          transaction = database.transaction('probe', 'readwrite');
          transaction.onerror = transaction.onabort = () => finish('INDEXEDDB_WRITE_ERROR');
          transaction.oncomplete = () => {
            if (done) return;
            metrics.wrote = true;
            phase = 'READ';
            try {
              const read = database.transaction('probe').objectStore('probe').get('ready');
              read.onerror = () => finish('INDEXEDDB_READ_ERROR');
              read.onsuccess = () => {
                if (done) return;
                metrics.readBack = read.result === 1;
                finish(metrics.readBack ? null : 'INDEXEDDB_READ_MISMATCH');
              };
            } catch { finish('INDEXEDDB_READ_ERROR'); }
          };
          transaction.objectStore('probe').put(1, 'ready');
        } catch { finish('INDEXEDDB_WRITE_ERROR'); }
      };
    } catch { finish('INDEXEDDB_OPEN_ERROR'); }
  });
}

async function verifyPlaybackFile(base64) {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const video = document.createElement('video');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  const started = performance.now();
  const events = [];
  const state = () => ({
    elapsedMs: Math.round(performance.now() - started),
    readyState: video.readyState, networkState: video.networkState, mediaError: video.error?.code ?? 0,
    videoWidth: video.videoWidth, currentTimeMs: Math.round(video.currentTime * 1000),
    durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : -1,
    paused: video.paused, seeking: video.seeking, visibility: document.visibilityState,
  });
  const mark = (event) => {
    if (events.length < 24) {
      const { elapsedMs, currentTimeMs, readyState, networkState } = state();
      events.push({ event, elapsedMs, currentTimeMs, readyState, networkState });
    }
  };
  let timer;
  let interval;
  try {
    video.muted = true;
    video.playsInline = true;
    const mediaEvents = [
      'loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing',
      'waiting', 'stalled', 'suspend', 'seeking', 'seeked', 'timeupdate', 'pause', 'abort', 'error',
    ];
    for (const name of mediaEvents) video.addEventListener(name, () => mark(name));
    video.src = url;
    document.body.append(video);
    return await new Promise((resolve) => {
      const finish = (passed, code, playError, interruption) => resolve({ passed, code, metrics: {
        ...state(), events: events.slice(),
        codecSupport: video.canPlayType('video/mp4; codecs="avc1.42C00A, mp4a.40.2"'),
        decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
        ...(playError && { playError }),
        ...(interruption && { interruption }),
      } });
      let firstFrameTime;
      timer = setTimeout(() => finish(false, 'DOWNLOAD_CHROMIUM_TIMEOUT'), 6000);
      interval = setInterval(() => {
        if (video.readyState < 2 || video.videoWidth === 0) return;
        if (firstFrameTime === undefined) firstFrameTime = video.currentTime;
        if (video.currentTime - firstFrameTime < 0.15) return;
        // The authorized fixtures contain approximately six seconds of content.
        const durationMatches = video.duration >= 5 && video.duration <= 8;
        finish(durationMatches, durationMatches ? undefined : 'DOWNLOAD_CHROMIUM_DURATION_MISMATCH');
      }, 80);
      video.addEventListener('error', () => finish(false, 'DOWNLOAD_CHROMIUM_MEDIA_ERROR'), { once: true });
      mark('play-request');
      video.play().then(() => mark('play-resolved'), (error) => {
        mark('play-rejected');
        const names = ['NotAllowedError', 'AbortError', 'NotSupportedError'];
        const playError = names.includes(error?.name) ? error.name : 'OtherError';
        const message = String(error?.message ?? '');
        const interruption = playError !== 'AbortError' ? undefined
          : /a new load request/i.test(message) ? 'NEW_LOAD'
          : /a call to pause/i.test(message) ? 'PAUSE_CALL'
          : /removed from the document/i.test(message) ? 'REMOVED'
          : 'UNCLASSIFIED';
        finish(false, 'DOWNLOAD_CHROMIUM_PLAY_REJECTED', playError, interruption);
      });
    });
  } finally {
    clearTimeout(timer);
    clearInterval(interval);
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}

async function probeMp4(window, name, bytes, sha256) {
  try {
    const playback = await window.webContents.executeJavaScript(
      '(' + verifyPlaybackFile.toString() + ')(' + JSON.stringify(bytes.toString('base64')) + ')', true);
    return {
      name, status: playback.passed ? 'PASS' : 'FAIL', code: playback.code,
      detail: 'Chromium 复核 MP4 的视频帧和播放进度',
      metrics: { ...playback.metrics, bytes: bytes.length, sha256 },
    };
  } catch {
    return { name, status: 'FAIL', code: 'DOWNLOAD_CHROMIUM_PROBE_EXECUTION' };
  }
}

async function compareMp4Controls(window, profile, downloadSha256) {
  const fixtureFolder = path.join(profile, 'acceptance-fixtures');
  const folder = path.join(fixtureFolder, 'mp4-controls');
  const samples = [
    ['mp4-standard-control', 'control-standard.mp4', '87c8e5d1b588953acbae3290c80af547d65bfa774d5539c49e8a4d7005a040d6'],
    ['mp4-remux-control', 'app-remux.mp4', '59c0e9f51926b19a330d8bf2611ddefdd03f5c51d13bd1e003b15d810a50aa4b'],
  ];
  try {
    const parent = await fs.lstat(fixtureFolder);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Invalid fixture directory');
    await fs.lstat(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    return samples.map(([name]) => ({ name, status: 'FAIL', code: 'MP4_CONTROL_INVALID' }));
  }

  const readVerified = async (file, expected) => {
    const bytes = await readContainedFile(folder, file, maxOutputBytes);
    if (!bytes || bytes.toString('ascii', 4, 8) !== 'ftyp' ||
        createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new Error('MP4 control hash or format mismatch');
    }
    return bytes;
  };
  const checks = [];
  for (const [name, file, hash] of samples) {
    try {
      const bytes = await readVerified(file, hash);
      if (name === 'mp4-remux-control') {
        const reference = 'c21c1e6ff20237682175451d13a626bf76b295fa12a7ad75701a0f54c7862a56';
        await readVerified('app-download.mp4', reference);
        if (downloadSha256 !== reference) {
          checks.push({ name, status: 'NOT RUN', code: 'MP4_REMUX_BASELINE_MISMATCH' });
          continue;
        }
      }
      checks.push(await probeMp4(window, name, bytes, hash));
    } catch {
      checks.push({ name, status: 'FAIL', code: 'MP4_CONTROL_INVALID' });
    }
  }
  return checks;
}

async function observeBusiness(window, log, { profile, phase, origin, fixture }) {
  verifySmokeProfile(profile);
  if (phase !== 'initial' && phase !== 'restart') throw new Error('Invalid integration phase');
  try {
    const storage = await window.webContents.executeJavaScript('(' + observeIndexedDb.toString() + ')()');
    log('integration-check', storage);
  } catch {
    log('integration-check', { name: 'indexeddb', status: 'FAIL', code: 'INDEXEDDB_PROBE_EXECUTION' });
  }
  const names = phase === 'initial' ? ['preset-initial', 'source-import', 'vod-search', 'media-playback', 'native-download', 'downloaded-file-chromium']
    : ['business-persistence', 'preset-restart'];
  let args;
  let observed;
  try {
    const inspection = phase === 'initial' ? fixture ?? {} : {};
    if (inspection.error) throw Object.assign(new Error('Fixture preparation failed'), { code: inspection.error });
    const previous = phase === 'restart' ? await readContainedFile(profile, 'acceptance-observed.json', 2048) : null;
    args = {
      sourceList: inspection.sources, media: Boolean(inspection.media), origin, phase,
      playlistURL: new URL(mediaPrefix + 'clip.m3u8', origin).href,
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
        if (!output) {
          download.status = 'FAIL';
          download.code = 'DOWNLOAD_FILE_UNAVAILABLE';
          observed.observed.download = undefined;
          download.detail = '下载完成回执存在，未找到有效的 MP4 输出文件';
        } else {
          observed.observed.downloadSha256 = output.sha256;
          Object.assign(download.metrics, { bytes: output.bytes.length, sha256: output.sha256 });
          download.detail += '。文件已读回并计算 SHA-256。';
          observed.checks.push(await probeMp4(window, 'downloaded-file-chromium', output.bytes, output.sha256));
        }
      }
      observed.checks.push(...await compareMp4Controls(window, profile, observed.observed.downloadSha256));
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

module.exports = { createIntegrationSaveDialog, observeBusiness, prepareIntegrationFixtures, serveIntegrationMedia };
