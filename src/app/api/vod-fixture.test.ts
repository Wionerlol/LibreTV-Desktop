import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { aggregateResults } from '@/components/video-card';
import { isInDisabledSubscription, useAppStore } from '@/lib/store';
import { syncSourceSubscription } from '@/lib/subscription-sync';
import type { SourceConfig, SourceListPayload } from '@/lib/types';
import { GET as detail } from './detail/route';
import { GET as sourceList } from './source-list/route';
import { POST as probe } from './source/test/route';

// Auth is covered separately. Only the synthetic host is mapped to the fixture
// in this process. Literal private addresses use the production SSRF checks.
vi.mock('@/lib/api-guard', () => ({ guardRequest: () => null }));
vi.mock('@/lib/ssrf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ssrf')>();
  return {
    ...actual,
    checkUpstreamAllowed: (url: string) => new URL(url).hostname === 'vod-fixture.example.test'
      ? Promise.resolve({ ok: true } as const)
      : actual.checkUpstreamAllowed(url),
  };
});

const origin = 'http://vod-fixture.example.test';
const title = 'LibreTV 合成短片';
const cover = origin + '/cover.png';
const manifest = origin + '/clip.m3u8';
const source = (key: string): SourceConfig => ({ key, name: key, url: origin + '/vod-' + key });
const alpha = { ...source('a'), url: source('a').url + '?site=fixture' };
const beta = { ...source('b'), detail: origin + '/fallback' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const nativeFetch = globalThis.fetch;
const counts = new Map<string, number>();
const closed = new Set<string>();
let server: Server;
let local: string;
let list: SourceListPayload;
let search: typeof import('./search/route').POST;

beforeAll(async () => {
  vi.stubEnv('SEARCH_SOURCE_TIMEOUT_MS', '3000');
  ({ POST: search } = await import('./search/route'));
  const historicalPath = process.env.LIBRETV_HISTORICAL_SOURCE_FIXTURE;
  list = historicalPath ? JSON.parse(await readFile(historicalPath, 'utf8')) : { sources: [alpha, beta], liveSources: [] };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    res.on('close', () => closed.add(path));
    const json = (value: unknown, status = 200) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    const html = (value: string) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(value);
    const row = { vod_id: path === '/vod-b' ? 29 : 17, vod_name: title, vod_year: '2026', vod_pic: cover };
    if (path === '/sources.json') {
      const first = list.sources[0];
      return json({ ...list, sources: [...list.sources, { ...first, url: first.url + '/' }] });
    }
    if (path === '/cover.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
    if (path === '/vod-failed') return json({ error: 'fixture failure' }, 503);
    if (path === '/vod-bad-json') return json({ message: 'not an Apple CMS result' });
    if (path === '/vod-empty') return json({ list: null });
    if (path === '/vod-timeout' || (path.startsWith('/vod-cancel') && counts.get(path) === 1)) return;
    if (path === '/fallback/index.php/vod/detail/id/29.html') return html('<h1>' + title + '</h1>第一集$' + manifest);
    if (url.searchParams.get('ac') !== 'videolist') return json({ error: 'missing action' }, 400);
    if (path === '/vod-a' && url.searchParams.get('site') !== 'fixture') return json({ error: 'missing base query' }, 400);
    if (url.searchParams.has('ids')) {
      if (path === '/vod-b') return html('<p>Site API has no JSON detail</p>');
      return json({ list: [{ ...row, vod_play_url: '第一集$' + manifest + '#第二集$' + origin + '/second.m3u8' }] });
    }
    return json({ pagecount: 1, list: [row, row, { ...row, vod_id: 91, vod_name: '无关结果' }] });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  local = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  vi.stubGlobal('fetch', (input: string, init: RequestInit) => {
    const url = new URL(input, origin);
    if (url.pathname === '/api/source-list') return sourceList(new Request(url));
    if (url.origin === origin) return nativeFetch(local + url.pathname + url.search, init);
    throw new Error('unexpected fixture target');
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (server?.listening) await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

const searchRequest = (sources: SourceConfig[], stream = false, signal?: AbortSignal) =>
  new Request('http://app.example.test/api/search' + (stream ? '?stream=1' : ''),
    { method: 'POST', body: JSON.stringify({ sources, wd: title }), signal });
const detailRequest = (source: SourceConfig, id: string) =>
  new Request('http://app.example.test/api/detail?' + new URLSearchParams({ source: JSON.stringify(source), id }));

it('批量导入保留来源和详情，去重与重新同步维持选择，删除保留其他直播源', async () => {
  const url = origin + '/sources.json';
  const { vodCount } = await syncSourceSubscription(' ' + url + '/ ');
  const state = useAppStore.getState();
  expect(vodCount).toBe(process.env.LIBRETV_HISTORICAL_SOURCE_FIXTURE ? 22 : 2);
  const identity = ({ name, url, detail }: Omit<SourceConfig, 'key'>) => ({ name, url, detail });
  expect(state.customAPIs.map(identity)).toEqual(list.sources.map(identity));
  expect(state.selectedKeys).toHaveLength(vodCount);
  const key = state.customAPIs[0].key;
  state.toggleSourceSelected(key);
  await syncSourceSubscription(url);
  expect(useAppStore.getState().selectedKeys).not.toContain(key);
  state.toggleSourceSelected(key);
  expect(useAppStore.getState().selectedKeys).toContain(key);
  state.setSubscriptionEnabled(url, false);
  expect(isInDisabledSubscription(useAppStore.getState(), key)).toBe(true);
  state.setSubscriptionEnabled(url, true);
  expect(isInDisabledSubscription(useAppStore.getState(), key)).toBe(false);

  const other = origin + '/unrelated.json';
  state.applySubscriptionLive(other, [{ name: '独立测试频道', url: origin + '/live.m3u' }]);
  state.removeSubscription(url);
  expect(useAppStore.getState().customAPIs).toEqual([]);
  expect(useAppStore.getState().liveSubscriptions).toMatchObject([{ fromSubscriptions: [other] }]);
});

it('订阅、搜索及详情拒绝真实私网地址', async () => {
  const localSource = { ...alpha, url: local + '/vod-a' };
  const subscription = new Request('http://app.example.test/api/source-list?' + new URLSearchParams({ url: local + '/sources.json' }));
  expect((await sourceList(subscription)).status).toBe(403);
  expect(await (await search(searchRequest([localSource]))).json()).toMatchObject({ list: [], failures: [{ sourceKey: alpha.key }] });
  expect((await detail(detailRequest(localSource, '17'))).status).toBe(400);
});

it('探活区分正常空结果、上游状态和错误格式', async () => {
  const cases = [
    ['empty', { ok: true, count: 0 }],
    ['failed', { ok: false, error: 'HTTP 503' }],
    ['bad-json', { ok: false, error: 'API返回的数据格式无效' }],
  ] as const;
  for (const [key, expected] of cases) {
    const res = await probe(new Request('http://app.example.test/api/source/test', {
      method: 'POST', body: JSON.stringify({ url: source(key).url }),
    }));
    expect(await res.json()).toMatchObject({ ...expected, ms: expect.any(Number) });
  }
});

it('跨源搜索聚合卡片、获取封面并按来源返回不同剧集', async () => {
  const single = await (await search(searchRequest([alpha]))).json();
  expect(single.list).toMatchObject([{ vodId: '17', sourceKey: 'a', name: title, pic: cover }]);
  const renamed = { ...alpha, key: 'renamed', name: '更名后的源' };
  const fresh = await (await search(searchRequest([renamed]))).json();
  expect(fresh.list).toMatchObject([{ sourceKey: renamed.key, sourceName: renamed.name }]);

  const res = await search(searchRequest([alpha, beta, source('failed')], true));
  const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));
  const done = events.at(-1);
  expect(done).toMatchObject({ type: 'done', failures: [{ sourceKey: 'failed', error: 'HTTP 503' }] });
  const groups = aggregateResults(done.list);
  expect(groups).toMatchObject([{ name: title, pic: cover, year: '2026' }]);
  expect(groups[0].items.map((item) => item.sourceKey).sort()).toEqual(['a', 'b']);
  const image = await nativeFetch(local + '/cover.png');
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
  expect(await (await detail(detailRequest(alpha, '17'))).json()).toMatchObject({
    episodes: [manifest, origin + '/second.m3u8'], videoInfo: { sourceKey: 'a', title, cover },
  });
  expect(await (await detail(detailRequest(renamed, '17'))).json()).toMatchObject({
    videoInfo: { sourceKey: renamed.key, sourceName: renamed.name },
  });
  expect(await (await detail(detailRequest(beta, '29'))).json()).toMatchObject({
    episodes: [manifest], videoInfo: { sourceKey: 'b', title },
  });
});

it('流式搜索先推送健康源，随后超时中断慢源', async () => {
  const res = await search(searchRequest([alpha, source('timeout')], true));
  const reader = res.body!.getReader();
  const readEvent = async () => JSON.parse(Buffer.from((await reader.read()).value!).toString());
  expect(await readEvent()).toMatchObject({ type: 'source', sourceKey: 'a', ok: true });
  expect(await readEvent()).toMatchObject({ type: 'source', sourceKey: 'timeout', ok: false, timedOut: true });
  expect(await readEvent()).toMatchObject({ type: 'done', list: [{ sourceKey: 'a' }], failures: [{ sourceKey: 'timeout', timedOut: true }] });
  await vi.waitFor(() => expect(closed.has('/vod-timeout')).toBe(true));
}, 8000);

it('关闭搜索结果流会中断上游且取消结果不进入缓存', async () => {
  const selected = [source('cancel-stream')];
  const res = await search(searchRequest(selected, true));
  await vi.waitFor(() => expect(counts.get('/vod-cancel-stream')).toBe(1));
  await res.body!.cancel();
  await vi.waitFor(() => expect(closed.has('/vod-cancel-stream')).toBe(true));
  expect(await (await search(searchRequest(selected))).json()).toMatchObject({ list: [{ sourceKey: 'cancel-stream' }], failures: [] });
});

it('非流式请求中断传播到上游', async () => {
  const controller = new AbortController();
  const promise = search(searchRequest([source('cancel-json')], false, controller.signal));
  await vi.waitFor(() => expect(counts.get('/vod-cancel-json')).toBe(1));
  controller.abort();
  expect((await promise).status).toBe(499);
  await vi.waitFor(() => expect(closed.has('/vod-cancel-json')).toBe(true));
});
