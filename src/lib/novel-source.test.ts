import { describe, expect, it } from 'vitest';
import {
  chapterNumber,
  clearNovelCache,
  decodeEntities,
  metaContent,
  parseBookMetaHtml,
  parseChapterHtml,
  parseSearchHtml,
  parseTocHtml,
  stripTags,
} from './novel-source';

describe('decodeEntities', () => {
  it('解码命名实体、数字实体与十六进制实体', () => {
    expect(decodeEntities('a&nbsp;b&amp;c&#20013;&#x6587;')).toBe('a b&c中文');
  });

  it('未知实体保持原样，避免误吞正文', () => {
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
  });
});

describe('stripTags', () => {
  it('去标签、解实体并压缩空白', () => {
    expect(stripTags('  <span>斗破</span>\n 苍穹&nbsp; ')).toBe('斗破 苍穹');
  });
});

describe('metaContent', () => {
  const html = '<meta property="og:novel:book_name" content="斗破苍穹" /><meta name="description" content="简介" />';

  it('按 property 取值', () => {
    expect(metaContent(html, 'og:novel:book_name')).toBe('斗破苍穹');
  });

  it('也能按 name 取值（description 走这条路）', () => {
    expect(metaContent(html, 'description')).toBe('简介');
  });

  it('缺失时返回 undefined', () => {
    expect(metaContent(html, 'og:image')).toBeUndefined();
  });
});

describe('parseSearchHtml', () => {
  const html = `<h2>搜索"斗破苍穹"的结果</h2><ul class="search">
    <li class="fen"><span class="lei">类别</span></li>
    <li><span class="lei"><a href="/sort/8_1/">[其他类型]</a></span><span class="name"><a href="/book/349642/" title="x">斗破苍穹之雷霆震碎</a></span><span class="jie"><a href="/chapter/349642/1.html">第625章 龙后</a></span><span class="zuo"><a href="/author/张三">张三</a></span><span class="time">08-31</span></li>
    <li><span class="lei"><a href="/sort/3_1/">[都市言情]</a></span><span class="name"><a href="/book/672391/">斗破苍穹之无上神道</a></span><span class="jie"><a href="/chapter/672391/2.html">第1章 开始</a></span><span class="zuo"><a href="/author/李四">李四</a></span><span class="time">09-09</span></li>
    <li><span class="lei"><a href="/sort/8_1/">[其他类型]</a></span><span class="name"><a href="/book/349642/">重复条目</a></span><span class="zuo"><a href="/author/张三">张三</a></span></li>
  </ul>`;

  it('抽取书籍 ID、书名、作者、分类、最新章节与更新时间', () => {
    const items = parseSearchHtml(html);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: '349642',
      name: '斗破苍穹之雷霆震碎',
      author: '张三',
      category: '其他类型',
      latestChapter: '第625章 龙后',
      updatedAt: '08-31',
    });
    expect(items[1].category).toBe('都市言情');
  });

  it('同一本书的重复条目只保留第一次出现', () => {
    expect(parseSearchHtml(html).map((i) => i.id)).toEqual(['349642', '672391']);
  });

  it('无关 HTML 返回空数组', () => {
    expect(parseSearchHtml('<div>nothing</div>')).toEqual([]);
  });
});

describe('parseBookMetaHtml', () => {
  const html = `<meta property="og:novel:book_name" content="斗破苍穹" />
    <meta property="og:novel:author" content="天蚕土豆" />
    <meta property="og:description" content="这里是属于斗气的世界" />
    <meta property="og:image" content="https://www.biquge365.net/files/cover.jpg" />
    <meta property="og:novel:category" content="其他类型" />
    <meta property="og:novel:status" content="连载中" />`;

  it('解析全部 og:novel 元信息', () => {
    expect(parseBookMetaHtml(html, '63611')).toEqual({
      id: '63611',
      name: '斗破苍穹',
      author: '天蚕土豆',
      cover: 'https://www.biquge365.net/files/cover.jpg',
      intro: '这里是属于斗气的世界',
      category: '其他类型',
      status: '连载中',
    });
  });

  it('元信息缺失时回退到 h1 与「佚名」', () => {
    const book = parseBookMetaHtml('<h1>某书</h1>', '7');
    expect(book.name).toBe('某书');
    expect(book.author).toBe('佚名');
  });
});

describe('parseTocHtml', () => {
  const html = `<div class="listmain">
    <a href="/chapter/63611/900.html">第1章 陨落的天才</a>
    <a href="/chapter/63611/901.html">第2章 斗气大陆</a>
    <a href="/chapter/60000/999.html">别的书的章节</a>
    <a href="/chapter/63611/900.html">第1章 陨落的天才</a>
    <a href="/chapter/63611/902.html"></a>
    <a href="/chapter/63611/903.html">开始阅读</a>
    <a href="/chapter/63611/904.html">《：斗帝之路》手游·角色传记（上）</a>
  </div>`;

  it('按出现顺序抽取章节并按 ID 去重，忽略空标题与其他书的链接', () => {
    expect(parseTocHtml(html, '63611')).toEqual([
      { id: '900', title: '第1章 陨落的天才' },
      { id: '901', title: '第2章 斗气大陆' },
    ]);
  });
});

describe('parseChapterHtml', () => {
  const html = `<title>斗破苍穹_第1章 陨落的天才_笔趣阁</title>
    <div id="txt" class="txt">
      <p style="font-weight:bold">一秒记住【笔趣阁】biquge365.net，更新快，无弹窗！</p><br>
      &nbsp;&nbsp;&nbsp;&nbsp;第1章 陨落的天才<br/>
      &nbsp;&nbsp;&nbsp;&nbsp;「斗之力，三段！」<br/>
      &nbsp;&nbsp;&nbsp;&nbsp;望着测验魔石碑上面闪亮得甚至有些刺眼的五个大字。<br/>
    </div>`;

  it('取标题中间段，正文按 <br/> 拆段并剔除广告与重复标题', () => {
    const { title, paragraphs } = parseChapterHtml(html);
    expect(title).toBe('第1章 陨落的天才');
    expect(paragraphs).toEqual(['「斗之力，三段！」', '望着测验魔石碑上面闪亮得甚至有些刺眼的五个大字。']);
  });

  it('剔除站点插入的分页标记', () => {
    const marked = `<html><title>书名_第5章 相遇_笔趣阁</title><body>
      <div  id="txt" class="txt">
        &nbsp;&nbsp;第5章 相遇(第1/2页)<br/>
        &nbsp;&nbsp;他把门带上，屋里只剩风声。(第2/2页)<br/>
        &nbsp;&nbsp;2/2页<br/>
      </div></body></html>`;
    expect(parseChapterHtml(marked).paragraphs).toEqual(['他把门带上，屋里只剩风声。']);
  });

  it('正文容器缺失时返回空段落', () => {
    expect(parseChapterHtml('<html><title>只有标题_第1章_x</title></html>').paragraphs).toEqual([]);
  });
});


describe('chapterNumber', () => {
  it('识别阿拉伯与中文章号', () => {
    expect(chapterNumber('第12章 试探')).toBe(12);
    expect(chapterNumber('第一百六十八章 赵磊')).toBe(168);
    expect(chapterNumber('第十章 起步')).toBe(10);
    expect(chapterNumber('第一千零一章 归来')).toBe(1001);
  });

  it('番外、感言等取不到章号', () => {
    expect(chapterNumber('完结感言！！')).toBeNull();
    expect(chapterNumber('番外：第五章王平')).toBeNull();
  });
});

describe('parseTocHtml 排序', () => {
  it('倒序的最新章节小块与正序全目录混合后按章号升序', () => {
    const html = `<div>
      <a href="/chapter/63611/903.html">第124章 卢谨</a>
      <a href="/chapter/63611/902.html">第123章 最后一课</a>
      <a href="/chapter/63611/801.html">第1章 日更三万</a>
      <a href="/chapter/63611/802.html">第2章 催更鬼</a>
      <a href="/chapter/63611/803.html">第一百一十章 变数</a>
      <a href="/chapter/63611/804.html">完本感言</a>
    </div>`;
    expect(parseTocHtml(html).map((c) => c.title)).toEqual([
      '第1章 日更三万',
      '第2章 催更鬼',
      '第一百一十章 变数',
      '第123章 最后一课',
      '第124章 卢谨',
      '完本感言',
    ]);
  });
});
describe('clearNovelCache', () => {
  it('可重复调用（缓存模块无副作用）', () => {
    clearNovelCache();
    clearNovelCache();
    expect(true).toBe(true);
  });
});
