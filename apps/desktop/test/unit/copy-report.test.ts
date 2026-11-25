/**
 * A tab of yours copying, as its preload reports it (preload/copy-report.ts): the page's real copy or cut (trusted),
 * never a synthetic event a page makes up, which writes nothing and would mark your own copy as the page's.
 */
import { describe, expect, it } from 'vitest';
import { installCopyReport } from '../../src/preload/copy-report';

describe('The page’s copies, reported (the final check of #150)', () => {
  it('a trusted copy or cut is reported; a synthetic one never is', () => {
    const listeners = new Map<string, (event: { isTrusted: boolean }) => void>();
    let reported = 0;
    installCopyReport({ addEventListener: (type, listener) => void listeners.set(type, listener) }, () => void reported++);
    listeners.get('copy')!({ isTrusted: false });
    listeners.get('cut')!({ isTrusted: false });
    expect(reported).toBe(0);
    listeners.get('copy')!({ isTrusted: true });
    listeners.get('cut')!({ isTrusted: true });
    expect(reported).toBe(2);
  });
});
