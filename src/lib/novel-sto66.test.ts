import { describe, expect, it } from 'vitest';
import {
  stChapterNumber,
  stDecodeEntities,
  stParseBookMetaHtml,
  stParseChapterHtml,
  stParseSearchHtml,
  stParseTocHtml,
  stStripTags,
} from './novel-sto66';

describe('stDecodeEntities', () => {
  it('解命名实体与数字实体', () => {
    expect(stDecodeEntities('a&nbsp;b&amp;c&#39;&#x4e2d;')).toBe('a b&c\'中');
  });
  it('保留未知实体', () => {
    expect(stDecodeEntities('&unknown;')).toBe('&unknown;');
  });
});

describe('stStripTags', () => {
  it('剥标签压缩空白', () => {
    expect(stStripTags('<p> hello   <b>world</b> </p>')).toBe('hello world');
  });
});

describe('stChapterNumber', () => {
  it('识别补零四位章号', () => {
    expect(stChapterNumber('0356【夜空前所未有的绚烂】')).toBe(356);
  });
  it('识别中文第N章', () => {
    expect(stChapterNumber('第12章 初入京城')).toBe(12);
  });
  it('无章号返回 null', () => {
    expect(stChapterNumber('上架感言')).toBeNull();
  });
});

const SEARCH_HTML = `
<div class="bookbox">
  <div class="p10">
    <h2 class="bookname"><a href="/book/4Fh5LASjcQ3jIPBmsJXcxT.html">白衣卿相</a></h2>
    <div class="author">作者：王梓钧&nbsp;&nbsp;字数：119万</div>
    <div class="cat">最新：<a href="/chapter/4Fh5LASjcQ3jIPBmsJXcxT/9kR2aB3cD4eF5gH6iJ7k.html">0356【夜空前所未有的绚烂】</a></div>
    <div class="update"><span>简介：</span>穿越北宋，做个白衣卿相。</div>
  </div>
</div>
<div class="bookbox">
  <div class="p10">
    <h2 class="bookname"><a href="/book/4Fh5LASjcQ3jIPBmsJXcxT.html">白衣卿相（重复）</a></h2>
  </div>
</div>`;

describe('stParseSearchHtml', () => {
  it('解析书名/作者/最新章/简介并按 ID 去重', () => {
    const items = stParseSearchHtml(SEARCH_HTML);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('4Fh5LASjcQ3jIPBmsJXcxT');
    expect(items[0].name).toBe('白衣卿相');
    expect(items[0].author).toBe('王梓钧 字数：119万');
    expect(items[0].latestChapter).toBe('0356【夜空前所未有的绚烂】');
    expect(items[0].intro).toBe('穿越北宋，做个白衣卿相。');
  });
});

const META_HTML = `
<h1 class="booktitle">白衣卿相</h1>
<p class="booktag">
  <a class="red" href="/author/x">王梓钧</a>
  <a class="blue" href="/sort/1">历史军事</a>
  <span class="red">连载中</span>
</p>
<img class="thumbnail" src="https://cdn.sto66.com/cover/abc.jpg" />
<p class="bookintro">穿越北宋，做个白衣卿相。</p>`;

describe('stParseBookMetaHtml', () => {
  it('取书名/作者/分类/状态/封面/简介', () => {
    const meta = stParseBookMetaHtml(META_HTML, '4Fh5LASjcQ3jIPBmsJXcxT');
    expect(meta.name).toBe('白衣卿相');
    expect(meta.author).toBe('王梓钧');
    expect(meta.category).toBe('历史军事');
    expect(meta.status).toBe('连载中');
    expect(meta.cover).toBe('https://cdn.sto66.com/cover/abc.jpg');
    expect(meta.intro).toBe('穿越北宋，做个白衣卿相。');
  });
});

const TOC_HTML = `
<dl>
  <dd><a href="/chapter/4Fh5LASjcQ3jIPBmsJXcxT/A1b2C3dE4fG5hI6jK7l.html" title="0000【开往北宋的高铁】">0000【开往北宋的高铁】</a></dd>
  <dd><a href="/chapter/4Fh5LASjcQ3jIPBmsJXcxT/D4e5F6gH7iJ8kL9mN0o.html" title="0001【嘉祐七年深秋】">0001【嘉祐七年深秋】</a></dd>
  <dd><a href="/chapter/4Fh5LASjcQ3jIPBmsJXcxT/A1b2C3dE4fG5hI6jK7l.html" title="0000【开往北宋的高铁】">重复</a></dd>
  <dd><a href="/chapter/4Fh5LASjcQ3jIPBmsJXcxT/G7h8I9jK0lM1nO2pQ3r.html" title="上架感言">上架感言</a></dd>
  <dd><a href="/chapter/OTHERBOOK00000000000/J1k2L3mN4oP5qR6sT7u.html" title="0000【别的书】">别的书</a></dd>
</dl>`;

describe('stParseTocHtml', () => {
  it('解析章节、去重、过滤公告与跨书链接', () => {
    const chapters = stParseTocHtml(TOC_HTML, '4Fh5LASjcQ3jIPBmsJXcxT');
    expect(chapters.map((c) => c.title)).toEqual(['0000【开往北宋的高铁】', '0001【嘉祐七年深秋】']);
    expect(chapters[0].id).toBe('A1b2C3dE4fG5hI6jK7l');
  });

  it('正文页抽出段落并剔除标题重复行与站点广告', () => {
    const html = `
    <h1 class="pt10">0000【开往北宋的高铁】</h1>
    <div class="read">
      <div id="content">
        <p>　　“女士们，先生们，欢迎您乘坐……”</p>
        <p>0000【开往北宋的高铁】</p>
        <p>请记住本站域名 www.sto66.com</p>
        <p>　　徐来靠在座位上，一脸疲惫。</p>
      </div>
    </div>`;
    const { title, paragraphs } = stParseChapterHtml(html);
    expect(title).toBe('0000【开往北宋的高铁】');
    expect(paragraphs).toEqual(['“女士们，先生们，欢迎您乘坐……”', '徐来靠在座位上，一脸疲惫。']);
  });
});
