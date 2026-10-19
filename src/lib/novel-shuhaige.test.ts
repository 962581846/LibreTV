import { describe, expect, it } from 'vitest';
import {
  shChapterNumber,
  shClearNovelCache,
  shDecodeEntities,
  shParseBookMetaHtml,
  shParseChapterHtml,
  shParseSearchHtml,
  shParseTocHtml,
  shParseTocPageCount,
  shStripTags,
} from './novel-shuhaige';

describe('shDecodeEntities / shStripTags', () => {
  it('解码命名实体与数字实体', () => {
    expect(shDecodeEntities('a&nbsp;b&amp;c&#20013;&#x6587;')).toBe('a b&c中文');
  });

  it('未知实体保持原样', () => {
    expect(shDecodeEntities('&unknown;')).toBe('&unknown;');
  });

  it('去标签并压缩空白', () => {
    expect(shStripTags('  <span>白衣</span>\n 卿相&nbsp; ')).toBe('白衣 卿相');
  });

  it('clearNovelCache 可重复调用', () => {
    expect(() => shClearNovelCache()).not.toThrow();
  });
});

describe('shParseSearchHtml', () => {
  const html = `<div class="bookClassCardGrid" id="bookList">
    <article class="classBookCard"><span class="classBookCover"><a class="classBookCoverLink" href="/book/1262260513468565162.html" title="白衣卿相"><img src="https://bookcover.yuewen.com/qdbimg/349573/1047634306/300" alt="封面"/></a><a class="book-cover-badge classCoverCat" href="/book/bookclass.html?c=4" title="历史军事">历史军事</a></span><div class="classBookBody"><h3 class="classBookTitle"><a href="/book/1262260513468565162.html">白衣卿相</a></h3><p class="classBookAuthor">作者：<a href="/book/bookclass.html?k=%E7%8E%8B">王梓钧</a></p><p class="classBookMeta">连载中 · 133.07万字</p><p class="classBookChapter"><a href="/book/1262260513468565162/2039351400479759143.html">0352【缩减待遇】</a></p><p class="classBookDesc">一袭白衣入汴梁。</p><p class="classBookTime is-today">2026-10-19 11:02:52</p></div></article>
    <article class="classBookCard"><span class="classBookCover"><a class="classBookCoverLink" href="/book/1262260513468559488.html" title="诡秘之主"><img src="x"/></a></span><div class="classBookBody"><h3 class="classBookTitle"><a href="/book/1262260513468559488.html">诡秘之主</a></h3><p class="classBookAuthor">作者：<a href="#">爱潜水的乌贼</a></p><p class="classBookMeta">完结 · 400万字</p><p class="classBookChapter"><a href="/book/1262260513468559488/1.html">1418【大结局】<i class="red"> [免费]</i></a></p></div></article>
    <article class="classBookCard"><span class="classBookCover"><a class="classBookCoverLink" href="/book/1262260513468565162.html" title="重复"><img src="x"/></a></span><div class="classBookBody"><h3 class="classBookTitle"><a href="/book/1262260513468565162.html">重复条目</a></h3><p class="classBookAuthor">作者：<a href="#">某人</a></p></div></article>
  </div>`;

  it('抽 ID、书名、作者、分类、最新章节与时间，并按 ID 去重', () => {
    const items = shParseSearchHtml(html);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: '1262260513468565162',
      name: '白衣卿相',
      author: '王梓钧',
      category: '历史军事',
      latestChapter: '0352【缩减待遇】',
      updatedAt: '2026-10-19 11:02:52',
    });
  });

  it('最新章节里的 [免费] 标记被清掉', () => {
    expect(shParseSearchHtml(html)[1].latestChapter).toBe('1418【大结局】');
  });

  it('没有结果时返回空数组', () => {
    expect(shParseSearchHtml('<div></div>')).toEqual([]);
  });
});

describe('shParseBookMetaHtml', () => {
  const html = `<img class="cover" id="bookCoverImg" src="https://bookcover.yuewen.com/qdbimg/349573/1047634306/300" width="200"/>
    <h1 id="bookName">白衣卿相</h1>
    <a href="/book/bookclass.html" id="bookAuthor" title="按作者查看作品">王梓钧</a>
    <em id="bookStatus">连载中</em>
    <a class="book-cat-badge" id="bookCatBadge" href="/book/bookclass.html?c=4" title="历史军事">历史军事</a>
    <p id="bookDesc">《白衣卿相》是王梓钧创作的小说。</p>`;

  it('取书名/作者/状态/封面/分类/简介', () => {
    expect(shParseBookMetaHtml(html, '1262260513468565162')).toEqual({
      id: '1262260513468565162',
      name: '白衣卿相',
      author: '王梓钧',
      cover: 'https://bookcover.yuewen.com/qdbimg/349573/1047634306/300',
      intro: '《白衣卿相》是王梓钧创作的小说。',
      category: '历史军事',
      status: '连载中',
    });
  });

  it('缺字段时给兜底值', () => {
    const meta = shParseBookMetaHtml('<h1>无题</h1>', '1262260513468565162');
    expect(meta.name).toBe('无题');
    expect(meta.author).toBe('佚名');
  });
});

describe('shParseTocPageCount', () => {
  it('按 data-total / data-page-size 算页数', () => {
    const html =
      '<div class="indexPager" id="indexPager" data-book-id="1" data-page="1" data-page-size="100" data-total="354" data-ssr-complete="1"></div>';
    expect(shParseTocPageCount(html)).toBe(4);
  });

  it('没有分页器时算 1 页', () => {
    expect(shParseTocPageCount('<ul id="bookIndexList"></ul>')).toBe(1);
  });
});

describe('shParseTocHtml', () => {
  const html = `<ul id="bookIndexList">
    <li class="catalogVolumeHeading"><h4>正文卷</h4></li>
    <li data-index-id="2039351400476934501"><a href="/book/1262260513468565162/2039351400476934501.html">0000【开往北宋的高铁】<i class="red"> [免费]</i></a></li>
    <li data-index-id="2039351400476934502"><a href="/book/1262260513468565162/2039351400476934502.html">0001【嘉祐七年深秋】<i class="red"> [免费]</i></a></li>
    <li data-index-id="9999999999999999999"><a href="/book/9999999999999999999/8888888888888888888.html">别书的章节</a></li>
    <li data-index-id="2039351400476934501"><a href="/book/1262260513468565162/2039351400476934501.html">0000【重复】</a></li>
  </ul>`;

  it('按 data-index-id 抽章节，跳过卷标题、别的书与重复项', () => {
    const chapters = shParseTocHtml(html, '1262260513468565162');
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toEqual({ id: '2039351400476934501', title: '0000【开往北宋的高铁】' });
  });

  it('不传 bookId 时不过滤来源书', () => {
    expect(shParseTocHtml(html)).toHaveLength(3);
  });
});

describe('shParseChapterHtml', () => {
  const html = `<section class="readChapterAppendBlock"><div class="readChapterAppendHeader"><span class="readChapterAppendText">0000【开往北宋的高铁】</span></div>
    <div class="readChapterAppendBody"><p>“女士们，先生们，欢迎您乘坐……”</p><p>徐来靠在座位上，一脸疲惫。</p><p>0000【开往北宋的高铁】</p><p>书海阁 www.washai.net 最快更新</p><p>  </p></div></section>`;

  it('抽标题与段落，去掉重复标题、广告与空段', () => {
    const { title, paragraphs } = shParseChapterHtml(html);
    expect(title).toBe('0000【开往北宋的高铁】');
    expect(paragraphs).toEqual(['“女士们，先生们，欢迎您乘坐……”', '徐来靠在座位上，一脸疲惫。']);
  });
});

describe('shChapterNumber', () => {
  it('解析四位补零前缀', () => {
    expect(shChapterNumber('0352【缩减待遇】')).toBe(352);
  });

  it('也认「第N章」写法', () => {
    expect(shChapterNumber('第12章 试探')).toBe(12);
  });

  it('番外等没有章号返回 null', () => {
    expect(shChapterNumber('番外·一')).toBeNull();
  });
});
