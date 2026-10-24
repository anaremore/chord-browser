/**
 * Interface size (Settings → Appearance, DESIGN.md §10): Chord's own views
 * zoom, pages keep their own zoom, and main places each page where the shell
 * draws its frame, at every size.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');
const captures = resolve(appDir, '../../.qa/interface-size');

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function launch(profile: string): Promise<ElectronApplication> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, CHORD_HOME_URL: 'about:blank' };
  delete env['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ args: [appDir, '--no-first-run'], env, cwd: appDir, chromiumSandbox: true }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}
const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');
const isTab = (url: string) => url === 'about:blank';
const runAction = (shell: Page, action: string) => shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);
const ratio = (page: Page) => page.evaluate(() => devicePixelRatio);

/** The content frame the shell draws, in its CSS pixels; null until it's drawn (just after launch). */
const frameInShell = (shell: Page): Promise<Box | null> =>
  shell.evaluate(() => {
    const r = document.querySelector('[data-region="page"]')?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  });

/** Where main put the page's view, in window pixels. */
const pageInWindow = (app: ElectronApplication): Promise<Box | null> =>
  app.evaluate(({ BaseWindow }) => {
    for (const w of BaseWindow.getAllWindows())
      for (const v of w.contentView.children) {
        const contents = (v as { webContents?: Electron.WebContents }).webContents;
        if (contents && !contents.isDestroyed() && contents.getURL() === 'about:blank') return v.getBounds();
      }
    return null;
  });

/** The page sits on the shell's frame, scaled to window pixels (a pixel of rounding either way). */
async function expectPageOnFrame(app: ElectronApplication, shell: Page, scale: number): Promise<void> {
  await expect
    .poll(async () => {
      const [frame, page] = await Promise.all([frameInShell(shell), pageInWindow(app)]);
      if (!frame) return 'no frame';
      if (!page) return 'no page';
      const off = [page.x - frame.x * scale, page.y - frame.y * scale, page.width - frame.width * scale, page.height - frame.height * scale];
      return off.every((d) => Math.abs(d) <= 1.5) ? 'on frame' : `page ${JSON.stringify(page)} vs frame ${JSON.stringify(frame)} × ${scale}`;
    })
    .toBe('on frame');
}

test('interface size zooms Chord, not pages, places pages on the frame, and is kept', async () => {
  test.setTimeout(90_000);
  mkdirSync(captures, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  let app = await launch(profile);
  try {
    let shell = await pageWhere(app, isShell);
    let tab = await pageWhere(app, isTab);
    // The screen's own scale, which both start at.
    const screen = await ratio(tab);
    expect(await ratio(shell)).toBeCloseTo(screen, 2);
    await expectPageOnFrame(app, shell, 1);

    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance' }).click();
    const sizes = settings.getByRole('radiogroup', { name: 'Interface size' });
    await expect(sizes.getByRole('radio', { name: '100%' })).toHaveAttribute('aria-checked', 'true');

    for (const scale of [1.25, 1.5]) {
      await sizes.getByRole('radio', { name: `${Math.round(scale * 100)}%` }).click();
      await expect.poll(() => ratio(shell)).toBeCloseTo(screen * scale, 2);
      await expect.poll(() => ratio(settings)).toBeCloseTo(screen * scale, 2);
      // Pages keep their own zoom.
      expect(await ratio(tab)).toBeCloseTo(screen, 2);
      await expectPageOnFrame(app, shell, scale);
      await settings.waitForTimeout(300);
      await shell.screenshot({ path: join(captures, `shell-${scale * 100}.png`) });
      await settings.screenshot({ path: join(captures, `settings-${scale * 100}.png`) });
    }

    // Kept across a restart: everything opens at the size.
    await app.close();
    app = await launch(profile);
    shell = await pageWhere(app, isShell);
    tab = await pageWhere(app, isTab);
    await expect.poll(() => ratio(shell)).toBeCloseTo(screen * 1.5, 2);
    expect(await ratio(tab)).toBeCloseTo(screen, 2);
    await expectPageOnFrame(app, shell, 1.5);
  } finally {
    await app.close();
  }
});
