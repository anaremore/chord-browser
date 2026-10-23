/**
 * DIAGNOSTIC (temporary): where a frame snapshot gives up on this machine.
 * For each variant of frame-snapshot.spec.ts's setup (the page focused or
 * not, its setBounds/capturePage watched or not), toggles the sidebar and
 * prints what main told the shell (show, move, drop) and when, and where the
 * page went. Never fails; it only prints.
 */
import { test } from '@playwright/test';
import { isShell, launch, pageWhere, runAction, setReducedMotion, startSite } from './a11y-kit';

test('DIAGNOSTIC: frame snapshot phases', async () => {
  const site = await startSite({ '/': '<title>Timing</title><body style="background:linear-gradient(90deg,#e64,#4ae)"><h1>Timing</h1></body>' });
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  const out: string[] = [];
  try {
    const shell = await pageWhere(app, isShell);
    await pageWhere(app, (url) => url === `${site.origin}/`);
    await setReducedMotion(app, shell, false);
    await shell.emulateMedia({ reducedMotion: 'no-preference' });
    await shell.waitForTimeout(800);
    // What main sends the shell about snapshots, and every move of the page.
    await app.evaluate(({ BaseWindow, WebContentsView }, origin) => {
      const g = globalThis as unknown as { log: string[]; t0: number };
      g.log = [];
      g.t0 = performance.now();
      const at = () => Math.round(performance.now() - g.t0);
      const w = BaseWindow.getAllWindows().find((x) => x.getTitle() === 'Chord')!;
      for (const v of w.contentView.children) {
        if (!(v instanceof WebContentsView)) continue;
        const contents = v.webContents;
        if (contents.getURL().startsWith('chord://shell')) {
          const send = contents.send.bind(contents);
          contents.send = (channel: string, ...args: unknown[]) => {
            if (channel === 'frame:snapshot') {
              const e = args[0] as { seq: number; phase: string };
              g.log.push(`${at()} ${e.phase}#${e.seq}`);
            }
            send(channel, ...args);
          };
        }
      }
      const proto = WebContentsView.prototype as unknown as { setBounds(r: Electron.Rectangle): void; __orig?: (r: Electron.Rectangle) => void };
      proto.__orig ??= proto.setBounds;
      proto.setBounds = function (this: Electron.WebContentsView, r: Electron.Rectangle) {
        if (this.webContents.getURL().startsWith(origin)) g.log.push(`${at()} page x=${r.x} focused=${this.webContents.isFocused()}`);
        return proto.__orig!.call(this, r);
      };
    }, site.origin);
    const variants: [string, () => Promise<void>][] = [
      ['base', async () => {}],
      [
        'page focused',
        () => app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin))!.focus(), site.origin),
      ],
      [
        'spec watch() wrappers',
        () =>
          app.evaluate(({ BaseWindow }, origin) => {
            const w = BaseWindow.getAllWindows().find((x) => x.getTitle() === 'Chord')!;
            for (const v of w.contentView.children as unknown as { setBounds(b: Electron.Rectangle): void; webContents: Electron.WebContents }[]) {
              if (!('webContents' in v) || !v.webContents.getURL().startsWith(origin)) continue;
              const own = v as unknown as Record<string, unknown>;
              const setBounds = (own['chordSetBounds'] as ((b: Electron.Rectangle) => void) | undefined) ?? v.setBounds.bind(v);
              own['chordSetBounds'] = setBounds;
              v.setBounds = (b) => setBounds(b);
              const contents = v.webContents as unknown as Record<string, unknown>;
              const capturePage = (contents['chordCapturePage'] as (() => Promise<Electron.NativeImage>) | undefined) ?? v.webContents.capturePage.bind(v.webContents);
              contents['chordCapturePage'] = capturePage;
              (v.webContents as unknown as { capturePage(): Promise<Electron.NativeImage> }).capturePage = () => capturePage();
            }
          }, site.origin),
      ],
    ];
    for (const [name, setup] of variants) {
      await setup();
      for (let i = 0; i < 2; i++) {
        await app.evaluate(() => {
          const g = globalThis as unknown as { log: string[]; t0: number };
          g.log = [];
          g.t0 = performance.now();
        });
        await runAction(shell, 'view.toggleSidebar');
        await shell.waitForTimeout(1200);
        const log = await app.evaluate(() => (globalThis as unknown as { log: string[] }).log);
        out.push(`${name} #${i}: ${log.join(' | ')}`);
      }
    }
  } finally {
    console.log(`[snapshot diag] ${process.platform}-${process.arch}\n${out.join('\n')}`);
    await app.close();
    site.server.close();
  }
});
