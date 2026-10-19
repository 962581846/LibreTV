import { describe, expect, it } from 'vitest';
import {
  chapterNumber,
  clearNovelCache,
  decodeEntities,
  parseBookMetaHtml,
  parseChapterHtml,
  parseSearchHtml,
  parseTocHtml,
  stripTags,
} from './novel-source';
import { toSimplified } from './novel-t2s';

describe('decodeEntities', () => {
  it('解码命名实体、数字实体与十六进制实体', () => {
    expect(decodeEntities('a&nbsp;b&amp;c&#20013;&#x6587;')).toBe('a b&c中文');
  });

  it('未知实体保持原样，避免误吞正文', () => {
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
  });
});

describe('stripTags', () => {
  it('去标签、压空白', () => {
    expect(stripTags('<span>a</span>\n\n  b ')).toBe('a b');
  });
});

describe('toSimplified', () => {
  it('常用繁体字转简体，简体原样返回', () => {
    expect(toSimplified('神秘複蘇，楊間厲鬼')).toBe('神秘复苏，杨间厉鬼');
    expect(toSimplified('已经就是简体')).toBe('已经就是简体');
  });

  it('「著」按词区分：进行体转「着」，著名/著作仍是「著」', () => {
    expect(toSimplified('他侧身躺著看手機，翻看著帖子')).toBe('他侧身躺着看手机，翻看着帖子');
    expect(toSimplified('著名作家的著作')).toBe('著名作家的著作');
  });
});

describe('chapterNumber', () => {
  it('识别阿拉伯与中文章号', () => {
    expect(chapterNumber('第12章 试探')).toBe(12);
    expect(chapterNumber('第1099章願望和交易')).toBe(1099);
    expect(chapterNumber('第一百六十八章 赵磊')).toBe(168);
    expect(chapterNumber('第十章 起步')).toBe(10);
  });

  it('番外、感言等取不到章号', () => {
    expect(chapterNumber('番外：第4章招魂（三）')).toBeNull();
    expect(chapterNumber('完本感言')).toBeNull();
  });
});

const SEARCH_HTML = `
<ul class = "nav novel-list style-default">
  <li class = "novel-item-wrapper">
    <div class = "novel-item">
      <div class = "novel-item-cover-wrapper">
        <a href = "//czbooks.net/n/uj4ib">
          <div class = "novel-item-title">神秘複蘇</div>
        </a>
      </div>
      <div class = "novel-item-author">作者: <a href="//czbooks.net/a/佛前獻花">佛前獻花</a></div>
      <div class = "novel-item-newest-chapter">最新: <a href="//czbooks.net/n/uj4ib/u3dph">番外：第4章招魂（三）</a></div>
      <div class = "novel-item-date">2023-08-25</div>
    </div>
  </li>
  <li class = "novel-item-wrapper">
    <div class = "novel-item">
      <div class = "novel-item-cover-wrapper">
        <a href = "//czbooks.net/n/uj4ib"><div class = "novel-item-title">重複項</div></a>
      </div>
    </div>
  </li>
  <li class = "novel-item-wrapper">
    <div class = "novel-item">
      <div class = "novel-item-cover-wrapper">
        <a href = "//czbooks.net/n/c8idd3"><div class = "novel-item-title">斗破蒼穹之虛空破</div></a>
      </div>
    </div>
  </li>
</ul>`;

describe('parseSearchHtml', () => {
  it('解析书名/作者/最新章/日期，并按 bookId 去重', () => {
    const items = parseSearchHtml(SEARCH_HTML);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'uj4ib',
      name: '神秘复苏',
      author: '佛前献花',
      latestChapter: '番外：第4章招魂（三）',
      updatedAt: '2023-08-25',
    });
    expect(items[1].name).toBe('斗破苍穹之虚空破');
  });
});

const BOOK_HTML = `
<div class = "novel-detail">
  <div class = "thumbnail"><img src="https://img.czbooks.net/thumbnail/a.jpg" /></div>
  <div class = "state">
    <table>
      <tr><td>連載狀態</td><td>連載中</td></tr>
      <tr><td> 分  類 </td><td><a id="novel-category" href="//czbooks.net/c/xianxia">武俠仙俠</a></td></tr>
    </table>
  </div>
  <div class="info-wrap">
    <div class = "info">
      <span class = "title">《神秘複蘇》</span>
      <span class = "author">作者: <a href="//czbooks.net/a/佛前獻花">佛前獻花</a></span>
    </div>
    <div class = "description">靈異復甦的故事。<br />楊間開始了他的旅程。</div>
  </div>
</div>
<ul class = "nav chapter-list" id = "chapter-list">
  <li class = "volume">正文卷</li>
  <li><a href="//czbooks.net/n/uj4ib/ui3p1">第2章臨時講課</a></li>
  <li><a href="//czbooks.net/n/uj4ib/ui3pg">第1章論壇裡的鬼故事。</a></li>
  <li><a href="//czbooks.net/n/uj4ib/u3cdl">番外 招魂（一）</a></li>
  <li><a href="https://czbooks.net/n/other/u3cdl">第3章 別的書</a></li>
  <li><a href="//czbooks.net/n/uj4ib/ujunk">今天無更</a></li>
  <li><a href="//czbooks.net/n/uj4ib/ujunk2">求月票</a></li>
</ul>`;

describe('parseBookMetaHtml', () => {
  it('取书名、作者、封面、状态、分类与简介', () => {
    expect(parseBookMetaHtml(BOOK_HTML, 'uj4ib')).toMatchObject({
      id: 'uj4ib',
      name: '神秘复苏',
      author: '佛前献花',
      cover: 'https://img.czbooks.net/thumbnail/a.jpg',
      status: '连载中',
      category: '武侠仙侠',
      intro: '灵异复苏的故事。 杨间开始了他的旅程。',
    });
  });

  it('默认占位封面视为没有封面', () => {
    const html = '<div class = "thumbnail"><img src="https://czbooks.net/images/default_no_thumbnail.jpg"></div>';
    expect(parseBookMetaHtml(html, 'x1').cover).toBeUndefined();
  });
});

describe('parseTocHtml', () => {
  it('跳过卷标题与其他书的链接，并按章号升序（番外排最后）', () => {
    const chapters = parseTocHtml(BOOK_HTML, 'uj4ib');
    expect(chapters.map((c) => c.title)).toEqual(['第1章论坛里的鬼故事。', '第2章临时讲课', '番外 招魂（一）']);
    expect(chapters.map((c) => c.id)).toEqual(['ui3pg', 'ui3p1', 'u3cdl']);
  });
});

const CHAPTER_HTML = `
<html><head><title>【神秘複蘇】第1章 | 小說狂人</title></head><body>
<div class = "name">《神秘複蘇》第1章論壇裡的鬼故事。</div>
<div class = "content">第1章論壇裡的鬼故事。<br /><br />　　老頭掐指一算。<br /><br />　　「臥槽，樓主真乃神人也。」<br /><br />　　請記住本站小說狂人。<br /></div>
</body></html>`;

describe('parseChapterHtml', () => {
  it('标题去掉书名，正文按 <br /> 拆段并转简体，剔除广告与重复标题', () => {
    const { title, paragraphs } = parseChapterHtml(CHAPTER_HTML);
    expect(title).toBe('第1章论坛里的鬼故事。');
    expect(paragraphs).toEqual(['老头掐指一算。', '「卧槽，楼主真乃神人也。」']);
  });

  it('正文容器缺失时返回空段落', () => {
    expect(parseChapterHtml('<html><body>无</body></html>').paragraphs).toEqual([]);
  });
});

describe('clearNovelCache', () => {
  it('可重复调用（缓存模块无副作用）', () => {
    clearNovelCache();
    clearNovelCache();
    expect(true).toBe(true);
  });
});
