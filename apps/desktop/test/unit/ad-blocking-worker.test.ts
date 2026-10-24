/**
 * Ad blocking's worker (main/ad-blocking/worker.ts), run without a thread:
 * element hiding is only ever `display: none`, private windows' requests are
 * matched by the engine, and compiling the bundled lists writes a whole set.
 */
import { FiltersEngine } from '@ghostery/adblocker';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_CONFIG } from '../../src/main/ad-blocking/compile';
import type { CompileResult } from '../../src/main/ad-blocking/protocol';
import { handle, hidingOnly } from '../../src/main/ad-blocking/worker';

const LISTS = join(import.meta.dirname, '../../build/ad-blocking');

describe('element hiding', () => {
  it('keeps only display: none rules, rebuilt', () => {
    expect(hidingOnly('.ad,\n#banner { display: none !important; }')).toBe('.ad,\n#banner { display: none !important; }');
    expect(hidingOnly('.a { display:none!important }\n\n.b { display: none !important; }')).toBe('.a { display: none !important; }\n.b { display: none !important; }');
    // Anything else is dropped: other declarations, fetches, at-rules, comments.
    expect(hidingOnly('.ad { background: url(https://x.example/leak?) }')).toBe('');
    expect(hidingOnly('@import url(https://x.example/a.css); .ad { display: none !important; }')).toBe('');
    expect(hidingOnly('.ad /* x */ { display: none !important; }')).toBe('');
    expect(hidingOnly('.ad { display: none !important; color: red }')).toBe('');
    expect(hidingOnly('a[href^="https://x"]; @import url(https://x.example/a.css); .ad { display: none !important; }')).toBe('');
    // Quoted attribute values may hold anything (EasyList matches inline styles).
    expect(hidingOnly('div[style="width: 300px; height: 250px;"] { display: none !important; }')).toBe('div[style="width: 300px; height: 250px;"] { display: none !important; }');
    expect(hidingOnly('a[href*="url(@"] { display: none !important; }')).toBe('a[href*="url(@"] { display: none !important; }');
    expect(hidingOnly('.\\[\\&_\\.ad\\]\\:\\!z-\\[5\\] { display: none !important; }')).toBe('.\\[\\&_\\.ad\\]\\:\\!z-\\[5\\] { display: none !important; }');
  });

  it('keeps every rule EasyList gives real sites', () => {
    const texts = ['easylist', 'easyprivacy'].map((id) => readFileSync(join(LISTS, `${id}.txt`), 'utf8'));
    const engine = FiltersEngine.parse(texts.join('\n'), ENGINE_CONFIG);
    for (const [url, hostname, domain] of [
      ['https://www.cnn.com/', 'www.cnn.com', 'cnn.com'],
      ['https://www.theguardian.com/uk', 'www.theguardian.com', 'theguardian.com'],
      ['https://example.com/', 'example.com', 'example.com'],
    ] as const) {
      const { styles } = engine.getCosmeticsFilters({ url, hostname, domain, getBaseRules: true, getInjectionRules: false, getExtendedRules: false, getRulesFromDOM: false, getRulesFromHostname: true });
      const blocks = (css: string) => css.split('{').length - 1;
      expect(blocks(styles)).toBeGreaterThan(0);
      expect(blocks(hidingOnly(styles))).toBe(blocks(styles));
    }
  }, 30_000);
});

describe('the engine', () => {
  it('answers element hiding for a page and private windows’ requests', async () => {
    const engine = FiltersEngine.parse(['||ads.example^$third-party', '@@||ads.example/allowed.js', 'news.example##.sponsor', '##.ad-slot'].join('\n'), ENGINE_CONFIG);
    await handle({ type: 'open', bytes: engine.serialize() });
    const css = (await handle({ type: 'css', url: 'https://www.news.example/article' })) as string;
    expect(css).toContain('.sponsor');
    expect(css).toMatch(/\{ display: none !important; \}$/);
    expect(await handle({ type: 'css', url: 'https://other.example/' })).not.toContain('.sponsor');
    const match = (url: string, sourceUrl = 'https://news.example/') => handle({ type: 'match', url, sourceUrl, resourceType: 'script' });
    expect(await match('https://ads.example/tag.js')).toBe(true);
    expect(await match('https://ads.example/allowed.js')).toBe(false);
    expect(await match('https://cdn.example/lib.js')).toBe(false);
    // First-party: the filter is third-party only.
    expect(await match('https://ads.example/tag.js', 'https://ads.example/')).toBe(false);
  });

  it('compiles the bundled lists into a whole set, swapped in', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'chord-lists-')), 'Lists');
    const bytes = (id: string) => new Uint8Array(readFileSync(join(LISTS, `${id}.txt`)));
    const result = (await handle({ type: 'compile', lists: { easylist: bytes('easylist'), easyprivacy: bytes('easyprivacy') }, from: [out], out })) as CompileResult;
    expect(result.rules).toBeGreaterThan(5000);
    expect(result.info.versions.easylist).toMatch(/^\d{12}$/);
    for (const file of ['engine.bin', 'lists.json', 'easylist.txt', 'easyprivacy.txt', 'rules/easylist.json', 'rules/easyprivacy.json']) expect(existsSync(join(out, file))).toBe(true);
    expect(existsSync(`${out}.new`)).toBe(false);
    // A list that came back unchanged is read from the set before.
    const again = (await handle({ type: 'compile', lists: { easylist: null, easyprivacy: bytes('easyprivacy') }, from: [out], out })) as CompileResult;
    expect(again.info.versions).toEqual(result.info.versions);
    // Something that isn't the list is refused, and the set stays as it was.
    await expect(handle({ type: 'compile', lists: { easylist: new TextEncoder().encode('<html>nope</html>'), easyprivacy: null }, from: [out], out })).rejects.toThrow(/EasyList/);
    expect(JSON.parse(readFileSync(join(out, 'lists.json'), 'utf8')).versions).toEqual(result.info.versions);
  }, 30_000);
});
