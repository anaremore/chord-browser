/**
 * Chord Player (ARCHITECTURE.md §9; DESIGN.md §7.1, §7.10, §7.14), Chord
 * driving the real player: packaged on castLabs ECS for Linux x64 exactly as
 * CI packages it (apps/player/scripts/package.mjs), served from a local
 * stand-in for GitHub Releases with its manifest signed by a test key, as
 * updates.spec.ts does.
 *
 * The services' addresses are this machine (--host-resolver-rules, which
 * Chord passes on to the player in development builds asked for it), and
 * "Netflix" is a Widevine test page: Shaka Player with Shaka's Angel One
 * stream and its no-auth licence server, as spike S14 played. The CDM, the
 * stream and the licence come from the network.
 *
 * Linux x64 only: the E2E container and CI's Linux jobs. Windows and macOS
 * builds are checked by the player's own smoke test (.github/workflows/player.yml).
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { artworkPng, watchPage } from '../../../player/scripts/test-page.mjs';
import { capturesDir, dispatch, isPopover, isSettings, isShell, launch, newPage, pageWhere, runAction, where } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();
/** Chord's console (the player's goes there too, in development builds), shown when a test fails. */
let output = '';
test.afterEach(async () => {
  const info = test.info();
  if (info.status !== info.expectedStatus) console.log(`--- Chord's output (last 12000 characters) ---\n${output.slice(-12_000)}`);
  output = '';
});
test.skip(!(process.platform === 'linux' && process.arch === 'x64'), 'Chord Player is driven end to end on Linux x64; other OSes run its smoke test');

const repo = resolve(import.meta.dirname, '../../../..');
const keys = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

interface Release {
  tag: string;
  version: string;
  manifestName: string;
  manifest: string;
  zip: string;
  zipName: string;
  size: number;
}

let release: Release;
let site: { server: Server; origin: string; port: number; corrupt: boolean };

/** The player, packaged for this machine (or the one CI built, in CHORD_PLAYER_PACKAGE_DIR). */
function packagePlayer(): Release {
  let dir = process.env['CHORD_PLAYER_PACKAGE_DIR'];
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'chord-player-package-'));
    const env = { ...process.env } as Record<string, string>;
    delete env['ELECTRON_RUN_AS_NODE'];
    const result = spawnSync(process.execPath, [join(repo, 'apps/player/scripts/package.mjs'), '--out', dir], { cwd: repo, env, stdio: 'inherit', timeout: 15 * 60_000 });
    if (result.status !== 0) throw new Error(`Packaging Chord Player failed (${result.status ?? result.signal})`);
  }
  const manifestName = readdirSync(dir).find((n) => /^chord-player-linux-x64\.json$/.test(n))!;
  const manifest = readFileSync(join(dir, manifestName), 'utf8');
  const { version, file, size } = JSON.parse(manifest) as { version: string; file: string; size: number };
  return { tag: `player-v${version}`, version, manifestName, manifest, zip: join(dir, file), zipName: file, size };
}

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  release = packagePlayer();
  const zip = readFileSync(release.zip);
  const corrupted = Buffer.from(zip);
  corrupted[corrupted.length >> 1]! ^= 0xff;
  const signature = sign(null, Buffer.from(release.manifest), keys.privateKey).toString('base64');
  const art = artworkPng();
  const pages: Record<string, string> = {
    '/': '<title>Home</title><p>Nothing to watch here.</p>',
    '/elsewhere': '<title>Elsewhere</title><p>A page that isn’t a streaming service’s.</p>',
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/releases') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ tag_name: 'v99.0.0', draft: false }, { tag_name: release.tag, draft: false }]));
    }
    if (path === '/watch') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(watchPage({ links: [{ id: 'elsewhere', href: `${site.origin}/elsewhere`, text: 'Elsewhere' }] }));
    }
    if (path === '/art.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(art);
    }
    const files: Record<string, Buffer | string> = {
      [`/download/${release.tag}/${release.manifestName}`]: release.manifest,
      [`/download/${release.tag}/${release.manifestName}.sig`]: signature,
      [`/download/${release.tag}/${release.zipName}`]: site.corrupt ? corrupted : zip,
    };
    const body = files[decodeURIComponent(path)] ?? pages[path];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': pages[path] ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((done) => server.listen(0, done));
  const port = (server.address() as AddressInfo).port;
  site = { server, origin: `http://127.0.0.1:${port}`, port, corrupt: false };
});
test.afterAll(() => site?.server.close());

const netflix = () => `http://www.netflix.com:${site.port}`;

/** Chord, with a player folder of its own and the stand-in release. */
async function launchChord(root = mkdtempSync(join(tmpdir(), 'chord-player-root-'))): Promise<{ app: ElectronApplication; root: string }> {
  const app = await launch(
    {
      CHORD_HOME_URL: `${site.origin}/`,
      CHORD_E2E_HOOKS: '1',
      CHORD_PLAYER_ROOT: root,
      CHORD_PLAYER_FEED: `${site.origin}/releases`,
      CHORD_PLAYER_DOWNLOADS: `${site.origin}/download/`,
      CHORD_PLAYER_PUBLIC_KEY: publicPem,
      CHORD_PLAYER_TEST: '1',
      CHORD_PLAYER_SECURE_ORIGINS: netflix(),
    },
    { args: ['--host-resolver-rules=MAP www.netflix.com 127.0.0.1'] },
  );
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-50_000)));
  return { app, root };
}

interface PlayerDebug {
  url: string;
  video: { currentTime: number; paused: boolean; width: number; height: number; error: number | null } | null;
  muted: boolean;
  cdm: string;
  focusRequests: number;
}
type Hooks = { chordTestHooks: { player(): Record<string, unknown>; playerDebug(): Promise<PlayerDebug | null>; playerTest(body: Record<string, unknown>): Promise<unknown> } };
const debug = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as Hooks).chordTestHooks.playerDebug());
const playerTest = (app: ElectronApplication, body: Record<string, unknown>) => app.evaluate((_e, b) => (globalThis as unknown as Hooks).chordTestHooks.playerTest(b), body);
const inspect = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as Hooks).chordTestHooks.player());

const notice = (popover: Page, service = 'Netflix') => popover.getByRole('dialog', { name: `${service} won’t play in Chord yet` });

test('installs Chord Player from the notice, plays a Widevine stream in it, and Chord controls it', async () => {
  test.setTimeout(6 * 60_000);
  const { app, root } = await launchChord();
  try {
    const shell = await pageWhere(app, isShell);
    const popover = await pageWhere(app, isPopover);
    const { windowId } = await where(shell);
    await dispatch(shell, { t: 'tab.open', windowId, url: `${netflix()}/watch` });

    // Before it's installed: Install, with the download's size, ahead of other browsers.
    const card = notice(popover);
    const install = card.getByRole('button', { name: `Install Chord Player (about ${Math.round(release.size / 1e6)} MB)` });
    await expect(install).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Chord Player, a companion app with Widevine');
    await card.screenshot({ path: join(capturesDir, 'player-notice-install.png') });
    await install.click();

    // Then progress, then the page opens in the player and the tab says so.
    const playing = shell.getByRole('status').filter({ hasText: 'Playing in Chord Player' });
    await expect(playing).toBeVisible({ timeout: 120_000 });
    await expect(card).toHaveCount(0);
    expect(existsSync(join(root, release.version))).toBe(true);
    expect((await inspect(app))['hello']).toMatchObject({ protocol: 1, app: release.version });

    // It plays: the video advances and has a size, with Widevine from Google's component updater.
    await expect
      .poll(async () => {
        const d = await debug(app);
        return Boolean(d?.video && d.video.currentTime > 3 && d.video.width > 0 && !d.video.paused);
      }, { timeout: 150_000, intervals: [1000] })
      .toBe(true);
    const state = (await debug(app))!;
    expect(state.url).toBe(`${netflix()}/watch`);
    expect(state.cdm).toBe('ready');
    writeFileSync(join(capturesDir, 'player-window.png'), Buffer.from((await playerTest(app, { do: 'capture' })) as string, 'base64'));
    await shell.screenshot({ path: join(capturesDir, 'player-tab.png') });

    // Away from the tab, the Now playing card has the player, as a tab would be, with Back to the player.
    await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}/` });
    const nowPlaying = shell.getByRole('group', { name: 'Now playing' });
    await expect(nowPlaying).toContainText('Angel One', { timeout: 20_000 });
    await expect(nowPlaying).toContainText('Shaka Player test streams');
    await nowPlaying.screenshot({ path: join(capturesDir, 'player-now-playing.png') });

    await nowPlaying.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(async () => (await debug(app))?.video?.paused).toBe(true);
    await expect(nowPlaying.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await nowPlaying.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(async () => (await debug(app))?.video?.paused).toBe(false);
    await nowPlaying.getByRole('button', { name: 'Mute Chord Player' }).click();
    await expect.poll(async () => (await debug(app))?.muted).toBe(true);
    await nowPlaying.getByRole('button', { name: 'Unmute Chord Player' }).click();
    await expect.poll(async () => (await debug(app))?.muted).toBe(false);

    const focusBefore = (await debug(app))!.focusRequests;
    await nowPlaying.getByRole('button', { name: /Back to the player/ }).click();
    await expect.poll(async () => (await debug(app))?.focusRequests).toBeGreaterThan(focusBefore);

    // A link the page follows to anywhere else opens in Chord, and the player stays on its page.
    const today = shell.getByRole('tree', { name: 'Today' });
    await playerTest(app, { do: 'navigate-page', url: `${site.origin}/elsewhere` });
    await expect(today.getByRole('treeitem', { name: 'Elsewhere' })).toHaveCount(1, { timeout: 20_000 });
    expect((await debug(app))!.url).toBe(`${netflix()}/watch`);

    // The bar's Back to Chord brings the tab it plays for forward.
    const netflixTab = await shell.evaluate(async () => {
      const { state } = await (window as unknown as { chord: { state: { snapshot(): Promise<{ state: { nodes: Record<string, { kind: string; url?: string; id: string }> } }> } } }).chord.state.snapshot();
      return Object.values(state.nodes).find((n) => n.kind === 'tab' && n.url?.includes('/watch'))!.id;
    });
    await playerTest(app, { do: 'back' });
    await expect.poll(async () => (await where(shell)).tabId).toBe(netflixTab);
    await expect(playing).toBeVisible();

    // Closing the player's window: the tab shows its page again, and the notice now opens the player.
    await playerTest(app, { do: 'close-window' });
    await expect(playing).toHaveCount(0, { timeout: 20_000 });
    await expect(card.getByRole('button', { name: 'Open in Chord Player' })).toBeVisible({ timeout: 20_000 });
    await expect(nowPlaying).toHaveCount(0);

    // Settings → General → Chord Player: Remove (asked twice) takes it, and its sign-ins, away.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'General' }).click();
    const remove = settings.getByRole('button', { name: 'Remove', exact: true });
    await expect(settings.getByText(`Chord Player ${release.version}`)).toBeVisible();
    await remove.click();
    await settings.getByRole('button', { name: 'Remove it and its sign-ins?' }).click();
    await expect.poll(() => existsSync(root)).toBe(false);
    await expect(settings.getByText('It installs from the notice on their pages.')).toBeVisible();
    await expect(card.getByRole('button', { name: /Install Chord Player/ })).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test('a corrupted download is refused; private windows and Google-free mode don’t offer Chord Player', async () => {
  test.setTimeout(3 * 60_000);
  site.corrupt = true;
  const { app, root } = await launchChord();
  try {
    const shell = await pageWhere(app, isShell);
    const popover = await pageWhere(app, isPopover);
    const { windowId } = await where(shell);
    await dispatch(shell, { t: 'tab.open', windowId, url: `${netflix()}/watch` });
    const card = notice(popover);
    await card.getByRole('button', { name: /Install Chord Player/ }).click();
    await expect(card.getByRole('alert')).toHaveText('The download didn’t match its signature, so Chord didn’t install it.', { timeout: 60_000 });
    await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(existsSync(join(root, release.version))).toBe(false);
    await card.screenshot({ path: join(capturesDir, 'player-notice-refused.png') });

    // A private window: the notice, without Chord Player (it has one profile, which keeps sign-ins).
    const shells = app.windows().filter((p) => isShell(p.url()));
    const popovers = app.windows().filter((p) => isPopover(p.url()));
    await runAction(shell, 'window.newPrivate');
    const privateShell = await newPage(app, isShell, shells);
    const privatePopover = await newPage(app, isPopover, popovers);
    const { windowId: privateId } = await where(privateShell);
    await dispatch(privateShell, { t: 'tab.open', windowId: privateId, url: `${netflix()}/watch` });
    const privateCard = notice(privatePopover);
    await expect(privateCard).toBeVisible({ timeout: 20_000 });
    await expect(privateCard).toContainText('which Chord doesn’t include yet');
    await expect(privateCard.getByRole('button', { name: /Chord Player/ })).toHaveCount(0);

    // Google-free mode: Widevine's CDM comes from Google, so the notice offers no player in any window.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    await settings.getByRole('switch', { name: 'Google-free mode' }).click();
    await expect(settings.getByText('Not offered, and closed if it’s open')).toBeVisible();
    await expect(card).toContainText('which Chord doesn’t include yet');
    await expect(card.getByRole('button', { name: /Chord Player|Try again/ })).toHaveCount(0);
  } finally {
    site.corrupt = false;
    await app.close();
  }
});
