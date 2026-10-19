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
/** 源选项：与 src/lib/novel-sources.ts 的注册表保持一致（不 import 服务端模块，避免把抓取代码打进前端包） */
const SOURCE_OPTIONS = [
  { id: 'auto', label: '自动选源', short: '自动' },
  { id: 'shuhaige', label: '书海阁(干净)', short: '书海阁' },
  { id: 'sto66', label: '思兔阅读', short: '思兔' },
  { id: 'biquge365', label: '笔趣阁(境内)', short: '笔趣阁' },
  { id: 'czbooks', label: '小說狂人(境外)', short: '狂人' },
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

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

function BookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5z" strokeLinejoin="round" />
      <path d="M8 3v18" />
    </svg>
  );
}

/**
 * 小说页：搜索 → 详情目录 → 阅读，状态由 URL 驱动（?id=<书籍>&c=<章节>&src=<源>）。
 * 手机端优先：搜索区吸顶、结果卡片大点击区、阅读页底部固定翻章条 + 目录抽屉。
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
  // 源里的选择：auto 表示让服务端按顺序试；不因命中某个源而改写，避免下次失去回退能力
  const [src, setSrc] = useState<string>('auto');
  // 本次搜索实际命中的源：目录/正文沿用同一个源，避免跨源 ID 混用
  const [pinnedSrc, setPinnedSrc] = useState<string>('');
  const effSrc = pinnedSrc || src;
  const [kw, setKw] = useState('');
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [fontSize, setFontSize] = useState(18);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [tocOpen, setTocOpen] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);

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
      setIntroOpen(false);
      if (src) setPinnedSrc(src);
      const suffix = src ? `&src=${encodeURIComponent(src)}` : '';
      router.push(`/novel?id=${encodeURIComponent(id)}${suffix}`, { scroll: false });
    },
    [router]
  );

  const openChapter = useCallback(
    (id: string, cid: string, src?: string) => {
      if (src) setPinnedSrc(src);
      setTocOpen(false);
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

  useEffect(() => {
    srcRef.current = effSrc;
  }, [effSrc]);

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

  const tocList = (
    <ol className="text-sm sm:grid sm:grid-cols-2 sm:gap-0.5">
      {filteredChapters.slice(0, shown).map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => openChapter(bookId, c.id)}
            className={cn(
              'w-full truncate rounded-md px-2 py-2 text-left text-[13px] transition-colors hover:bg-hover sm:text-sm',
              c.id === chapterId ? 'font-medium text-accent bg-accent/10' : 'text-muted'
            )}
            title={c.title}
          >
            {c.title}
          </button>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="min-h-screen bg-page text-content">
      <Header />

      {/* 吸顶搜索区：手机上滚动阅读时也能随时换书 */}
      <div className="sticky top-0 z-30 border-b border-line bg-page/90 backdrop-blur-md">
        <div className="mx-auto w-full max-w-5xl px-3 pb-2 pt-2.5 sm:px-5">
          <form onSubmit={submitSearch} className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
              <input
                className="input h-10 w-full pl-9 pr-3 text-sm"
                placeholder={by === 'articlename' ? '搜索书名…' : '搜索作者…'}
                value={input}
                maxLength={50}
                onChange={(e) => setInput(e.target.value)}
                aria-label="搜索小说"
              />
            </div>
            <button type="submit" className="btn-primary h-10 shrink-0 px-4" disabled={searchQuery.isFetching}>
              {searchQuery.isFetching ? '搜索中…' : '搜索'}
            </button>
            {showReader && (
              <button
                type="button"
                className="btn-ghost h-10 shrink-0 px-3"
                onClick={() => router.push(`/novel?id=${encodeURIComponent(bookId)}`, { scroll: false })}
              >
                目录
              </button>
            )}
          </form>

          <div className="scrollbar-thin mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5">
            <div className="flex shrink-0 rounded-full bg-chip p-0.5">
              {(['articlename', 'author'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setBy(k)}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] transition-colors',
                    by === k ? 'bg-accent text-on-accent' : 'text-muted hover:text-content'
                  )}
                >
                  {k === 'articlename' ? '书名' : '作者'}
                </button>
              ))}
            </div>
            <span className="h-4 w-px shrink-0 bg-line" />
            {SOURCE_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                title={o.label}
                onClick={() => {
                  setSrc(o.id);
                  setPinnedSrc('');
                }}
                className={cn(
                  'chip shrink-0 border px-2 py-0.5 text-[11px]',
                  src === o.id ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-chip text-muted hover:bg-hover'
                )}
              >
                {o.short}
              </button>
            ))}
          </div>
        </div>
      </div>

      {download && (
        <div className="border-b border-line bg-accent/10">
          <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-3 py-2 text-xs sm:px-5">
            <Spinner size="sm" />
            <span className="min-w-0 flex-1 truncate">
              正在下载 {download.done} / {download.total} 章
              {download.failed > 0 ? `（失败 ${download.failed}）` : ''}
              <span className="hidden text-muted sm:inline"> · 源站限速，长篇十几分钟</span>
            </span>
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={cancelDownload}>
              取消
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-5xl px-3 pb-24 pt-3 sm:px-5 sm:pb-10 sm:pt-5">
        {showReader ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <article className="card px-4 py-4 sm:px-8 sm:py-7">
              <header className="mb-4 border-b border-line pb-3">
                <button
                  type="button"
                  className="mb-1 inline-flex items-center gap-1 text-[11px] text-muted hover:text-content lg:hidden"
                  onClick={() => router.push(`/novel?id=${encodeURIComponent(bookId)}`, { scroll: false })}
                >
                  ← {book?.name ?? '返回目录'}
                </button>
                <div className="flex items-start gap-2">
                  <h1 className="min-w-0 flex-1 text-base font-semibold leading-snug sm:text-lg">
                    {chapter?.title ?? '加载中…'}
                  </h1>
                  <div className="flex shrink-0 items-center gap-1">
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
                </div>
              </header>

              {chapterQuery.isLoading && (
                <div className="flex justify-center py-16">
                  <Spinner size="lg" />
                </div>
              )}
              {chapterQuery.isError && <p className="py-8 text-sm text-danger">{(chapterQuery.error as Error).message}</p>}
              {paragraphs.length > 0 && (
                <div className="space-y-4" style={{ fontSize: `${fontSize}px` }}>
                  {paragraphs.map((line, i) => (
                    <p key={i} className="indent-[2em] leading-[1.95]">
                      {line}
                    </p>
                  ))}
                </div>
              )}

              <nav className="mt-8 flex items-center gap-2 border-t border-line pt-4">
                <button
                  type="button"
                  className="btn-ghost h-10 flex-1 sm:flex-none"
                  disabled={!chapter?.prevId}
                  onClick={() => chapter?.prevId && openChapter(chapter.bookId, chapter.prevId)}
                >
                  上一章
                </button>
                <span className="hidden flex-1 text-center text-xs text-muted sm:block">
                  {chapter ? `第 ${chapter.index + 1} / ${chapter.total} 章` : ''}
                </span>
                <button
                  type="button"
                  className="btn-primary h-10 flex-1 sm:flex-none"
                  disabled={!chapter?.nextId}
                  onClick={() => chapter?.nextId && openChapter(chapter.bookId, chapter.nextId)}
                >
                  下一章
                </button>
              </nav>
            </article>

            <aside className="hidden lg:block">
              <div className="card p-3 lg:sticky lg:top-32">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{book?.name ?? '目录'}</h2>
                  <span className="chip shrink-0 bg-chip text-muted">{chapters.length} 章</span>
                </div>
                <input
                  className="input mb-2 h-8 w-full text-xs"
                  placeholder="筛选章节…"
                  value={catalogFilter}
                  onChange={(e) => {
                    setCatalogFilter(e.target.value);
                    setShown(PAGE_SIZE);
                  }}
                  aria-label="筛选章节"
                />
                <div className="scrollbar-thin max-h-[62vh] overflow-y-auto">{tocList}</div>
                {filteredChapters.length > shown && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm mt-2 w-full"
                    onClick={() => setShown((v) => v + PAGE_SIZE)}
                  >
                    加载更多（剩 {filteredChapters.length - shown} 章）
                  </button>
                )}
              </div>
            </aside>
          </div>
        ) : bookId ? (
          <BookDetail
            bookQuery={bookQuery}
            chapters={chapters}
            introOpen={introOpen}
            onToggleIntro={() => setIntroOpen((v) => !v)}
            catalogFilter={catalogFilter}
            onFilter={(value) => {
              setCatalogFilter(value);
              setShown(PAGE_SIZE);
            }}
            shown={shown}
            onMore={() => setShown((v) => v + PAGE_SIZE)}
            filteredCount={filteredChapters.length}
            tocList={tocList}
            onOpenChapter={(cid) => openChapter(bookId, cid)}
            onDownload={startDownload}
            downloading={!!download}
          />
        ) : kw ? (
          <SearchResults query={searchQuery} onOpenBook={openBook} keyword={kw} />
        ) : (
          <EmptyState
            recent={recent}
            onOpenChapter={openChapter}
            onPickSource={(id) => {
              setSrc(id);
              setPinnedSrc('');
            }}
          />
        )}
      </main>

      {/* 手机：阅读页底部固定翻章条（含目录抽屉入口） */}
      {showReader && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur-md lg:hidden"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="mx-auto flex max-w-5xl items-center gap-2 px-3 py-2">
            <button
              type="button"
              className="btn-ghost h-10 px-3 text-xs"
              aria-label="上一章"
              disabled={!chapter?.prevId}
              onClick={() => chapter?.prevId && openChapter(chapter.bookId, chapter.prevId)}
            >
              上一章
            </button>
            <button
              type="button"
              className="btn-primary h-10 flex-1 text-xs"
              aria-label="打开章节目录"
              onClick={() => setTocOpen(true)}
            >
              目录 · {chapter ? `${chapter.index + 1}/${chapter.total}` : '…'}
            </button>
            <button
              type="button"
              className="btn-ghost h-10 px-3 text-xs"
              aria-label="下一章"
              disabled={!chapter?.nextId}
              onClick={() => chapter?.nextId && openChapter(chapter.bookId, chapter.nextId)}
            >
              下一章
            </button>
          </div>
        </div>
      )}

      {/* 手机：目录抽屉 */}
      {tocOpen && showReader && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="关闭目录"
            className="absolute inset-0 bg-black/50"
            onClick={() => setTocOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 flex max-h-[82vh] flex-col rounded-t-2xl border-t border-line bg-surface shadow-2xl">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{book?.name ?? '目录'}</h2>
              <span className="chip shrink-0 bg-chip text-muted">{chapters.length} 章</span>
              <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setTocOpen(false)}>
                关闭
              </button>
            </div>
            <div className="px-3 py-2">
              <input
                className="input h-9 w-full text-sm"
                placeholder="筛选章节…"
                value={catalogFilter}
                onChange={(e) => {
                  setCatalogFilter(e.target.value);
                  setShown(PAGE_SIZE);
                }}
                aria-label="筛选章节"
              />
            </div>
            <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-6">
              {tocList}
              {filteredChapters.length > shown && (
                <button
                  type="button"
                  className="btn-ghost btn-sm mt-2 w-full"
                  onClick={() => setShown((v) => v + PAGE_SIZE)}
                >
                  加载更多（剩 {filteredChapters.length - shown} 章）
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BookDetail({
  bookQuery,
  chapters,
  introOpen,
  onToggleIntro,
  catalogFilter,
  onFilter,
  shown,
  onMore,
  filteredCount,
  tocList,
  onOpenChapter,
  onDownload,
  downloading,
}: {
  bookQuery: ReturnType<typeof useQuery<NovelBookData>>;
  chapters: { id: string; title: string }[];
  introOpen: boolean;
  onToggleIntro: () => void;
  catalogFilter: string;
  onFilter: (value: string) => void;
  shown: number;
  onMore: () => void;
  filteredCount: number;
  tocList: React.ReactNode;
  onOpenChapter: (chapterId: string) => void;
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
    return <p className="text-sm text-danger">{(bookQuery.error as Error).message}</p>;
  }
  const book = bookQuery.data;
  if (!book) return null;
  // 目录已按章号升序排好，第一章就是正文章节（广告位在解析时已过滤）
  const startChapter = book.chapters[0];
  return (
    <>
      <section className="card overflow-hidden">
        <div className="relative">
          {book.cover ? (
            <div
              aria-hidden
              className="absolute inset-0 scale-110 bg-cover bg-center opacity-20 blur-2xl"
              style={{ backgroundImage: `url(${coverSrc(book.cover)})` }}
            />
          ) : null}
          <div className="relative flex gap-3 p-4 sm:gap-5 sm:p-6">
            {book.cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={coverSrc(book.cover)}
                alt={book.name}
                className="h-[7.5rem] w-20 shrink-0 rounded-lg bg-chip object-cover shadow-lg sm:h-36 sm:w-24"
                loading="lazy"
              />
            ) : (
              <div className="flex h-[7.5rem] w-20 shrink-0 items-center justify-center rounded-lg bg-chip text-faint sm:h-36 sm:w-24">
                <BookIcon className="h-7 w-7" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="line-clamp-2 text-base font-semibold leading-snug sm:text-xl">{book.name}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted sm:text-xs">
                <span>{book.author}</span>
                {book.category && <span className="chip bg-chip">{book.category}</span>}
                {book.status && <span className="chip bg-chip">{book.status}</span>}
                <span>{book.chapters.length} 章</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary h-9 px-4 text-sm"
                  disabled={!startChapter}
                  onClick={() => startChapter && onOpenChapter(startChapter.id)}
                >
                  开始阅读
                </button>
                <button
                  type="button"
                  className="btn-ghost h-9 px-3 text-sm"
                  disabled={downloading || !book.chapters.length}
                  onClick={() => onDownload(book)}
                >
                  {downloading ? '下载中…' : '下载 TXT'}
                </button>
              </div>
            </div>
          </div>
        </div>
        {book.intro ? (
          <div className="border-t border-line px-4 py-3 sm:px-6">
            <p className={cn('whitespace-pre-line text-xs leading-6 text-muted', !introOpen && 'line-clamp-3')}>
              {book.intro}
            </p>
            <button type="button" className="mt-1 text-[11px] text-accent" onClick={onToggleIntro}>
              {introOpen ? '收起简介' : '展开简介'}
            </button>
          </div>
        ) : null}
      </section>

      <section className="card mt-4">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
          <h2 className="text-sm font-semibold">目录</h2>
          <span className="chip bg-chip text-muted">{chapters.length} 章</span>
          <div className="relative ml-auto w-32 shrink-0 sm:w-56">
            <input
              className="input h-8 w-full text-xs"
              placeholder="筛选章节…"
              value={catalogFilter}
              onChange={(e) => onFilter(e.target.value)}
              aria-label="筛选章节"
            />
          </div>
        </div>
        <div className="scrollbar-thin max-h-[62vh] overflow-y-auto px-2 py-1">
          <div className="hidden sm:block">{tocList}</div>
          <div className="sm:hidden">{tocList}</div>
        </div>
        {filteredCount > shown && (
          <button type="button" className="w-full border-t border-line py-2.5 text-xs text-accent" onClick={onMore}>
            加载更多（剩 {filteredCount - shown} 章）
          </button>
        )}
      </section>
    </>
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
    return <p className="text-sm text-danger">{(query.error as Error).message}</p>;
  }
  const items = query.data?.items ?? [];
  const errors = query.data?.errors ?? [];
  if (items.length === 0) {
    return <p className="py-8 text-sm text-muted">没有找到与「{keyword}」相关的书，换个关键词或换源试试。</p>;
  }
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 px-1">
        <p className="min-w-0 flex-1 truncate text-xs text-muted">
          「{keyword}」找到 <span className="font-medium text-content">{items.length}</span> 本
        </p>
        {errors.length > 0 && <span className="chip bg-chip text-muted">{errors.length} 个源失败</span>}
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={`${item.source ?? 'x'}-${item.id}`}>
            <button
              type="button"
              onClick={() => onOpenBook(item.id, item.source)}
              className="card w-full px-3 py-2.5 text-left transition-colors hover:border-accent active:bg-hover"
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
                {item.category && <span className="chip shrink-0 bg-chip text-muted">{item.category}</span>}
                {item.source && (
                  <span
                    className={cn(
                      'chip shrink-0 border',
                      item.source === 'shuhaige' || item.source === 'sto66'
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-line bg-chip text-muted'
                    )}
                  >
                    {sourceLabel(item.source)}
                  </span>
                )}
              </div>
              <p className="mt-1 truncate text-[11px] text-muted">
                {item.author}
                {item.latestChapter ? ` · 最新：${item.latestChapter}` : ''}
                {item.updatedAt ? ` · ${item.updatedAt}` : ''}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmptyState({
  recent,
  onOpenChapter,
  onPickSource,
}: {
  recent: RecentItem[];
  onOpenChapter: (bookId: string, chapterId: string, src?: string) => void;
  onPickSource: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <section className="card px-4 py-8 text-center sm:px-8 sm:py-12">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
          <BookIcon className="h-6 w-6" />
        </div>
        <h1 className="mt-3 text-lg font-semibold">小说阅读</h1>
        <p className="mx-auto mt-1.5 max-w-sm text-xs leading-6 text-muted">
          搜索书名或作者即可在线读：目录跳转、←/→ 翻章、字号调节、整本下载 TXT。
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-1.5">
          {SOURCE_OPTIONS.filter((o) => o.id !== 'auto').map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => onPickSource(o.id)}
              className="chip border border-line bg-chip px-2.5 py-1 text-muted hover:bg-hover hover:text-content"
              title={o.label}
            >
              {o.short}
            </button>
          ))}
        </div>
      </section>

      {recent.length > 0 && (
        <section className="card p-3 sm:p-4">
          <h2 className="mb-2 text-sm font-semibold">最近阅读</h2>
          <ul className="space-y-1">
            {recent.slice(0, 8).map((item) => (
              <li key={`${item.id}-${item.chapterId}`}>
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-hover"
                  onClick={() => onOpenChapter(item.id, item.chapterId, item.src)}
                >
                  <span className="block truncate text-sm">{item.name}</span>
                  <span className="block truncate text-[11px] text-muted">{item.chapterTitle}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
