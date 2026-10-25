import { describe, expect, it } from 'vitest';
import {
  cleanOutline,
  cleanSiteEffects,
  EFFECT_PRESETS,
  EFFECTS_LIMITS,
  effectsFromRecord,
  effectsHost,
  effectsRecord,
  effectsSummary,
  effectsTurn,
  emptyEffects,
  hasEffects,
  outlineResult,
  parseEffectsAnswer,
  type SiteEffects,
} from '../src';

describe('effectsHost', () => {
  it.each([
    ['https://www.example.com/a?b#c', 'example.com'],
    ['http://Example.COM/', 'example.com'],
    ['https://news.example.com/', 'news.example.com'],
    ['https://www.www.example.com/', 'www.example.com'],
    ['http://localhost:3000/app', 'localhost:3000'],
    ['https://example.com:443/', 'example.com'],
    ['http://[::1]:8080/', '[::1]:8080'],
    ['https://www/', 'www'],
    ['chord://settings', null],
    ['file:///home/me/page.html', null],
    ['about:blank', null],
    ['javascript:alert(1)', null],
    ['not a url', null],
  ])('%s', (url, host) => {
    expect(effectsHost(url)).toBe(host);
  });
});

const site = (over: Partial<SiteEffects> = {}): SiteEffects => ({ ...emptyEffects('news.test', 10), ...over });

describe('what a site has', () => {
  it('is empty until something is added; a dry site still has its Effects', () => {
    expect(hasEffects(site())).toBe(false);
    expect(hasEffects(site({ css: '   \n' }))).toBe(false);
    expect(hasEffects(site({ css: 'p{}' }))).toBe(true);
    expect(hasEffects(site({ wet: false, presets: ['dark'] }))).toBe(true);
  });

  it('is summed up for Settings', () => {
    expect(effectsSummary(site({ css: 'p{}', hidden: [{ selector: '#a', label: 'a', at: 0 }, { selector: '#b', label: 'b', at: 0 }], presets: ['dark', 'no-sticky'], duet: [{ id: '1', ask: 'x', summary: 'y', css: '', at: 0 }] }))).toBe(
      'Your CSS · 2 hidden · Dark · No sticky bars · 1 from Duet',
    );
    expect(effectsSummary(site())).toBe('');
  });

  it('has three presets, each with words for its chip', () => {
    expect(EFFECT_PRESETS.map((p) => p.id)).toEqual(['reading-width', 'dark', 'no-sticky']);
    for (const p of EFFECT_PRESETS) expect(p.name && p.description.endsWith('.') && p.css).toBeTruthy();
  });
});

describe('cleanSiteEffects', () => {
  it.each<[string, unknown]>([
    ['nothing', null],
    ['a string', 'news.test'],
    ['no host', { css: 'p{}' }],
    ['a host with a space', { host: 'news .test' }],
    ['a host with a path', { host: 'news.test/x' }],
    ['a host still with www.', { host: 'www.news.test' }],
    ['a host in capitals', { host: 'News.Test' }],
  ])('refuses %s', (_what, raw) => {
    expect(cleanSiteEffects(raw)).toBeNull();
  });

  it('keeps what checks out, field by field', () => {
    const cleaned = cleanSiteEffects(
      {
        host: 'news.test',
        wet: 'yes',
        css: 'x'.repeat(EFFECTS_LIMITS.css + 1),
        hidden: [{ selector: '#a', label: 'A'.repeat(500) }, { selector: '#a', label: 'again' }, { selector: '' }, null, { selector: 7 }],
        presets: ['dark', 'dark', 'neon', 3],
        duet: [{ id: 'd', ask: 'q', summary: 's', css: 'p{}' }, { id: 'no-css' }, { css: 'no id' }],
        createdAt: -5,
        updatedAt: 'later',
      },
      99,
    );
    expect(cleaned).toEqual({
      host: 'news.test',
      wet: true,
      css: '',
      hidden: [{ selector: '#a', label: 'A'.repeat(EFFECTS_LIMITS.label), at: 0 }],
      presets: ['dark'],
      duet: [{ id: 'd', ask: 'q', summary: 's', css: 'p{}', at: 0 }],
      createdAt: 99,
      updatedAt: 99,
    });
  });

  it('keeps the newest past a list’s limit', () => {
    const hidden = Array.from({ length: EFFECTS_LIMITS.hidden + 5 }, (_, i) => ({ selector: `#e${i}`, label: '', at: i }));
    const kept = cleanSiteEffects({ host: 'news.test', hidden })!.hidden;
    expect(kept).toHaveLength(EFFECTS_LIMITS.hidden);
    expect(kept[0]!.selector).toBe('#e5');
  });
});

describe('the export record (0.4)', () => {
  it('round-trips a site, without what main inserts and with new ids for Duet’s patches', () => {
    const before = site({
      wet: false,
      css: 'h1 { color: red }',
      hidden: [{ selector: '#ad', label: 'div#ad', at: 5 }],
      presets: ['reading-width'],
      duet: [{ id: 'old', ask: 'Bigger text', summary: 'Bigger body text', css: 'body { font-size: 20px }', at: 6 }],
      updatedAt: 1234,
    });
    const record = effectsRecord(before);
    expect(record).toEqual({
      type: 'effects',
      version: 1,
      site: 'news.test',
      wet: false,
      css: 'h1 { color: red }',
      hidden: [{ selector: '#ad', label: 'div#ad' }],
      presets: ['reading-width'],
      duet: [{ ask: 'Bigger text', summary: 'Bigger body text', css: 'body { font-size: 20px }' }],
      updatedAt: 1234,
    });
    expect('compiled' in record).toBe(false);
    const after = effectsFromRecord(JSON.parse(JSON.stringify(record)), () => 'new-id', 9999);
    expect(after).toEqual({ ...before, hidden: [{ ...before.hidden[0]!, at: 1234 }], duet: [{ ...before.duet[0]!, id: 'new-id', at: 1234 }], createdAt: 1234 });
  });

  it.each<[string, unknown]>([
    ['another type', { type: 'chord', version: 1, site: 'a.test' }],
    ['a later version', { type: 'effects', version: 2, site: 'a.test' }],
    ['no site', { type: 'effects', version: 1 }],
  ])('refuses %s', (_what, raw) => {
    expect(effectsFromRecord(raw, () => 'x')).toBeNull();
  });
});

describe('Ask Duet', () => {
  it.each<[string, string, { css: string; summary: string } | null]>([
    ['plain JSON', '{"css": "h1 { color: green }", "summary": "Green headline"}', { css: 'h1 { color: green }', summary: 'Green headline' }],
    ['in a fence', 'Here you go:\n```json\n{"css":"p{}","summary":"x"}\n```', { css: 'p{}', summary: 'x' }],
    ['inside a sentence', 'Sure! {"css":"a{}","summary":"Links"} Hope it helps.', { css: 'a{}', summary: 'Links' }],
    ['no summary', '{"css":"a{}"}', { css: 'a{}', summary: '' }],
    ['a long summary, on one line', `{"css":"a{}","summary":"${'w '.repeat(100)}"}`, { css: 'a{}', summary: 'w '.repeat(60).trim() }],
    ['empty css, a reason', '{"css":"","summary":"CSS can\'t reorder the comments."}', { css: '', summary: "CSS can't reorder the comments." }],
    ['css not a string', '{"css": 5}', null],
    ['an array of strings', '["a{}"]', null],
    ['too much css', `{"css":"${'a'.repeat(EFFECTS_LIMITS.duetCss + 1)}"}`, null],
    ['not JSON', 'h1 { color: green }', null],
  ])('%s', (_what, text, expected) => {
    expect(parseEffectsAnswer(text)).toEqual(expected);
  });

  it('puts the page in a tool result marked untrusted, and only Chord’s label and your words in the turn', () => {
    expect(effectsTurn('news.test', '  bigger text  ')).toBe('Restyle news.test: bigger text');
    const result = JSON.parse(outlineResult({ url: 'https://news.test/a/b?token=secret#x', title: 'News', outline: 'body\n  main', current: 'h1{}', retrievedAt: 0 }));
    expect(result).toEqual({
      source: 'web_page_outline',
      origin: 'https://news.test',
      path: '/a/b',
      title: 'News',
      retrieved_at: '1970-01-01T00:00:00.000Z',
      trust: 'untrusted',
      outline: 'body\n  main',
      current_effects_css: 'h1{}',
    });
  });

  it('takes out characters an outline could hide instructions in, and keeps its indents', () => {
    expect(cleanOutline('body\n  main​#x‮\u{E0041}')).toBe('body\n  main#x');
  });
});
