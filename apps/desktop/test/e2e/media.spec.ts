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
import { ARTWORK_PNG, mediaPage, talkPage, twitchPage } from '../fixtures/media';
import { dispatch, isOverlay, isSettings, isShell, launch, leavePlaying, newPage, pageWhere, runAction, where } from './a11y-kit';
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
    '/film': mediaPage({ title: 'Film', video: true, track: { title: 'Film Score', artist: 'Composer', album: '' } }),
    // A video its page muted (a player you muted there): silent to Chord.
    '/hushed': talkPage({ title: 'Hushed', muted: true }),
    // Picture and sound in one element, as most sites' videos are.
    '/talk': talkPage(),
    // A player like Twitch's: it plays only when its own button says so, and pauses its video if played from outside.
    '/twitch': twitchPage(),
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

    // A tab left playing: the card shows it, with what its Media Session says.
    await leavePlaying(app, shell, `${site.origin}/audio`);
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

    // A second tab left playing: the newest in full, the other as a row with its own controls.
    await leavePlaying(app, shell, `${site.origin}/radio`);
    await expect(card(shell)).toContainText('Radio Song');
    const audioRow = card(shell).getByRole('button', { name: 'Go to tab: Probe Song' });
    await expect(audioRow).toBeVisible();
    await card(shell).getByRole('button', { name: 'Pause: Probe Song' }).click();
    await expect.poll(() => paused(audio)).toBe(true);
    await card(shell).getByRole('button', { name: 'Play: Probe Song' }).click();
    await expect.poll(() => paused(audio)).toBe(false);

    // Go to tab: it's on screen (its own controls are there), so the card shows the other one alone.
    await audioRow.click();
    await expect(row(shell, 'Audio')).toHaveAttribute('aria-current', 'page');
    await expect(card(shell)).toContainText('Radio Song');
    await expect(card(shell).getByRole('button', { name: /^Go to tab: / })).toHaveCount(1);

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

for (const [what, path] of [
  ['a video with sound', '/talk'],
  ['audio', '/audio'],
] as const) {
  test(`paused in its page, then another chord: no card for it (${what})`, async () => {
    const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` });
    try {
      const shell = await pageWhere(app, isShell);
      await expect(row(shell, 'Second page')).toBeVisible();
      await open(shell, path);
      const page = await pageWhere(app, (url) => url === `${site.origin}${path}`);
      const media = path === '/audio' ? 'audio' : 'video';
      const isPaused = () => page.evaluate((m) => document.querySelector<HTMLMediaElement>(m)!.paused, media);
      await expect.poll(isPaused).toBe(false);
      await page.evaluate((m) => document.querySelector<HTMLMediaElement>(m)!.pause(), media);
      await expect.poll(isPaused).toBe(true);
      // You left it paused: nothing to want controls for.
      const { windowId } = await where(shell);
      await dispatch(shell, { t: 'chord.create', windowId, name: 'Work', icon: 'W', theme: { stops: [{ l: 0.72, c: 0.12, h: 40 }], grain: 0.2, appearance: 'auto' } });
      await shell.waitForTimeout(1000);
      await expect(card(shell)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

test('no card for what you didn’t leave sounding: a background tab’s own autoplay (its row has the speaker), or a video its page muted (no speaker either)', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Second page')).toBeVisible();
    await open(shell, '/audio', true);
    await expect(row(shell, 'Audio').locator('[aria-label="Mute tab"]')).toBeVisible();

    // Playing, muted by its own player, and left: the tab makes no sound, so Chord has nothing to offer.
    const { windowId, tabId } = await where(shell);
    await open(shell, '/hushed');
    const hushed = await pageWhere(app, (url) => url === `${site.origin}/hushed`);
    await expect.poll(() => hushed.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(0.3);
    await dispatch(shell, { t: 'tab.activate', windowId, nodeId: tabId! });
    await expect(row(shell, 'Second page')).toHaveAttribute('aria-current', 'page');
    await shell.waitForTimeout(1000);
    await expect(row(shell, 'Hushed').locator('[aria-label="Mute tab"]')).toHaveCount(0);
    await expect(card(shell)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('several left playing: two rows under the newest, then "and 1 more", which shows the rest', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Second page')).toBeVisible();
    for (const path of ['/plain', '/audio', '/radio', '/talk']) await leavePlaying(app, shell, `${site.origin}${path}`);
    // Newest first: Talk in full; Radio Song and Probe Song as rows; Plain audio behind "and 1 more".
    await expect(card(shell).getByRole('button', { name: /^Go to tab: / })).toHaveCount(3);
    await card(shell).getByRole('button', { name: 'and 1 more' }).click();
    await expect(card(shell).getByRole('button', { name: /^Go to tab: / })).toHaveCount(4);
    await expect(card(shell).getByRole('button', { name: 'Go to tab: Plain audio' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('on Twitch, Play and Pause press its own button: its player ignores its video being played', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` }, { args: ['--host-resolver-rules=MAP www.twitch.tv 127.0.0.1'] });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Second page')).toBeVisible();
    const url = `${site.origin.replace('127.0.0.1', 'www.twitch.tv')}/twitch`;
    await leavePlaying(app, shell, url);
    const page = await pageWhere(app, (u) => u === url);
    const state = () => page.evaluate(() => [document.querySelector('[data-a-target="player-play-pause-button"]')!.getAttribute('data-a-player-state'), document.querySelector('video')!.paused]);
    await card(shell).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(state).toEqual(['paused', true]);
    await card(shell).getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(state).toEqual(['playing', false]);
  } finally {
    await app.close();
  }
});

test('paused from the card, then another chord: the card still plays it', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Second page')).toBeVisible();
    await leavePlaying(app, shell, `${site.origin}/movie`);
    const page = await pageWhere(app, (url) => url === `${site.origin}/movie`);
    const isPaused = () => page.evaluate(() => document.querySelector('audio')!.paused);
    await card(shell).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(isPaused).toBe(true);
    const { windowId } = await where(shell);
    await dispatch(shell, { t: 'chord.create', windowId, name: 'Work', icon: 'W', theme: { stops: [{ l: 0.72, c: 0.12, h: 40 }], grain: 0.2, appearance: 'auto' } });
    await expect(card(shell).getByRole('button', { name: 'Play', exact: true })).toBeVisible({ timeout: 10_000 });
    await card(shell).getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(isPaused).toBe(false);
  } finally {
    await app.close();
  }
});

test('paused, then another chord: the card still plays it', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Second page')).toBeVisible();
    await leavePlaying(app, shell, `${site.origin}/audio`);
    const audio = await pageWhere(app, (url) => url === `${site.origin}/audio`);
    await expect(card(shell)).toContainText('Probe Song');
    await card(shell).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => paused(audio)).toBe(true);
    // Another chord: the paused tab's chord isn't the one on screen any more.
    const { windowId } = await where(shell);
    await dispatch(shell, { t: 'chord.create', windowId, name: 'Work', icon: 'W', theme: { stops: [{ l: 0.72, c: 0.12, h: 40 }], grain: 0.2, appearance: 'auto' } });
    await expect(card(shell)).toContainText('Probe Song');
    await card(shell).getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => paused(audio)).toBe(false);
  } finally {
    await app.close();
  }
});

test('two videos with auto picture-in-picture on (the default): the first left pops out, the next stays in, and you choose which is out', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Second page')).toBeVisible();
    const pipOf = async (path: string) => (await pageWhere(app, (url) => url === `${site.origin}${path}`)).evaluate(() => document.pictureInPictureElement?.id ?? null);
    const playing = async (path: string) => (await pageWhere(app, (url) => url === `${site.origin}${path}`)).evaluate(() => !document.querySelector('video')!.paused);

    // Left playing, the first video pops out on its own; the card says it's out.
    await leavePlaying(app, shell, `${site.origin}/movie`);
    await expect.poll(() => pipOf('/movie')).toBe('v');
    await expect(card(shell).getByRole('button', { name: 'Back to the tab', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // The second stays in its tab (there's one picture-in-picture window): newest in full, the first as a row, still out.
    await leavePlaying(app, shell, `${site.origin}/film`);
    await expect(card(shell)).toContainText('Film Score');
    expect(await pipOf('/film')).toBeNull();
    await expect(card(shell).getByRole('button', { name: 'Back to the tab: Movie Night' })).toHaveAttribute('aria-pressed', 'true');

    // Choose the newest: they swap. The other goes back into its tab, playing on, and you stay where you are.
    await card(shell).getByRole('button', { name: 'Pop out the video', exact: true }).click();
    await expect.poll(() => pipOf('/film')).toBe('v');
    await expect.poll(() => pipOf('/movie')).toBeNull();
    expect(await playing('/movie')).toBe(true);
    await expect(row(shell, 'Second page')).toHaveAttribute('aria-current', 'page');
    await expect(card(shell).getByRole('button', { name: 'Pop out the video: Movie Night' })).toHaveAttribute('aria-pressed', 'false');

    // And back again, from its row.
    await card(shell).getByRole('button', { name: 'Pop out the video: Movie Night' }).click();
    await expect.poll(() => pipOf('/movie')).toBe('v');
    await expect.poll(() => pipOf('/film')).toBeNull();
    expect(await playing('/film')).toBe(true);

    // Back to the tab, from the row: that tab comes on screen with its video in it, and leaves the card.
    await card(shell).getByRole('button', { name: 'Back to the tab: Movie Night' }).click();
    await expect(row(shell, 'Movie')).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => pipOf('/movie')).toBeNull();
    expect(await playing('/movie')).toBe(true);
    await expect(card(shell).getByRole('button', { name: /^Go to tab: / })).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test('the card shows a page without Media Session by its tab, and pops a video out into picture-in-picture', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/second` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(shell, 'Second page')).toBeVisible();
    // Auto picture-in-picture off (Settings → General), or leaving the video would pop it out before the card could.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.evaluate(() => (window as unknown as { chord: { settings: { set(s: unknown): Promise<void> } } }).chord.settings.set({ autoPip: false }));
    await row(shell, 'Second page').click();
    await leavePlaying(app, shell, `${site.origin}/plain`);
    await expect(card(shell).getByRole('button', { name: 'Go to tab: Plain audio' })).toBeVisible();
    await expect(card(shell).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    // No video: no picture-in-picture.
    await expect(card(shell).getByRole('button', { name: 'Pop out the video' })).toHaveCount(0);

    await leavePlaying(app, shell, `${site.origin}/movie`);
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

    // The site pops it out again; you go elsewhere, then back to its tab: it comes back in, playing on.
    await movie.click('#site-pip');
    await expect.poll(pip).toBe('v');
    await row(shell, 'Second page').click();
    await expect(row(shell, 'Second page')).toHaveAttribute('aria-current', 'page');
    expect(await pip()).toBe('v');
    await row(shell, 'Movie').click();
    await expect.poll(pip).toBeNull();
    expect(await movie.evaluate(() => document.querySelector('video')!.paused)).toBe(false);
  } finally {
    await app.close();
  }
});
