/**
 * The password detector on real sites' forms, in Playwright's own Chromium, headless: no
 * Electron, no window (S17 §13, layer 2).
 *
 * - **DuckDuckGo's corpus** (corpus.ts: pinned, hash-checked, cached, never in the repo).
 *   Each file is loaded as DuckDuckGo's own harness loads it (body > div > the snapshot,
 *   under its index's title), with the page's scripts blocked and every other request
 *   aborted. The agent's scan and classifier run in the page, and score.ts scores each
 *   labelled field. **baseline.json** lists every field wrong today. A field that was right and
 *   is now wrong fails, and so does one that's newly right, until the baseline is taken again
 *   (`CHORD_FORMS_UPDATE=1 pnpm --filter @chord/desktop test:forms`). So the number only
 *   ratchets up; the totals are printed on every run.
 * - **Chord's own fixtures** (fixtures/*.html): one pattern each, every field marked with the
 *   role it must get (`data-chord-expect`), the form's kind in `<meta name="chord-kind">`.
 *   All must pass.
 *
 * Writes test-results/forms/ (the score, and the scan's records for tuning in Node).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bundleAgent } from '../../src/passwords/build';
import { CORPUS_COMMIT, ensureCorpus } from './corpus';
import type { PageResult } from './page';
import { compareBaseline, scoreCorpus, type CorpusBaseline, type ScoredFile } from './score';

const here = import.meta.dirname;
const BASELINE = join(here, 'baseline.json');
const RESULTS = resolve(here, '..', '..', 'test-results', 'forms');
const ORIGIN = 'http://forms.test';
/** At least this share of files must be wholly right, whatever the baseline says (M0: about 81%). */
const FLOOR = 0.8;

let script = '';
let current = '';
test.beforeAll(async () => {
  script = await bundleAgent({ entry: join(here, 'page.ts'), minify: false });
});
test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(`${ORIGIN}/`)) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': "script-src 'none'" }, body: current });
    }
    return route.abort();
  });
});

async function scanPage(page: Page, html: string, path: string): Promise<PageResult> {
  current = html;
  await page.goto(`${ORIGIN}/${encodeURIComponent(path)}`, { waitUntil: 'domcontentloaded' });
  // Evaluated over CDP, which the page's CSP doesn't cover; its own scripts never run.
  return (await page.evaluate(`${script}\n;globalThis.chordFormsScan()`)) as PageResult;
}

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

test("DuckDuckGo's corpus, held to the baseline", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const { formsDir, index } = await ensureCorpus((line) => console.log(`[forms] ${line}`));
  const files: ScoredFile[] = [];
  const records: Record<string, PageResult['records']> = {};
  for (const entry of index) {
    const body = readFileSync(join(formsDir, entry.html), 'utf8');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(entry.title ?? '__test__')}</title></head><body>${entry.hasExtraWrappers === false ? body : `<div>${body}</div>`}</body></html>`;
    const result = await scanPage(page, html, entry.html);
    files.push({
      html: entry.html,
      fields: result.fields.filter((f) => f.index >= 0).map((f) => ({ index: f.index, label: f.label!, field: f.field, role: f.role })),
      missing: result.missing,
    });
    records[entry.html] = result.records;
  }
  const score = scoreCorpus(files);
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, 'score.json'), JSON.stringify(score, null, 2));
  writeFileSync(join(RESULTS, 'records.json'), JSON.stringify(records));
  const pct = (n: number) => `${((100 * n) / score.scoredFiles).toFixed(1)}%`;
  console.log(
    `[forms] ${score.rightFiles} of ${score.scoredFiles} files right (${pct(score.rightFiles)}); ` +
      `${score.rightFilesStrict} (${pct(score.rightFilesStrict)}) counting "username OR emailAddress" as username only; ` +
      `${score.wrongFields} of ${score.fields} labelled fields wrong`,
  );
  if (process.env['CHORD_FORMS_UPDATE']) {
    const baseline: CorpusBaseline = { corpus: `duckduckgo/duckduckgo-autofill@${CORPUS_COMMIT}`, rightFiles: score.rightFiles, scoredFiles: score.scoredFiles, failures: score.failures };
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`[forms] baseline written: ${BASELINE}`);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as CorpusBaseline;
  const { regressed, fixed } = compareBaseline(score, baseline);
  expect(regressed, 'fields that were right and are now wrong').toEqual([]);
  expect(fixed, 'fields newly right: take the baseline again (CHORD_FORMS_UPDATE=1)').toEqual([]);
  expect(score.rightFiles / score.scoredFiles).toBeGreaterThanOrEqual(FLOOR);
});

test("Chord's own fixtures, every field right", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const dir = join(here, 'fixtures');
  const problems: string[] = [];
  const names = readdirSync(dir).filter((n) => n.endsWith('.html'));
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const html = readFileSync(join(dir, name), 'utf8');
    const result = await scanPage(page, html, name);
    for (const f of result.fields) {
      if (f.expect === null) continue;
      const want = f.expect === 'none' ? null : f.expect;
      if (f.role !== want) problems.push(`${name}: ${f.field} is ${f.role ?? 'none'}, wanted ${want ?? 'none'}`);
    }
    const kind = /<meta name="chord-kind" content="([^"]+)">/.exec(html)?.[1];
    if (kind && !result.kinds.includes(kind as never)) problems.push(`${name}: kinds ${JSON.stringify(result.kinds)}, wanted ${kind}`);
  }
  expect(problems).toEqual([]);
});
