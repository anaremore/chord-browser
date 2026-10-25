import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, restoreState, seedState, type Command, type Context, type State, type TabNode } from '@chord/core';
import { ChordDatabase } from '../src/db';
import { MIGRATIONS } from '../src/migrations';
import { opsForState, opsFromPatches } from '../src';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-data-'));
  file = join(dir, 'chord.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const ctx: Context = { now: 5000, newId: () => `id-${++n}` };
const seed = () =>
  seedState({ now: 1000, newId: ctx.newId, theme: { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' }, homeUrl: 'https://home.test/' });

/** Apply commands to state and the database, the way main and chord-data do. */
function drive(db: ChordDatabase, state: State, commands: Command[]): State {
  for (const command of commands) {
    const result = apply(state, command, ctx);
    db.write(opsFromPatches(result.patches, result.state));
    state = result.state;
  }
  return state;
}

/** What survives a restart: everything except engine state, closed tabs and the version. */
const durable = (s: State) => ({
  settings: s.settings,
  sitePermissions: s.sitePermissions,
  downloads: s.downloads,
  extensions: s.extensions,
  chords: s.chords,
  nodes: s.nodes,
  windows: s.windows,
});

const ICON = 'data:image/png;base64,iVBORw0KGgo=';

/** Rows in a table, read through a separate connection that's closed again (Windows can't delete open files). */
function count(table: string): number {
  const db = new DatabaseSync(file);
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

describe('chord-data', () => {
  it('starts empty, then round-trips a session through a restart', () => {
    let db = new ChordDatabase(file);
    expect(db.version).toBe(MIGRATIONS.length);
    expect(db.load()).toBeNull();

    let state = seed();
    db.write(opsForState(state));
    const windowId = Object.keys(state.windows)[0]!;
    state = drive(db, state, [
      { t: 'tab.open', windowId, url: 'https://a.test/' },
      { t: 'tab.open', windowId, url: 'https://b.test/', background: true },
      { t: 'tab.updated', nodeId: 'id-4', title: 'A page', favicon: ICON },
      { t: 'tab.updated', nodeId: 'id-5', title: 'B page', favicon: ICON },
      { t: 'window.sidebar', windowId, sidebar: 'collapsed' },
      { t: 'window.bounds', windowId, bounds: { x: 40, y: 50, width: 1100, height: 760, maximized: false } },
      { t: 'settings.set', settings: { searchEngine: 'duckduckgo', motion: { tabMoves: false } } },
      { t: 'chord.theme', chordId: Object.keys(state.chords)[0]!, theme: { grain: 0.45, appearance: 'dark' } },
      { t: 'permission.set', origin: 'https://meet.test', permissions: ['camera', 'microphone'], decision: 'allow' },
      { t: 'permission.set', origin: 'https://ads.test', permissions: ['notifications'], decision: 'block' },
      {
        t: 'download.update',
        download: {
          id: 'd1',
          url: 'https://a.test/f.zip',
          filename: 'f.zip',
          path: 'C:/Downloads/f.zip',
          mime: 'application/zip',
          state: 'completed',
          received: 10,
          total: 10,
          speed: 0,
          startedAt: 3,
          endedAt: 4,
        },
      },
    ]);
    db.close();

    db = new ChordDatabase(file);
    const restored = restoreState(db.load(), { now: 9, newId: ctx.newId, theme: state.chords[Object.keys(state.chords)[0]!]!.theme, homeUrl: 'x' });
    expect(durable(restored)).toEqual(durable(state));
    expect((restored.nodes['id-4'] as TabNode).favicon).toBe(ICON);
    // Two tabs share one stored icon.
    db.close();
    expect(count('favicon')).toBe(1);
  });

  it('remembers installed extensions per profile, and forgets removed ones', () => {
    const db = new ChordDatabase(file);
    let state = seed();
    db.write(opsForState(state));
    const ext = (profileId: string, id: string, version: string) => ({
      id,
      profileId,
      name: 'uBlock Origin Lite',
      version,
      source: 'store' as const,
      path: `C:/Chord/Extensions/${profileId}/${id}/${version}_0`,
      notifiedVersion: null,
      pinned: true,
      installedAt: 1,
      updatedAt: 2,
    });
    const ubol = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
    state = drive(db, state, [
      { t: 'extension.record', extension: ext('default', ubol, '2026.1013.1') },
      { t: 'extension.record', extension: ext('work', ubol, '2026.1013.1') },
      { t: 'extension.record', extension: { ...ext('default', ubol, '2026.1021.1354'), notifiedVersion: '2026.1013.1' } },
      { t: 'extension.forget', profileId: 'work', id: ubol },
      { t: 'extension.pin', profileId: 'default', id: ubol, pinned: false },
    ]);
    const saved = db.load();
    db.close();
    expect(saved?.extensions).toEqual([{ ...ext('default', ubol, '2026.1021.1354'), notifiedVersion: '2026.1013.1', pinned: false }]);
    expect(restoreState(saved, { now: 9, newId: ctx.newId, theme: state.chords[Object.keys(state.chords)[0]!]!.theme, homeUrl: 'x' }).extensions).toEqual(state.extensions);
  });

  it('keeps a split view through a restart, and forgets it once it dissolves', () => {
    let db = new ChordDatabase(file);
    let state = seed();
    db.write(opsForState(state));
    const windowId = Object.keys(state.windows)[0]!;
    const first = Object.values(state.nodes)[0]!.id;
    state = drive(db, state, [{ t: 'split.add', windowId, withId: first, url: 'https://beside.test/', direction: 'column' }]);
    const split = Object.values(state.nodes).find((n) => n.kind === 'split')!;
    state = drive(db, state, [{ t: 'split.resize', splitId: split.id, sizes: [0.3, 0.7] }]);
    db.close();
    db = new ChordDatabase(file);
    const back = restoreState(db.load(), { now: 0, newId: ctx.newId, theme: state.chords[split.chordId]!.theme, homeUrl: 'https://home.test/' });
    expect(back.nodes[split.id]).toMatchObject({ kind: 'split', direction: 'column', sizes: [0.3, 0.7] });
    expect(Object.values(back.nodes).filter((n) => n.parentId === split.id)).toHaveLength(2);
    drive(db, state, [{ t: 'split.separate', splitId: split.id }]);
    db.close();
    expect(count('split')).toBe(0);
  });

  it('deletes closed tabs and unused icons', () => {
    let db = new ChordDatabase(file);
    let state = seed();
    db.write(opsForState(state));
    const windowId = Object.keys(state.windows)[0]!;
    state = drive(db, state, [
      { t: 'tab.open', windowId, url: 'https://a.test/' },
      { t: 'tab.updated', nodeId: 'id-4', favicon: ICON },
      { t: 'tab.close', windowId, nodeId: 'id-4' },
    ]);
    db.close();
    db = new ChordDatabase(file);
    expect(db.load()!.nodes.map((node) => node.id).sort()).toEqual(Object.keys(state.nodes).sort());
    db.close();
    expect(count('favicon')).toBe(0);
  });

  it("keeps an open tab's back/forward history across a restart, written after its row, and drops it with the tab", () => {
    let db = new ChordDatabase(file);
    let state = seed();
    db.write(opsForState(state));
    const windowId = Object.keys(state.windows)[0]!;
    const result = apply(state, { t: 'tab.open', windowId, url: 'https://a.test/2' }, ctx);
    state = result.state;
    const tabId = Object.keys(state.nodes).find((id) => state.nodes[id]!.kind === 'tab' && (state.nodes[id] as TabNode).url === 'https://a.test/2')!;
    const nav = { entries: [{ url: 'https://a.test/1', title: 'One' }, { url: 'https://a.test/2', title: 'Two', pageState: 'scrolled' }], index: 1 };
    // The history arrives in the same batch as the tab's row, ahead of it: still kept.
    db.write([{ k: 'nav', id: tabId, value: nav }, ...opsFromPatches(result.patches, state)]);
    db.close();

    db = new ChordDatabase(file);
    expect(db.loadNavs()).toEqual({ [tabId]: nav });
    // A tab's own row, written again, leaves its history alone; null clears it.
    db.write(opsForState(state));
    expect(db.loadNavs()[tabId]).toEqual(nav);
    db.write([{ k: 'nav', id: tabId, value: null }]);
    expect(db.loadNavs()).toEqual({});
    db.write([{ k: 'nav', id: tabId, value: nav }]);
    drive(db, state, [{ t: 'tab.close', windowId, nodeId: tabId as never }]);
    expect(db.loadNavs()).toEqual({});
    db.close();
  });

  it('gives a chord with separate sign-ins its own profile, and prunes it once nothing uses it', () => {
    let db = new ChordDatabase(file);
    let state = seed();
    db.write(opsForState(state));
    const chordId = Object.keys(state.chords)[0]!;
    state = drive(db, state, [{ t: 'chord.profile', chordId, profileId: 'work-1' }]);
    db.close();
    db = new ChordDatabase(file);
    expect(db.load()!.chords[0]!.profileId).toBe('work-1');
    // Still used: nothing to prune.
    expect(db.pruneProfiles()).toEqual([]);
    drive(db, state, [{ t: 'chord.profile', chordId, profileId: 'default' }]);
    expect(db.pruneProfiles()).toEqual(['persist:p-work-1']);
    expect(db.pruneProfiles()).toEqual([]);
    db.close();
    expect(count('profile')).toBe(1);
  });

  it('keeps page zoom per site across a restart, and forgets a site set back to 100%', () => {
    let db = new ChordDatabase(file);
    let state = seed();
    db.write(opsForState(state));
    state = drive(db, state, [
      { t: 'zoom.set', host: 'a.test', factor: 1.25 },
      { t: 'zoom.set', host: 'b.test:8080', factor: 0.8 },
    ]);
    db.close();
    db = new ChordDatabase(file);
    expect(db.load()!.siteZoom).toEqual({ 'a.test': 1.25, 'b.test:8080': 0.8 });
    drive(db, state, [{ t: 'zoom.set', host: 'a.test', factor: 1 }]);
    db.close();
    db = new ChordDatabase(file);
    expect(db.load()!.siteZoom).toEqual({ 'b.test:8080': 0.8 });
    db.close();
  });

  it('keeps Effects per site across a restart, checks them as it reads them, and forgets a removed site', () => {
    let db = new ChordDatabase(file);
    const site = {
      host: 'news.test',
      wet: false,
      css: 'h1 { color: red }',
      hidden: [{ selector: '#ad', label: 'div#ad', at: 2 }],
      presets: ['dark' as const],
      duet: [{ id: 'd1', ask: 'Bigger text', summary: 'Bigger body text', css: 'body { font-size: 20px }', at: 3 }],
      createdAt: 1,
      updatedAt: 4,
    };
    db.write([
      { k: 'effect', id: 'news.test', value: { ...site, compiled: 'h1 {\n  color: red !important;\n}', sanitizer: 1 } },
      { k: 'effect', id: 'other.test:8080', value: { ...site, host: 'other.test:8080', css: '', hidden: [], presets: ['reading-width'], duet: [], compiled: 'x', sanitizer: 1 } },
    ]);
    db.close();
    db = new ChordDatabase(file);
    const loaded = db.loadEffects();
    expect(loaded.map((e) => e.host).sort()).toEqual(['news.test', 'other.test:8080']);
    expect(loaded.find((e) => e.host === 'news.test')).toEqual({ ...site, compiled: 'h1 {\n  color: red !important;\n}', sanitizer: 1 });
    db.write([{ k: 'effect', id: 'other.test:8080', value: null }]);
    // A row changed by hand: what doesn't check out is dropped as it's read (an unknown preset, a selector too long).
    const raw = new DatabaseSync(file);
    raw.prepare(`UPDATE effect SET presets = '["dark","neon"]', hidden = ? WHERE host = 'news.test'`).run(JSON.stringify([{ selector: 'x'.repeat(2000), label: 'big' }, { selector: '#ok', label: 'ok' }]));
    raw.close();
    db.close();
    db = new ChordDatabase(file);
    const [only] = db.loadEffects();
    expect(db.loadEffects()).toHaveLength(1);
    expect(only!.presets).toEqual(['dark']);
    expect(only!.hidden.map((h) => h.selector)).toEqual(['#ok']);
    db.close();
    expect(count('effect')).toBe(1);
  });

  it('keeps a muted tab muted across a restart, until it’s unmuted', () => {
    let db = new ChordDatabase(file);
    let state = seed();
    db.write(opsForState(state));
    const windowId = Object.keys(state.windows)[0]!;
    state = drive(db, state, [{ t: 'tab.open', windowId, url: 'https://music.test/' }]);
    const nodeId = state.windows[windowId]!.activeTab[state.windows[windowId]!.activeChordId]!;
    state = drive(db, state, [{ t: 'tab.mute', nodeId, muted: true }]);
    db.close();
    db = new ChordDatabase(file);
    expect((db.load()!.nodes.find((n) => n.id === nodeId) as TabNode).muted).toBe(true);
    drive(db, state, [{ t: 'tab.mute', nodeId, muted: false }]);
    db.close();
    db = new ChordDatabase(file);
    expect('muted' in db.load()!.nodes.find((n) => n.id === nodeId)!).toBe(false);
    db.close();
  });

  it('keeps link routes across a restart, and forgets one that was removed', () => {
    let db = new ChordDatabase(file);
    let state = seed();
    db.write(opsForState(state));
    const chordId = Object.keys(state.chords)[0]!;
    state = drive(db, state, [
      { t: 'linkRoute.set', host: 'github.com', chordId },
      { t: 'linkRoute.set', host: 'linear.app', chordId },
    ]);
    db.close();
    db = new ChordDatabase(file);
    expect(
      db
        .load()!
        .linkRoutes!.map((r) => r.host)
        .sort(),
    ).toEqual(['github.com', 'linear.app']);
    drive(db, state, [{ t: 'linkRoute.delete', host: 'github.com' }]);
    db.close();
    db = new ChordDatabase(file);
    expect(db.load()!.linkRoutes).toEqual([{ host: 'linear.app', chordId, createdAt: expect.any(Number) }]);
    db.close();
  });

  it('keeps favorites (with their icons), folders and the sidebar width across a restart', () => {
    let db = new ChordDatabase(file);
    let state = seed();
    db.write(opsForState(state));
    const windowId = Object.keys(state.windows)[0]!;
    const chordId = Object.keys(state.chords)[0]!;
    const tabId = Object.values(state.nodes)[0]!.id;
    state = drive(db, state, [
      { t: 'tab.updated', nodeId: tabId, favicon: ICON },
      { t: 'favorite.add', favoriteId: 'fav-1', nodeId: tabId },
      { t: 'folder.create', folderId: 'folder-1', chordId, title: 'Reading', tabId },
      { t: 'folder.toggle', nodeId: 'folder-1', collapsed: true },
      { t: 'window.sidebarWidth', windowId, width: 320 },
    ]);
    db.close();
    db = new ChordDatabase(file);
    const saved = db.load()!;
    expect(saved.favorites).toEqual([state.favorites['fav-1']]);
    expect(saved.favorites![0]!.favicon).toBe(ICON);
    expect(saved.nodes.find((n) => n.id === 'folder-1')).toMatchObject({ kind: 'folder', title: 'Reading', collapsed: true });
    expect(saved.nodes.find((n) => n.id === tabId)).toMatchObject({ parentId: 'folder-1', section: 'pinned' });
    expect(saved.windows[0]!.sidebarWidth).toBe(320);
    drive(db, state, [{ t: 'favorite.remove', favoriteId: 'fav-1' }]);
    db.close();
    expect(count('favorite')).toBe(0);
  });

  it('rolls back a batch that breaks a constraint, keeping what was there', () => {
    const db = new ChordDatabase(file);
    const state = seed();
    db.write(opsForState(state));
    const tab = Object.values(state.nodes)[0] as TabNode;
    // A tab in a chord that doesn't exist fails the deferred foreign key at commit.
    expect(() =>
      db.write([
        { k: 'node', id: tab.id, value: { ...tab, title: 'changed' } },
        { k: 'node', id: 'stray', value: { ...tab, id: 'stray', chordId: 'missing' } },
      ]),
    ).toThrow();
    expect((db.load()!.nodes[0] as TabNode).title).toBe('');
    db.close();
  });

  it('upgrades a version-6 profile (extensions, no Favorites yet) to 7, keeping everything', () => {
    // A profile as the build before Favorites left it: migrations 1-6, a chord and an installed extension.
    const v6 = new DatabaseSync(file);
    for (const migration of MIGRATIONS.slice(0, 6)) v6.exec(migration);
    v6.exec('PRAGMA user_version = 6');
    const theme = JSON.stringify({ stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' });
    v6.prepare('INSERT INTO chord (id, profile_id, name, icon, theme, rank, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'c1', 'default', 'Personal', '✦', theme, 'a0', 0, 0,
    );
    v6.prepare(
      `INSERT INTO extension (profile_id, id, name, version, source, path, notified_version, pinned, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('default', 'cjpalhdlnbpafiamejdnhcphjbkeiagm', 'uBlock Origin Lite', '2026.10.1', 'store', '/extensions/ubol', '2026.10.1', 1, 1000, 1000);
    v6.close();

    const db = new ChordDatabase(file);
    expect(db.version).toBe(MIGRATIONS.length);
    const saved = db.load()!;
    expect(saved.chords.map((c) => c.name)).toEqual(['Personal']);
    expect(saved.extensions).toEqual([
      {
        id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
        profileId: 'default',
        name: 'uBlock Origin Lite',
        version: '2026.10.1',
        source: 'store',
        path: '/extensions/ubol',
        notifiedVersion: '2026.10.1',
        pinned: true,
        installedAt: 1000,
        updatedAt: 1000,
      },
    ]);
    expect(saved.favorites).toEqual([]);
    // The new table takes favorites.
    db.write([{ k: 'favorite', id: 'fav-1', value: { id: 'fav-1', url: 'https://mail.test/', title: 'Mail', favicon: ICON, rank: 'a0', createdAt: 5 } }]);
    expect(db.load()!.favorites!.map((f) => f.url)).toEqual(['https://mail.test/']);
    db.close();
    // And the version-6 copy was kept.
    const backup = new DatabaseSync(`${file}.v6.bak`);
    expect(backup.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    backup.close();
  });

  it('backs up the previous version before migrating', () => {
    const old = new DatabaseSync(file);
    old.exec(MIGRATIONS[0]!);
    old.exec('PRAGMA user_version = 1');
    old.close();
    // Pretend a newer build adds a migration.
    (MIGRATIONS as string[]).push('CREATE TABLE later (id INTEGER PRIMARY KEY) STRICT;');
    try {
      const db = new ChordDatabase(file);
      expect(db.version).toBe(MIGRATIONS.length);
      db.close();
      const backup = new DatabaseSync(`${file}.v1.bak`);
      expect(backup.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      backup.close();
    } finally {
      (MIGRATIONS as string[]).pop();
    }
  });
});
