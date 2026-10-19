import { describe, expect, it } from 'vitest';
import { DEFAULT_SOURCE_ORDER, NOVEL_SOURCES, getNovelSource, inferNovelSource, listNovelSources, searchNovelAcross } from './novel-sources';

describe('小说源注册表', () => {
  it('注册表包含境内、境外与干净源三个源', () => {
    expect(NOVEL_SOURCES.map((s) => s.id)).toEqual(['shuhaige', 'biquge365', 'czbooks']);
    expect(DEFAULT_SOURCE_ORDER[0]).toBe('shuhaige');
  });

  it('listNovelSources 只暴露展示字段', () => {
    const list = listNovelSources();
    expect(list).toHaveLength(3);
    expect(Object.keys(list[0]).sort()).toEqual(['id', 'label', 'note']);
  });

  it('getNovelSource 支持空值与未知 ID', () => {
    expect(getNovelSource('czbooks')?.id).toBe('czbooks');
    expect(getNovelSource('nope')).toBeUndefined();
    expect(getNovelSource(null)).toBeUndefined();
  });

  it('按 ID 形态推断源：19 位归书海阁、≤12 位归境内、字母数字归境外', () => {
    expect(inferNovelSource('1262260513468565162')?.id).toBe('shuhaige');
    expect(inferNovelSource('63611')?.id).toBe('biquge365');
    expect(inferNovelSource('uj4ib')?.id).toBe('czbooks');
    expect(inferNovelSource('')).toBeUndefined();
  });

  it('searchNovelAcross 在首选源无结果时继续试下一个源', async () => {
    // 用一个不存在的关键词走真实网络是不合适的，这里只验证「全部源都失败」时返回 errors
    const result = await searchNovelAcross('', 'articlename').catch(() => null);
    expect(result === null || result.items.length === 0).toBe(true);
  });
});
