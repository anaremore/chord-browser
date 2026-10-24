/**
 * Import from other browsers (ARCHITECTURE.md §9, DESIGN.md §8.7): first run's
 * step and Settings → Import. Detection is pointed at synthetic profiles
 * (test/fixtures/browsers.ts) through CHORD_IMPORT_ROOT, a development-only
 * variable; no test ever reads a real browser's files.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { makeBrowserFixtures } from '../fixtures/browsers';
import { audit, expectClean, isOverlay, isSettings, isShell, launch, newPage, pageWhere, runAction, startSite, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

interface Node {
  id: string;
  kind: 'tab' | 'folder' | 'split';
  chordId: string;
  section: 'pinned' | 'today';
  parentId: string | null;
  rank: string;
  title?: string;
  url?: string;
  collapsed?: boolean;
}
interface Snapshot {
  windowId: string;
  state: {
    chords: Record<string, { id: string; name: string; rank: string; private?: boolean }>;
    nodes: Record<string, Node>;
    favorites: Record<string, { url: string }>;
    windows: Record<string, { activeChordId: string }>;
  };
}
interface ChordWindow {
  chord: { state: { snapshot(): Promise<Snapshot> }; history: { search(q: string): Promise<{ history: { url: string; visitCount: number }[] }> } };
}

const snapshot = (shell: Page) => shell.evaluate(() => (window as unknown as ChordWindow).chord.state.snapshot());
const historyFor = (overlay: Page, query: string) => overlay.evaluate((q) => (window as unknown as ChordWindow).chord.history.search(q), query);
const chordNamed = (s: Snapshot, name: string) => Object.values(s.state.chords).find((c) => c.name === name);
/** A chord's or folder's children, by title, in order. */
const inside = (s: Snapshot, chordId: string, section: 'pinned' | 'today', parentId: string | null) =>
  Object.values(s.state.nodes)
    .filter((n) => n.chordId === chordId && n.section === section && n.parentId === parentId)
    .sort((a, b) => (a.rank < b.rank ? -1 : 1))
    .map((n) => (n.kind === 'folder' ? `[${n.title}]` : n.title));
const folderIn = (s: Snapshot, chordId: string, title: string) => Object.values(s.state.nodes).find((n) => n.kind === 'folder' && n.chordId === chordId && n.title === title);

let site: Site;
let browsers: string;
test.beforeAll(async () => {
  site = await startSite({ '/': '<title>Home page</title><p>Home</p>' });
  browsers = mkdtempSync(join(tmpdir(), 'chord-e2e-browsers-'));
  makeBrowserFixtures(browsers);
});
test.afterAll(() => site.server.close());

test('first run: bring Chrome’s bookmarks, a folder as a chord, the bar as Favorites, and its history', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_IMPORT_ROOT: browsers, CHORD_APPEARANCE: 'light' }, { firstRun: true });
  try {
    const shell = await pageWhere(app, isShell);
    const welcome = shell.getByRole('dialog', { name: 'Welcome to Chord' });
    await welcome.getByRole('button', { name: /Make your first chord/ }).click();
    await welcome.getByRole('button', { name: /Home/ }).click();
    await welcome.getByRole('button', { name: /^Next/ }).click();
    await welcome.getByRole('button', { name: /Looks good/ }).click();

    // The step reads the first browser it found at once; the others are a click away.
    await expect(welcome.getByRole('heading', { name: 'Bring your bookmarks?' })).toBeVisible();
    const from = welcome.getByRole('radiogroup', { name: 'Import from' });
    await expect(from.getByRole('radio', { name: 'Chrome · Alex' })).toHaveAttribute('aria-checked', 'true');
    await expect(from.getByRole('radio', { name: 'Chrome · Work' })).toBeVisible();
    await expect(from.getByRole('radio', { name: 'Firefox' })).toBeVisible();
    await expect(welcome.getByText('5 bookmarks in 3 folders · 2 pages of history')).toBeVisible();
    await expect(welcome.getByText('Open tabs stay in Chrome: Chord can’t read them reliably.')).toBeVisible();
    const where = welcome.getByRole('list', { name: 'Where they go' });
    await expect(where.getByRole('combobox', { name: 'Where Bookmarks bar goes' })).toHaveValue('favorites');
    await expect(where.getByRole('combobox', { name: 'Where Recipes goes' })).toHaveValue('new');
    // Work goes into the chord being made, as a pinned folder.
    const first = await snapshot(shell);
    const home = first.state.windows[first.windowId]!.activeChordId;
    await where.getByRole('combobox', { name: 'Where Work goes' }).selectOption(`chord:${home}`);
    expectClean(await audit(shell, 'first run: import', { include: '[role="dialog"]', appearance: 'light' }));

    await welcome.getByRole('button', { name: /^Import/ }).click();
    await expect(welcome.getByText('Imported 5 bookmarks and 2 pages of history.')).toBeVisible();
    await expect(shell.getByRole('group', { name: 'Imported 5 bookmarks and 2 pages of history from Chrome' }).getByRole('button', { name: 'Undo' })).toBeVisible();

    const s = await snapshot(shell);
    const recipes = chordNamed(s, 'Recipes')!;
    expect(Object.values(s.state.chords).filter((c) => !c.private).map((c) => c.name)).toEqual(['Home', 'Recipes']);
    expect(inside(s, recipes.id, 'pinned', null)).toEqual(['Apple pie', '[Soups]']);
    expect(inside(s, recipes.id, 'pinned', folderIn(s, recipes.id, 'Soups')!.id)).toEqual(['Tomato soup']);
    expect(inside(s, home, 'pinned', null)).toEqual(['[Work]', '[Other bookmarks]']);
    expect(folderIn(s, home, 'Work')!.collapsed).toBe(true);
    expect(Object.values(s.state.favorites).map((f) => f.url)).toEqual(['https://chord.test/']);
    await expect(shell.getByRole('tablist', { name: 'Chords' }).getByRole('tab', { name: 'Recipes' })).toBeVisible();

    // History, ranked like Chord's own: two visits, one typed.
    const overlay = await pageWhere(app, isOverlay);
    await expect.poll(async () => (await historyFor(overlay, 'apple pie')).history.map((h) => [h.url, h.visitCount])).toEqual([['https://recipes.test/pie', 2]]);

    // Next goes on with first run.
    await welcome.getByRole('button', { name: /^Next/ }).click();
    await expect(welcome.getByRole('heading', { name: 'What do you open every day?' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Settings: Firefox’s folders, open tabs and history land in the window behind, never a private one, and Undo takes them all back', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_IMPORT_ROOT: browsers, CHORD_APPEARANCE: 'dark' });
  try {
    const shell = await pageWhere(app, isShell);
    const before = await snapshot(shell);
    const personal = chordNamed(before, 'Personal')!.id;
    // A private window open meanwhile is left alone.
    await runAction(shell, 'window.newPrivate');
    await newPage(app, isShell, [shell]);
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Import' }).click();
    await settings.getByRole('radiogroup', { name: 'Import from' }).getByRole('radio', { name: 'Firefox' }).click();
    await expect(settings.getByText('4 bookmarks in 2 folders · 2 pages of history · 2 open tabs')).toBeVisible();
    const where = settings.getByRole('list', { name: 'Where they go' });
    await expect(where.getByRole('combobox', { name: 'Where Reading goes' })).toHaveValue('new');
    await expect(where.getByRole('combobox', { name: 'Where open tabs go' })).toHaveValue(`chord:${personal}`);
    await where.getByRole('combobox', { name: 'Where Mozilla Firefox goes' }).selectOption('skip');
    expectClean(await audit(settings, 'Settings → Import', { appearance: 'dark' }));

    await settings.getByRole('main').getByRole('button', { name: 'Import', exact: true }).click();
    await expect(settings.getByText('Imported 2 tabs, 3 bookmarks and 2 pages of history.')).toBeVisible();
    await expect(shell.getByRole('group', { name: 'Imported 2 tabs, 3 bookmarks and 2 pages of history from Firefox' })).toBeVisible();

    const s = await snapshot(shell);
    const reading = chordNamed(s, 'Reading')!;
    expect(inside(s, reading.id, 'pinned', null)).toEqual(['Long read']);
    // Open tabs at the top of Today, not loaded until opened; the private window's chord got nothing.
    expect(inside(s, personal, 'today', null).slice(0, 2)).toEqual(['Two', 'Three']);
    expect(inside(s, personal, 'pinned', null)).toEqual(['[Other Bookmarks]']);
    expect(Object.values(s.state.favorites).map((f) => f.url)).toEqual(['https://news.test/ff']);
    const privateChord = Object.values(s.state.chords).find((c) => c.private)!;
    expect(Object.values(s.state.nodes).filter((n) => n.chordId === privateChord.id).map((n) => n.url)).not.toContain('https://open.test/two');
    const overlay = await pageWhere(app, isOverlay);
    await expect.poll(async () => (await historyFor(overlay, 'firefox news')).history.length).toBe(1);

    // Undo, from Settings: chords, folders, tabs, favorites and history all go.
    await settings.getByRole('button', { name: 'Undo' }).click();
    await expect(settings.getByText('Import undone.')).toBeVisible();
    const after = await snapshot(shell);
    expect(Object.values(after.state.chords).filter((c) => !c.private).map((c) => c.name)).toEqual(['Personal']);
    expect(Object.keys(after.state.favorites)).toEqual([]);
    const ids = (snap: Snapshot) => Object.values(snap.state.nodes).filter((n) => n.chordId === personal).map((n) => n.id);
    expect(ids(after)).toEqual(ids(before));
    expect((await historyFor(overlay, 'firefox news')).history).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a big import comes in parts while history streams, and the toast’s Undo takes it back', async () => {
  const big = mkdtempSync(join(tmpdir(), 'chord-e2e-browsers-'));
  makeBrowserFixtures(big, undefined, { extraBookmarks: 3000, extraPages: 6000 });
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_IMPORT_ROOT: big });
  try {
    const shell = await pageWhere(app, isShell);
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Import' }).click();
    await settings.getByRole('radiogroup', { name: 'Import from' }).getByRole('radio', { name: 'Chrome · Alex' }).click();
    await expect(settings.getByText('3,005 bookmarks in 4 folders · 6,002 pages of history')).toBeVisible();
    await settings.getByRole('main').getByRole('button', { name: 'Import', exact: true }).click();
    // History goes a batch at a time, and says how far it's got.
    await expect(settings.getByRole('progressbar', { name: 'Import' })).toBeVisible();
    await expect(settings.getByText('Imported 3,005 bookmarks and 6,002 pages of history.')).toBeVisible({ timeout: 60_000 });
    const s = await snapshot(shell);
    const bigChord = chordNamed(s, 'Big')!;
    expect(inside(s, bigChord.id, 'pinned', null)).toHaveLength(3000);

    await shell.getByRole('group', { name: 'Imported 3,005 bookmarks and 6,002 pages of history from Chrome' }).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => chordNamed(await snapshot(shell), 'Big')).toBeUndefined();
    const overlay = await pageWhere(app, isOverlay);
    await expect.poll(async () => (await historyFor(overlay, 'many')).history.length).toBe(0);
  } finally {
    await app.close();
  }
});
