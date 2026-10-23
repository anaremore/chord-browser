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
