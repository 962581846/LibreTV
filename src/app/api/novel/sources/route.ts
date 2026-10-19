import { NextResponse } from 'next/server';
import { listNovelSources } from '@/lib/novel-sources';

export const dynamic = 'force-dynamic';

/** 可用小说源列表：GET /api/novel/sources */
export async function GET() {
  return NextResponse.json({ sources: listNovelSources() });
}
