/**
 * The toast deck (DESIGN.md §6.5): up to three toasts stack like a deck,
 * older ones 6 px higher and smaller behind the newest, and fan out while
 * the stack is hovered or has focus, so every toast's button can be reached.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

async function launch(): Promise<ElectronApplication> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-e2e-')), CHORD_HOME_URL: 'about:blank' };
  delete env['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ args: [appDir, '--no-first-run'], env, cwd: appDir, chromiumSandbox: true }));
}

async function shellOf(app: ElectronApplication): Promise<Page> {
  const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
  await expect.poll(() => app.windows().some((p) => isShell(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => isShell(p.url()))!;
}

/** What main sends the shell for a toast (window.ts `toast`). */
const show = (app: ElectronApplication, toast: { id: string; message: string }) =>
  app.evaluate(({ webContents }, toast) => {
    const shell = webContents.getAllWebContents().find((c) => c.getURL().startsWith('chord://shell') || c.getURL().includes('/shell/index.html'))!;
    shell.send('toast:show', { ...toast, action: { label: 'Undo', command: { t: 'chord.select', chordId: 'none' } } });
  }, toast);

/** Each toast's box in the shell, newest first; its bottom is what shows of it, after its clip. */
const boxes = (shell: Page) =>
  shell.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[aria-label="Notifications"] [role="group"]')].map((el) => {
      const r = el.getBoundingClientRect();
      const clip = Number(/inset\(0(?:px)? 0(?:px)? ([\d.]+)px/.exec(el.style.clipPath)?.[1] ?? 0);
      return { top: r.top, bottom: r.top + (el.offsetHeight - clip) * (r.width / el.offsetWidth), width: r.width };
    }),
  );

test('three toasts stack like a deck, and fan out on hover and on focus', async () => {
  const app = await launch();
  try {
    const shell = await shellOf(app);
    await expect(shell.getByRole('treeitem').first()).toBeVisible();
    for (const [id, message] of [
      ['one', 'Closed 3 tabs'],
      ['two', 'Moved “Release notes” to Work'],
      ['three', 'Archived 12 tabs'],
    ] as const)
      await show(app, { id, message });
    const stack = shell.getByRole('region', { name: 'Notifications' });
    await expect(stack.getByRole('group')).toHaveCount(3);
    // Move the pointer away from the stack, so it's tucked in.
    await shell.mouse.move(1, 1);

    // Tucked in: each older toast's top shows 6 px above the one in front, narrower, and never below it.
    const tucked = async () => {
      const [front, second, third] = await boxes(shell);
      if (!front || !second || !third) return 'missing';
      const ok =
        Math.abs(front.top - second.top - 6) <= 1 &&
        Math.abs(second.top - third.top - 6) <= 1 &&
        second.bottom <= front.bottom + 0.5 &&
        third.width < second.width &&
        second.width < front.width;
      return ok ? 'deck' : JSON.stringify({ front, second, third });
    };
    await expect.poll(tucked).toBe('deck');
    // Only the front one's words show.
    await expect(stack.getByRole('group', { name: 'Closed 3 tabs' }).getByText('Closed 3 tabs')).toHaveCSS('opacity', '0');

    // Hovered: fanned out, none overlapping, and the oldest's Undo is the one a click would reach.
    await stack.hover({ position: { x: 40, y: 4 } });
    const apart = async () => {
      const [front, second, third] = await boxes(shell);
      if (!front || !second || !third) return 'missing';
      return second.bottom <= front.top - 7 && third.bottom <= second.top - 7 ? 'apart' : JSON.stringify({ front, second, third });
    };
    await expect.poll(apart).toBe('apart');
    const oldestUndo = stack.getByRole('group', { name: 'Closed 3 tabs' }).getByRole('button', { name: 'Undo' });
    await oldestUndo.click({ trial: true });

    // The keyboard gets the same: focus inside the stack fans it out.
    await shell.mouse.move(1, 1);
    await expect.poll(tucked).toBe('deck');
    await oldestUndo.focus();
    await expect.poll(apart).toBe('apart');

    // A click on a toast itself, not its button, dismisses just that one.
    await stack.getByRole('group', { name: 'Moved “Release notes” to Work' }).getByText('Moved “Release notes” to Work').click();
    await expect(stack.getByRole('group')).toHaveCount(2);
    await expect(stack.getByRole('group', { name: 'Moved “Release notes” to Work' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
