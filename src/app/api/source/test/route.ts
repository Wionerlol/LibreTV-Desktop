import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { fetchUpstream } from '@/lib/fetch-utils';
import { parseSearchList } from '@/lib/cms-parser';

export const runtime = 'nodejs';

/** 点播源探活：以搜索 "test" 的响应耗时与结果量衡量可用性 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let url = '';
  try {
    const body = (await req.json()) as { url?: string };
    url = (body.url || '').trim().replace(/\/+$/, '');
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
  if (!/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: '无效的源地址' }, { status: 400 });
  }

  const verdict = await checkUpstreamAllowed(url);
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, ms: 0, error: verdict.reason });
  }

  const start = Date.now();
  try {
    const api = new URL(url);
    api.searchParams.set('ac', 'videolist');
    api.searchParams.set('wd', 'test');
    const res = await fetchUpstream(api.href, {
      timeoutMs: 6000,
      signal: req.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36', Accept: 'application/json' },
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, ms: Date.now() - start, error: `HTTP ${res.status}` });
    }
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || !('list' in data)) {
      throw new Error('API返回的数据格式无效');
    }
    const list = parseSearchList(data, { key: 'test', name: 'test', url });
    const count = list.filter((item) => item.vodId && item.name).length;
    if (list.length && !count) throw new Error('API返回的数据格式无效');
    return NextResponse.json({ ok: true, ms: Date.now() - start, count });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      ms: Date.now() - start,
      error: err instanceof Error ? (err.name === 'TimeoutError' || err.name === 'AbortError' ? '超时' : err.message) : '请求失败',
    });
  }
}
