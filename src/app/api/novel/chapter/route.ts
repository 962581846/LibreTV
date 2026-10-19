import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { fetchNovelChapter } from '@/lib/novel-source';

export const dynamic = 'force-dynamic';

/** 单章正文：GET /api/novel/chapter?bid=<书籍ID>&cid=<章节ID> */
export async function GET(req: Request) {
  const guarded = await guardRequest(req);
  if (guarded) return guarded;
  const { searchParams } = new URL(req.url);
  const bid = (searchParams.get('bid') ?? '').trim();
  const cid = (searchParams.get('cid') ?? '').trim();
  if (!/^\d+$/.test(bid) || !/^\d+$/.test(cid)) return jsonError('章节参数非法', 400);
  try {
    return NextResponse.json(await fetchNovelChapter(bid, cid));
  } catch (err) {
    return jsonError(`获取正文失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
}
