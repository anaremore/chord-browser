/**
 * DIAGNOSTIC (temporary): how long a frame snapshot's pictures take on this
 * machine, against PREPARE_TIMEOUT_MS (200 ms), and whether a sidebar toggle
 * glides at all. Never fails; it only prints.
 */
import { expect, test } from '@playwright/test';
import { isShell, launch, pageWhere, runAction, setReducedMotion, startSite } from './a11y-kit';

test('DIAGNOSTIC: frame snapshot timing', async () => {
  const site = await startSite({ '/': '<title>Timing</title><body style="background:linear-gradient(90deg,#e64,#4ae)"><h1>Timing</h1></body>' });
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    await pageWhere(app, (url) => url === `${site.origin}/`);
    await setReducedMotion(app, shell, false);
    await shell.emulateMedia({ reducedMotion: 'no-preference' });
    await shell.waitForTimeout(1000);
    const captures = await app.evaluate(async ({ webContents }, origin) => {
      const page = webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin))!;
      const times: number[] = [];
      for (let i = 0; i < 6; i++) {
        const t0 = performance.now();
        await page.capturePage();
        times.push(Math.round(performance.now() - t0));
      }
      return times;
    }, site.origin);
    const glides: string[] = [];
    for (let i = 0; i < 4; i++) {
      await app.evaluate(({ WebContentsView }, origin) => {
        const g = globalThis as unknown as { moves: string[]; t0: number };
        g.moves = [];
        g.t0 = performance.now();
        const proto = WebContentsView.prototype as unknown as { setBounds(r: Electron.Rectangle): void; __orig?: (r: Electron.Rectangle) => void };
        proto.__orig ??= proto.setBounds;
        proto.setBounds = function (this: Electron.WebContentsView, r: Electron.Rectangle) {
          if (this.webContents.getURL().startsWith(origin)) g.moves.push(`${Math.round(performance.now() - g.t0)}ms x=${r.x}`);
          return proto.__orig!.call(this, r);
        };
      }, site.origin);
      const t0 = Date.now();
      const sawCanvas = shell.waitForFunction(() => document.querySelectorAll('canvas').length > 0, undefined, { polling: 'raf', timeout: 3000 }).then(
        () => `canvas after ${Date.now() - t0}ms`,
        () => 'no canvas',
      );
      await runAction(shell, 'view.toggleSidebar');
      const canvas = await sawCanvas;
      await shell.waitForTimeout(1200);
      const moves = await app.evaluate(() => (globalThis as unknown as { moves: string[] }).moves);
      glides.push(`toggle ${i}: ${canvas}; page moves: ${moves.join(', ')}`);
    }
    console.log(`[snapshot diag] ${process.platform}-${process.arch} capturePage ms: ${captures.join(', ')}\n${glides.join('\n')}`);
    expect(true).toBe(true);
  } finally {
    await app.close();
    site.server.close();
  }
});
