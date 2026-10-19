/**
 * 小说源适配层：书海阁（book.washai.net）的抓取与解析。
 *
 * 站点是标准 HTML CMS（没有 JSON 接口）：
 * - 搜索：GET /book/bookclass.html?k=<关键词>&page=1，结果是 <article class="classBookCard">，
 *   单页最多 18 条，page=2 直接 404，所以不做翻页；
 * - 详情：GET /book/<id>.html，书名/作者/状态/封面/分类/简介都挂在固定 id 的元素上；
 * - 目录：GET /book/indexList-<id>.html 是第 1 页，之后 /book/indexList/<id>/<n>.html，
 *   每页 100 章，页数由 #indexPager 的 data-total / data-page-size 算出；
 * - 正文：GET /book/<id>/<cid>.html，标题在 <span class="readChapterAppendText">，
 *   正文是 <div class="readChapterAppendBody"> 下的一串 <p>。
 *
 * 相比另两个源，这里的正文是起点原稿（作者的话、求月票都在），没有防盗乱码与替换段。
 * 解析函数保持纯函数并导出以便单测；网络层走 fetch-utils，复用超时与 SSRF 校验。
 */

import { fetchUpstream } from './fetch-utils';
import type { NovelBook, NovelChapter, NovelChapterRef, NovelSearchItem } from './types';

const BASE = 'https://book.washai.net';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;
/** 搜索结果与正文 10 分钟，目录 30 分钟（目录 4 页、350 章，很少变化） */
const TTL_SEARCH_MS = 10 * 60 * 1000;
const TTL_BOOK_MS = 30 * 60 * 1000;
const TTL_CHAPTER_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 120;
/** 目录最多抓 30 页（3000 章），防止异常页面把请求打爆 */
const MAX_TOC_PAGES = 30;
/** 书号是 19 位数字（如 1262260513468565162），章节号同为 19 位 */
const ID_RE = /^\d{10,20}$/;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** 仅供测试与多源注册表清缓存用 */
export function shClearNovelCache(): void {
  cache.clear();
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  middot: '·',
  times: '×',
};

/** 解码 HTML 实体（数字实体与常见命名实体） */
export function shDecodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 去标签 + 解码实体 + 压缩空白 */
export function shStripTags(input: string): string {
  return shDecodeEntities(input.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string | undefined {
  const m =
    tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')) ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m?.[1];
}

/** 站点在标题里塞的 [免费]/[VIP] 标记，不是标题的一部分 */
function cleanChapterTitle(raw: string): string {
  const withoutMark = raw.replace(/<i[^>]*>[\s\S]*?<\/i>/gi, '');
  return shStripTags(withoutMark)
    .replace(/[\[【(（]\s*(免费|VIP|vip|收费)\s*[\]】)）]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const JUNK_CHAPTER_TITLE = /^(开始阅读|加入书架|公告|通知|请假|感言|上架感言|完结感言|新书|作品相关|书友群)/;

/** 从章节标题里取章节号：书海阁是「0352【缩减待遇】」这种四位补零前缀 */
export function shChapterNumber(title: string): number | null {
  const plain = title.match(/^(\d{1,5})\s*[【\[（(]/);
  if (plain) return Number(plain[1]);
  const cn = title.match(/^第\s*(\d{1,6})\s*[章节回]/);
  if (cn) return Number(cn[1]);
  return null;
}

/** 解析搜索结果页：每个 <article class="classBookCard"> 一条 */
export function shParseSearchHtml(html: string): NovelSearchItem[] {
  const items: NovelSearchItem[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split('<article class="classBookCard"').slice(1)) {
    const id = chunk.match(/\/book\/(\d{10,20})\.html/)?.[1];
    if (!id || seen.has(id)) continue;
    const name = chunk.match(/class="classBookTitle"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1];
    if (!name) continue;
    seen.add(id);
    const author = chunk.match(/class="classBookAuthor"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1];
    const category =
      chunk.match(/class="[^"]*classCoverCat"[^>]*>([\s\S]*?)<\/a>/)?.[1] ??
      chunk.match(/class="[^"]*classCoverCat"[^>]*title="([^"]*)"/)?.[1];
    const latestChapter = chunk.match(/class="classBookChapter"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1];
    const updatedAt = chunk.match(/class="classBookTime[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1];
    items.push({
      id,
      name: shStripTags(name),
      author: author ? shStripTags(author) : '佚名',
      category: category ? shStripTags(category) : undefined,
      latestChapter: latestChapter ? cleanChapterTitle(latestChapter) : undefined,
      updatedAt: updatedAt ? shStripTags(updatedAt) : undefined,
    });
  }
  return items;
}

/** 解析书籍详情页的元信息（不含目录） */
export function shParseBookMetaHtml(html: string, id: string): Omit<NovelBook, 'chapters'> {
  const name =
    html.match(/id="bookName"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
  const author = html.match(/id="bookAuthor"[^>]*>([\s\S]*?)<\/a>/)?.[1];
  const status = html.match(/id="bookStatus"[^>]*>([\s\S]*?)<\/em>/)?.[1];
  const category = html.match(/id="bookCatBadge"[^>]*>([\s\S]*?)<\/a>/)?.[1];
  const coverTag = html.match(/<img[^>]*id=["']bookCoverImg["'][^>]*>/i)?.[0];
  const intro =
    html.match(/id="bookDesc"[^>]*>([\s\S]*?)<\/p>/)?.[1] ??
    html.match(/<meta[^>]*property=["']og:description["'][^>]*>/i)?.[0];
  return {
    id,
    name: shStripTags(name) || `书籍 ${id}`,
    author: author ? shStripTags(author) : '佚名',
    cover: coverTag ? attr(coverTag, 'src') : undefined,
    intro: intro ? shStripTags(intro) : undefined,
    category: category ? shStripTags(category) : undefined,
    status: status ? shStripTags(status) : undefined,
  };
}

/** 目录页总页数：读 #indexPager 的 data-total / data-page-size */
export function shParseTocPageCount(html: string): number {
  const tag = html.match(/<div[^>]*id=["']indexPager["'][^>]*>/i)?.[0];
  if (!tag) return 1;
  const total = Number(attr(tag, 'data-total') ?? '0');
  const size = Number(attr(tag, 'data-page-size') ?? '100');
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(size) || size <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

/**
 * 解析单页目录：<li data-index-id="<cid>"><a href="/book/<bid>/<cid>.html">标题</a></li>
 * 卷标题是 <li class="catalogVolumeHeading">、没有 data-index-id，天然被跳过。
 * 传 bookId 时只保留本书——目录页底部会混入「相关推荐」的别的书。
 */
export function shParseTocHtml(html: string, bookId?: string): NovelChapterRef[] {
  const chapters: NovelChapterRef[] = [];
  const seen = new Set<string>();
  const re = /<li[^>]*data-index-id="(\d{10,20})"[^>]*>\s*<a href="\/book\/(\d{10,20})\/(\d{10,20})\.html"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    if (bookId && m[2] !== bookId) continue;
    const id = m[3];
    if (seen.has(id)) continue;
    const title = cleanChapterTitle(m[4]);
    if (!title || JUNK_CHAPTER_TITLE.test(title)) continue;
    seen.add(id);
    chapters.push({ id, title });
  }
  return chapters;
}

/** 解析正文页：标题 + 段落数组 */
export function shParseChapterHtml(html: string): { title: string; paragraphs: string[] } {
  const rawTitle = html.match(/class="readChapterAppendText"[^>]*>([\s\S]*?)<\/span>/)?.[1];
  const title = rawTitle ? cleanChapterTitle(rawTitle) : '';
  const body = html.match(/<div class="readChapterAppendBody">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const paragraphs: string[] = [];
  const titleKey = title.replace(/\s/g, '');
  for (const m of body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const line = shStripTags(m[1]).replace(/^[\u00a0\u3000]+/, '').trim();
    if (!line) continue;
    // 站点的广告尾巴不进正文
    if (/书海阁|washai|笔趣阁|一秒记住|更新快|无弹窗|请记住本站|最新章节/.test(line)) continue;
    // 有些页面把标题重复成第一段
    if (titleKey && line.replace(/\s/g, '') === titleKey) continue;
    paragraphs.push(line);
  }
  return { title, paragraphs };
}

function upstreamInit(): RequestInit {
  return {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: `${BASE}/`,
    },
  };
}

async function getHtml(path: string): Promise<string> {
  const res = await fetchUpstream(`${BASE}${path}`, { ...upstreamInit(), timeoutMs: TIMEOUT_MS });
  if (!res.ok) throw new Error(`上游返回 ${res.status}`);
  return res.text();
}

/** 搜索：站点只有一个搜索框，by 参数只影响缓存键（作者名同样能在书名框里搜到） */
export async function shSearchNovel(
  keyword: string,
  by: 'articlename' | 'author' = 'articlename'
): Promise<NovelSearchItem[]> {
  const kw = keyword.trim().slice(0, 50);
  if (!kw) return [];
  const key = `novel:sh:search:${by}:${kw}`;
  const hit = cacheGet<NovelSearchItem[]>(key);
  if (hit) return hit;
  const html = await getHtml(`/book/bookclass.html?k=${encodeURIComponent(kw)}&page=1`);
  const items = shParseSearchHtml(html);
  cacheSet(key, items, TTL_SEARCH_MS);
  return items;
}

function mergeToc(pages: string[], bookId: string): NovelChapterRef[] {
  const chapters: NovelChapterRef[] = [];
  const seen = new Set<string>();
  for (const html of pages) {
    for (const chapter of shParseTocHtml(html, bookId)) {
      if (seen.has(chapter.id)) continue;
      seen.add(chapter.id);
      chapters.push(chapter);
    }
  }
  return chapters;
}

/** 书籍详情 + 全量目录（目录 4 页 350 章，抓完缓存 30 分钟） */
export async function shFetchNovelBook(id: string): Promise<NovelBook> {
  if (!ID_RE.test(id)) throw new Error('书籍 ID 非法');
  const key = `novel:sh:book:${id}`;
  const hit = cacheGet<NovelBook>(key);
  if (hit) return hit;
  const first = await getHtml(`/book/indexList-${id}.html`);
  const pages = Math.min(shParseTocPageCount(first), MAX_TOC_PAGES);
  const rest: string[] = [];
  for (let page = 2; page <= pages; page += 1) {
    rest.push(await getHtml(`/book/indexList/${id}/${page}.html`));
  }
  const metaHtml = await getHtml(`/book/${id}.html`);
  const chapters = mergeToc([first, ...rest], id);
  if (!chapters.length) throw new Error('这本书在源站没有章节（多为空书或已下架），换一本试试');
  const book: NovelBook = { ...shParseBookMetaHtml(metaHtml, id), chapters };
  cacheSet(key, book, TTL_BOOK_MS);
  return book;
}

/** 单章正文 + 上下章（顺序取自目录缓存） */
export async function shFetchNovelChapter(bookId: string, chapterId: string): Promise<NovelChapter> {
  if (!ID_RE.test(bookId) || !ID_RE.test(chapterId)) throw new Error('章节 ID 非法');
  const key = `novel:sh:chapter:${bookId}:${chapterId}`;
  const cached = cacheGet<NovelChapter>(key);
  if (cached) return cached;
  const book = await shFetchNovelBook(bookId);
  const index = book.chapters.findIndex((c) => c.id === chapterId);
  if (index < 0) throw new Error('章节不存在');
  const html = await getHtml(`/book/${bookId}/${chapterId}.html`);
  const { title, paragraphs } = shParseChapterHtml(html);
  if (!paragraphs.length) throw new Error('正文为空');
  const chapter: NovelChapter = {
    id: chapterId,
    bookId,
    title: title || book.chapters[index].title,
    content: paragraphs.join('\n'),
    index,
    total: book.chapters.length,
    prevId: index > 0 ? book.chapters[index - 1].id : undefined,
    nextId: index + 1 < book.chapters.length ? book.chapters[index + 1].id : undefined,
  };
  cacheSet(key, chapter, TTL_CHAPTER_MS);
  return chapter;
}
