import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { fetchNovelChapterAuto } from '@/lib/novel-sources';

export const dynamic = 'force-dynamic';

/** 单章正文：GET /api/novel/chapter?bid=<书籍ID>&cid=<章节ID>&src=<源ID> */
export async function GET(req: Request) {
  const guarded = await guardRequest(req);
  if (guarded) return guarded;
  const { searchParams } = new URL(req.url);
  const bid = (searchParams.get('bid') ?? '').trim();
  const cid = (searchParams.get('cid') ?? '').trim();
  if (!bid || !cid || !/^[a-z0-9]{1,32}$/i.test(bid) || !/^[a-z0-9]{1,32}$/i.test(cid)) {
    return jsonError('章节参数非法', 400);
  }
  const src = (searchParams.get('src') ?? '').trim();
  try {
    const { source, chapter } = await fetchNovelChapterAuto(bid, cid, src === 'auto' ? null : src);
    return NextResponse.json({ ...chapter, source });
  } catch (err) {
    return jsonError(`获取正文失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
}
