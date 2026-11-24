import { createHash } from 'node:crypto';

import { MAX_VOD_SOURCES, normalizeUrl, optionalString } from './source-list';
import type { SourceConfig } from './types';

function canonicalVodUrl(raw: unknown): string | undefined {
  const valid = normalizeUrl(raw, false);
  if (!valid) return undefined;
  const url = new URL(valid);
  if (url.username || url.password) return undefined;
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

/** 仅在受信任的桌面构建显式提供预置时，由状态 API 调用。这里不访问源站。 */
export function parseDesktopInitialSources(raw: string | undefined): SourceConfig[] | undefined {
  if (!raw) return undefined;
  let payload: { version?: unknown; sources?: unknown } | null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (payload?.version !== 2 || !Array.isArray(payload.sources)) return undefined;

  const sources: SourceConfig[] = [];
  const seen = new Set<string>();
  for (const item of payload.sources) {
    if (sources.length >= MAX_VOD_SOURCES) break;
    const canonical = canonicalVodUrl(item?.url);
    if (!canonical || !optionalString(item?.name) || seen.has(canonical)) continue;
    const { name, url, detail, isAdult } = item;
    seen.add(canonical);
    sources.push({
      key: 'desktop_vod_' + createHash('sha256').update(canonical).digest('hex'),
      name,
      url,
      ...(canonicalVodUrl(detail) ? { detail } : {}),
      ...(isAdult === true ? { isAdult: true } : {}),
    });
  }
  return sources.length > 0 ? sources : undefined;
}
