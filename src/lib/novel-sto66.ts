/**
 * 小说源适配层：思兔阅读（www.sto66.com）的抓取与解析。
 *
 * 站点是 UTF-8 的 HTML CMS，结构与书海阁完全不同：
 * - 搜索：GET /search/<关键词>.html，结果是 div.bookbox > div.p10；
 * - 详情：GET /book/<id>.html，标题/作者/分类/状态/封面/简介在固定 class 上；
 * - 目录：GET /chapter/<id>.html，<dd><a href="/chapter/<bid>/<cid>.html" title="...">；
 * - 正文：GET /chapter/<bid>/<cid>.html，正文是 <div id="content"> 下的一串 <p>。
 *
 * 书号是 21 位大小写字母+数字（如 4Fh5LASjcQ3jIPBmsJXcxT），和书海阁的 19 位纯数字、
 * czbooks 的 5 位小写字母数字都不同，可用长度区分。
 * 解析函数保持纯函数并导出以便单测；网络层走 fetch-utils 复用超时与 SSRF 校验。
 */

import { fetchUpstream } from './fetch-utils';
import type { NovelBook, NovelChapter, NovelChapterRef, NovelSearchItem } from './types';

const BASE = 'https://www.sto66.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;
const TTL_SEARCH_MS = 10 * 60 * 1000;
const TTL_BOOK_MS = 30 * 60 * 1000;
const TTL_CHAPTER_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 120;
/** 书号：21 位 base62 */
const ID_RE = /^[A-Za-z0-9]{16,32}$/;

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

export function stClearNovelCache(): void {
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

export function stDecodeEntities(input: string): string {
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

export function stStripTags(input: string): string {
  return stDecodeEntities(input.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string | undefined {
  const m =
    tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')) ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m?.[1];
}

const JUNK_CHAPTER_TITLE = /^(开始阅读|加入书架|公告|通知|请假|感言|上架感言|完结感言|新书|作品相关|书友群)/;

/** 章节号：思兔同样是「0356【标题】」的四位补零前缀 */
export function stChapterNumber(title: string): number | null {
  const plain = title.match(/^(\d{1,5})\s*[【\[（(]/);
  if (plain) return Number(plain[1]);
  const cn = title.match(/^第\s*(\d{1,6})\s*[章节回]/);
  if (cn) return Number(cn[1]);
  return null;
}

/** 搜索结果页：div.bookbox 里一条一本 */
export function stParseSearchHtml(html: string): NovelSearchItem[] {
  const items: NovelSearchItem[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split('<div class="bookbox"').slice(1)) {
    const link = chunk.match(/<h2 class="bookname"[^>]*>\s*<a href="\/book\/([A-Za-z0-9]{16,32})\.html"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const [, id, rawName] = link;
    if (seen.has(id)) continue;
    seen.add(id);
    const author = chunk.match(/<div class="author">\s*作者：([\s\S]*?)<\/div>/)?.[1];
    const latest = chunk.match(/<div class="cat">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1];
    const intro = chunk.match(/<div class="update">\s*(?:<span>简介：<\/span>)?([\s\S]*?)<\/div>/)?.[1];
    items.push({
      id,
      name: stStripTags(rawName),
      author: author ? stStripTags(author) : '佚名',
      latestChapter: latest ? stStripTags(latest) : undefined,
      intro: intro ? stStripTags(intro) : undefined,
    });
  }
  return items;
}

/** 详情页元信息 */
export function stParseBookMetaHtml(html: string, id: string): Omit<NovelBook, 'chapters'> {
  const name = html.match(/<h1 class="booktitle"[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  const tag = html.match(/<p class="booktag"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
  const author = tag.match(/<a[^>]*class="red"[^>]*>([\s\S]*?)<\/a>/)?.[1];
  const category = tag.match(/<a[^>]*class="blue"[^>]*>([\s\S]*?)<\/a>/)?.[1];
  const status = tag.match(/<span[^>]*class="red"[^>]*>([\s\S]*?)<\/span>/)?.[1];
  const coverTag = html.match(/<img[^>]*class="thumbnail"[^>]*>/i)?.[0];
  const intro = html.match(/<p class="bookintro"[^>]*>([\s\S]*?)<\/p>/)?.[1];
  return {
    id,
    name: name ? stStripTags(name) : `书籍 ${id}`,
    author: author ? stStripTags(author) : '佚名',
    cover: coverTag ? attr(coverTag, 'src') : undefined,
    intro: intro ? stStripTags(intro) : undefined,
    category: category ? stStripTags(category) : undefined,
    status: status ? stStripTags(status) : undefined,
  };
}

/**
 * 目录页：<dd><a href="/chapter/<bid>/<cid>.html" title="标题">标题</a>
 * 页面只列本书章节，但仍按 bookId 过滤，避免推荐位混入。
 */
export function stParseTocHtml(html: string, bookId?: string): NovelChapterRef[] {
  const chapters: NovelChapterRef[] = [];
  const seen = new Set<string>();
  const re = /<a\s[^>]*href="\/chapter\/([A-Za-z0-9]{16,32})\/([A-Za-z0-9]{16,32})\.html"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    if (bookId && m[1] !== bookId) continue;
    const id = m[2];
    if (seen.has(id)) continue;
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
    const title = stStripTags(attr(openTag, 'title') ?? m[3]);
    if (!title || JUNK_CHAPTER_TITLE.test(title)) continue;
    seen.add(id);
    chapters.push({ id, title });
  }
  return chapters;
}

/** 正文页：标题 + 段落 */
export function stParseChapterHtml(html: string): { title: string; paragraphs: string[] } {
  const title = stStripTags(html.match(/<h1 class="pt10"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '');
  const body = html.match(/<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  const paragraphs: string[] = [];
  const titleKey = title.replace(/\s/g, '');
  for (const m of body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const line = stStripTags(m[1]);
    if (!line) continue;
    if (/思兔|sto66|请记住本站|最快更新|无弹窗/.test(line)) continue;
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

export async function stSearchNovel(
  keyword: string,
  by: 'articlename' | 'author' = 'articlename'
): Promise<NovelSearchItem[]> {
  const kw = keyword.trim().slice(0, 50);
  if (!kw) return [];
  const key = `novel:st:search:${by}:${kw}`;
  const hit = cacheGet<NovelSearchItem[]>(key);
  if (hit) return hit;
  const html = await getHtml(`/search/${encodeURIComponent(kw)}.html`);
  const items = stParseSearchHtml(html);
  cacheSet(key, items, TTL_SEARCH_MS);
  return items;
}

export async function stFetchNovelBook(id: string): Promise<NovelBook> {
  if (!ID_RE.test(id)) throw new Error('书籍 ID 非法');
  const key = `novel:st:book:${id}`;
  const hit = cacheGet<NovelBook>(key);
  if (hit) return hit;
  const [metaHtml, tocHtml] = await Promise.all([getHtml(`/book/${id}.html`), getHtml(`/chapter/${id}.html`)]);
  const chapters = stParseTocHtml(tocHtml, id);
  if (!chapters.length) throw new Error('这本书在源站没有章节（多为空书或已下架），换一本试试');
  const book: NovelBook = { ...stParseBookMetaHtml(metaHtml, id), chapters };
  cacheSet(key, book, TTL_BOOK_MS);
  return book;
}

export async function stFetchNovelChapter(bookId: string, chapterId: string): Promise<NovelChapter> {
  if (!ID_RE.test(bookId) || !ID_RE.test(chapterId)) throw new Error('章节 ID 非法');
  const key = `novel:st:chapter:${bookId}:${chapterId}`;
  const cached = cacheGet<NovelChapter>(key);
  if (cached) return cached;
  const book = await stFetchNovelBook(bookId);
  const index = book.chapters.findIndex((c) => c.id === chapterId);
  if (index < 0) throw new Error('章节不存在');
  const html = await getHtml(`/chapter/${bookId}/${chapterId}.html`);
  const { title, paragraphs } = stParseChapterHtml(html);
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
