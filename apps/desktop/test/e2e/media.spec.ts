/**
 * Media in the sidebar (DESIGN.md §7.2, §7.10; ARCHITECTURE.md §9): the
 * speaker on a tab's row and muting, kept through sleep and restarts; and the
 * Now playing card, with what the page's Media Session says, Play and Pause,
 * Mute, picture-in-picture, Go to tab, and several tabs playing at once.
 *
 * The pages play a tone they write themselves (fixtures/media.ts): Chromium
 * reports a tab as audible even with no sound device, as on CI.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ARTWORK_PNG, mediaPage } from '../fixtures/media';
import { dispatch, isOverlay, isShell, launch, newPage, pageWhere, runAction, where } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  const pages: Record<string, string> = {
    '/second': '<title>Second page</title><p>Nothing plays here.</p>',
    '/audio': mediaPage({ title: 'Audio', track: { title: 'Probe Song', artist: 'Probe Artist', album: 'Probe Album', artwork: '/art.png' } }),
    '/radio': mediaPage({ title: 'Radio', track: { title: 'Radio Song', artist: 'Radio Artist', album: '' } }),
    '/plain': mediaPage({ title: 'Plain audio' }),
    '/quiet': mediaPage({ title: 'Quiet', autoplay: false }),
    '/movie': mediaPage({ title: 'Movie', video: true, track: { title: 'Movie Night', artist: 'Director', album: '' } }),
  };
  const server = createServer((req, res) => {
    if (req.url === '/art.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(ARTWORK_PNG);
      return;
    }
    const body = pages[req.url ?? '/'];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  site = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
});
test.afterAll(() => site.server.close());

const today = (shell: Page) => shell.getByRole('tree', { name: 'Today' });
const row = (shell: Page, name: string) => today(shell).getByRole('treeitem', { name, exact: true });
const card = (shell: Page) => shell.getByRole('group', { name: 'Now playing' });

/** Whether Chromium plays a tab's page muted (null while there's no page at that address). */
const muted = (app: ElectronApplication, url: string) =>
  app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)?.isAudioMuted() ?? null, url);

/** Whether the page's `<audio>` is paused. */
const paused = (page: Page) => page.evaluate(() => document.querySelector('audio')!.paused);

/** Opens a tab in the window, in the background or not. */
async function open(shell: Page, path: string, background = false): Promise<void> {
  const { windowId } = await where(shell);
  await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}${path}`, background });
}

test('a tab making sound shows a speaker on its row that mutes and unmutes it; so do the command bar and the keys', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/audio` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const audio = row(shell, 'Audio');
    // The speaker is for the pointer (the keyboard has the row's menu and the keys); the row says what it shows.
    await expect(audio.locator('[aria-label="Mute tab"]')).toBeVisible();
    await expect(audio).toHaveAccessibleDescription('Playing sound');

    await audio.locator('[aria-label="Mute tab"]').click();
    await expect.poll(() => muted(app, `${site.origin}/audio`)).toBe(true);
    // Muted, it still plays (silently): the speaker stays, crossed out.
    await expect(audio.locator('[aria-label="Unmute tab"]')).toBeVisible();
    await expect(audio).toHaveAccessibleDescription('Muted');
    await audio.locator('[aria-label="Unmute tab"]').click();
    await expect.poll(() => muted(app, `${site.origin}/audio`)).toBe(false);

    // The command bar's action, for the tab on screen: Mute tab, then Unmute tab.
    await runAction(shell, 'tab.new');
    await expect(overlay.getByRole('combobox')).toBeFocused();
    await overlay.keyboard.type('mute tab');
    // Actions never lead (the search does): it's picked.
    await overlay.getByRole('option', { name: /^Mute tab/ }).click();
    await expect.poll(() => muted(app, `${site.origin}/audio`)).toBe(true);
    // Mute or unmute tab (Ctrl+M, ⌃M on macOS) toggles it back.
    await runAction(shell, 'tab.mute');
    await expect.poll(() => muted(app, `${site.origin}/audio`)).toBe(false);
    await expect(audio.locator('[aria-label="Mute tab"]')).toBeVisible();

    // A page that stops making sound loses its speaker.
    const page = await pageWhere(app, (url) => url === `${site.origin}/audio`);
    await page.evaluate(() => document.querySelector('audio')!.pause());
    await expect(audio.locator('[aria-label="Mute tab"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('a muted tab stays muted through sleep and a restart', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  let app = await launch({ CHORD_HOME_URL: `${site.origin}/quiet`, CHORD_SLEEP_AFTER_MS: '700', CHORD_IDLE_CHECK_MS: '200' }, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Quiet')).toBeVisible();
    await runAction(shell, 'tab.mute');
    await expect.poll(() => muted(app, `${site.origin}/quiet`)).toBe(true);

    // Hidden long enough, it sleeps (its page closes); shown again, the new page is muted too.
    await open(shell, '/second');
    await expect(row(shell, 'Quiet')).toHaveAttribute('data-asleep', 'true', { timeout: 10_000 });
    await expect.poll(() => muted(app, `${site.origin}/quiet`)).toBeNull();
    await row(shell, 'Quiet').click();
    await expect.poll(() => muted(app, `${site.origin}/quiet`)).toBe(true);
  } finally {
    await app.close();
  }

  app = await launch({}, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Quiet')).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => muted(app, `${site.origin}/quiet`)).toBe(true);
    // It plays: the row's speaker shows it muted.
    const page = await pageWhere(app, (url) => url === `${site.origin}/quiet`);
    await page.evaluate(() => document.querySelector('audio')!.play());
    await expect(row(shell, 'Quiet').locator('[aria-label="Unmute tab"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('muting works in a private window', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(row(shell, 'Second page')).toBeVisible();
    await runAction(shell, 'window.newPrivate');
    const privateShell = await newPage(app, isShell, [shell]);
    const privateOverlay = await newPage(app, isOverlay, [overlay]);
    await expect(privateOverlay.getByRole('combobox')).toBeFocused();
    await privateOverlay.keyboard.type(`${site.origin}/plain`);
    await privateOverlay.keyboard.press('Enter');
    const plain = row(privateShell, 'Plain audio');
    await plain.locator('[aria-label="Mute tab"]').click();
    await expect.poll(() => muted(app, `${site.origin}/plain`)).toBe(true);
    await expect(plain.locator('[aria-label="Unmute tab"]')).toBeVisible();
    // The other window's card never shows a private window's media.
    await expect(card(shell)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the Now playing card: what plays, Play and Pause, Mute, Go to tab, and several tabs at once', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Second page')).toBeVisible();
    // Nothing plays: no card.
    await expect(card(shell)).toHaveCount(0);

    // A tab you aren't looking at plays: the card shows it, with what its Media Session says.
    await open(shell, '/audio', true);
    const audio = await pageWhere(app, (url) => url === `${site.origin}/audio`);
    await expect(card(shell)).toContainText('Probe Song');
    await expect(card(shell)).toContainText('Probe Artist · Probe Album');
    await expect(card(shell).getByRole('button', { name: 'Go to tab: Audio' })).toBeVisible();
    await expect(card(shell).locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);

    // Pause and Play reach the page's player.
    await card(shell).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => paused(audio)).toBe(true);
    await expect(card(shell).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await card(shell).getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => paused(audio)).toBe(false);
    await expect(card(shell).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

    // Mute, as the row's speaker does.
    await card(shell).getByRole('button', { name: 'Mute tab' }).click();
    await expect.poll(() => muted(app, `${site.origin}/audio`)).toBe(true);
    await expect(row(shell, 'Audio').locator('[aria-label="Unmute tab"]')).toBeVisible();
    await card(shell).getByRole('button', { name: 'Unmute tab' }).click();
    await expect.poll(() => muted(app, `${site.origin}/audio`)).toBe(false);

    // A second tab starts playing: it's the newest, and the card steps between the two.
    await open(shell, '/radio', true);
    await expect(card(shell)).toContainText('Radio Song');
    const next = card(shell).getByRole('button', { name: 'Next playing tab, 1 of 2' });
    await next.click();
    await expect(card(shell)).toContainText('Probe Song');

    // Go to tab: it's on screen (its own controls are there), so the card shows the other one.
    await card(shell).getByRole('button', { name: 'Go to tab: Audio' }).click();
    await expect(row(shell, 'Audio')).toHaveAttribute('aria-current', 'page');
    await expect(card(shell)).toContainText('Radio Song');
    await expect(card(shell).getByRole('button', { name: /^Next playing tab/ })).toHaveCount(0);

    // Closed, it's gone at once; with nothing else playing out of sight, so is the card.
    const { windowId } = await where(shell);
    const radio = await shell.evaluate(async () => {
      const { state } = await (window as unknown as { chord: { state: { snapshot(): Promise<{ state: { nodes: Record<string, { title?: string; id: string }> } }> } } }).chord.state.snapshot();
      return Object.values(state.nodes).find((n) => n.title === 'Radio')!.id;
    });
    await dispatch(shell, { t: 'tab.close', windowId, nodeId: radio });
    await expect(card(shell)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the card shows a page without Media Session by its tab, and pops a video out into picture-in-picture', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Second page')).toBeVisible();
    await open(shell, '/plain', true);
    await expect(card(shell).getByRole('button', { name: 'Go to tab: Plain audio' })).toBeVisible();
    await expect(card(shell).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    // No video: no picture-in-picture.
    await expect(card(shell).getByRole('button', { name: 'Pop out the video' })).toHaveCount(0);

    await open(shell, '/movie', true);
    const movie = await pageWhere(app, (url) => url === `${site.origin}/movie`);
    await expect(card(shell)).toContainText('Movie Night');
    const pip = () => movie.evaluate(() => document.pictureInPictureElement?.id ?? null);
    await card(shell).getByRole('button', { name: 'Pop out the video' }).click();
    await expect.poll(pip).toBe('v');
    // Its row and the card say so; back to the tab brings the tab on screen, the video in it, playing on.
    await expect(row(shell, 'Movie').locator('[aria-label="Back to the tab"]')).toBeVisible();
    await card(shell).getByRole('button', { name: 'Back to the tab' }).click();
    await expect.poll(pip).toBeNull();
    expect(await movie.evaluate(() => document.querySelector('video')!.paused)).toBe(false);
    await expect(row(shell, 'Movie')).toHaveAttribute('aria-current', 'page');

    // Popped out by the site itself (its own button, out of Chord's sight): the card still knows, and brings it back.
    await movie.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'site-pip';
      button.textContent = 'Picture-in-picture';
      button.onclick = () => void document.querySelector('video')!.requestPictureInPicture();
      document.body.append(button);
    });
    await movie.click('#site-pip');
    await expect.poll(pip).toBe('v');
    await row(shell, 'Second page').click();
    await expect(card(shell).getByRole('button', { name: 'Back to the tab' })).toBeVisible({ timeout: 10_000 });
    await card(shell).getByRole('button', { name: 'Back to the tab' }).click();
    await expect.poll(pip).toBeNull();
    await expect(row(shell, 'Movie')).toHaveAttribute('aria-current', 'page');
  } finally {
    await app.close();
  }
});
