import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { searchNovel } from '@/lib/novel-source';

export const dynamic = 'force-dynamic';

/**
 * 小说搜索：GET /api/novel/search?kw=<关键词>&by=articlename|author
 * 站点只有 POST 搜索入口，服务端代为提交并把 HTML 归一化成 JSON。
 */
export async function GET(req: Request) {
  const guarded = await guardRequest(req);
  if (guarded) return guarded;
  const { searchParams } = new URL(req.url);
  const keyword = (searchParams.get('kw') ?? '').trim();
  if (!keyword) return jsonError('请输入搜索关键词', 400);
  if (keyword.length > 50) return jsonError('关键词过长', 400);
  const by = searchParams.get('by') === 'author' ? 'author' : 'articlename';
  try {
    const items = await searchNovel(keyword, by);
    return NextResponse.json({ keyword, by, items });
  } catch (err) {
    return jsonError(`搜索失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
}
