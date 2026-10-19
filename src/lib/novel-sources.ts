/**
 * 小说源注册表：把多个源包装成统一接口，供 API 与页面使用。
 *
 * 设计要点：
 * - 每个源自己负责搜索 / 目录 / 正文，ID 体系互不兼容（笔趣阁是纯数字，czbooks 是字母数字）；
 * - `inferNovelSource` 靠 ID 形态猜源，`src` 缺省时用它兜底；
 * - `searchNovelAcross` 按顺序试源，第一个拿到结果的就返回，失败的源原因记在 errors 里，
 *   这样单个源被限流/403 时整站搜索仍然可用。
 */

import { clearNovelCache as czClearCache, fetchNovelBook as czFetchBook, fetchNovelChapter as czFetchChapter, searchNovel as czSearch } from './novel-source';
import { bgClearNovelCache, bgFetchNovelBook, bgFetchNovelChapter, bgSearchNovel } from './novel-biquge365';
import { shClearNovelCache, shFetchNovelBook, shFetchNovelChapter, shSearchNovel } from './novel-shuhaige';
import { stClearNovelCache, stFetchNovelBook, stFetchNovelChapter, stSearchNovel } from './novel-sto66';
import type { NovelBook, NovelChapter, NovelSearchItem } from './types';

export type NovelSourceId = 'shuhaige' | 'sto66' | 'biquge365' | 'czbooks';
export type NovelSearchBy = 'articlename' | 'author';

export interface NovelSourceInfo {
  id: NovelSourceId;
  label: string;
  note: string;
}

export interface NovelSourceAdapter extends NovelSourceInfo {
  search(keyword: string, by?: NovelSearchBy): Promise<NovelSearchItem[]>;
  book(id: string): Promise<NovelBook>;
  chapter(bookId: string, chapterId: string): Promise<NovelChapter>;
  matchesId(id: string): boolean;
}

const shuhaige: NovelSourceAdapter = {
  id: 'shuhaige',
  label: '书海阁（干净）',
  note: 'book.washai.net，正文是起点原稿，无防盗乱码，目录分页抓全',
  search: (keyword, by = 'articlename') => shSearchNovel(keyword, by),
  book: (id) => shFetchNovelBook(id),
  chapter: (bookId, chapterId) => shFetchNovelChapter(bookId, chapterId),
  matchesId: (id) => /^\d{13,20}$/.test(id),
};

const sto66: NovelSourceAdapter = {
  id: 'sto66',
  label: '思兔阅读',
  note: 'sto66.com，正文干净、更新最快，目录单页抓全',
  search: (keyword, by = 'articlename') => stSearchNovel(keyword, by),
  book: (id) => stFetchNovelBook(id),
  chapter: (bookId, chapterId) => stFetchNovelChapter(bookId, chapterId),
  matchesId: (id) => /^[A-Za-z0-9]{16,32}$/.test(id) && /[A-Za-z]/.test(id) && !/^[a-z0-9]{1,15}$/.test(id),
};
const biquge365: NovelSourceAdapter = {
  id: 'biquge365',
  label: '笔趣阁（境内）',
  note: 'biquge365.net，HTML 爬取，章节按章号重排',
  search: (keyword, by = 'articlename') => bgSearchNovel(keyword, by),
  book: (id) => bgFetchNovelBook(id),
  chapter: (bookId, chapterId) => bgFetchNovelChapter(bookId, chapterId),
  matchesId: (id) => /^\d{1,12}$/.test(id),
};

const czbooks: NovelSourceAdapter = {
  id: 'czbooks',
  label: '小說狂人（境外）',
  note: 'czbooks.net，繁体正文自动转简体，偶尔限流',
  search: (keyword, by = 'articlename') => czSearch(keyword, by),
  book: (id) => czFetchBook(id),
  chapter: (bookId, chapterId) => czFetchChapter(bookId, chapterId),
  matchesId: (id) => /^[a-z0-9]{1,32}$/i.test(id) && !/^\d+$/.test(id),
};

/** 搜索时的默认尝试顺序：先境内（不容易被墙），再境外（正文更干净） */
export const DEFAULT_SOURCE_ORDER: NovelSourceId[] = ['shuhaige', 'sto66', 'biquge365', 'czbooks'];

export const NOVEL_SOURCES: NovelSourceAdapter[] = [shuhaige, sto66, biquge365, czbooks];

export function listNovelSources(): NovelSourceInfo[] {
  return NOVEL_SOURCES.map(({ id, label, note }) => ({ id, label, note }));
}

export function getNovelSource(id: string | null | undefined): NovelSourceAdapter | undefined {
  if (!id) return undefined;
  return NOVEL_SOURCES.find((s) => s.id === id);
}

export function inferNovelSource(bookId: string): NovelSourceAdapter | undefined {
  return NOVEL_SOURCES.find((s) => s.matchesId(bookId));
}

export function clearAllNovelCaches(): void {
  czClearCache();
  bgClearNovelCache();
  shClearNovelCache();
  stClearNovelCache();
}

export interface NovelSourceFailure {
  source: NovelSourceId;
  message: string;
}

export interface NovelSearchHit extends NovelSearchItem {
  source: NovelSourceId;
}

export interface NovelSearchResult {
  source: NovelSourceId | null;
  items: NovelSearchHit[];
  errors: NovelSourceFailure[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orderOf(preferred?: NovelSourceId | null): NovelSourceAdapter[] {
  const rest = NOVEL_SOURCES.filter((s) => s.id !== preferred);
  const first = getNovelSource(preferred);
  return first ? [first, ...rest] : NOVEL_SOURCES;
}

/**
 * 搜全部源并合并：单个源限流/403 只丢它自己，其它源照样出结果。
 * 结果按相关度排序（书名全等 > 前缀 > 包含），同书名同作者只留一条。
 */
export async function searchNovelAggregate(
  keyword: string,
  by: NovelSearchBy = 'articlename',
  preferred?: NovelSourceId | null
): Promise<NovelSearchResult> {
  const targets = orderOf(preferred);
  const errors: NovelSourceFailure[] = [];
  const settled = await Promise.all(
    targets.map(async (source) => {
      try {
        const items = await source.search(keyword, by);
        return { source, items };
      } catch (error) {
        errors.push({ source: source.id, message: errorMessage(error) });
        return { source, items: [] as NovelSearchHit[] };
      }
    })
  );

  const wanted = normalizeNovelText(keyword);
  const seen = new Set<string>();
  const hits: NovelSearchHit[] = [];
  for (const { source, items } of settled) {
    for (const item of items) {
      const name = normalizeNovelText(item.name);
      const author = normalizeNovelText(item.author ?? '');
      const key = name + '|' + author;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ ...item, source: source.id });
    }
  }

  const score = (hit: NovelSearchHit): number => {
    const name = normalizeNovelText(hit.name);
    const author = normalizeNovelText(hit.author ?? '');
    let value = 20;
    if (name === wanted) value = 100;
    else if (name.startsWith(wanted)) value = 80;
    else if (name.includes(wanted)) value = 60;
    if (author && author === wanted) value += 10;
    return value;
  };

  hits.sort((a, b) => score(b) - score(a));
  return { source: hits.length ? hits[0].source : null, items: hits, errors };
}

function normalizeNovelText(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/** 兼容旧调用：语义上等同于聚合搜索（保留导出名，避免调用方改动） */
export async function searchNovelAcross(
  keyword: string,
  by: NovelSearchBy = 'articlename',
  preferred?: NovelSourceId | null
): Promise<NovelSearchResult> {
  return searchNovelAggregate(keyword, by, preferred);
}

export async function fetchNovelBookAuto(id: string, src?: string | null): Promise<{ source: NovelSourceId; book: NovelBook }> {
  const preferred = getNovelSource(src) ?? inferNovelSource(id);
  const errors: string[] = [];
  for (const source of orderOf(preferred?.id)) {
    if (!source.matchesId(id)) continue;
    try {
      const book = await source.book(id);
      return { source: source.id, book };
    } catch (error) {
      errors.push(`${source.id}: ${errorMessage(error)}`);
    }
  }
  throw new Error(errors[0] ?? '没有找到这本书，换个源试试');
}

export async function fetchNovelChapterAuto(
  bookId: string,
  chapterId: string,
  src?: string | null
): Promise<{ source: NovelSourceId; chapter: NovelChapter }> {
  const preferred = getNovelSource(src) ?? inferNovelSource(bookId);
  const errors: string[] = [];
  for (const source of orderOf(preferred?.id)) {
    if (!source.matchesId(bookId)) continue;
    try {
      const chapter = await source.chapter(bookId, chapterId);
      return { source: source.id, chapter };
    } catch (error) {
      errors.push(`${source.id}: ${errorMessage(error)}`);
    }
  }
  throw new Error(errors[0] ?? '章节读取失败，换个源试试');
}
