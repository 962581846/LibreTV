import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { fetchNovelBook } from '@/lib/novel-source';

export const dynamic = 'force-dynamic';

/** 书籍详情 + 全量目录：GET /api/novel/book?id=<书籍ID> */
export async function GET(req: Request) {
  const guarded = await guardRequest(req);
  if (guarded) return guarded;
  const id = (new URL(req.url).searchParams.get('id') ?? '').trim();
  if (!/^\d+$/.test(id)) return jsonError('书籍 ID 非法', 400);
  try {
    return NextResponse.json(await fetchNovelBook(id));
  } catch (err) {
    return jsonError(`获取目录失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
}
