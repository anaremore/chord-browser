/* global document -- used inside Playwright page callbacks */
// Spike S2: what does Google's sign-in flow do in Chord?
// Uses a made-up address (no real account, no password) and records the
// page Google shows after "Next": a password/"couldn't find" step means
// allowed; "This browser or app may not be secure" means blocked.
import { _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const appDir = process.argv[2];
const label = process.argv[3] ?? 'default';
const out = process.env.S2_OUT ?? resolve(import.meta.dirname, 'results');
mkdirSync(out, { recursive: true });

const env = { ...process.env, CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-s2-')), CHORD_HOME_URL: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2F' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [appDir], env, cwd: appDir });
try {
  let tab;
  for (let i = 0; i < 150 && !tab; i++) {
    tab = app.windows().find((p) => p.url().includes('accounts.google.com'));
    if (!tab) await new Promise((r) => setTimeout(r, 200));
  }
  if (!tab) throw new Error('no Google tab; pages: ' + app.windows().map((p) => p.url()).join(', '));
  await tab.waitForLoadState('domcontentloaded');
  const ua = await tab.evaluate(() => navigator.userAgent);
  const brands = await tab.evaluate(() => JSON.stringify(navigator.userAgentData?.brands ?? null));
  console.log('UA:', ua);
  console.log('brands:', brands);
  try {
    await tab.waitForSelector('input#identifierId, input[name=identifier], input[type=email]', { timeout: 20_000 });
  } catch {
    console.log('no email field at', tab.url());
    console.log('page:', (await tab.evaluate(() => document.body?.innerText ?? '')).replace(/s+/g, ' ').slice(0, 400));
    await tab.screenshot({ path: resolve(out, `google-${label}-no-field.png`) });
    throw new Error('stopped');
  }
  await tab.fill('input#identifierId, input[name=identifier], input[type=email]', `chord-probe-${Date.now()}@gmail.com`);
  await tab.keyboard.press('Enter');
  await tab.waitForTimeout(6000);
  const text = (await tab.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400);
  console.log('after Next:', text);
  console.log('verdict:', /may not be secure|not be secure|Try using a different browser/i.test(text) ? 'BLOCKED' : 'ALLOWED (reached the next step)');
  await tab.screenshot({ path: resolve(out, `google-${label}.png`) });
} finally {
  await app.close();
}
