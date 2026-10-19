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
import type { NovelBook, NovelChapter, NovelSearchItem } from './types';

export type NovelSourceId = 'biquge365' | 'czbooks';
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
export const DEFAULT_SOURCE_ORDER: NovelSourceId[] = ['biquge365', 'czbooks'];

export const NOVEL_SOURCES: NovelSourceAdapter[] = [biquge365, czbooks];

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
}

export interface NovelSourceFailure {
  source: NovelSourceId;
  message: string;
}

export interface NovelSearchResult {
  source: NovelSourceId | null;
  items: NovelSearchItem[];
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

/** 依次尝试各个源；第一个返回非空结果的源胜出，其它源的失败原因汇总返回 */
export async function searchNovelAcross(
  keyword: string,
  by: NovelSearchBy = 'articlename',
  preferred?: NovelSourceId | null
): Promise<NovelSearchResult> {
  const errors: NovelSourceFailure[] = [];
  for (const source of orderOf(preferred)) {
    try {
      const items = await source.search(keyword, by);
      if (items.length) return { source: source.id, items, errors };
    } catch (error) {
      errors.push({ source: source.id, message: errorMessage(error) });
    }
  }
  return { source: null, items: [], errors };
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

export async function fetchNovelChapterAuto(bookId: string, chapterId: string, src?: string | null): Promise<{ source: NovelSourceId; chapter: NovelChapter }> {
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
