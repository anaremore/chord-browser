import { describe, expect, it } from 'vitest';
import {
  cleanOutline,
  cleanSiteEffects,
  EFFECT_PRESETS,
  effectPreset,
  EFFECTS_LIMITS,
  effectsFromRecord,
  effectsHost,
  effectsParts,
  effectsRecord,
  effectsSummary,
  effectsTurn,
  effectsWet,
  emptyEffects,
  hasEffects,
  outlineResult,
  parseEffectsAnswer,
  type DuetEffect,
  type EffectsParts,
  type HiddenElement,
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
const hiddenAt = (selector: string, on = true): HiddenElement => ({ selector, label: selector, on, at: 0 });
const patch = (id: string, css: string, on = true): DuetEffect => ({ id, ask: `ask ${id}`, summary: `patch ${id}`, css, on, at: 0 });

describe('a site’s stylesheet', () => {
  const READING = effectPreset('reading-width')!.css;
  const DARK = effectPreset('dark')!.css;
  const full = (over: Partial<SiteEffects> = {}) =>
    site({ css: 'h1 { color: red }', hidden: [hiddenAt('#ad'), hiddenAt('#promo')], presets: ['reading-width', 'dark'], duet: [patch('a', 'p { color: blue }'), patch('b', 'body { color: green }')], ...over });
  /** What a page gets: nothing while dry, else what's on. */
  const applied = (s: SiteEffects, everywhere: boolean): EffectsParts | null => (effectsWet(s, everywhere) ? effectsParts(s) : null);

  it.each<[string, SiteEffects, boolean, EffectsParts | null]>([
    ['everything on, in the order it applies', full(), true, { presets: [READING, DARK], hidden: ['#ad', '#promo'], css: 'h1 { color: red }', duet: ['p { color: blue }', 'body { color: green }'] }],
    ['your CSS off', full({ cssOn: false }), true, { presets: [READING, DARK], hidden: ['#ad', '#promo'], css: '', duet: ['p { color: blue }', 'body { color: green }'] }],
    ['a hidden element off', full({ hidden: [hiddenAt('#ad', false), hiddenAt('#promo')] }), true, { presets: [READING, DARK], hidden: ['#promo'], css: 'h1 { color: red }', duet: ['p { color: blue }', 'body { color: green }'] }],
    ['one patch off, the other kept in its place', full({ duet: [patch('a', 'p { color: blue }', false), patch('b', 'body { color: green }')] }), true, { presets: [READING, DARK], hidden: ['#ad', '#promo'], css: 'h1 { color: red }', duet: ['body { color: green }'] }],
    ['a preset turned off (it isn’t kept)', full({ presets: ['dark'] }), true, { presets: [DARK], hidden: ['#ad', '#promo'], css: 'h1 { color: red }', duet: ['p { color: blue }', 'body { color: green }'] }],
    [
      'every item off, presets still on',
      full({ cssOn: false, hidden: [hiddenAt('#ad', false), hiddenAt('#promo', false)], duet: [patch('a', 'p{}', false), patch('b', 'b{}', false)] }),
      true,
      { presets: [READING, DARK], hidden: [], css: '', duet: [] },
    ],
    ['dry on its own switch, everything on', full({ wet: false }), true, null],
    ['dry everywhere, everything on', full(), false, null],
    ['dry on both', full({ wet: false }), false, null],
    ['dry, with items off', full({ wet: false, cssOn: false, hidden: [hiddenAt('#ad', false)] }), true, null],
  ])('%s', (_what, s, everywhere, expected) => {
    expect(applied(s, everywhere)).toEqual(expected);
  });

  it('switching an item off and on again gives the same stylesheet', () => {
    const before = full();
    const off = full({ duet: before.duet.map((d) => (d.id === 'a' ? { ...d, on: false } : d)) });
    const on = { ...off, duet: off.duet.map((d) => ({ ...d, on: true })) };
    expect(effectsParts(off)).not.toEqual(effectsParts(before));
    expect(effectsParts(on)).toEqual(effectsParts(before));
  });
});

describe('what a site has', () => {
  it('is empty until something is added; a dry site still has its Effects', () => {
    expect(hasEffects(site())).toBe(false);
    expect(hasEffects(site({ css: '   \n' }))).toBe(false);
    expect(hasEffects(site({ css: 'p{}' }))).toBe(true);
    expect(hasEffects(site({ wet: false, presets: ['dark'] }))).toBe(true);
  });

  it('is summed up for Settings, with how many are switched off', () => {
    const hidden = [hiddenAt('#a'), hiddenAt('#b')];
    const duet = [patch('1', '')];
    expect(effectsSummary(site({ css: 'p{}', hidden, presets: ['dark', 'no-sticky'], duet }))).toBe('Your CSS · 2 hidden · Dark · No sticky bars · 1 from Duet');
    expect(effectsSummary(site({ css: 'p{}', cssOn: false, hidden: [hidden[0]!, { ...hidden[1]!, on: false }], duet: [{ ...duet[0]!, on: false }] }))).toBe('Your CSS · 2 hidden · 1 from Duet · 3 off');
    // Your CSS emptied and off isn't counted: there's nothing of it to be off.
    expect(effectsSummary(site({ cssOn: false, presets: ['dark'] }))).toBe('Dark');
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
      cssOn: true,
      hidden: [{ selector: '#a', label: 'A'.repeat(EFFECTS_LIMITS.label), on: true, at: 0 }],
      presets: ['dark'],
      duet: [{ id: 'd', ask: 'q', summary: 's', css: 'p{}', on: true, at: 0 }],
      createdAt: 99,
      updatedAt: 99,
    });
  });

  it.each<[string, Record<string, unknown>, { cssOn: boolean; hidden: boolean[]; duet: boolean[] }]>([
    ['a row from before the switches: everything on', { css: 'p{}', hidden: [{ selector: '#a' }], duet: [{ id: 'd', css: 'p{}' }] }, { cssOn: true, hidden: [true], duet: [true] }],
    ['switches off', { css: 'p{}', cssOn: false, hidden: [{ selector: '#a', on: false }, { selector: '#b', on: true }], duet: [{ id: 'd', css: 'p{}', on: false }] }, { cssOn: false, hidden: [false, true], duet: [false] }],
    // Only `false` is off: anything else a hand-edited row holds reads as on, as `wet` does.
    ['switches that aren’t booleans', { css: 'p{}', cssOn: 0, hidden: [{ selector: '#a', on: 'no' }], duet: [{ id: 'd', css: 'p{}', on: null }] }, { cssOn: true, hidden: [true], duet: [true] }],
  ])('reads %s', (_what, fields, expected) => {
    const cleaned = cleanSiteEffects({ host: 'news.test', ...fields })!;
    expect({ cssOn: cleaned.cssOn, hidden: cleaned.hidden.map((h) => h.on), duet: cleaned.duet.map((d) => d.on) }).toEqual(expected);
  });

  it('keeps the newest past a list’s limit', () => {
    const hidden = Array.from({ length: EFFECTS_LIMITS.hidden + 5 }, (_, i) => ({ selector: `#e${i}`, label: '', at: i }));
    const kept = cleanSiteEffects({ host: 'news.test', hidden })!.hidden;
    expect(kept).toHaveLength(EFFECTS_LIMITS.hidden);
    expect(kept[0]!.selector).toBe('#e5');
  });
});

describe('the export record (0.4)', () => {
  it('round-trips a site with each item’s switch, without what main inserts and with new ids for Duet’s patches', () => {
    const before = site({
      wet: false,
      css: 'h1 { color: red }',
      cssOn: false,
      hidden: [
        { selector: '#ad', label: 'div#ad', on: true, at: 5 },
        { selector: '#promo', label: 'Promo', on: false, at: 5 },
      ],
      presets: ['reading-width'],
      duet: [
        { id: 'old', ask: 'Bigger text', summary: 'Bigger body text', css: 'body { font-size: 20px }', on: false, at: 6 },
        { id: 'older', ask: 'Blue links', summary: 'Blue links', css: 'a { color: blue }', on: true, at: 6 },
      ],
      updatedAt: 1234,
    });
    const record = effectsRecord(before);
    expect(record).toEqual({
      type: 'effects',
      version: 1,
      site: 'news.test',
      wet: false,
      css: 'h1 { color: red }',
      cssOn: false,
      hidden: [
        { selector: '#ad', label: 'div#ad', on: true },
        { selector: '#promo', label: 'Promo', on: false },
      ],
      presets: ['reading-width'],
      duet: [
        { ask: 'Bigger text', summary: 'Bigger body text', css: 'body { font-size: 20px }', on: false },
        { ask: 'Blue links', summary: 'Blue links', css: 'a { color: blue }', on: true },
      ],
      updatedAt: 1234,
    });
    expect('compiled' in record).toBe(false);
    let id = 0;
    const after = effectsFromRecord(JSON.parse(JSON.stringify(record)), () => `new-${++id}`, 9999);
    expect(after).toEqual({
      ...before,
      hidden: before.hidden.map((h) => ({ ...h, at: 1234 })),
      duet: before.duet.map((d, i) => ({ ...d, id: `new-${i + 1}`, at: 1234 })),
      createdAt: 1234,
    });
  });

  it('reads a record from before the switches as everything on', () => {
    const old = {
      type: 'effects',
      version: 1,
      site: 'news.test',
      wet: true,
      css: 'h1 { color: red }',
      hidden: [{ selector: '#ad', label: 'div#ad' }],
      presets: [],
      duet: [{ ask: 'Bigger text', summary: 'Bigger body text', css: 'body { font-size: 20px }' }],
      updatedAt: 1234,
    };
    const after = effectsFromRecord(old, () => 'new-id')!;
    expect(after.cssOn).toBe(true);
    expect(after.hidden.map((h) => h.on)).toEqual([true]);
    expect(after.duet.map((d) => d.on)).toEqual([true]);
    expect(effectsParts(after)).toEqual({ presets: [], hidden: ['#ad'], css: 'h1 { color: red }', duet: ['body { font-size: 20px }'] });
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
