/**
 * Your data's export and import (docs/decisions/S15-your-data.md §8–§9; DESIGN.md §8.8):
 * a profile seeded with a bit of everything, and with everything an export
 * must leave out, exports from Settings → Your data, plain and then
 * encrypted. The plain file's lines parse and hold what was seeded and
 * nothing else; the encrypted one opens with its passphrase only. Then the
 * files come back: into a new profile, everything as it was, and one Undo
 * takes it all back; into a profile with data, settings off until you turn
 * them on. The system's save and open dialogs are answered in main, so no
 * window but Chord's opens.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { effectsHost, placeKey, readDataFile, type DataRecord } from '@chord/core';
import { nodeCrypto } from '@chord/data/crypto';
import { audit, capturesDir, dispatch, expectClean, isOverlay, isSettings, isShell, launch, newPage, pageWhere, runAction, startSite, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

let site: Site;
test.beforeAll(async () => {
  site = await startSite({ '/': '<title>Home page</title><p>Home</p>', '/styled': '<title>Styled</title><p>Styled by its Effects</p>' });
});
test.afterAll(() => site.server.close());

const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const IMAGE_ID = 'abcdefabcdefabcdefabcdef';
const NOW = Date.now();

/**
 * What a few weeks of use leave, written straight into chord.db while Chord is closed: a chord with its own sign-ins
 * and proxy, a folder with a tab and its icon, a Favorite, a theme, settings, a route, Effects, zoom, permissions,
 * history and a Duet chat with an image. And what an export must never hold: an open tab's back/forward history
 * (with a form's contents), the archive, a download, the interface size, a chat's provider session, Codex's own copy.
 */
function seed(profile: string, personal: string): void {
  const db = new DatabaseSync(join(profile, 'chord.db'));
  const run = (sql: string, ...values: (string | number | null | Uint8Array)[]) => db.prepare(sql).run(...values);
  const theme = JSON.stringify({ stops: [{ l: 0.7, c: 0.12, h: 200 }], grain: 0.2, appearance: 'auto' });
  const proxy = JSON.stringify({ mode: 'server', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080, bypass: [] }, pac: null });
  db.exec('BEGIN');
  run(`INSERT INTO profile (id, name, partition, is_default, created_at) VALUES ('work-signins', 'Work', 'persist:p-work-signins', 0, 1)`);
  run(`INSERT INTO chord (id, profile_id, name, icon, theme, rank, proxy, created_at, updated_at) VALUES ('work', 'work-signins', 'Work', 'W', ?, 'zz', ?, 1, 1700000000000)`, theme, proxy);
  run(`INSERT INTO favicon (key, data, mime, fetched_at) VALUES ('icon-key', ?, 'image/png', 1)`, ICON);
  run(`INSERT INTO node (id, chord_id, parent_id, section, kind, rank, created_at, updated_at) VALUES ('folder', 'work', NULL, 'pinned', 'folder', 'a0', 1, 1700000000001)`);
  run(`INSERT INTO folder (node_id, title, collapsed) VALUES ('folder', 'Reading', 0)`);
  run(`INSERT INTO node (id, chord_id, parent_id, section, kind, rank, created_at, updated_at) VALUES ('mail', 'work', 'folder', 'pinned', 'tab', 'a0', 1, 1700000000002)`);
  run(
    `INSERT INTO tab (node_id, pinned_url, custom_title, url, title, favicon_key, nav_state, last_active_at, muted) VALUES ('mail', 'https://mail.test/', 'Mail', 'https://mail.test/inbox', 'Inbox', 'icon-key', ?, 1, 1)`,
    Buffer.from(JSON.stringify({ entries: [{ url: 'https://mail.test/', title: 'Mail', pageState: 'FORM-SECRET' }], index: 0 })),
  );
  run(`INSERT INTO favorite (id, url, title, favicon_key, rank, created_at, updated_at) VALUES ('fav', 'https://calendar.test/', 'Calendar', 'icon-key', 'a0', 1, 1700000000003)`);
  const set = (key: string, value: unknown) =>
    run(`INSERT INTO setting (key, value, updated_at) VALUES (?, ?, 1700000000004) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, key, JSON.stringify(value));
  set('themes', [{ id: 'theme-1', name: 'Late Night', stops: [{ l: 0.5, c: 0.2, h: 280 }], grain: 0.3 }]);
  set('searchEngine', 'duckduckgo');
  set('uiScale', 1.25);
  set('proxy', { mode: 'none', server: { scheme: 'http', host: 'proxy.corp.test', port: 3128, bypass: ['<local>'] }, pac: null });
  run(`INSERT INTO link_route (host, chord_id, created_at, updated_at) VALUES ('github.com', 'work', 1, 1700000000005)`);
  run(`INSERT INTO site_zoom (profile_id, host, factor, updated_at) VALUES ('default', 'docs.test', 1.25, 1700000000006)`);
  run(`INSERT INTO site_permission (profile_id, origin, permission, decision, updated_at) VALUES ('default', 'https://meet.test', 'camera', 'allow', 1700000000007)`);
  run(`INSERT INTO site_permission (profile_id, origin, permission, decision, updated_at) VALUES ('default', 'https://meet.test', 'notifications', 'block', 1700000000007)`);
  run(
    `INSERT INTO effect (host, wet, css, css_on, hidden, presets, duet, compiled, sanitizer, created_at, updated_at) VALUES ('news.test', 1, 'h1 { color: red }', 0, ?, '["dark"]', '[]', '', 0, 1, 1700000000008)`,
    JSON.stringify([{ selector: '#ad', label: 'Ad', on: true, at: 1 }]),
  );
  for (const [url, title, visits] of [
    ['https://news.test/a', 'A story', [NOW - 3000, NOW - 1000]],
    ['https://news.test/b', 'B story', [NOW - 2000]],
  ] as const) {
    const row = run(
      `INSERT INTO history_url (profile_id, place, url, title, visit_count, typed_count, last_visit_at, decay_day) VALUES ('default', ?, ?, ?, ?, 0, ?, 1)`,
      placeKey(url)!,
      url,
      title,
      visits.length,
      Math.max(...visits),
    );
    for (const at of visits) run(`INSERT INTO history_visit (url_id, visited_at, transition) VALUES (?, ?, 'link')`, Number(row.lastInsertRowid), at);
  }
  run(`INSERT INTO archive_item (id, profile_id, chord_id, url, title, reason, archived_at) VALUES ('arch', 'default', ?, 'https://archived.test/', 'Archived', 'closed', ?)`, personal, NOW);
  run(
    `INSERT INTO download (id, profile_id, url, path, filename, mime, state, received, total, started_at, ended_at) VALUES ('dl', 'default', 'https://download.test/file.zip', '/tmp/file.zip', 'file.zip', 'application/zip', 'completed', 1, 1, 1, 2)`,
  );
  run(
    `INSERT INTO duet_thread (id, chord_id, title, provider, model, provider_session_id, scope, created_at, updated_at, last_used_at) VALUES ('th', 'work', 'Trip', 'codex', NULL, 'SESSION-SECRET', 'ask', 5000, 5000, 5000)`,
  );
  const message = (id: string, role: string, text: string, body: unknown, at: number) =>
    run(`INSERT INTO duet_message (id, thread_id, role, text, body, created_at) VALUES (?, 'th', ?, ?, ?, ?)`, id, role, text, JSON.stringify(body), at);
  message('m1', 'user', 'Draw a lighthouse', { role: 'user', text: 'Draw a lighthouse', attachments: [], images: [{ id: IMAGE_ID, mime: 'image/png', width: 1, height: 1, codexCopy: '/home/me/.codex/generated_images/x.png' }] }, 5001);
  message('m2', 'assistant', 'Here', { role: 'assistant', text: 'Here [1]', citations: [{ n: 1, ref: 't1', url: 'https://maps.test/', title: 'Maps', quote: 'q', tabId: 'node-7' }], status: 'done' }, 5002);
  db.exec('COMMIT');
  db.close();
  mkdirSync(join(profile, 'duet', 'images'), { recursive: true });
  writeFileSync(join(profile, 'duet', 'images', `${IMAGE_ID}.png`), ICON);
  writeFileSync(join(profile, 'duet', 'images', `${IMAGE_ID}.thumb.jpg`), Buffer.from('a thumbnail'));
}

/** The system's save dialog, answered in main with `path`; the options it was asked with are kept. */
const answerSaveDialog = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, target) => {
    const asked = ((globalThis as { chordSaveDialogs?: { defaultPath?: string }[] }).chordSaveDialogs ??= []);
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      asked.push(args.at(-1) as { defaultPath?: string });
      return { canceled: false, filePath: target };
    }) as typeof dialog.showSaveDialog;
  }, path);
const lastSaveDialog = (app: ElectronApplication) => app.evaluate(() => (globalThis as { chordSaveDialogs?: { defaultPath?: string }[] }).chordSaveDialogs?.at(-1)?.defaultPath ?? '');

const records = (text: string): DataRecord[] =>
  text
    .split('\n')
    .slice(1, -2)
    .map((line) => JSON.parse(line) as DataRecord);
const ofType = (rs: DataRecord[], type: string) => rs.filter((r) => r.type === type);

async function openExport(app: ElectronApplication, shell: Page): Promise<Page> {
  await runAction(shell, 'app.settings');
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Your data' }).click();
  await settings.getByRole('button', { name: 'Export…' }).click();
  return settings;
}

test('a seeded profile exports plain and encrypted: everything it should hold, nothing it shouldn’t, and the passphrase opens only its own file', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const out = mkdtempSync(join(tmpdir(), 'chord-e2e-export-'));
  // First launch: Chord makes its database and a first chord, then quits.
  let app = await launch({ CHORD_HOME_URL: `${site.origin}/` }, { profile });
  let shell = await pageWhere(app, isShell);
  await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Home page');
  const personal = await shell.evaluate(async () => {
    const { state, windowId } = await (window as unknown as { chord: { state: { snapshot(): Promise<{ windowId: string; state: { windows: Record<string, { activeChordId: string }> } }> } } }).chord.state.snapshot();
    return state.windows[windowId]!.activeChordId;
  });
  await app.close();
  seed(profile, personal);

  app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: 'dark' }, { profile });
  try {
    shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Home page');
    // A private window is open while Chord exports: nothing of it is ever saved, so nothing of it goes in.
    await runAction(shell, 'window.newPrivate');
    await newPage(app, isShell, [shell]);
    const settings = await openExport(app, shell);

    // What goes in, counted before anything's written.
    const card = settings.getByRole('group', { name: 'Export your data' });
    await expect(card.getByText('2 chords · 1 pinned tab in 1 folder · 1 Today tab · 1 Favorite · 1 theme · 1 link route · Effects for 1 site · your settings.')).toBeVisible();
    // The seeded pages, and the home page each launch visited.
    await expect(card.getByText('3 pages', { exact: true })).toBeVisible();
    await expect(card.getByText('1 chat, 1 image')).toBeVisible();
    await expect(card.getByRole('switch', { name: 'Include history' })).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByRole('switch', { name: 'Encrypt with a passphrase' })).toHaveAttribute('aria-checked', 'false');
    await expect(card.getByText('Anyone with the file can read it.')).toBeVisible();
    expectClean(await audit(settings, 'Settings → Your data → Export', { appearance: 'dark' }));

    // Plain: the system's save dialog offers today's name, and the file is written by a process of its own.
    const plainPath = join(out, 'backup.jsonl');
    await answerSaveDialog(app, plainPath);
    await card.getByRole('button', { name: 'Choose where to save…' }).click();
    await expect(card.getByText(/^Saved backup\.jsonl, [\d.]+ KB$/)).toBeVisible({ timeout: 30_000 });
    expect(basename(await lastSaveDialog(app))).toMatch(/^Chord data \d{4}-\d{2}-\d{2}\.jsonl$/);
    await card.getByRole('button', { name: 'Show in folder' }).scrollIntoViewIfNeeded();
    await settings.screenshot({ path: resolve(capturesDir, 'settings-your-data-saved-dark.png') });

    // Show in folder selects the file in the system's file manager (answered in main here).
    await app.evaluate(({ shell: os }) => {
      const shown: string[] = ((globalThis as { chordShown?: string[] }).chordShown = []);
      os.showItemInFolder = (path: string) => void shown.push(path);
    });
    await card.getByRole('button', { name: 'Show in folder' }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { chordShown?: string[] }).chordShown)).toEqual([plainPath]);

    // The file: a header, a line per record, the end, each a line of JSON.
    const text = readFileSync(plainPath, 'utf8');
    const lines = text.split('\n');
    expect(lines.at(-1)).toBe('');
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(header).toMatchObject({ chord: 'data', format: 1, kind: 'export', includes: ['setup', 'today', 'history', 'duet'] });
    expect(header['device']).toMatch(/^[0-9a-f]{16}$/);
    const plain = records(text);
    expect(JSON.parse(lines.at(-2)!)).toEqual({ end: plain.length });

    // What was seeded.
    const work = ofType(plain, 'chord').find((r) => r.id === 'work')!;
    expect(work.set).toMatchObject({ name: 'Work', profile: 'work-signins', proxy: { mode: 'server', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080 } } });
    expect(work.at).toEqual([1700000000000, 0, header['device']]);
    expect(ofType(plain, 'folder').map((r) => r.set['title'])).toEqual(['Reading']);
    const mail = ofType(plain, 'tab').find((r) => r.id === 'mail')!;
    expect(mail.set).toMatchObject({ url: 'https://mail.test/inbox', pinnedUrl: 'https://mail.test/', customTitle: 'Mail', muted: true, pos: { chord: 'work', section: 'pinned', parent: 'folder' } });
    const icon = ofType(plain, 'icon')[0]!;
    expect(mail.set['icon']).toBe(icon.id);
    expect(Buffer.from(icon.set['data'] as string, 'base64')).toEqual(ICON);
    expect(ofType(plain, 'favorite').map((r) => [r.set['url'], r.set['icon']])).toEqual([['https://calendar.test/', icon.id]]);
    expect(ofType(plain, 'theme').map((r) => r.set['name'])).toEqual(['Late Night']);
    const settingsFields = Object.assign({}, ...ofType(plain, 'settings').map((r) => r.set)) as Record<string, unknown>;
    expect(settingsFields['searchEngine']).toBe('duckduckgo');
    expect(settingsFields['proxy']).toMatchObject({ mode: 'none', server: { host: 'proxy.corp.test' } });
    expect(ofType(plain, 'route').map((r) => [r.id, r.set['chord']])).toEqual([['github.com', 'work']]);
    expect(ofType(plain, 'effects')[0]).toMatchObject({ id: 'news.test', set: { cssOn: false, presets: ['dark'], hidden: [{ selector: '#ad', label: 'Ad', on: true }] } });
    expect(ofType(plain, 'zoom').map((r) => [r.id, r.set['factor']])).toEqual([['docs.test', 1.25]]);
    expect(ofType(plain, 'permission')[0]).toMatchObject({ id: 'https://meet.test', set: { camera: 'allow', notifications: 'block' } });
    const pages = new Map(ofType(plain, 'page').map((r) => [r.id, r.set['visits'] as number[]]));
    expect([...pages.keys()].sort()).toEqual([`${site.origin}/`, 'https://news.test/a', 'https://news.test/b']);
    expect(pages.get('https://news.test/a')).toEqual([NOW - 3000, NOW - 1000]);
    expect(pages.get('https://news.test/b')).toEqual([NOW - 2000]);
    expect(ofType(plain, 'thread').map((r) => r.set['title'])).toEqual(['Trip']);
    expect(ofType(plain, 'message').map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(Buffer.from(ofType(plain, 'image')[0]!.set['data'] as string, 'base64')).toEqual(ICON);
    // The Today tab Chord opened at first launch; the private window's never.
    expect(ofType(plain, 'tab').filter((r) => (r.set['pos'] as { section: string }).section === 'today').map((r) => r.set['url'])).toEqual([`${site.origin}/`]);

    // And nothing that mustn't be there.
    for (const never of ['FORM-SECRET', 'pageState', 'archived.test', 'download.test', 'SESSION-SECRET', 'generated_images', 'node-7', 'uiScale', 'Private', 'lastActiveAt']) {
      expect(text, never).not.toContain(never);
    }

    // Encrypted: the passphrase's rules first, then Suggest one.
    await card.getByRole('switch', { name: 'Encrypt with a passphrase' }).click();
    await expect(card.getByText('Chord can’t open the file without it, and can’t get it back for you.')).toBeVisible();
    const first = card.getByLabel('Passphrase', { exact: true });
    await first.fill('too short');
    await first.blur();
    await expect(card.getByText('At least 12 characters.')).toBeVisible();
    await card.getByRole('button', { name: 'Suggest one' }).click();
    const passphrase = await first.inputValue();
    expect(passphrase.split(' ')).toHaveLength(5);
    await expect(card.getByLabel('Again', { exact: true })).toHaveValue(passphrase);
    expectClean(await audit(settings, 'Settings → Your data → Export, encrypted', { appearance: 'dark' }));
    await card.getByRole('button', { name: 'Suggest one' }).scrollIntoViewIfNeeded();
    await settings.screenshot({ path: resolve(capturesDir, 'settings-your-data-encrypt-dark.png') });

    const sealedPath = join(out, 'backup.chorddata');
    await answerSaveDialog(app, sealedPath);
    await card.getByRole('button', { name: 'Choose where to save…' }).click();
    await expect(card.getByText(/^Saved backup\.chorddata, [\d.]+ KB$/)).toBeVisible({ timeout: 30_000 });
    expect(basename(await lastSaveDialog(app))).toMatch(/^Chord data \d{4}-\d{2}-\d{2}\.chorddata$/);
    // The passphrase isn't kept once the file is written.
    await expect(first).toHaveValue('');

    const sealed = readFileSync(sealedPath);
    expect(sealed.subarray(0, 18).toString('latin1')).toBe('chord-encrypted 1\n');
    expect(sealed.includes('mail.test')).toBe(false);
    const read = await readDataFile(sealed, passphrase, nodeCrypto);
    expect(read.problem).toBeNull();
    // The same records as the plain file, but for the setting that changed between them: Encrypt with a passphrase, remembered.
    const content = (rs: DataRecord[]) => rs.filter((r) => r.type !== 'settings').map(({ type, id, set }) => ({ type, id, set }));
    expect(content(read.records)).toEqual(content(plain));
    expect(Object.assign({}, ...ofType(read.records, 'settings').map((r) => r.set))).toMatchObject({ encryptExports: true });
    expect((await readDataFile(sealed, `${passphrase}!`, nodeCrypto)).problem).toBe('wrong-passphrase');
    expect((await readDataFile(sealed, null, nodeCrypto)).problem).toBe('needs-passphrase');
  } finally {
    await app.close();
  }
});

test('a folder Chord can’t write to says so, and offers to choose another', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const settings = await openExport(app, shell);
    const card = settings.getByRole('group', { name: 'Export your data' });
    await expect(card.getByText('1 chord · 1 Today tab · your settings.')).toBeVisible();
    await answerSaveDialog(app, join(mkdtempSync(join(tmpdir(), 'chord-e2e-export-')), 'no such folder', 'backup.jsonl'));
    await card.getByRole('button', { name: 'Choose where to save…' }).click();
    await expect(card.getByText('Chord couldn’t save there. Choose another place.')).toBeVisible({ timeout: 30_000 });
    const out = join(mkdtempSync(join(tmpdir(), 'chord-e2e-export-')), 'backup.jsonl');
    await answerSaveDialog(app, out);
    await card.getByRole('button', { name: 'Choose where to save…' }).click();
    await expect(card.getByText(/^Saved backup\.jsonl, /)).toBeVisible({ timeout: 30_000 });
    expect(readFileSync(out, 'utf8')).toMatch(/^\{"chord":"data"/);
  } finally {
    await app.close();
  }
});

/* ---------- Import (S15 §5, §8, §9 step 2) ---------- */

interface ImportSnapshot {
  windowId: string;
  state: {
    chords: Record<string, { id: string; name: string; profileId: string; proxy?: unknown; private?: boolean }>;
    nodes: Record<string, { id: string; kind: string; chordId: string; parentId: string | null; section: string; title?: string; customTitle?: string | null; url?: string }>;
    favorites: Record<string, { id: string; url: string; title: string }>;
    windows: Record<string, { activeChordId: string }>;
    live: Record<string, unknown>;
    settings: { searchEngine: string; themes: { name: string }[]; proxy: { mode: string } };
    sitePermissions: Record<string, Record<string, string>>;
    imports: Record<string, unknown>;
  };
}
interface ImportWindow {
  chord: {
    state: { snapshot(): Promise<ImportSnapshot> };
    history: { search(q: string): Promise<{ history: { url: string }[] }> };
    duet: { search(q: string): Promise<{ threadTitle: string }[]> };
  };
}
const stateOf = (shell: Page) => shell.evaluate(() => (window as unknown as ImportWindow).chord.state.snapshot());
const historyFor = (overlay: Page, query: string) => overlay.evaluate(async (q) => (await (window as unknown as ImportWindow).chord.history.search(q)).history.map((h) => h.url).sort(), query);
const chatsFor = (overlay: Page, query: string) => overlay.evaluate(async (q) => (await (window as unknown as ImportWindow).chord.duet.search(q)).map((h) => h.threadTitle), query);
const backgroundOf = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const STYLED = 'rgb(1, 2, 3)';

/** The system's open dialog, answered in main with `path`. */
const answerOpenDialog = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [target] })) as typeof dialog.showOpenDialog;
  }, path);

async function openYourData(app: ElectronApplication, shell: Page): Promise<Page> {
  await runAction(shell, 'app.settings');
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Your data' }).click();
  return settings;
}

/** What a chord.db says of a Duet chat: whether it came from a file, and its provider session. */
function chatRow(profile: string, id: string): { imported_at: number | null; provider_session_id: string | null } | undefined {
  const db = new DatabaseSync(join(profile, 'chord.db'), { readOnly: true });
  try {
    return db.prepare('SELECT imported_at, provider_session_id FROM duet_thread WHERE id = ?').get(id) as { imported_at: number | null; provider_session_id: string | null } | undefined;
  } finally {
    db.close();
  }
}

/**
 * The seeded profile (`seed`), with Effects for the test site, exported once,
 * plain and encrypted: the files the import journeys bring in.
 */
let exported: Promise<{ plain: string; sealed: string; passphrase: string }> | null = null;
const exportedProfile = () => (exported ??= exportSeeded());
async function exportSeeded(): Promise<{ plain: string; sealed: string; passphrase: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const out = mkdtempSync(join(tmpdir(), 'chord-e2e-export-'));
  let app = await launch({ CHORD_HOME_URL: `${site.origin}/` }, { profile });
  const personal = await (await pageWhere(app, isShell)).evaluate(async () => {
    const { state, windowId } = await (window as unknown as ImportWindow & { chord: { state: { snapshot(): Promise<ImportSnapshot> } } }).chord.state.snapshot();
    return state.windows[windowId]!.activeChordId;
  });
  await app.close();
  seed(profile, personal);
  const db = new DatabaseSync(join(profile, 'chord.db'));
  db.prepare(`INSERT INTO effect (host, wet, css, css_on, hidden, presets, duet, compiled, sanitizer, created_at, updated_at) VALUES (?, 1, ?, 1, '[]', '[]', '[]', '', 0, 1, 1700000000009)`).run(
    effectsHost(`${site.origin}/`)!,
    `body { background-color: ${STYLED} }`,
  );
  db.close();
  app = await launch({ CHORD_HOME_URL: `${site.origin}/` }, { profile });
  try {
    const settings = await openExport(app, await pageWhere(app, isShell));
    const card = settings.getByRole('group', { name: 'Export your data' });
    const plain = join(out, 'backup.jsonl');
    await answerSaveDialog(app, plain);
    await card.getByRole('button', { name: 'Choose where to save…' }).click();
    await expect(card.getByText(/^Saved backup\.jsonl, /)).toBeVisible({ timeout: 30_000 });
    await card.getByRole('switch', { name: 'Encrypt with a passphrase' }).click();
    await card.getByRole('button', { name: 'Suggest one' }).click();
    const passphrase = await card.getByLabel('Passphrase', { exact: true }).inputValue();
    const sealed = join(out, 'backup.chorddata');
    await answerSaveDialog(app, sealed);
    await card.getByRole('button', { name: 'Choose where to save…' }).click();
    await expect(card.getByText(/^Saved backup\.chorddata, /)).toBeVisible({ timeout: 30_000 });
    return { plain, sealed, passphrase };
  } finally {
    await app.close();
  }
}

test('a Chord file into a new profile: everything comes in as it was, nothing loads, and one Undo takes it all back', async () => {
  test.setTimeout(240_000);
  const { plain } = await exportedProfile();
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: 'dark' }, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Home page');
    const before = await stateOf(shell);
    const first = before.state.windows[before.windowId]!.activeChordId;
    const settings = await openYourData(app, shell);

    // The file chosen in the system's dialog, read off main, and counted against this new profile.
    await answerOpenDialog(app, plain);
    await settings.getByRole('button', { name: 'Choose a file…' }).click();
    const card = settings.getByRole('group', { name: 'From a Chord file' });
    await expect(card.getByText(/^From another computer, exported \w{3} \d{1,2}, \d{4} by Chord /)).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(/^New: 2 chords, 1 pinned tab, 1 Today tab, 1 folder, 1 Favorite, 1 theme, 1 link route, Effects for 2 sites, page zoom for 1 site, blocked permissions for 1 site\. The chord Chord started with makes way\.$/)).toBeVisible();
    await expect(card.getByText('2 new pages, for search in every chord')).toBeVisible();
    await expect(card.getByText('1 new chat, 1 image. Nothing is sent anywhere until you write in one.')).toBeVisible();
    await expect(card.getByText(`${effectsHost(`${site.origin}/`)} and news.test. Chord checks every stylesheet again before it uses it.`)).toBeVisible();
    // A new profile takes the file's settings, each named; its proxies too.
    await expect(card.getByRole('switch', { name: 'Import settings from the file' })).toHaveAttribute('aria-checked', 'true');
    const changes = card.getByRole('list', { name: 'What the file’s settings change' });
    await expect(changes).toContainText('Search engine: Google → DuckDuckGo');
    await expect(changes).toContainText('Proxy for every chord: The system’s proxy → No proxy');
    await expect(changes).toContainText('Work’s own proxy: The proxy for every chord → SOCKS5 proxy at 10.0.0.2:1080');
    await expect(card.getByText('Tabs stay unloaded until you open them. Sites you’d allowed to use your camera, microphone or location ask again.')).toBeVisible();
    expectClean(await audit(settings, 'Settings → Your data → From a Chord file', { appearance: 'dark' }));
    await card.getByRole('button', { name: 'Import', exact: true }).scrollIntoViewIfNeeded();
    await settings.screenshot({ path: resolve(capturesDir, 'settings-your-data-import-dark.png') });

    await card.getByRole('button', { name: 'Import', exact: true }).click();
    const done = /^Imported 2 chords, 2 tabs, 1 Favorite, Effects for 2 sites, \d+ settings, \d+ pages of history and 1 Duet chat/;
    await expect(card.getByText(done)).toBeVisible({ timeout: 30_000 });
    await expect(shell.getByRole('group', { name: done })).toBeVisible();

    // The file's chords, in place of the one first run made; its tab went with the window to the first of them.
    const after = await stateOf(shell);
    expect(Object.values(after.state.chords).map((c) => c.name).sort()).toEqual(['Personal', 'Work']);
    expect(after.state.chords[first]).toBeUndefined();
    const work = after.state.chords['work']!;
    expect(work).toMatchObject({ profileId: 'work-signins', proxy: { mode: 'server' } });
    expect(after.state.nodes['mail']).toMatchObject({ chordId: 'work', parentId: 'folder', section: 'pinned', customTitle: 'Mail', url: 'https://mail.test/inbox' });
    expect(Object.values(after.state.favorites).map((f) => f.url)).toEqual(['https://calendar.test/']);
    expect(after.state.settings).toMatchObject({ searchEngine: 'duckduckgo', themes: [{ name: 'Late Night' }], proxy: { mode: 'none' } });
    // Blocks only: the camera the other computer allowed asks again here.
    expect(after.state.sitePermissions).toEqual({ 'https://meet.test': { notifications: 'block' } });
    // Nothing loaded: the only page is the one the window was already showing.
    expect(Object.keys(after.state.live)).toEqual(Object.keys(before.state.live));
    await dispatch(shell, { t: 'chord.activate', windowId: after.windowId, chordId: 'work' });
    await expect(shell.getByRole('tree', { name: 'Pinned' })).toContainText('Reading');
    await expect(shell.getByRole('tree', { name: 'Pinned' })).toContainText('Mail');

    // History in the command bar, the chat in its search, and its image beside Duet's own.
    await expect.poll(() => historyFor(overlay, 'story')).toEqual(['https://news.test/a', 'https://news.test/b']);
    await expect.poll(() => chatsFor(overlay, 'lighthouse')).toEqual(['Trip']);
    expect(chatRow(profile, 'th')).toMatchObject({ provider_session_id: null, imported_at: expect.any(Number) });
    expect(readFileSync(join(profile, 'duet', 'images', `${IMAGE_ID}.png`))).toEqual(ICON);

    // The site's Effects, sanitized again here, on its next page.
    await dispatch(shell, { t: 'tab.open', windowId: after.windowId, url: `${site.origin}/styled` });
    const styled = await pageWhere(app, (url) => url === `${site.origin}/styled`);
    await expect.poll(() => backgroundOf(styled)).toBe(STYLED);

    // One Undo, from Settings: everything it brought goes, and the first-run chord comes back with its tab.
    await card.getByRole('button', { name: 'Undo' }).click();
    await expect(card.getByText('Import undone.')).toBeVisible({ timeout: 30_000 });
    const undone = await stateOf(shell);
    expect(Object.keys(undone.state.chords)).toEqual([first]);
    expect(Object.values(undone.state.nodes).map((n) => n.id)).toContain(Object.values(before.state.nodes)[0]!.id);
    expect(undone.state.favorites).toEqual({});
    expect(undone.state.settings).toMatchObject({ searchEngine: 'google', themes: [], proxy: { mode: 'system' } });
    expect(undone.state.sitePermissions).toEqual({});
    expect(undone.state.imports).toEqual({});
    expect(await historyFor(overlay, 'story')).toEqual([]);
    expect(await chatsFor(overlay, 'lighthouse')).toEqual([]);
    expect(chatRow(profile, 'th')).toBeUndefined();
    expect(existsSync(join(profile, 'duet', 'images', `${IMAGE_ID}.png`))).toBe(false);
    // The styled tab went with the chord it was in; the site, opened again, has no Effects.
    expect(styled.isClosed()).toBe(true);
    await dispatch(shell, { t: 'tab.open', windowId: undone.windowId, url: `${site.origin}/styled` });
    const plainAgain = await pageWhere(app, (url) => url === `${site.origin}/styled`);
    await expect(plainAgain.getByText('Styled by its Effects')).toBeVisible();
    expect(await backgroundOf(plainAgain)).not.toBe(STYLED);
  } finally {
    await app.close();
  }
});

test('a Chord file into a profile with data: problems first, then its settings off until you turn them on, named, and the toast’s Undo', async () => {
  test.setTimeout(240_000);
  const { sealed, passphrase } = await exportedProfile();
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  // A profile of its own: a chord with a pinned tab, and a Favorite at the file's address under another name.
  let app = await launch({ CHORD_HOME_URL: `${site.origin}/` }, { profile });
  await pageWhere(app, isShell);
  await app.close();
  const db = new DatabaseSync(join(profile, 'chord.db'));
  db.exec(`INSERT INTO chord (id, profile_id, name, icon, theme, rank, created_at, updated_at) VALUES ('side', 'default', 'Side project', 'S', '{"stops":[{"l":0.7,"c":0.1,"h":120}],"grain":0.2,"appearance":"auto"}', 'b0', 1, 1)`);
  db.exec(`INSERT INTO node (id, chord_id, parent_id, section, kind, rank, created_at, updated_at) VALUES ('notes', 'side', NULL, 'pinned', 'tab', 'a0', 1, 1)`);
  db.exec(`INSERT INTO tab (node_id, pinned_url, url, title, last_active_at) VALUES ('notes', 'https://notes.test/', 'https://notes.test/', 'Notes', 1)`);
  db.exec(`INSERT INTO favorite (id, url, title, rank, created_at, updated_at) VALUES ('mine', 'https://calendar.test/', 'Cal (mine)', 'a0', 1, 0)`);
  db.close();

  app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: 'light' }, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    const before = await stateOf(shell);
    const settings = await openYourData(app, shell);
    const card = settings.getByRole('group', { name: 'From a Chord file' });

    // Not a Chord file: said in a soft card, with one way on.
    const text = join(mkdtempSync(join(tmpdir(), 'chord-e2e-files-')), 'notes.txt');
    writeFileSync(text, 'Dear diary\n');
    await answerOpenDialog(app, text);
    await settings.getByRole('button', { name: 'Choose a file…' }).click();
    await expect(card.getByText('That isn’t a Chord file.')).toBeVisible({ timeout: 30_000 });

    // Encrypted: its passphrase, and a wrong one said so.
    await answerOpenDialog(app, sealed);
    await card.getByRole('button', { name: 'Choose another file…' }).click();
    await expect(card.getByText('This file is encrypted. Enter its passphrase.')).toBeVisible({ timeout: 30_000 });
    await card.getByLabel('Passphrase', { exact: true }).fill(`${passphrase}!`);
    await card.getByRole('button', { name: 'Open' }).click();
    await expect(card.getByText('That passphrase doesn’t open this file.')).toBeVisible({ timeout: 30_000 });
    expectClean(await audit(settings, 'Settings → Your data → From a Chord file, a wrong passphrase', { appearance: 'light' }));
    await card.getByRole('button', { name: 'Try again' }).click();
    await card.getByLabel('Passphrase', { exact: true }).fill(passphrase);
    await card.getByRole('button', { name: 'Open' }).click();

    // A profile with data: settings stay off until you turn them on, and each change is named either way.
    // The Favorite here at the file's address, under an older name: newer there, so it's that one, renamed.
    await expect(card.getByText(/^New: 2 chords, 1 pinned tab, 1 Today tab, 1 folder, 1 theme, .*\. Newer than yours: 1 Favorite\. Everything else is here already\.$/)).toBeVisible({ timeout: 30_000 });
    const toggle = card.getByRole('switch', { name: 'Import settings from the file' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(card.getByText(/^Off: yours stay as they are\. \d+ changes if you turn it on:$/)).toBeVisible();
    await expect(card.getByRole('list', { name: 'What the file’s settings change' })).toContainText('Search engine: Google → DuckDuckGo');
    expectClean(await audit(settings, 'Settings → Your data → From a Chord file, a profile with data', { appearance: 'light' }));
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await card.getByRole('button', { name: 'Import', exact: true }).click();
    const done = /^Imported 2 chords, 2 tabs, 1 Favorite, Effects for 2 sites, \d+ settings, \d+ pages of history and 1 Duet chat/;
    await expect(card.getByText(done)).toBeVisible({ timeout: 30_000 });

    const after = await stateOf(shell);
    expect(Object.values(after.state.chords).map((c) => c.name).sort()).toEqual(['Personal', 'Personal', 'Side project', 'Work']);
    expect(after.state.nodes['notes']).toMatchObject({ chordId: 'side', title: 'Notes' });
    // The file's Favorite is the one here, at its address: never a second.
    expect(Object.values(after.state.favorites).map((f) => [f.id, f.url, f.title])).toEqual([['mine', 'https://calendar.test/', 'Calendar']]);
    expect(after.state.settings.searchEngine).toBe('duckduckgo');

    // The window's toast takes it all back.
    await shell.getByRole('group', { name: done }).getByRole('button', { name: 'Undo' }).click();
    await expect(card.getByText('Import undone.')).toBeVisible({ timeout: 30_000 });
    const undone = await stateOf(shell);
    expect(Object.keys(undone.state.chords).sort()).toEqual(Object.keys(before.state.chords).sort());
    expect(Object.values(undone.state.favorites).map((f) => [f.id, f.title])).toEqual([['mine', 'Cal (mine)']]);
    expect(undone.state.settings.searchEngine).toBe('google');
    expect(Object.keys(undone.state.nodes).sort()).toEqual(Object.keys(before.state.nodes).sort());
  } finally {
    await app.close();
  }
});
