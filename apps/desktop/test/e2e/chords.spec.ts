/**
 * Chord switching by swipe (DESIGN.md §6.4) and the theme editor's color
 * wheel (§7.7). Real trackpads can't be driven from a test, so swipes are
 * synthetic wheel events with `deltaX`, as Chromium delivers a trackpad's
 * scroll. A trackpad's on macOS comes with the OS's phases (begin, end,
 * fling), which a test hook sends on any platform; a mouse's, or a swipe
 * anywhere else, has none and ends when its events stop (GestureEnd).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { setReducedMotion } from './a11y-kit';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

async function launch(): Promise<ElectronApplication> {
  // A fresh profile per launch, on a page that needs no network.
  // The hooks: a trackpad's gesture phases (chordTestHooks.gesturePhase).
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-e2e-')), CHORD_HOME_URL: 'about:blank', CHORD_E2E_HOOKS: '1' };
  delete env['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir], env, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');

const runAction = (shell: Page, action: string) =>
  shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

/** A trackpad's gesture phase, as macOS sends it with a two-finger swipe (main's input-event handler). */
const gesturePhase = (app: ElectronApplication, phase: 'begin' | 'end' | 'fling') =>
  app.evaluate((_, p) => (globalThis as unknown as { chordTestHooks: { gesturePhase(p: string): void } }).chordTestHooks.gesturePhase(p), phase);

/**
 * A two-finger swipe as macOS sends it: the OS's begin, wheel events `gapMs` apart over an element of the shell, and
 * the OS's end (`fling` when the fingers left moving), `endAfterMs` after the last event. The gesture ends on the OS's
 * end, never on a pause between events: a busy machine delays the events, as it does a trackpad's, and the swipe still
 * ends when the fingers lift (#198). `phases: false` for a mouse's wheel, or a swipe on Windows or Linux, which have
 * none. A step with `pauseMs` is a pause of the fingers, no event.
 */
async function swipe(
  app: ElectronApplication,
  shell: Page,
  deltas: { x: number; y?: number; pauseMs?: number }[],
  gapMs: number,
  {
    over = '[aria-label="Sidebar"] [aria-label="Unpinned tabs"]',
    end = 'end',
    phases = true,
    endAfterMs = 0,
  }: { over?: string; end?: 'end' | 'fling'; phases?: boolean; endAfterMs?: number } = {},
) {
  if (phases) await gesturePhase(app, 'begin');
  await shell.evaluate(
    async ({ deltas, gapMs, over }) => {
      for (const d of deltas) {
        if (d.pauseMs) {
          await new Promise((r) => setTimeout(r, d.pauseMs));
          continue;
        }
        // Looked up for each event: once the panes follow the fingers, the element under them is a new one, and an
        // event sent to the one that was there reaches nothing.
        const target = document.querySelector(over) ?? document.querySelector('[data-swipe-area]');
        target!.dispatchEvent(new WheelEvent('wheel', { deltaX: d.x, deltaY: d.y ?? 0, deltaMode: 0, bubbles: true, cancelable: true }));
        if (gapMs > 4) {
          await new Promise((r) => setTimeout(r, gapMs));
        } else {
          // A flick's events come as a burst, faster than a busy machine's timers fire: paced here without yielding,
          // as a trackpad sends them whatever the renderer is doing.
          const until = performance.now() + gapMs;
          while (performance.now() < until) {
            // The burst's few milliseconds.
          }
        }
      }
    },
    { deltas, gapMs, over },
  );
  if (endAfterMs) await shell.waitForTimeout(endAfterMs);
  if (phases) await gesturePhase(app, end);
}
const steps = (count: number, x: number, y = 0) => Array.from({ length: count }, () => ({ x, y }));
const pause = (ms: number) => ({ x: 0, pauseMs: ms });

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
const paneCount = (shell: Page) => shell.evaluate(() => document.querySelectorAll('[aria-label="Sidebar"] [aria-label="Unpinned tabs"]').length);

test('a two-finger swipe follows the fingers and settles on the nearest chord', async () => {
  const app = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const chords = await threeChords(shell);
    const selected = (name: string) => expect(chords.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    const tint = () => shell.evaluate(() => getComputedStyle(document.querySelector('[data-sidebar]')!).getPropertyValue('--color-tint'));
    const personalTint = await tint();

    // A slow swipe past half the width: the next chord comes in beside the current one, and wins.
    const swiping = swipe(app, shell, steps(32, 6), 16);
    await expect.poll(() => paneCount(shell)).toBeGreaterThan(1);
    await swiping;
    await selected('Work');
    await expect.poll(() => paneCount(shell)).toBe(1);
    expect(await tint()).not.toBe(personalTint);

    // A short, slow one springs back.
    await swipe(app, shell, steps(5, 4), 20);
    await expect.poll(() => paneCount(shell)).toBe(1);
    await selected('Work');

    // Back the other way.
    await swipe(app, shell, steps(32, -6), 16);
    await selected('Personal');
    await expect.poll(() => paneCount(shell)).toBe(1);

    // A quick flick commits however short: the fingers leave moving (the OS's fling), here read 150 ms after its last
    // event, as a busy renderer reads it; its speed is the one the fingers had.
    // (A burst 1 ms apart: a busy machine's late events are still a flick's.)
    await swipe(app, shell, steps(5, 18), 1, { end: 'fling', endAfterMs: 150 });
    // While it commits, a sideways event is ignored but never cancelled: a quick new touch's first event must start its
    // scroll for macOS to send its begin (Carbon's SF-R2-2 on #242).
    expect(
      await shell.evaluate(() =>
        document.querySelector('[aria-label="Sidebar"] [aria-label="Unpinned tabs"]')!.dispatchEvent(new WheelEvent('wheel', { deltaX: 6, deltaMode: 0, bubbles: true, cancelable: true })),
      ),
      'not cancelled',
    ).toBe(true);
    await selected('Work');
    await expect.poll(() => paneCount(shell)).toBe(1);

    // Its momentum keeps coming the same way, with no begin, and a stalled frame leaves a pause in it: still momentum,
    // never a new swipe to the next chord (Carbon's SF3 on #242).
    await swipe(app, shell, [...steps(6, 10), pause(150), ...steps(12, 10)], 16, { phases: false });
    await expect.poll(() => paneCount(shell)).toBe(1);
    await selected('Work');

    // On to the last; past it, it rubber-bands, and stays.
    await swipe(app, shell, steps(32, 6), 16);
    await selected('Play');
    await swipe(app, shell, steps(30, 8), 12);
    await expect.poll(() => paneCount(shell)).toBe(1);
    await selected('Play');

    // The fingers rest mid-swipe, long enough for a pane let go to spring back, then go on: one swipe, until the OS's
    // end (#198), however long the rest.
    await swipe(app, shell, [...steps(14, -6), pause(600), ...steps(18, -6)], 16);
    await selected('Work');
    await expect.poll(() => paneCount(shell)).toBe(1);

    // Up and down scrolls the list; it never switches chords.
    await swipe(app, shell, steps(20, 1, 12), 12);
    await expect.poll(() => paneCount(shell)).toBe(1);
    await selected('Work');

    // With no phases (Windows, Linux): it follows 1:1 and ends when its events stop, past half the width.
    await swipe(app, shell, steps(32, -6), 16, { phases: false });
    await selected('Personal');
    await expect.poll(() => paneCount(shell)).toBe(1);

    // The chord changes under a swipe (the switcher, a key, another window): the swipe lets go, and the new chord's pane
    // is in place, never left where the swipe had the old one's neighbors (#250).
    const paneX = () =>
      shell.evaluate(() => {
        const pane = document.querySelector('[aria-label="Sidebar"] [aria-label="Unpinned tabs"]')!.closest('[class*="chordPane"]')!;
        return new DOMMatrix(getComputedStyle(pane).transform).m41;
      });
    // The fingers rest a second mid-swipe, while the switcher goes to Work (the middle chord), then go on past half the
    // width. The rest of the touch is held off until the OS's end: never a new swipe from Work on to Play (Carbon's B2).
    const underIt = swipe(app, shell, [...steps(10, 6), pause(1_000), ...steps(22, 6)], 16);
    await expect.poll(() => paneCount(shell)).toBeGreaterThan(1);
    await chords.getByRole('tab', { name: 'Work' }).click();
    await underIt;
    // Long enough for a commit the swipe would have made of its own to land: it makes none, and Work stays.
    await shell.waitForTimeout(800);
    await selected('Work');
    await expect.poll(() => paneCount(shell)).toBe(1);
    await expect.poll(paneX).toBe(0);

    // A chord picked while a commit settles: the pane leaving leaves, the new one is in place (Carbon's B1).
    await swipe(app, shell, steps(32, 6), 16);
    await selected('Play');
    await chords.getByRole('tab', { name: 'Personal' }).click();
    await selected('Personal');
    await expect.poll(() => paneCount(shell)).toBe(1);
    await expect.poll(paneX).toBe(0);

    // The neighbor the swipe moves toward is deleted mid-swipe: it lets go at once, its pane in place, never sliding
    // toward a chord that's gone (Carbon's SF3).
    const workId = await shell.evaluate(async () => {
      const { state } = await (window as unknown as { chord: { state: { snapshot(): Promise<{ state: { chords: Record<string, { name: string }> } }> } } }).chord.state.snapshot();
      return Object.entries(state.chords).find(([, c]) => c.name === 'Work')![0];
    });
    const overGone = swipe(app, shell, [...steps(10, 6), pause(600), ...steps(22, 6)], 16);
    await expect.poll(() => paneCount(shell)).toBeGreaterThan(1);
    await app.evaluate((_, chordId) => (globalThis as unknown as { chordTestHooks: { deleteChord(id: string): void } }).chordTestHooks.deleteChord(chordId), workId);
    await overGone;
    expect(await paneX(), 'in place as the swipe ends').toBe(0);
    await selected('Personal');
    await expect.poll(() => paneCount(shell)).toBe(1);
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

    // One notch (a single big step) held for a moment, its repeats 20 ms apart: one chord, the repeats
    // don't run away with it. (One hold: a pause between them past the notch's cooldown is a second notch.)
    await swipe(app, shell, steps(4, 120), 20, { phases: false });
    await shell.waitForTimeout(400);
    await selected('Work');

    // A fling that ends a scroll up or down (the list's, not a swipe) leaves the next notch alone (Carbon's SF-R2-1 on
    // #242: only a swipe's fling holds its momentum off).
    await swipe(app, shell, steps(10, 0, 14), 12, { end: 'fling' });
    await swipe(app, shell, steps(1, 120), 20, { phases: false });
    await selected('Play');

    // With the sidebar collapsed, the bar takes the swipe.
    await runAction(shell, 'view.toggleSidebar');
    await expect(shell.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    const before = await shell.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label'));
    await swipe(app, shell, steps(32, -6), 16, { over: '[data-swipe-area]:not(nav)' });
    await expect
      .poll(() => shell.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label')))
      .not.toBe(before);
  } finally {
    await app.close();
  }
});


test('motion settings: with reduced motion a swipe’s commit crossfades; with “Slide between chords” off it switches with no animation (#250)', async () => {
  const app = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const chords = await threeChords(shell);
    const selected = (name: string) => expect(chords.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    // Every frame as painted (sampled just after each paint) from `record` until `read`: the chord selected, and each
    // chord pane's x, opacity, and whether it's the one coming in (not hidden from assistive tech).
    type Pane = { x: number; opacity: number; coming: boolean };
    type Frame = { selected: string | null; panes: Pane[] };
    type Recorder = { frames: Frame[]; frame: number };
    const record = () =>
      shell.evaluate(() => {
        const w = window as unknown as { recorder: Recorder };
        w.recorder = { frames: [], frame: 0 };
        const sample = () =>
          w.recorder.frames.push({
            selected: document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label') ?? null,
            panes: [...document.querySelectorAll('[class*="chordPane"]')].map((pane) => {
              const style = getComputedStyle(pane);
              return { x: new DOMMatrix(style.transform).m41, opacity: Number(style.opacity), coming: !pane.hasAttribute('aria-hidden') };
            }),
          });
        const tick = () => {
          setTimeout(sample, 0);
          w.recorder.frame = requestAnimationFrame(tick);
        };
        tick();
      });
    const read = () =>
      shell.evaluate(() => {
        const w = window as unknown as { recorder: Recorder };
        cancelAnimationFrame(w.recorder.frame);
        return w.recorder.frames;
      });
    const fading = (f: Frame) => f.panes.some((p) => p.opacity > 0.05 && p.opacity < 0.95);

    // Reduced motion: no slide, a 120 ms crossfade to the chord the swipe commits to (DESIGN.md §6.6), every pane where
    // it belongs while it fades, not where the fingers left it (Carbon's SF1). As the OS has it, for motion too.
    await shell.emulateMedia({ reducedMotion: 'reduce' });
    await setReducedMotion(app, shell, true);
    // The last click's slide over first: only the swipe's frames count.
    await expect
      .poll(() => shell.evaluate(() => [...document.querySelectorAll('[class*="chordPane"]')].map((p) => `${new DOMMatrix(getComputedStyle(p).transform).m41}/${getComputedStyle(p).opacity}`)))
      .toEqual(['0/1']);
    await record();
    await swipe(app, shell, steps(32, 6), 16);
    await selected('Work');
    await shell.waitForTimeout(400);
    const crossfade = (await read()).filter(fading);
    expect(crossfade.length, 'a crossfade').toBeGreaterThan(0);
    expect(crossfade.flatMap((f) => f.panes.map((p) => Math.round(p.x))), 'every pane in place while it fades').toEqual(crossfade.flatMap((f) => f.panes.map(() => 0)));

    // "Slide between chords" off: no animation at all, not even the crossfade (§6.8), reduced motion or not; the chord
    // coming in is in place in the first frame that shows it (Carbon's SF2).
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.evaluate(() => (window as unknown as { chord: { settings: { set(s: unknown): Promise<void> } } }).chord.settings.set({ motion: { chordSlide: false } }));
    await settings.close();
    await shell.bringToFront();
    await record();
    await swipe(app, shell, steps(32, -6), 16);
    await selected('Personal');
    await shell.waitForTimeout(400);
    const frames = await read();
    expect(frames.filter(fading).length, 'no crossfade').toBe(0);
    const switched = frames.filter((f) => f.selected === 'Personal');
    expect(switched.length).toBeGreaterThan(0);
    expect(switched.flatMap((f) => f.panes.filter((p) => p.coming).map((p) => Math.round(p.x))), 'in place from its first frame').toEqual(switched.flatMap((f) => f.panes.filter((p) => p.coming).map(() => 0)));
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
    // All of it on screen: the editor scrolls, and a handle below the fold can't be clicked or dragged.
    const showWheel = () => wheel.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await showWheel();
    let box = (await wheel.boundingBox())!;
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
    await showWheel();
    box = (await wheel.boundingBox())!;
    const added = (await handles.nth(count).boundingBox())!;
    // Well past the rim (1.6 radii; past 1.25 it goes), on a side of the wheel with room in the window:
    // Settings is smaller on a small screen.
    const view = await settings.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const out = 1.6 * (box.width / 2);
    const off = [
      { x: center.x + out, y: center.y },
      { x: center.x - out, y: center.y },
      { x: center.x, y: center.y + out },
      { x: center.x, y: center.y - out },
    ].find((p) => p.x > 4 && p.y > 4 && p.x < view.width - 4 && p.y < view.height - 4);
    expect(off, `no room past the wheel's rim in a ${view.width}×${view.height} window`).toBeDefined();
    await settings.mouse.move(added.x + added.width / 2, added.y + added.height / 2);
    await settings.mouse.down();
    await settings.mouse.move(off!.x, off!.y, { steps: 6 });
    await settings.mouse.up();
    await expect(handles)
      .toHaveCount(count)
      .catch(async (error: Error) => {
        const where = { view, wheel: box, picked: added, droppedAt: off, handles: await handles.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON())) };
        throw new Error(`${error.message}\n${JSON.stringify(where)}`);
      });

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
