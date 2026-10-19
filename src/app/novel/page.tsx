'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { Spinner } from '@/components/states';
import { api } from '@/lib/client-api';
import { cn } from '@/lib/utils';

/** 最近阅读（本地记录，最多 20 条） */
// v2：小说源从 biquge365 换到 czbooks 后书籍 ID 体系变了，旧记录点开必然 404
const RECENT_KEY = 'libretv:novel:recent:v2';
/** 阅读字号（本地记忆） */
const FONT_KEY = 'libretv:novel:font';
/** 选中的小说源（本地记忆，auto 表示自动选源） */
const SRC_KEY = 'libretv:novel:src';
/** 源下拉选项：与 src/lib/novel-sources.ts 的注册表保持一致（不 import 服务端模块，避免把抓取代码打进前端包） */
const SOURCE_OPTIONS = [
  { id: 'auto', label: '自动选源' },
  { id: 'shuhaige', label: '书海阁(干净)' },
  { id: 'biquge365', label: '笔趣阁(境内)' },
  { id: 'czbooks', label: '小說狂人(境外)' },
] as const;
/** 源 id → 展示名（结果行徽标用） */
function sourceLabel(id: string): string {
  const option = SOURCE_OPTIONS.find((o) => o.id === id);
  return option?.label ?? id;
}

/** 外站封面走本站代理：源站做了 referer 校验/防盗链，直连会变成破图 */
function coverSrc(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

/** 目录一次渲染多少章 */
const PAGE_SIZE = 200;

/** 书籍详情（含全量目录）的类型，跟随 api 层签名 */
type NovelBookData = Awaited<ReturnType<typeof api.novelBook>>;

interface RecentItem {
  id: string;
  src?: string;
  name: string;
  chapterId: string;
  chapterTitle: string;
  ts: number;
}

function readRecent(): RecentItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as RecentItem[]) : [];
    return Array.isArray(list) ? list.filter((x) => x && typeof x.id === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
}

function writeRecent(item: RecentItem): RecentItem[] {
  if (typeof window === 'undefined') return [];
  const next = [item, ...readRecent().filter((x) => !(x.id === item.id && x.chapterId === item.chapterId))].slice(0, 20);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 配额满时忽略：最近阅读只是便利功能 */
  }
  return next;
}

/**
 * 小说页：搜索 → 详情目录 → 阅读，状态由 URL 驱动（?id=<书籍>&c=<章节>）。
 * 内容来源为台灣「小說狂人」（czbooks.net）：服务端抓取后归一化成 JSON（/api/novel/*），
 * 并统一转成简体；该站正文干净，不会像部分盗版站那样插入别的小说的段落。
 */
export default function NovelPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-page">
          <Header />
          <div className="flex justify-center py-24">
            <Spinner size="lg" />
          </div>
        </div>
      }
    >
      <NovelContent />
    </Suspense>
  );
}

function NovelContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const bookId = searchParams.get('id') ?? '';
  const chapterId = searchParams.get('c') ?? '';

  const [input, setInput] = useState('');
  const [by, setBy] = useState<'articlename' | 'author'>('articlename');
  // 下拉里的选择：auto 表示让服务端按顺序试；不因命中某个源而改写，避免下次失去回退能力
  const [src, setSrc] = useState<string>('auto');
  // 本次搜索实际命中的源：目录/正文沿用同一个源，避免跨源 ID 混用
  const [pinnedSrc, setPinnedSrc] = useState<string>('');
  const effSrc = pinnedSrc || src;
  const [kw, setKw] = useState('');
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [fontSize, setFontSize] = useState(18);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);

  useEffect(() => {
    setRecent(readRecent());
    const saved = Number(window.localStorage.getItem(FONT_KEY) ?? '');
    if (saved >= 14 && saved <= 30) setFontSize(saved);
    const urlSrc = searchParams.get('src');
    if (urlSrc && SOURCE_OPTIONS.some((o) => o.id === urlSrc)) setPinnedSrc(urlSrc);
    const savedSrc = window.localStorage.getItem(SRC_KEY);
    if (savedSrc && SOURCE_OPTIONS.some((o) => o.id === savedSrc)) setSrc(savedSrc);
  }, [searchParams]);

  useEffect(() => {
    window.localStorage.setItem(FONT_KEY, String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    window.localStorage.setItem(SRC_KEY, src);
  }, [src]);

  useEffect(() => {
    srcRef.current = effSrc;
  }, [effSrc]);

  const searchQuery = useQuery({
    queryKey: ['novel-search', kw, by, src],
    queryFn: ({ signal }) => api.novelSearch(kw, by, src, signal),
    enabled: kw.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  const bookQuery = useQuery({
    queryKey: ['novel-book', bookId, effSrc],
    queryFn: ({ signal }) => api.novelBook(bookId, effSrc, signal),
    enabled: bookId.length > 0,
    staleTime: 30 * 60 * 1000,
    retry: 0,
  });

  const chapterQuery = useQuery({
    queryKey: ['novel-chapter', bookId, chapterId, effSrc],
    queryFn: ({ signal }) => api.novelChapter(bookId, chapterId, effSrc, signal),
    enabled: bookId.length > 0 && chapterId.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 0,
  });

  const book = bookQuery.data;
  const chapter = chapterQuery.data;

  // 自动选源搜到结果后，记住实际命中的源供目录/正文复用
  useEffect(() => {
    const hit = searchQuery.data?.source;
    if (hit) setPinnedSrc(hit);
  }, [searchQuery.data?.source]);

  // 打开正文即写入最近阅读（含章节标题，便于书架直接跳回）
  useEffect(() => {
    if (!chapter || !book) return;
    setRecent(writeRecent({ id: book.id, src: effSrc || undefined, name: book.name, chapterId: chapter.id, chapterTitle: chapter.title, ts: Date.now() }));
  }, [chapter, book, effSrc]);

  const openBook = useCallback(
    (id: string, src?: string) => {
      setCatalogFilter('');
      setShown(PAGE_SIZE);
      if (src) setPinnedSrc(src);
      const suffix = src ? `&src=${encodeURIComponent(src)}` : '';
      router.push(`/novel?id=${encodeURIComponent(id)}${suffix}`, { scroll: false });
    },
    [router]
  );

  const openChapter = useCallback(
    (id: string, cid: string, src?: string) => {
      if (src) setPinnedSrc(src);
      const suffix = src ? `&src=${encodeURIComponent(src)}` : '';
      router.push(`/novel?id=${encodeURIComponent(id)}&c=${encodeURIComponent(cid)}${suffix}`, { scroll: false });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [router]
  );

  // 整本下载：逐章取正文拼成一个 TXT。必须串行 + 自适应限速：源站对 Worker 出网 IP 有频率限制，
  // 实测 4 并发或 <0.5s 间隔都会大面积 429；间隔稳定在 1.5s 左右时 8/8 全通。
  // 因此这里从 600ms 起步，撞到 429 就翻倍放慢（上限 4s），连续顺利再慢慢收回。
  const [download, setDownload] = useState<{ done: number; failed: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 下载循环里要读「当前生效的源」，用 ref 避免闭包拿到旧值
  const srcRef = useRef(effSrc);

  const cancelDownload = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setDownload(null);
  }, []);

  const startDownload = useCallback(async (target: NovelBookData | undefined) => {
    if (!target || !target.chapters.length) return;
    const chapters = target.chapters;
    const controller = new AbortController();
    abortRef.current = controller;
    setDownload({ done: 0, failed: 0, total: chapters.length });

    const slots: string[] = new Array(chapters.length).fill('');
    let done = 0;
    let failed = 0;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let gapMs = 600;
    let streak = 0;
    for (let index = 0; index < chapters.length; index += 1) {
      if (controller.signal.aborted) break;
      const ref = chapters[index];
      let text: string | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await sleep(gapMs);
        if (controller.signal.aborted) break;
        try {
          const ch = await api.novelChapter(target.id, ref.id, srcRef.current, controller.signal);
          text = `${ch.title}\n\n${ch.content}`;
          streak += 1;
          // 连续顺利就慢慢提速，逼近源站能接受的节奏
          if (streak >= 8) {
            streak = 0;
            gapMs = Math.max(600, Math.round(gapMs * 0.85));
          }
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : '';
          // 未登录 / 章节不存在，重试也没用
          if (/未登录|不存在|非法/.test(message)) break;
          // 其余（多半是 429 限流）放慢再试
          gapMs = Math.min(4000, Math.round(gapMs * 2));
          streak = 0;
        }
      }
      slots[index] = text ?? `${ref.title}\n\n（本章下载失败，重新下载即可补齐）`;
      if (!text) failed += 1;
      done += 1;
      setDownload({ done, failed, total: chapters.length });
      if (index + 1 < chapters.length) await sleep(gapMs);
    }

    const aborted = controller.signal.aborted;
    abortRef.current = null;
    setDownload(null);
    if (aborted) return;

    const head = `《${target.name}》${target.author ? `\n作者：${target.author}` : ''}${target.chapters.length ? `\n共 ${target.chapters.length} 章` : ''}\n\n`;
    const body = slots.filter((x) => x).join('\n\n');
    const blob = new Blob([head + body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${target.name.replace(/[\\/:*?"<>|]/g, '_')}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, []);

  // 键盘翻页：← 上一章、→ 下一章（输入框聚焦时不拦截）
  useEffect(() => {
    if (!chapter) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === 'ArrowLeft' && chapter.prevId) openChapter(chapter.bookId, chapter.prevId);
      if (e.key === 'ArrowRight' && chapter.nextId) openChapter(chapter.bookId, chapter.nextId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chapter, openChapter]);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const value = input.trim();
    if (!value) return;
    setKw(value);
    router.push('/novel', { scroll: false });
  };

  // 目录随书本对象变化，单独 memo 以免下游 useMemo 每次都重算
  const chapters = useMemo(() => book?.chapters ?? [], [book]);
  const filteredChapters = useMemo(() => {
    const needle = catalogFilter.trim();
    return needle ? chapters.filter((c) => c.title.includes(needle)) : chapters;
  }, [chapters, catalogFilter]);

  const paragraphs = useMemo(() => (chapter?.content ? chapter.content.split('\n') : []), [chapter]);
  const showReader = bookId.length > 0 && chapterId.length > 0;

  return (
    <div className="min-h-screen bg-page text-content">
      <Header />
      <main className="max-w-6xl mx-auto px-4 py-5 grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* 左：阅读区 / 搜索结果 */}
        <section className="min-w-0">
          <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2 mb-4">
            <input
              className="input flex-1 min-w-[180px] h-9"
              placeholder={by === 'articlename' ? '搜索书名…' : '搜索作者…'}
              value={input}
              maxLength={50}
              onChange={(e) => setInput(e.target.value)}
              aria-label="搜索小说"
            />
            <select
              className="input h-9"
              value={by}
              onChange={(e) => setBy(e.target.value as 'articlename' | 'author')}
              aria-label="搜索类型"
            >
              <option value="articlename">书名</option>
              <option value="author">作者</option>
            </select>
            <select
              className="input h-9"
              value={src}
              onChange={(e) => {
                setSrc(e.target.value);
                setPinnedSrc('');
              }}
              aria-label="小说源"
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-primary h-9 px-4" disabled={searchQuery.isFetching}>
              {searchQuery.isFetching ? '搜索中…' : '搜索'}
            </button>
            {showReader && (
              <button
                type="button"
                className="btn-ghost h-9"
                onClick={() => router.push(`/novel?id=${encodeURIComponent(bookId)}`, { scroll: false })}
              >
                返回目录
              </button>
            )}
          </form>

          {download && (
            <div className="card p-3 mb-4 flex items-center gap-3 text-sm">
              <Spinner size="sm" />
              <span className="flex-1 min-w-0 truncate">
                正在下载 {download.done} / {download.total} 章
                {download.failed > 0 ? `（失败 ${download.failed}，可稍后重下补齐）` : ''}
                <span className="text-muted"> · 源站限速，长篇需要十几分钟</span>
              </span>
              <button type="button" className="btn-ghost btn-sm shrink-0" onClick={cancelDownload}>
                取消
              </button>
            </div>
          )}

          {showReader ? (
            <article className="card p-5 sm:p-8">
              <header className="mb-4 flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-semibold flex-1 min-w-0 truncate">{chapter?.title ?? '加载中…'}</h1>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    aria-label="下载全本"
                    disabled={!!download}
                    onClick={() => startDownload(book)}
                  >
                    下载TXT
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    aria-label="减小字号"
                    onClick={() => setFontSize((v) => Math.max(14, v - 1))}
                  >
                    A-
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    aria-label="增大字号"
                    onClick={() => setFontSize((v) => Math.min(30, v + 1))}
                  >
                    A+
                  </button>
                </div>
              </header>

              {chapterQuery.isLoading && (
                <div className="flex justify-center py-16">
                  <Spinner size="lg" />
                </div>
              )}
              {chapterQuery.isError && (
                <p className="text-danger text-sm py-8">{(chapterQuery.error as Error).message}</p>
              )}
              {paragraphs.length > 0 && (
                <div className="leading-8" style={{ fontSize: `${fontSize}px` }}>
                  {paragraphs.map((line, i) => (
                    <p key={i} className="mb-3 indent-8">
                      {line}
                    </p>
                  ))}
                </div>
              )}

              <nav className="mt-6 flex items-center justify-between gap-2 border-t border-line pt-4">
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={!chapter?.prevId}
                  onClick={() => chapter?.prevId && openChapter(chapter.bookId, chapter.prevId)}
                >
                  上一章
                </button>
                <span className="text-xs text-muted">
                  {chapter ? `第 ${chapter.index + 1} / ${chapter.total} 章` : ''}
                </span>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={!chapter?.nextId}
                  onClick={() => chapter?.nextId && openChapter(chapter.bookId, chapter.nextId)}
                >
                  下一章
                </button>
              </nav>
            </article>
          ) : bookId ? (
            <BookIntro
              bookQuery={bookQuery}
              onOpenChapter={openChapter}
              onDownload={startDownload}
              downloading={!!download}
            />
          ) : kw ? (
            <SearchResults
              query={searchQuery}
              onOpenBook={openBook}
              keyword={kw}
            />
          ) : (
            <EmptyState recent={recent} onOpenChapter={openChapter} />
          )}
        </section>

        {/* 右：目录 / 最近阅读 */}
        <aside className="lg:sticky lg:top-16 lg:self-start">
          {bookId && book ? (
            <div className="card p-3">
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-sm font-semibold flex-1 min-w-0 truncate">目录 · {book.name}</h2>
                <span className="chip bg-chip text-muted">{chapters.length} 章</span>
              </div>
              <input
                className="input w-full h-8 mb-2"
                placeholder="筛选章节…"
                value={catalogFilter}
                onChange={(e) => {
                  setCatalogFilter(e.target.value);
                  setShown(PAGE_SIZE);
                }}
                aria-label="筛选章节"
              />
              <ol className="max-h-[60vh] overflow-y-auto scrollbar-thin text-sm">
                {filteredChapters.slice(0, shown).map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => openChapter(book.id, c.id)}
                      className={cn(
                        'w-full text-left px-2 py-1.5 rounded-md truncate hover:bg-hover',
                        c.id === chapterId ? 'text-accent bg-hover' : 'text-muted'
                      )}
                      title={c.title}
                    >
                      {c.title}
                    </button>
                  </li>
                ))}
              </ol>
              {filteredChapters.length > shown && (
                <button type="button" className="btn-ghost w-full mt-2 btn-sm" onClick={() => setShown((v) => v + PAGE_SIZE)}>
                  加载更多（剩 {filteredChapters.length - shown} 章）
                </button>
              )}
            </div>
          ) : (
            <div className="card p-3">
              <h2 className="text-sm font-semibold mb-2">最近阅读</h2>
              {recent.length === 0 ? (
                <p className="text-xs text-muted py-2">还没有阅读记录</p>
              ) : (
                <ul className="text-sm space-y-1 max-h-[60vh] overflow-y-auto scrollbar-thin">
                  {recent.map((item) => (
                    <li key={`${item.id}-${item.chapterId}`}>
                      <button
                        type="button"
                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-hover"
                        onClick={() => openChapter(item.id, item.chapterId)}
                      >
                        <span className="block truncate text-content">{item.name}</span>
                        <span className="block truncate text-xs text-muted">{item.chapterTitle}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function BookIntro({
  bookQuery,
  onOpenChapter,
  onDownload,
  downloading,
}: {
  bookQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.novelBook>>>>;
  onOpenChapter: (bookId: string, chapterId: string, src?: string) => void;
  onDownload: (book: NovelBookData | undefined) => void;
  downloading: boolean;
}) {
  if (bookQuery.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  }
  if (bookQuery.isError) {
    return <p className="text-danger text-sm">{(bookQuery.error as Error).message}</p>;
  }
  const book = bookQuery.data;
  if (!book) return null;
  // 目录已按章号升序排好，第一章就是正文章节（广告位在解析时已过滤）
  const startChapter = book.chapters[0];
  return (
    <div className="card p-5 flex gap-4">
      {book.cover ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={coverSrc(book.cover)} alt={book.name} className="w-24 h-32 object-cover rounded-md bg-chip shrink-0" loading="lazy" />
      ) : null}
      <div className="min-w-0">
        <h1 className="text-lg font-semibold truncate">{book.name}</h1>
        <p className="text-xs text-muted mt-1">
          {book.author}
          {book.category ? ` · ${book.category}` : ''}
          {book.status ? ` · ${book.status}` : ''}
          {` · ${book.chapters.length} 章`}
        </p>
        {book.intro && <p className="text-sm text-muted mt-3 line-clamp-6 whitespace-pre-line">{book.intro}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-primary btn-sm" disabled={!startChapter}
            onClick={() => startChapter && onOpenChapter(book.id, startChapter.id)}>
            从头开始阅读
          </button>
          <button type="button" className="btn-ghost btn-sm" disabled={downloading || !book.chapters.length}
            onClick={() => onDownload(book)}>
            {downloading ? '下载中…' : '下载全本 TXT'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SearchResults({
  query,
  onOpenBook,
  keyword,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.novelSearch>>>>;
  onOpenBook: (id: string, src?: string) => void;
  keyword: string;
}) {
  if (query.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  }
  if (query.isError) {
    return <p className="text-danger text-sm">{(query.error as Error).message}</p>;
  }
  const items = query.data?.items ?? [];
  if (items.length === 0) {
    return <p className="text-sm text-muted py-8">没有找到与「{keyword}」相关的书，换个关键词试试。</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => onOpenBook(item.id, item.source)}
            className="card w-full text-left p-3 hover:border-accent transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{item.name}</span>
              {item.category && <span className="chip bg-chip text-muted shrink-0">{item.category}</span>}
              {item.source && (
                <span className="chip bg-chip text-muted shrink-0">{sourceLabel(item.source)}</span>
              )}
            </div>
            <p className="text-xs text-muted mt-1 truncate">
              {item.author}
              {item.latestChapter ? ` · 最新：${item.latestChapter}` : ''}
              {item.updatedAt ? ` · ${item.updatedAt}` : ''}
            </p>
          </button>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  recent,
  onOpenChapter,
}: {
  recent: RecentItem[];
  onOpenChapter: (bookId: string, chapterId: string, src?: string) => void;
}) {
  return (
    <div className="card p-6">
      <h1 className="text-lg font-semibold">小说阅读</h1>
      <p className="text-sm text-muted mt-2">
        输入书名或作者搜索，点进去即可在线阅读，支持目录跳转、上下章、字号调节（键盘 ← → 也能翻章）与整本下载成 TXT。
      </p>
      {recent.length > 0 && (
        <div className="mt-4">
          <h2 className="text-sm font-semibold mb-2">继续阅读</h2>
          <ul className="space-y-1 text-sm">
            {recent.slice(0, 5).map((item) => (
              <li key={`${item.id}-${item.chapterId}`}>
                <button type="button" className="text-accent hover:underline" onClick={() => onOpenChapter(item.id, item.chapterId, item.src)}>
                  {item.name} · {item.chapterTitle}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
