import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/status/route';
import { isPasswordConfigured, sessionFromCookieHeader } from './auth';
import { parseDesktopInitialSources } from './desktop-initial-sources';
import type { AuthStatusResponse } from './types';

vi.mock('./auth', () => ({
  isPasswordConfigured: vi.fn(),
  sessionFromCookieHeader: vi.fn(),
}));

const first = { name: '示例甲', url: 'https://EXAMPLE.invalid:443/vod/', detail: 'https://example.invalid/details/' };
const second = { name: '示例乙', url: 'http://other.invalid/api.php/provide/vod', isAdult: true };
const payload = JSON.stringify({ version: 2, sources: [first, second] });
const presets = parseDesktopInitialSources(payload)!;
const desktopStatus: AuthStatusResponse = {
  passwordRequired: true,
  verified: true,
  version: 'desktop-test',
  defaultSources: [],
  defaultLiveSources: [],
  defaultSubscriptions: [],
  defaultRecommendSource: null,
  defaultImageMode: null,
  desktopInitialSources: presets,
};
const fixture = process.env.LIBRETV_HISTORICAL_FIXTURE || 'artifacts/fixtures/libretv-historical-sources.json';

function storageWith(snapshot?: string) {
  const map = new Map<string, string>();
  if (snapshot !== undefined) map.set('libretv-settings', snapshot);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
  });
  return map;
}

async function coldStart(status: AuthStatusResponse = desktopStatus, beforeStatus?: () => void | Promise<void>) {
  vi.resetModules();
  const { useAppStore } = await import('./store');
  const { flushPendingPersist } = await import('./persist-storage');
  const { applyEnvPresets } = await import('./subscription-sync');
  await useAppStore.persist.rehydrate();
  await beforeStatus?.();
  await applyEnvPresets(status);
  return { store: useAppStore, applyEnvPresets, flushPendingPersist };
}

afterEach(async () => {
  const { flushPendingPersist } = await import('./persist-storage');
  flushPendingPersist();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('个人桌面初始源', () => {
  it('按规范地址去重，次序或名称变化不改变源身份，原始字段保持不变', () => {
    expect(presets[0]).toMatchObject(first);
    expect(presets[0].key).toMatch(/^desktop_vod_[a-f0-9]{64}$/);
    const deduped = parseDesktopInitialSources(JSON.stringify({
      version: 2, sources: [first, { name: '重复', url: 'https://example.invalid/vod#shortcut' }, second],
    }));
    expect(deduped).toEqual(presets);
    const reordered = parseDesktopInitialSources(JSON.stringify({
      version: 2, sources: [second, { ...first, name: '不同名称', url: 'https://example.invalid/vod' }],
    }));
    expect(reordered?.map((source) => source.key)).toEqual([presets[1].key, presets[0].key]);
    expect(parseDesktopInitialSources('not JSON')).toBeUndefined();
    expect(parseDesktopInitialSources(JSON.stringify({ version: 2, sources: [null, { name: 'x', url: 'https://example.invalid', detail: 'file:///data' }] }))).toHaveLength(1);
  });

  it.runIf(existsSync(fixture))('复用原始历史夹具全部 22 条及原始 name、url 和 detail', () => {
    const raw = readFileSync(fixture);
    expect(createHash('sha256').update(raw).digest('hex')).toBe('2cb60e5b455466ab02811d99217f03f0e65077382502e45a5b0000cad2b81ddd');
    const expected = JSON.parse(raw.toString('utf8')).sources;
    const result = parseDesktopInitialSources(raw.toString('utf8'))!;
    expect(result).toHaveLength(22);
    expect(result.map(({ name, url, detail }) => ({ name, url, ...(detail === undefined ? {} : { detail }) }))).toEqual(expected);
    expect(new Set(result.map((source) => source.key)).size).toBe(22);
  });

  it('状态 API 仅在已验证的构建显式提供源列表时发送', async () => {
    vi.mocked(isPasswordConfigured).mockReturnValue(true);
    vi.mocked(sessionFromCookieHeader).mockReturnValue(false);
    vi.stubEnv('LIBRETV_DESKTOP_INITIAL_SOURCES', payload);
    const req = new Request('http://127.0.0.1:17888/api/status');
    expect(await (await GET(req)).json()).not.toHaveProperty('desktopInitialSources');
    vi.mocked(sessionFromCookieHeader).mockReturnValue(true);
    expect(await (await GET(req)).json()).toHaveProperty('desktopInitialSources', presets);
    vi.stubEnv('LIBRETV_DESKTOP_INITIAL_SOURCES', undefined);
    expect(await (await GET(req)).json()).not.toHaveProperty('desktopInitialSources');
  });

  it('全新 profile 首次落盘，成人过滤及现有 Web 默认行为保持', async () => {
    const remote = vi.fn().mockRejectedValue(new Error('network unavailable'));
    vi.stubGlobal('fetch', remote);
    const saved = storageWith();
    const { store } = await coldStart();
    expect(store.getState().customAPIs).toEqual(presets);
    expect(store.getState().selectedKeys).toEqual([presets[0].key]);
    expect(store.getState().yellowFilter).toBe(true);
    expect(JSON.parse(saved.get('libretv-settings')!).state.desktopInitialSourcesApplied).toBe(true);
    expect(remote).not.toHaveBeenCalled();
  });

  it('跳过已有设置的 profile，包括已经删空的源列表', async () => {
    const user = { key: 'custom_0', name: '已有源', url: first.url, detail: 'https://example.invalid/mine' };
    for (const customAPIs of [[user], []]) {
      storageWith(JSON.stringify({ state: { customAPIs, selectedKeys: [], yellowFilter: false }, version: 2 }));
      const { store, flushPendingPersist } = await coldStart();
      expect(store.getState().customAPIs).toEqual(customAPIs);
      expect(store.getState().selectedKeys).toEqual([]);
      expect(store.getState().yellowFilter).toBe(false);
      expect(store.getState().desktopInitialSourcesApplied).toBeUndefined();
      flushPendingPersist();
    }
  });

  it('重复状态请求、重启和升级保留用户编辑、停用和删除', async () => {
    storageWith();
    let { store, applyEnvPresets, flushPendingPersist } = await coldStart();
    store.getState().toggleSourceSelected(presets[0].key);
    store.getState().updateCustomApi(presets[0].key, { name: '我改的名' });
    store.getState().removeCustomApi(presets[1].key);
    await applyEnvPresets(desktopStatus);
    expect(store.getState().customAPIs).toEqual([{ ...presets[0], name: '我改的名' }]);
    expect(store.getState().selectedKeys).toEqual([]);
    flushPendingPersist();

    ({ store, flushPendingPersist, applyEnvPresets } = await coldStart({
      ...desktopStatus, version: 'candidate-upgrade', desktopInitialSources: [...presets, {
        ...presets[1], key: 'future-candidate',
      }],
    }));
    expect(store.getState().customAPIs).toEqual([{ ...presets[0], name: '我改的名' }]);
    expect(store.getState().selectedKeys).toEqual([]);
    store.getState().removeCustomApi(presets[0].key);
    await applyEnvPresets(desktopStatus);
    flushPendingPersist();
    ({ store } = await coldStart());
    expect(store.getState().customAPIs).toEqual([]);
    expect(store.getState().selectedKeys).toEqual([]);
  });

  it('普通 Web 仍使用管理员配置，桌面未验证响应无法初始化', async () => {
    storageWith();
    const admin = { key: 'env_0', name: '站点源', url: 'https://web.invalid' };
    const { store } = await coldStart({
      ...desktopStatus, verified: false, defaultSources: [admin],
    });
    expect(store.getState().envSources).toEqual([admin]);
    expect(store.getState().customAPIs).toEqual([]);
    expect(store.getState().desktopInitialSourcesApplied).toBeUndefined();
  });
});
