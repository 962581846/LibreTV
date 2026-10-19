/**
 * 小说源适配层：小說狂人（czbooks.net，台灣站）的搜索 / 目录 / 正文抓取与解析。
 *
 * 为什么用这个站：国内那批盗版站会把别的小说的段落塞进正文（读起来是乱的），
 * czbooks 的正文是干净的整段文字；站点虽然被 Cloudflare 前置，
 * 但从 Cloudflare Worker 直接 GET 能拿到 200，所以适合部署在 Worker 上的本应用。
 *
 * 站点没有 JSON 接口，只能爬 HTML：
 * - 搜索：GET /s/<关键词>?q=<关键词>（繁简都吃，站内自己做归一化）；作者页 /a/<作者> 结构相同
 * - 书籍详情：GET /n/<bookId>，<div class="info"> 里有《书名》和作者，.description 是简介，
 *   state 表里有連載狀態 / 分類，chapter-list 是全量目录（上千章一次给全，无分页）
 * - 正文：GET /n/<bookId>/<chapterId>，正文在 <div class="content">，段落之间是 <br />
 * - 站点输出繁體，统一用 toSimplified() 转简体后再返回给前端
 *
 * 解析函数全部导出且是纯函数（只吃 HTML 字符串），便于单元测试；
 * 网络层统一走 fetch-utils，复用其超时与 SSRF 校验。
 */

import { fetchUpstream } from './fetch-utils';
import { toSimplified } from './novel-t2s';
import type { NovelBook, NovelChapter, NovelChapterRef, NovelSearchItem } from './types';

const BASE = 'https://czbooks.net';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;
/** 搜索缓存 10 分钟，目录 30 分钟（上千章且极少变化），正文 30 分钟（正文不会改，下载整本时会大量命中） */
const TTL_SEARCH_MS = 10 * 60 * 1000;
const TTL_BOOK_MS = 30 * 60 * 1000;
const TTL_CHAPTER_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 240;

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
  // Map 迭代序即插入序：超限时逐出最旧写入的键
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** 仅供测试：清空内存缓存 */
export function clearNovelCache(): void {
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
  ndash: '–',
  middot: '·',
  times: '×',
  copy: '©',
};

/** 解开 HTML 实体；未知实体原样保留，避免吞掉正文 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** 去标签 + 解实体 + 压空白（czbooks 的 HTML 里属性和值之间常有空格，正则都要容忍） */
export function stripTags(input: string): string {
  return decodeEntities(input.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取指定 class 的 div 内容（czbooks 用 class = "xxx" 这种带空格的写法） */
function divByClass(html: string, className: string): string | undefined {
  const re = new RegExp(
    `<div\\s+class\\s*=\\s*"${className}"\\s*>([\\s\\S]*?)</div>`,
    'i'
  );
  return html.match(re)?.[1];
}

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

/** 从章节标题里取章节号（第12章 / 第一百六十八章）；番外等取不到号的返回 null */
export function chapterNumber(title: string): number | null {
  const m = title.match(/^第\s*([0-9]+|[零〇一二三四五六七八九十百千万两]+)\s*[章節节回]/);
  if (!m) return null;
  return /^[0-9]+$/.test(m[1]) ? Number(m[1]) : parseChineseNumber(m[1]);
}

/**
 * 解析搜索结果页（/s/<kw> & 作者页 /a/<name>）。
 * 每个结果是一个 <li class = "novel-item-wrapper"> 块：
 * 书名在 .novel-item-title，作者 / 最新章 / 日期分别在 .novel-item-author / -newest-chapter / -date
 */
export function parseSearchHtml(html: string): NovelSearchItem[] {
  const items: NovelSearchItem[] = [];
  const seen = new Set<string>();
  const blocks = html.split(/class\s*=\s*"novel-item-wrapper"/i).slice(1);
  for (const block of blocks) {
    const id = block.match(/\/n\/([a-z0-9]+)/i)?.[1];
    if (!id || seen.has(id)) continue;
    const name = stripTags(block.match(/class\s*=\s*"novel-item-title"\s*>([\s\S]*?)<\/div>/i)?.[1] ?? '');
    if (!name) continue;
    const author = stripTags(block.match(/class\s*=\s*"novel-item-author"\s*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '');
    const latestChapter = stripTags(
      block.match(/class\s*=\s*"novel-item-newest-chapter"\s*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ''
    );
    const updatedAt = stripTags(block.match(/class\s*=\s*"novel-item-date"\s*>([\s\S]*?)<\/div>/i)?.[1] ?? '');
    seen.add(id);
    items.push({
      id,
      name: toSimplified(name),
      author: toSimplified(author || '佚名'),
      latestChapter: latestChapter ? toSimplified(latestChapter) : undefined,
      updatedAt: updatedAt || undefined,
    });
  }
  return items;
}

/** 解析书籍详情页的元信息（书名 / 作者 / 封面 / 简介 / 分类 / 状态），不含目录 */
export function parseBookMetaHtml(html: string, id: string): Omit<NovelBook, 'chapters'> {
  const info = divByClass(html, 'info') ?? '';
  const name = stripTags(info.match(/class\s*=\s*"title"\s*>\s*《([\s\S]*?)》/i)?.[1] ?? '');
  const author = stripTags(info.match(/class\s*=\s*"author"\s*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '');
  const thumbnail = divByClass(html, 'thumbnail') ?? '';
  const coverRaw = thumbnail.match(/<img[^>]*src\s*=\s*"([^"]+)"/i)?.[1] ?? '';
  const cover = /default_no_thumbnail/i.test(coverRaw) ? undefined : coverRaw || undefined;
  const status = stripTags(html.match(/連載狀態\s*<\/td>\s*<td>([\s\S]*?)<\/td>/i)?.[1] ?? '');
  const category = stripTags(html.match(/id\s*=\s*"novel-category"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '');
  const intro = stripTags(divByClass(html, 'description') ?? '');
  return {
    id,
    name: toSimplified(name || `书籍 ${id}`),
    author: toSimplified(author || '佚名'),
    cover,
    intro: intro ? toSimplified(intro) : undefined,
    category: category ? toSimplified(category) : undefined,
    status: status ? toSimplified(status) : undefined,
  };
}

/** 目录里夹着的站点通知（今天无更 / 求月票 / 上架感言…）不是正文章节，「番外」这类保留 */
const JUNK_TOC_TITLE = /^(今天|今日|明天)?(无更|停更|断更|请假|一更|二更)|^(求|求个)(月票|推荐票|收藏|订阅|打赏)|感言$|^公告|^通知$|^新书|^上架/;

/**
 * 解析全量目录：chapter-list 里每个 <li><a href="//czbooks.net/n/<bookId>/<chapterId>">第N章…</a></li>，
 * 卷标题是 <li class="volume">，没有 href，自然被跳过。按章号升序排列。
 */
export function parseTocHtml(html: string, bookId?: string): NovelChapterRef[] {
  const chapters: NovelChapterRef[] = [];
  const seen = new Set<string>();
  const idFilter = bookId ? `\\/n\\/${bookId}\\/` : '\\/n\\/[a-z0-9]+\\/';
  const re = new RegExp(`href\\s*=\\s*"(?:https?:)?\\/\\/czbooks\\.net${idFilter.replace(/\\\//g, '\\/')}([a-z0-9]+)"[^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
  for (const m of html.matchAll(re)) {
    const id = m[1];
    if (seen.has(id)) continue;
    const title = stripTags(m[2]);
    if (!title) continue;
    // 站点输出繁體，通知类标题转成简体后再匹配（否则「今天無更」漏网）
    const simplifiedTitle = toSimplified(title);
    if (JUNK_TOC_TITLE.test(simplifiedTitle)) continue;
    seen.add(id);
    chapters.push({ id, title: toSimplified(title) });
  }
  // 目录里混着「最新章節」小块（倒序）时统一按章号升序，番外等无号章节保持原顺序排在最后
  chapters.sort((a, b) => {
    const na = chapterNumber(a.title);
    const nb = chapterNumber(b.title);
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    return na - nb;
  });
  return chapters;
}

/** 解析正文页：<div class="content"> 里用 <br /> 分段 */
export function parseChapterHtml(html: string): { title: string; paragraphs: string[] } {
  const name = stripTags(html.match(/<div\s+class\s*=\s*"name"\s*>([\s\S]*?)<\/div>/i)?.[1] ?? '');
  // 「《书名》第12章 标题」→「第12章 标题」
  const title = toSimplified(name.replace(/^《[^》]*》\s*/, '').trim());
  const body = divByClass(html, 'content') ?? '';
  const text = decodeEntities(
    body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  );
  const paragraphs: string[] = [];
  const titleKey = title.replace(/\s/g, '');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[\u00a0\u3000]/g, ' ').trim();
    if (!line) continue;
    // 站点广告行不进正文
    if (/小說狂人|小说狂人|czbooks|請記住|请记住本站|一秒記住|更新快|無彈窗|无弹窗/i.test(line)) continue;
    const simplified = toSimplified(line);
    // 章节标题在正文开头重复一次，去掉（比较用转换后的简体，繁简都能对上）
    if (titleKey && simplified.replace(/\s/g, '') === titleKey) continue;
    paragraphs.push(simplified);
  }
  return { title, paragraphs };
}

async function getHtml(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetchUpstream(url, {
    timeoutMs: TIMEOUT_MS,
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-TW,zh;q=0.9',
    },
    signal,
  });
  if (!res.ok) throw new Error(`小说源返回 ${res.status}，请稍后重试`);
  return await res.text();
}

/** czbooks 的书籍 ID / 章节 ID 都是小写字母数字（如 uj4ib、ui3pg），这里统一校验 */
export function isNovelId(value: string): boolean {
  return /^[a-z0-9]{1,32}$/i.test(value);
}

/** 搜索：by=author 走作者页，否则走站内搜索页 */
export async function searchNovel(keyword: string, by: 'articlename' | 'author' = 'articlename'): Promise<NovelSearchItem[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const seg = by === 'author' ? 'a' : 's';
  const encoded = encodeURIComponent(kw);
  const url = seg === 's' ? `${BASE}/s/${encoded}?q=${encoded}` : `${BASE}/a/${encoded}`;
  const cacheKey = `search:${seg}:${kw}`;
  const cached = cacheGet<NovelSearchItem[]>(cacheKey);
  if (cached) return cached;
  const items = parseSearchHtml(await getHtml(url));
  cacheSet(cacheKey, items, TTL_SEARCH_MS);
  return items;
}

/** 书籍详情 + 全量目录（一次请求，站点在同一个页面里给全） */
export async function fetchNovelBook(id: string): Promise<NovelBook> {
  const bookId = id.trim();
  if (!isNovelId(bookId)) throw new Error('书籍 ID 不合法');
  const cacheKey = `book:${bookId}`;
  const cached = cacheGet<NovelBook>(cacheKey);
  if (cached) return cached;
  const html = await getHtml(`${BASE}/n/${bookId}`);
  const book: NovelBook = { ...parseBookMetaHtml(html, bookId), chapters: parseTocHtml(html, bookId) };
  if (!book.chapters.length) throw new Error('这本书在源站没有章节（多为空书或已下架），换一本试试');
  cacheSet(cacheKey, book, TTL_BOOK_MS);
  return book;
}

/** 单章正文；上下章与序号取自目录缓存 */
export async function fetchNovelChapter(bookId: string, chapterId: string): Promise<NovelChapter> {
  const bid = bookId.trim();
  const cid = chapterId.trim();
  if (!isNovelId(bid) || !isNovelId(cid)) throw new Error('章节参数不合法');
  const cacheKey = `chapter:${bid}:${cid}`;
  const cached = cacheGet<NovelChapter>(cacheKey);
  if (cached) return cached;

  const [{ title, paragraphs }, book] = await Promise.all([
    getHtml(`${BASE}/n/${bid}/${cid}`).then(parseChapterHtml),
    fetchNovelBook(bid).catch(() => undefined),
  ]);
  const chapters = book?.chapters ?? [];
  const index = chapters.findIndex((c) => c.id === cid);
  const chapter: NovelChapter = {
    id: cid,
    bookId: bid,
    title: title || chapters[index]?.title || `章节 ${cid}`,
    content: paragraphs.join('\n'),
    index: index >= 0 ? index : 0,
    total: chapters.length,
    prevId: index > 0 ? chapters[index - 1].id : undefined,
    nextId: index >= 0 && index + 1 < chapters.length ? chapters[index + 1].id : undefined,
  };
  cacheSet(cacheKey, chapter, TTL_CHAPTER_MS);
  return chapter;
}
