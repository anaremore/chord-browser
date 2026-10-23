import { describe, expect, it } from 'vitest';
import { trimNavState } from '../../src/main/nav';

const page = (n: number, pageState?: string) => ({ url: `https://a.test/${n}`, title: `Page ${n}`, ...(pageState ? { pageState } : {}) });

describe('saved tab history', () => {
  it('keeps web pages and the scroll position of each', () => {
    expect(trimNavState([page(1, 'one'), page(2, 'two')], 1)).toEqual({ entries: [page(1, 'one'), page(2, 'two')], index: 1 });
  });

  it("has nothing to restore when the current page isn't on the web", () => {
    expect(trimNavState([page(1), { url: 'chrome://gpu', title: '' }], 1)).toBeNull();
    expect(trimNavState([], 0)).toBeNull();
  });

  it('drops pages that are not on the web and keeps pointing at the current one', () => {
    const nav = trimNavState([page(1), { url: 'file:///etc/hosts', title: '' }, page(3)], 2)!;
    expect(nav.entries.map((e) => e.url)).toEqual(['https://a.test/1', 'https://a.test/3']);
    expect(nav.index).toBe(1);
  });

  it('keeps 50 entries around the current one', () => {
    const entries = Array.from({ length: 120 }, (_, i) => page(i));
    const nav = trimNavState(entries, 100)!;
    expect(nav.entries).toHaveLength(50);
    expect(nav.entries[nav.index]!.url).toBe('https://a.test/100');
  });

  it('drops other pages’ state when it is unusually large', () => {
    const big = 'x'.repeat(600_000);
    const nav = trimNavState([page(1, big), page(2, big)], 1)!;
    expect(nav.entries[0]!.pageState).toBeUndefined();
    expect(nav.entries[1]!.pageState).toBe(big);
  });
});
