import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { fetchNovelBookAuto } from '@/lib/novel-sources';

export const dynamic = 'force-dynamic';

/** 书籍详情 + 全量目录：GET /api/novel/book?id=<书籍ID>&src=<源ID> */
export async function GET(req: Request) {
  const guarded = await guardRequest(req);
  if (guarded) return guarded;
  const { searchParams } = new URL(req.url);
  const id = (searchParams.get('id') ?? '').trim();
  if (!id || !/^[a-z0-9]{1,32}$/i.test(id)) return jsonError('书籍 ID 非法', 400);
  const src = (searchParams.get('src') ?? '').trim();
  try {
    const { source, book } = await fetchNovelBookAuto(id, src === 'auto' ? null : src);
    return NextResponse.json({ ...book, source });
  } catch (err) {
    return jsonError(`获取目录失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
}
