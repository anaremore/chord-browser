import { describe, expect, it } from 'vitest';
import { describeDownload, firstGrapheme, formatBytes, openedAgo, parseThemeCode, themeCode, type Download } from '../src';

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

describe('theme codes', () => {
  it('round-trips a theme through shareable JSON, ignoring text around it', () => {
    const theme = { name: 'Dusk', stops: [{ l: 0.72, c: 0.12, h: 300 }, { l: 0.72, c: 0.14, h: 30 }], grain: 0.2 };
    expect(parseThemeCode(`Try my theme: ${themeCode(theme)} !`)).toEqual(theme);
  });

  it('refuses anything that is not a valid theme', () => {
    expect(parseThemeCode('{"chordTheme":1,"name":"x","stops":[],"grain":0.2}')).toBeNull();
    expect(parseThemeCode('{"name":"x","stops":[{"l":0.5,"c":0.1,"h":10}],"grain":0.2}')).toBeNull();
    expect(parseThemeCode('not json')).toBeNull();
  });
});

describe('openedAgo', () => {
  const now = Date.UTC(2026, 9, 22, 12);
  const min = 60_000;
  it('says how long ago, in the largest unit that reads well', () => {
    expect(openedAgo(now - 20_000, now)).toBe('Opened just now');
    expect(openedAgo(now - 5 * min, now)).toBe('Opened 5 min ago');
    expect(openedAgo(now - 125 * min, now)).toBe('Opened 2 h ago');
    expect(openedAgo(now - 30 * 60 * min, now)).toBe('Opened yesterday');
    expect(openedAgo(now - 6 * 24 * 60 * min, now)).toBe('Opened 6 days ago');
    expect(openedAgo(now - 40 * 24 * 60 * min, now)).toBe('Opened over a month ago');
  });

  it('treats a time in the future as now', () => {
    expect(openedAgo(now + 10 * min, now)).toBe('Opened just now');
  });
});
