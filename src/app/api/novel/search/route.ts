import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { getNovelSource, listNovelSources, searchNovelAcross, type NovelSourceId } from '@/lib/novel-sources';

export const dynamic = 'force-dynamic';

/**
 * 小说搜索：GET /api/novel/search?kw=<关键词>&by=articlename|author&src=<源ID|auto>
 * 站点没有统一的 JSON 接口，服务端按源爬 HTML 再归一化；src=auto 时依次试各源，
 * 单个源被限流或 403 也不会让整个搜索失败。
 */
export async function GET(req: Request) {
  const guarded = await guardRequest(req);
  if (guarded) return guarded;
  const { searchParams } = new URL(req.url);
  const keyword = (searchParams.get('kw') ?? '').trim();
  if (!keyword) return jsonError('请输入搜索关键词', 400);
  if (keyword.length > 50) return jsonError('关键词过长', 400);
  const by = searchParams.get('by') === 'author' ? 'author' : 'articlename';
  const srcParam = (searchParams.get('src') ?? '').trim();
  try {
    if (srcParam && srcParam !== 'auto') {
      const source = getNovelSource(srcParam);
      if (!source) return jsonError(`未知的小说源: ${srcParam}`, 400);
      const items = await source.search(keyword, by);
      return NextResponse.json({ keyword, by, source: source.id, items, sources: listNovelSources() });
    }
    const result = await searchNovelAcross(keyword, by);
    if (!result.items.length) {
      const detail = result.errors.map((e) => `${e.source}: ${e.message}`).join('; ');
      return jsonError(`所有小说源都没有结果${detail ? `（${detail}）` : ''}`, 502);
    }
    return NextResponse.json({
      keyword,
      by,
      source: result.source as NovelSourceId,
      items: result.items,
      errors: result.errors,
      sources: listNovelSources(),
    });
  } catch (err) {
    return jsonError(`搜索失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
}
