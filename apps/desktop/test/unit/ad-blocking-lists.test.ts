/**
 * The filter lists as files (main/ad-blocking/lists.ts): what a list's header
 * says, what passes for the list, when to ask again, which compiled set wins.
 */
import { describe, expect, it } from 'vitest';
import { backoffMs, DEFAULT_REFRESH_MS, FILTER_LISTS, isList, isNewer, listHeader, MAX_REFRESH_MS, MIN_REFRESH_MS, setVersion } from '../../src/main/ad-blocking/lists';

const HEADER = '[Adblock Plus 2.0]\n! Version: 202610241817\n! Title: EasyList\n! Last modified: 24 Oct 2026 18:17 UTC\n! Expires: 4 days (update frequency)\n';
const list = (header: string, size = 60_000) => `${header}${'||ads.example^\n'.repeat(Math.ceil(size / 15))}`;

describe('filter lists', () => {
  it('come from their own host', () => {
    expect(FILTER_LISTS.map((l) => l.url)).toEqual(['https://easylist.to/easylist/easylist.txt', 'https://easylist.to/easylist/easyprivacy.txt']);
  });

  it('reads the header', () => {
    expect(listHeader(HEADER)).toEqual({ title: 'EasyList', version: '202610241817', refreshMs: 4 * 24 * 3_600_000 });
    expect(listHeader(HEADER.replace('4 days', '12 hours')).refreshMs).toBe(12 * 3_600_000);
    // Bounded: a list can't make Chord ask every minute, or never.
    expect(listHeader(HEADER.replace('4 days', '1 hours')).refreshMs).toBe(MIN_REFRESH_MS);
    expect(listHeader(HEADER.replace('4 days', '90 days')).refreshMs).toBe(MAX_REFRESH_MS);
    expect(listHeader('[Adblock Plus 2.0]\n! Title: EasyList\n').refreshMs).toBe(DEFAULT_REFRESH_MS);
  });

  it('a download is the list only with its title, a version and a plausible size', () => {
    expect(isList(list(HEADER), 'EasyList')).toBe(true);
    expect(isList(`\uFEFF${list(HEADER)}`, 'EasyList')).toBe(true);
    expect(isList(list(HEADER), 'EasyPrivacy')).toBe(false);
    expect(isList(list(HEADER.replace('! Version: 202610241817\n', '')), 'EasyList')).toBe(false);
    expect(isList(list(HEADER, 1000), 'EasyList')).toBe(false);
    expect(isList(list(`<!doctype html>${HEADER}`), 'EasyList')).toBe(false);
  });

  it('backs off after failures, up to a day', () => {
    expect(backoffMs(1, 0)).toBe(15 * 60_000);
    expect(backoffMs(3, 0)).toBe(60 * 60_000);
    expect(backoffMs(20, 1)).toBe(24 * 3_600_000);
  });

  it('uses the newer compiled set, list by list', () => {
    const a = { easylist: '202610241817', easyprivacy: '202610241817' };
    const b = { easylist: '202610201200', easyprivacy: '202610241817' };
    expect(isNewer(a, b)).toBe(true);
    expect(isNewer(b, a)).toBe(false);
    expect(isNewer(a, a)).toBe(false);
    expect(isNewer({ easylist: '2', easyprivacy: '1' }, { easylist: '1', easyprivacy: '2' })).toBe(false);
    expect(setVersion(a)).toBe('easylist@202610241817,easyprivacy@202610241817');
  });
});
