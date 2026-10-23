/**
 * Chord switching by swipe (DESIGN.md §6.4) and the theme editor's color
 * wheel (§7.7). Real trackpads can't be driven from a test, so swipes are
 * synthetic wheel events with `deltaX`, as Chromium delivers a trackpad's
 * scroll; the gesture ends the way it does where the OS sends no end phase,
 * after IDLE_END_MS without events.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

async function launch(): Promise<ElectronApplication> {
  // A fresh profile per launch, on a page that needs no network.
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-e2e-')), CHORD_HOME_URL: 'about:blank' };
  delete env['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ args: [appDir], env, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');

const runAction = (shell: Page, action: string) =>
  shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

/** Wheel events as a trackpad sends them, `gapMs` apart, over an element of the shell. */
function swipe(shell: Page, deltas: { x: number; y?: number }[], gapMs: number, over = '[aria-label="Sidebar"] [aria-label="Today"]') {
  return shell.evaluate(
    async ({ deltas, gapMs, over }) => {
      const target = document.querySelector(over) ?? document.querySelector('[data-swipe-area]');
      for (const d of deltas) {
        target!.dispatchEvent(new WheelEvent('wheel', { deltaX: d.x, deltaY: d.y ?? 0, deltaMode: 0, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, gapMs));
      }
    },
    { deltas, gapMs, over },
  );
}
const steps = (count: number, x: number, y = 0) => Array.from({ length: count }, () => ({ x, y }));

/** Three chords: Personal (the first), then Work and Play; ends on Personal. */
async function threeChords(shell: Page) {
  const chords = shell.getByRole('tablist', { name: 'Chords' });
  for (const name of ['Work', 'Play']) {
    await shell.getByRole('button', { name: 'New chord' }).click();
    const field = shell.getByRole('textbox', { name: 'Chord name' });
    await field.fill(name);
    await field.press('Enter');
    await expect(chords.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
  }
  await chords.getByRole('tab', { name: 'Personal' }).click();
  await expect(chords.getByRole('tab', { name: 'Personal' })).toHaveAttribute('aria-selected', 'true');
  return chords;
}

/** Every chord pane in the sidebar, current and beside it: one once a swipe has settled. */
const paneCount = (shell: Page) => shell.evaluate(() => document.querySelectorAll('[aria-label="Sidebar"] [aria-label="Today"]').length);

test('a two-finger swipe follows the fingers and settles on the nearest chord', async () => {
  const app = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const chords = await threeChords(shell);
    const selected = (name: string) => expect(chords.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    const tint = () => shell.evaluate(() => getComputedStyle(document.querySelector('[data-sidebar]')!).getPropertyValue('--color-tint'));
    const personalTint = await tint();

    // A slow swipe past half the width: the next chord comes in beside the current one, and wins.
    const swiping = swipe(shell, steps(32, 6), 16);
    await expect.poll(() => paneCount(shell)).toBeGreaterThan(1);
    await swiping;
    await selected('Work');
    await expect.poll(() => paneCount(shell)).toBe(1);
    expect(await tint()).not.toBe(personalTint);

    // A short, slow one springs back.
    await swipe(shell, steps(5, 4), 20);
    await expect.poll(() => paneCount(shell)).toBe(1);
    await selected('Work');

    // A quick flick commits however short.
    await swipe(shell, steps(4, 12), 4);
    await selected('Play');
    await expect.poll(() => paneCount(shell)).toBe(1);

    // Past the last chord it rubber-bands, and stays.
    await swipe(shell, steps(30, 8), 12);
    await expect.poll(() => paneCount(shell)).toBe(1);
    await selected('Play');

    // Back the other way.
    await swipe(shell, steps(32, -6), 16);
    await selected('Work');

    // Up and down scrolls the list; it never switches chords.
    await swipe(shell, steps(20, 1, 12), 12);
    await expect.poll(() => paneCount(shell)).toBe(1);
    await selected('Work');
  } finally {
    await app.close();
  }
});

test("a mouse's tilt wheel steps one chord per notch, and the minimal bar swipes too", async () => {
  const app = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const chords = await threeChords(shell);
    const selected = (name: string) => expect(chords.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');

    // One notch (a single big step), one chord.
    await swipe(shell, [{ x: 120 }], 0);
    await selected('Work');
    // Its repeats while held don't run away with it: still one chord.
    await swipe(shell, steps(3, 120), 20);
    await shell.waitForTimeout(400);
    await selected('Work');

    // With the sidebar collapsed, the bar takes the swipe.
    await runAction(shell, 'view.toggleSidebar');
    await expect(shell.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    const before = await shell.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label'));
    await swipe(shell, steps(32, -6), 16, '[data-swipe-area]:not(nav)');
    await expect
      .poll(() => shell.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label')))
      .not.toBe(before);
  } finally {
    await app.close();
  }
});


test('the color wheel: keys turn the hue, a click moves the nearest color, and a color dragged off goes', async () => {
  const app = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('tablist', { name: 'Chords' })).toBeVisible();
    const tint = () => shell.evaluate(() => getComputedStyle(document.querySelector('[data-sidebar]')!).getPropertyValue('--color-tint'));
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Appearance' }).click();
    await settings.getByRole('button', { name: 'Create theme' }).click();
    const editor = settings.getByRole('region', { name: 'New theme' });
    const first = editor.getByRole('slider', { name: 'Color 1' });
    await expect(first).toBeVisible();

    // Arrow keys turn the hue 5° at a time; Shift+arrows change how vivid it is.
    const hue = async () => Number(await first.getAttribute('aria-valuenow'));
    const start = await hue();
    await first.focus();
    await first.press('ArrowRight');
    await first.press('ArrowRight');
    expect(await hue()).toBe((start + 10) % 360);
    await first.press('Shift+ArrowDown');
    await first.press('Shift+ArrowDown');
    await first.press('Shift+ArrowDown');
    await first.press('Shift+ArrowDown');
    await expect(first).toHaveAttribute('aria-valuetext', /^Close to \w+/);

    // A click on the wheel's right edge takes the nearest color to hue 90°. Which one is nearest depends on
    // the colors the chord started with (the OS accent's; Dusk's, lilac and coral, where there's none), so
    // find it the way the wheel does: by distance from the click.
    const wheel = first.locator('..');
    const box = (await wheel.boundingBox())!;
    const at = { x: box.x + box.width - 6, y: box.y + box.height / 2 };
    const sliders = editor.getByRole('slider', { name: /^Color \d$/ });
    const centers = await sliders.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })));
    const distances = centers.map((c) => Math.hypot(c.x - at.x, c.y - at.y));
    const nearest = sliders.nth(distances.indexOf(Math.min(...distances)));
    await settings.mouse.click(at.x, at.y);
    await expect.poll(async () => Math.abs(Number(await nearest.getAttribute('aria-valuenow')) - 90)).toBeLessThanOrEqual(5);
    await expect(nearest).toHaveAttribute('aria-valuetext', /vivid$/);

    // "+" adds a color; dragged off the wheel and let go, it's removed.
    const handles = editor.getByRole('slider', { name: /^Color \d$/ });
    const count = await handles.count();
    await editor.getByRole('button', { name: 'Add a color' }).click();
    await expect(handles).toHaveCount(count + 1);
    const added = (await handles.nth(count).boundingBox())!;
    await settings.mouse.move(added.x + added.width / 2, added.y + added.height / 2);
    await settings.mouse.down();
    // Well past the rim (1.8 radii), still inside the window.
    await settings.mouse.move(box.x + box.width + 100, box.y + box.height / 2, { steps: 6 });
    await settings.mouse.up();
    await expect(handles).toHaveCount(count);

    // Making the theme puts it on the chord.
    const before = await tint();
    await editor.getByRole('button', { name: 'Create theme' }).click();
    await expect.poll(tint).not.toBe(before);

    // Surprise me re-colors the chord, and the colors can be kept as a theme.
    const surprised = await tint();
    await settings.getByRole('button', { name: 'Surprise me' }).click();
    await expect.poll(tint).not.toBe(surprised);
    await expect(settings.getByRole('button', { name: 'Current colors', exact: true })).toBeVisible();

    // "Edit colors…" in a chord's menu opens Appearance with its colors on the wheel.
    // A Settings window opened that way loads with this hash.
    await settings.goto(`${settings.url().split('#')[0]}#${encodeURIComponent('appearance/colors')}`);
    await settings.reload();
    await expect(settings.getByRole('region', { name: 'New theme' }).getByRole('slider', { name: 'Color 1' })).toBeVisible();
  } finally {
    await app.close();
  }
});
