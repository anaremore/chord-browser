import { describe, expect, it } from 'vitest';
import { describeDownload, firstGrapheme, formatBytes, type Download } from '../src';

describe('firstGrapheme', () => {
  it('keeps whole emoji, including skin tones, families and flags', () => {
    expect(firstGrapheme('👍🏽 nice')).toBe('👍🏽');
    expect(firstGrapheme('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
    expect(firstGrapheme('🇯🇵🇫🇷')).toBe('🇯🇵');
    expect(firstGrapheme('❤️')).toBe('❤️');
  });

  it('capitalizes a letter and ignores surrounding space', () => {
    expect(firstGrapheme('  work')).toBe('W');
    expect(firstGrapheme('é')).toBe('É');
    expect(firstGrapheme('♪')).toBe('♪');
  });

  it('returns nothing for blank input', () => {
    expect(firstGrapheme('   ')).toBe('');
  });
});

describe('download text', () => {
  const d = (patch: Partial<Download>): Download => ({
    id: 'd',
    url: 'https://a.test/f',
    filename: 'f.zip',
    path: '',
    mime: '',
    state: 'progressing',
    received: 0,
    total: 0,
    speed: 0,
    startedAt: 0,
    endedAt: null,
    ...patch,
  });

  it('formats sizes like a file manager', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(980_000)).toBe('980 KB');
    expect(formatBytes(12_345_678)).toBe('12.3 MB');
    expect(formatBytes(1_200_000_000)).toBe('1.2 GB');
  });

  it('says how far along a download is, or how it ended', () => {
    expect(describeDownload(d({ received: 12_300_000, total: 40_000_000, speed: 230_000 }))).toBe('12.3 MB of 40.0 MB · 3 min left');
    expect(describeDownload(d({ received: 5_000_000 }))).toBe('5.0 MB');
    expect(describeDownload(d({ state: 'completed', total: 2_100_000 }))).toBe('Done · 2.1 MB');
    expect(describeDownload(d({ state: 'interrupted' }))).toBe('Failed');
    expect(describeDownload(d({ state: 'paused', received: 1_000_000, total: 4_000_000 }))).toBe('Paused · 1.0 MB of 4.0 MB');
  });
});
