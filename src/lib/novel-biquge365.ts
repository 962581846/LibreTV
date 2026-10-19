/**
 * 小说源适配层：笔趣阁（biquge365.net）的搜索 / 目录 / 正文抓取与解析。
 *
 * 该站点没有 JSON 接口，只能爬 HTML：
 * - 搜索是 POST /s.php（GET 只返回空结果页），字段 type=articlename|author、s=<关键词>；
 * - 书籍详情 /book/<id>/ 带 og:novel:* 元信息（书名、作者、封面、简介、分类、状态）；
 * - 全量目录 /newbook/<id>/（/book/ 页只有最新 20 余章）；
 * - 正文 /chapter/<bid>/<cid>.html 在 <div id="txt"> 内，段落之间是 <br/> 而非 <p>。
 *
 * 解析函数全部导出并保持纯函数（只吃 HTML 字符串），便于单元测试；
 * 网络层统一走 fetch-utils，复用其超时与 SSRF 校验。
 */

import { fetchUpstream } from './fetch-utils';
import type { NovelBook, NovelChapter, NovelChapterRef, NovelSearchItem } from './types';

const BASE = 'https://www.biquge365.net';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;
/** 搜索结果与正文缓存 10 分钟，目录 30 分钟（目录 100KB+ 且极少变化） */
const TTL_SEARCH_MS = 10 * 60 * 1000;
const TTL_BOOK_MS = 30 * 60 * 1000;
const TTL_CHAPTER_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 40;

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
  // Map 迭代序即插入序：超限时逐出最旧写入的键（正文条目小，目录条目大但数量很少）
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** 仅供测试：清空内存缓存 */
export function bgClearNovelCache(): void {
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
export function bgDecodeEntities(input: string): string {
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
export function bgStripTags(input: string): string {
  return bgDecodeEntities(input.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')) ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m?.[1];
}

/** 从任意 HTML 里取 <meta property="og:xxx" content="..."> */
export function bgMetaContent(html: string, property: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const prop = attr(tag, 'property') ?? attr(tag, 'name');
    if (prop?.toLowerCase() === property.toLowerCase()) {
      const content = attr(tag, 'content');
      return content === undefined ? undefined : bgDecodeEntities(content).trim();
    }
  }
  return undefined;
}

/** 解析搜索结果页：每个 <li> 一条，书名/作者/分类/最新章节/更新时间 */
export function bgParseSearchHtml(html: string): NovelSearchItem[] {
  const items: NovelSearchItem[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split('<li').slice(1)) {
    const idMatch = chunk.match(/<span class="name">\s*<a href="\/book\/(\d+)\/"/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const name = chunk.match(/<span class="name">[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/)?.[1];
    if (!name) continue;
    const author = chunk.match(/<span class="zuo">\s*<a [^>]*>([\s\S]*?)<\/a>/)?.[1];
    const category = chunk.match(/<span class="lei">[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/)?.[1];
    const latestChapter = chunk.match(/<span class="jie">[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/)?.[1];
    const updatedAt = chunk.match(/<span class="time">([\s\S]*?)<\/span>/)?.[1];
    items.push({
      id,
      name: bgStripTags(name),
      author: author ? bgStripTags(author) : '佚名',
      category: category ? bgStripTags(category).replace(/^\[|\]$/g, '') : undefined,
      latestChapter: latestChapter ? bgStripTags(latestChapter) : undefined,
      updatedAt: updatedAt ? bgStripTags(updatedAt) : undefined,
    });
  }
  return items;
}

/** 解析书籍页的 og:novel:* 元信息（不含目录） */
export function bgParseBookMetaHtml(html: string, id: string): Omit<NovelBook, 'chapters'> {
  const name = bgMetaContent(html, 'og:novel:book_name') ?? bgStripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '');
  const description = bgMetaContent(html, 'og:description') ?? bgMetaContent(html, 'description');
  return {
    id,
    name: name || `书籍 ${id}`,
    author: bgMetaContent(html, 'og:novel:author') ?? '佚名',
    cover: bgMetaContent(html, 'og:image'),
    intro: description,
    category: bgMetaContent(html, 'og:novel:category'),
    status: bgMetaContent(html, 'og:novel:status'),
  };
}

/** 目录里的非正文条目：站点在目录首尾挂的广告/推荐位，点进去不是正文 */
/** 中文数字（零〇一二三四五六七八九十百千万两）转阿拉伯数字，失败返回 null */
const CN_NUM: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function parseChineseNumber(text: string): number | null {
  let total = 0;
  let current = 0;
  let matched = false;
  for (const ch of text) {
    if (ch in CN_NUM) {
      current = CN_NUM[ch];
      matched = true;
    } else if (ch === '十' || ch === '百' || ch === '千') {
      const unit = ch === '十' ? 10 : ch === '百' ? 100 : 1000;
      total += (current || 1) * unit;
      current = 0;
      matched = true;
    } else if (ch === '万') {
      total = (total + current) * 10000;
      current = 0;
      matched = true;
    } else {
      return null;
    }
  }
  return matched ? total + current : null;
}

/** 从章节标题里取章节号（第12章 / 第一百六十八章）；番外、感言等取不到号的返回 null */
export function bgChapterNumber(title: string): number | null {
  const m = title.match(/^第\s*([0-9]+|[零〇一二三四五六七八九十百千万两]+)\s*[章节回]/);
  if (!m) return null;
  return /^[0-9]+$/.test(m[1]) ? Number(m[1]) : parseChineseNumber(m[1]);
}

const JUNK_CHAPTER_TITLE = /^(开始阅读|加入书架|公告|通知|请假|感言|上架感言|完结感言|新书|作品相关|书友群|求[月推])|角色传记|手游/;

/**
 * 解析全量目录页：按出现顺序去重（页面首尾会重复挂最新章节）。
 * 传 bookId 时只保留本书章节——目录页底部还有「相关推荐」，会把别的书混进来。
 */
export function bgParseTocHtml(html: string, bookId?: string): NovelChapterRef[] {
  const chapters: NovelChapterRef[] = [];
  const seen = new Set<string>();
  const re = /<a href="\/chapter\/(\d+)\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    if (bookId && m[1] !== bookId) continue;
    const id = m[2];
    if (seen.has(id)) continue;
    const title = bgStripTags(m[3]);
    if (!title || JUNK_CHAPTER_TITLE.test(title)) continue;
    seen.add(id);
    chapters.push({ id, title });
  }
  // 站点的「最新章节」小列表是倒序，全量目录是正序，混在一起会乱：统一按章号升序
  chapters.sort((a, b) => {
    const na = bgChapterNumber(a.title);
    const nb = bgChapterNumber(b.title);
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    return na - nb;
  });
  return chapters;
}

/** 解析正文页：标题 + 正文段落数组 */
export function bgParseChapterHtml(html: string): { title: string; paragraphs: string[] } {
  // <title>书名_第N章 标题_笔趣阁</title>：取中间段，避免把站名带进标题
  const pageTitle = bgStripTags(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
  const titleParts = pageTitle.split('_').map((s) => s.trim()).filter(Boolean);
  const title = titleParts.length >= 2 ? titleParts[1] : (titleParts[0] ?? '');
  const body =
    html.match(/<div[^>]*id=["']txt["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
    html.match(/<div[^>]*id=["']content["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
    '';
  const text = bgDecodeEntities(
    body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  );
  const paragraphs: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[\u00a0\u3000]/g, ' ').trim();
    if (!line) continue;
    // 站点广告与重复标题行不进正文
    if (/笔趣阁|biquge365|一秒记住|更新快|无弹窗|请记住本站/i.test(line)) continue;
    // 站点在正文里塞的「(第1/2页)」之类分页标记
    const cleaned = line.replace(/[(（]\s*第?\s*\d+\s*\/\s*\d+\s*页\s*[)）]/g, '').trim();
    if (/^第?\s*\d+\s*\/\s*\d+\s*页$/.test(cleaned)) continue;
    if (!cleaned) continue;
    if (title && cleaned.replace(/\s/g, '') === title.replace(/\s/g, '')) continue;
    paragraphs.push(cleaned);
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

/** 搜索：站点只接受 POST /s.php */
export async function bgSearchNovel(keyword: string, by: 'articlename' | 'author' = 'articlename'): Promise<NovelSearchItem[]> {
  const kw = keyword.trim().slice(0, 50);
  if (!kw) return [];
  const key = `novel:search:${by}:${kw}`;
  const hit = cacheGet<NovelSearchItem[]>(key);
  if (hit) return hit;
  const res = await fetchUpstream(`${BASE}/s.php`, {
    ...upstreamInit(),
    method: 'POST',
    headers: { ...(upstreamInit().headers as Record<string, string>), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ type: by, s: kw, submit: '' }).toString(),
    timeoutMs: TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`上游返回 ${res.status}`);
  const items = bgParseSearchHtml(await res.text());
  cacheSet(key, items, TTL_SEARCH_MS);
  return items;
}

/** 书籍详情 + 全量目录（目录页 100KB+，单次抓取后缓存 30 分钟） */
export async function bgFetchNovelBook(id: string): Promise<NovelBook> {
  if (!/^\d+$/.test(id)) throw new Error('书籍 ID 非法');
  const key = `novel:book:${id}`;
  const hit = cacheGet<NovelBook>(key);
  if (hit) return hit;
  const [metaHtml, tocHtml] = await Promise.all([getHtml(`/book/${id}/`), getHtml(`/newbook/${id}/`)]);
  const book: NovelBook = { ...bgParseBookMetaHtml(metaHtml, id), chapters: bgParseTocHtml(tocHtml, id) };
  if (!book.chapters.length) throw new Error('目录为空');
  cacheSet(key, book, TTL_BOOK_MS);
  return book;
}

/** 单章正文 + 上下章（顺序取自目录缓存） */
export async function bgFetchNovelChapter(bookId: string, chapterId: string): Promise<NovelChapter> {
  if (!/^\d+$/.test(bookId) || !/^\d+$/.test(chapterId)) throw new Error('章节 ID 非法');
  const key = `novel:chapter:${bookId}:${chapterId}`;
  const cached = cacheGet<NovelChapter>(key);
  if (cached) return cached;
  const book = await bgFetchNovelBook(bookId);
  const index = book.chapters.findIndex((c) => c.id === chapterId);
  if (index < 0) throw new Error('章节不存在');
  const html = await getHtml(`/chapter/${bookId}/${chapterId}.html`);
  const { title, paragraphs } = bgParseChapterHtml(html);
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
