#!/usr/bin/env node
// Spike S17 M0, question 4, step 1: every corpus form loaded into Playwright's bundled
// Chromium (headless; run it in the Linux container, run-linux.mjs corpus), the agent's
// scan run on it, the field records written to results/corpus-records.json. No Electron.
//
// Each file goes in as DuckDuckGo's own harness puts it (body > div > the snapshot, the
// index's title), served with `script-src 'none'` so the page's scripts don't run (jsdom's
// innerHTML doesn't run them either), and with every request but the page's own aborted.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ensureCorpus } from './corpus.mjs';

const here = import.meta.dirname;
const { formsDir } = await ensureCorpus();
const index = JSON.parse(readFileSync(join(formsDir, 'index.json'), 'utf8'));
const scan = readFileSync(join(here, 'agent', 'scan.js'), 'utf8');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: true });
let current = '';
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith('http://corpus.test/form')) {
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': "script-src 'none'" }, body: current });
  }
  return route.abort();
});
const page = await context.newPage();
const out = [];
const started = Date.now();
for (const entry of index) {
  const html = readFileSync(join(formsDir, entry.html), 'utf8');
  const title = (entry.title ?? '__test__').replace(/</g, '&lt;');
  current = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${entry.hasExtraWrappers === false ? html : `<div>${html}</div>`}</body></html>`;
  await page.goto(`http://corpus.test/form?${encodeURIComponent(entry.html)}`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  const forms = await page.evaluate(`(${scan})({ manual: true })`);
  out.push({ html: entry.html, generated: !!entry.generated, expectedFailures: entry.expectedFailures ?? [], scanMs: Date.now() - t0, forms });
}
const version = browser.version();
await browser.close();
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'corpus-records.json'), JSON.stringify({ chromium: version, files: out }));
console.log(`[corpus-extract] ${out.length} files in ${((Date.now() - started) / 1000).toFixed(1)} s; ${out.reduce((a, f) => a + f.forms.reduce((b, g) => b + g.fields.length, 0), 0)} fields`);
