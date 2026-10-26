/**
 * Sync's journey (docs/decisions/S15-your-data.md §9 step 3; DESIGN.md §8.8):
 * two Chords with profiles of their own share one temp folder, as two
 * computers share a Dropbox. Sync is set up on one and joined from the
 * other; each changes something and the other has it; then a third tries a
 * wrong passphrase, and the first removes the second, which stops syncing and
 * keeps what it has. The system's folder picker is answered in main, so no
 * window but Chord's opens.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { dispatch, isSettings, isShell, launch, pageWhere, runAction, startSite, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

let site: Site;
test.beforeAll(async () => {
  site = await startSite({ '/': '<title>Home page</title><p>Home</p>', '/mail': '<title>Mail</title><p>Mail</p>', '/news': '<title>News</title><p>News</p>' });
});
test.afterAll(() => site.server.close());

const PASSPHRASE = 'harbor lantern quietly orbit maple';

interface Snapshot {
  windowId: string;
  state: {
    windows: Record<string, { activeChordId: string }>;
    chords: Record<string, { id: string; name: string; rank: string }>;
    nodes: Record<string, { id: string; kind: string; section: string; chordId: string; title?: string; pinnedUrl?: string | null; url?: string }>;
    favorites: Record<string, { url: string }>;
    settings: { searchEngine: string };
  };
}
const snapshot = (shell: Page) => shell.evaluate(() => (window as unknown as { chord: { state: { snapshot(): Promise<Snapshot> } } }).chord.state.snapshot());

/** What sync carries, as one computer has it: chord names, pinned tabs' homes, Favorites, the search engine. */
async function synced(shell: Page) {
  const { state } = await snapshot(shell);
  return {
    chords: Object.values(state.chords)
      .map((c) => c.name)
      .sort(),
    pinned: Object.values(state.nodes)
      .filter((n) => n.kind === 'tab' && n.section === 'pinned')
      .map((n) => n.pinnedUrl)
      .sort(),
    favorites: Object.values(state.favorites)
      .map((f) => f.url)
      .sort(),
    searchEngine: state.settings.searchEngine,
  };
}

const hooks = (app: ElectronApplication, name: 'syncWrite' | 'syncRead') => app.evaluate((_electron, hook) => (globalThis as unknown as { chordTestHooks: Record<string, () => Promise<unknown>> }).chordTestHooks[hook]!(), name);
/** One computer writes what's waiting, the other looks: as the 3 s write and the folder's watch would, without waiting for either. */
async function carry(from: ElectronApplication, to: ElectronApplication): Promise<void> {
  await hooks(from, 'syncWrite');
  await hooks(to, 'syncRead');
}

async function openSync(app: ElectronApplication, shell: Page, folder: string): Promise<Page> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, folder);
  await runAction(shell, 'app.settings');
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Your data' }).click();
  return settings;
}

async function chordApp(profile: string): Promise<{ app: ElectronApplication; shell: Page }> {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_E2E_HOOKS: '1' }, { profile });
  const shell = await pageWhere(app, isShell);
  await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Home page');
  return { app, shell };
}

test('two Chords sync through one folder: set up, join, edit on both, a wrong passphrase, and one removed', async () => {
  test.setTimeout(240_000);
  const folder = mkdtempSync(join(tmpdir(), 'chord-e2e-sync-folder-'));
  const desk = await chordApp(mkdtempSync(join(tmpdir(), 'chord-e2e-desk-')));
  const laptop = await chordApp(mkdtempSync(join(tmpdir(), 'chord-e2e-laptop-')));
  try {
    // The desk: some setup of its own first. A pinned tab, a Favorite, a search engine.
    const deskState = await snapshot(desk.shell);
    const deskChord = deskState.state.windows[deskState.windowId]!.activeChordId;
    await dispatch(desk.shell, { t: 'chord.update', chordId: deskChord, name: 'Work' });
    await dispatch(desk.shell, { t: 'tab.open', windowId: deskState.windowId, url: `${site.origin}/mail` });
    await expect(desk.shell.getByRole('tree', { name: 'Today' })).toContainText('Mail');
    const mail = Object.values((await snapshot(desk.shell)).state.nodes).find((n) => n.kind === 'tab' && n.url?.endsWith('/mail'))!.id;
    await dispatch(desk.shell, { t: 'tab.pin', nodeId: mail });

    // Set up on the desk: a new folder, a passphrase, Start syncing.
    const deskSettings = await openSync(desk.app, desk.shell, folder);
    await deskSettings.getByRole('button', { name: 'Turn on sync…' }).click();
    await expect(deskSettings.getByText(/Choose a passphrase\./)).toBeVisible();
    const fields = deskSettings.getByRole('group', { name: 'Turn on sync' });
    await fields.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await fields.getByLabel('Again').fill(PASSPHRASE);
    await fields.getByRole('button', { name: 'Start syncing' }).click();
    await expect(deskSettings.getByText(/^On · .* › Chord sync · /)).toBeVisible({ timeout: 30_000 });
    // What's in the folder: one generation's file, and this computer's log; nothing readable.
    expect(readdirSync(join(folder, 'Chord sync')).sort()).toEqual(['1', 'sync-1.json']);

    // Join from the laptop: a clearly fresh Chord, so the synced setup replaces its first-run chord without asking.
    const laptopSettings = await openSync(laptop.app, laptop.shell, folder);
    await laptopSettings.getByRole('button', { name: 'Turn on sync…' }).click();
    await expect(laptopSettings.getByText(/syncs 1 computer already\. Enter your passphrase\./)).toBeVisible();
    await laptopSettings.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await laptopSettings.getByRole('button', { name: 'Join' }).click();
    await expect(laptopSettings.getByText(/^On · .* › Chord sync · /)).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await synced(laptop.shell)).chords, { timeout: 15_000 }).toEqual(['Work']);
    await expect.poll(async () => (await synced(laptop.shell)).pinned).toEqual([`${site.origin}/mail`]);
    // Both computers are listed on each.
    await expect(laptopSettings.getByRole('list', { name: 'Computers that sync' }).getByRole('listitem')).toHaveCount(2);

    // Edit on both. The laptop adds a Favorite and changes the search engine; the desk renames its chord and pins another tab.
    const laptopState = await snapshot(laptop.shell);
    const laptopMail = Object.values(laptopState.state.nodes).find((n) => n.kind === 'tab' && n.pinnedUrl?.endsWith('/mail'))!.id;
    await dispatch(laptop.shell, { t: 'favorite.add', favoriteId: crypto.randomUUID(), nodeId: laptopMail });
    // A setting, through Settings' own channel, as a person changes it.
    await laptopSettings.evaluate(() => (window as unknown as { chord: { settings: { set(patch: unknown): Promise<void> } } }).chord.settings.set({ searchEngine: 'duckduckgo' }));
    await dispatch(desk.shell, { t: 'chord.update', chordId: deskChord, name: 'Studio' });
    await dispatch(desk.shell, { t: 'tab.open', windowId: deskState.windowId, url: `${site.origin}/news` });
    await expect(desk.shell.getByRole('tree', { name: 'Today' })).toContainText('News');
    const news = Object.values((await snapshot(desk.shell)).state.nodes).find((n) => n.kind === 'tab' && n.url?.endsWith('/news'))!.id;
    await dispatch(desk.shell, { t: 'tab.pin', nodeId: news });
    await carry(laptop.app, desk.app);
    await carry(desk.app, laptop.app);
    const expected = { chords: ['Studio'], pinned: [`${site.origin}/mail`, `${site.origin}/news`].sort(), favorites: [`${site.origin}/mail`], searchEngine: 'duckduckgo' };
    await expect.poll(() => synced(desk.shell), { timeout: 20_000 }).toEqual(expected);
    await expect.poll(() => synced(laptop.shell), { timeout: 20_000 }).toEqual(expected);

    // A third Chord with the wrong passphrase: the folder's key check says so, and nothing comes in.
    const third = await chordApp(mkdtempSync(join(tmpdir(), 'chord-e2e-third-')));
    try {
      const thirdSettings = await openSync(third.app, third.shell, folder);
      await thirdSettings.getByRole('button', { name: 'Turn on sync…' }).click();
      await thirdSettings.getByLabel('Passphrase', { exact: true }).fill('not the passphrase at all');
      await thirdSettings.getByRole('button', { name: 'Join' }).click();
      await expect(thirdSettings.getByText('That passphrase doesn’t open this folder.')).toBeVisible({ timeout: 20_000 });
      expect((await synced(third.shell)).chords).not.toContain('Studio');
    } finally {
      await third.app.close();
    }

    // The desk removes the laptop. It happens when Undo runs out; the laptop then stops, and keeps what it has.
    await deskSettings.getByRole('button', { name: /^Remove / }).click();
    await expect(deskSettings.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(deskSettings.getByRole('button', { name: 'Undo' })).toBeHidden({ timeout: 15_000 });
    await carry(desk.app, laptop.app);
    await laptopSettings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Your data' }).click();
    await expect(laptopSettings.getByText(/This computer was removed from sync/)).toBeVisible({ timeout: 20_000 });
    expect((await synced(laptop.shell)).chords).toEqual(['Studio']);
    await expect(deskSettings.getByRole('list', { name: 'Computers that sync' }).getByRole('listitem')).toHaveCount(1);
  } finally {
    await desk.app.close();
    await laptop.app.close();
  }
});

