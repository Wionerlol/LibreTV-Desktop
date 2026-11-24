import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportConfig, importConfig, MAX_HISTORY, type HistoryEntry } from './db';
import { PERSIST_KEY } from './persist-storage';

const fixture = vi.hoisted(() => ({
  history: new Map<string, HistoryEntry>(),
  settings: new Map<string, string>(),
}));

vi.mock('dexie', () => ({
  default: class {
    history = {
      toArray: async () => [...fixture.history.values()],
      bulkPut: async (entries: HistoryEntry[]) => {
        for (const entry of entries) fixture.history.set(entry.id, entry);
      },
    };

    version() {
      return { stores() {} };
    }

    transaction<T>(_mode: string, _table: unknown, apply: () => Promise<T>): Promise<T> {
      return apply();
    }
  },
}));

function backup(rows: unknown, settings?: string): string {
  return JSON.stringify({
    name: 'LibreTV-Settings',
    data: { viewingHistory: JSON.stringify(rows), [PERSIST_KEY]: settings },
  });
}

const modern: HistoryEntry = {
  id: 'movies_42',
  sourceKey: 'movies',
  sourceUrl: 'https://source.example/api',
  vodId: '42',
  title: '标题',
  pic: 'https://image.example/movie.jpg',
  episodeIndex: 3,
  totalEpisodes: 10,
  playbackPosition: 5.5,
  duration: 1820,
  timestamp: 1_740_000_000_000,
};

describe('配置备份观看历史', () => {
  beforeEach(() => {
    fixture.history.clear();
    fixture.settings.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => fixture.settings.get(key) ?? null,
      setItem: (key: string, value: string) => fixture.settings.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('在新配置中恢复现代备份的全部观看历史字段和设置', async () => {
    fixture.history.set(modern.id, modern);
    const settings = JSON.stringify({ state: { autoplayNext: false } });
    fixture.settings.set(PERSIST_KEY, settings);
    const content = await exportConfig();
    fixture.history.clear();
    fixture.settings.clear();

    await expect(importConfig(content)).resolves.toEqual({ historyImported: 1, historySkipped: 0, invalidHistoryRows: 0 });
    expect([...fixture.history.values()]).toEqual([modern]);
    expect(fixture.settings.get(PERSIST_KEY)).toBe(settings);
  });

  it('恢复旧版源标识、数值视频 ID、集数和播放进度', async () => {
    await expect(importConfig(backup([
      { sourceCode: 'legacy', vod_id: 0, episodes: ['a', 'b'], playbackPosition: 4, duration: 12, timestamp: 50 },
      { sourceName: '旧源', vod_id: '3', timestamp: 20 },
    ]))).resolves.toMatchObject({ historyImported: 2, historySkipped: 0 });

    expect(fixture.history.get('legacy_0')).toMatchObject({
      sourceKey: 'legacy', vodId: '0', totalEpisodes: 2, playbackPosition: 4, duration: 12, timestamp: 50,
    });
    expect(fixture.history.get('旧源_3')).toMatchObject({ sourceKey: '旧源', vodId: '3', timestamp: 20 });
  });

  it('报告无效和重复记录并保留本机较新的历史', async () => {
    fixture.history.set(modern.id, modern);
    const newer = { ...modern, id: 'movies_43', vodId: '43' };
    await expect(importConfig(backup([
      { ...modern, title: '旧标题', timestamp: modern.timestamp - 1 },
      null,
      { sourceKey: 'movies', vodId: {} },
      { ...newer, title: '重复旧项', timestamp: newer.timestamp - 1 },
      newer,
    ]))).resolves.toEqual({ historyImported: 1, historySkipped: 4, invalidHistoryRows: 2 });
    expect(fixture.history.get(modern.id)).toEqual(modern);
    expect(fixture.history.get(newer.id)).toEqual(newer);
  });

  it('容量不足时优先恢复最新备份且保留本机其他历史', async () => {
    for (let i = 0; i < MAX_HISTORY - 1; i++) {
      const id = 'local_' + i;
      fixture.history.set(id, { ...modern, id, sourceKey: 'local', vodId: String(i) });
    }
    await expect(importConfig(backup([{ ...modern, vodId: 'old', timestamp: 1 }, modern])))
      .resolves.toMatchObject({ historyImported: 1, historySkipped: 1 });
    expect(fixture.history.size).toBe(MAX_HISTORY);
    expect(fixture.history.get('local_0')).toBeDefined();
    expect(fixture.history.get(modern.id)).toEqual(modern);
  });

  it('在观看历史格式错误时保留现有设置和记录', async () => {
    fixture.history.set(modern.id, modern);
    fixture.settings.set(PERSIST_KEY, '现有设置');
    await expect(importConfig(backup({ notAnArray: true }, '备份设置'))).rejects.toThrow('观看历史格式不正确');
    expect(fixture.settings.get(PERSIST_KEY)).toBe('现有设置');
    expect([...fixture.history.values()]).toEqual([modern]);
  });
});
