/**
 * Your data's export, rows into records (export.ts), over a read-only
 * connection of its own as the export process opens it: what a seeded
 * profile's file holds, in which order, what it never holds, the history and
 * Duet switches, and one moment's data while chord-data goes on writing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chordFromRecord,
  favoriteFromRecord,
  iconFromRecord,
  iconId,
  imageFromRecord,
  messageFromRecord,
  nodeFromRecord,
  pageFromRecord,
  seedState,
  settingsFromFields,
  threadFromRecord,
  type DataRecord,
  type DuetImage,
  type State,
  type TabNode,
} from '@chord/core';
import { opsForState } from '../src';
import { sha256Hex } from '../src/crypto';
import { ChordDatabase } from '../src/db';
import { exportCounts, exportRecords, type ExportItem, type ExportOptions } from '../src/export';
import { amountsHere, chatsHere, localRecords, pagesHere } from '../src/import-file';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-export-'));
  file = join(dir, 'chord.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DEVICE = '9f2c4e1a7b3d5c60';
const ICON_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64');
const ICON = `data:image/png;base64,${ICON_BYTES.toString('base64')}`;
const IMAGE: DuetImage = { id: 'abcdefabcdefabcdefabcdef', mime: 'image/png', width: 2, height: 2, codexCopy: '/home/me/.codex/generated_images/x.png' };

let n = 0;
const newId = () => `id-${++n}`;

/** A profile with a bit of everything, and everything an export must leave out. */
function seeded(): { db: ChordDatabase; state: State } {
  const db = new ChordDatabase(file);
  const state = seedState({ now: 1000, newId, theme: { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' }, homeUrl: 'https://home.test/' });
  const personal = Object.values(state.chords)[0]!;
  state.chords['work'] = { id: 'work', profileId: 'work-signins', name: 'Work', icon: 'W', theme: personal.theme, rank: 'b0', createdAt: 2000, proxy: { mode: 'none', server: null, pac: null } };
  state.chords['private'] = { id: 'private', profileId: 'private-w9', name: 'Private', icon: 'P', theme: personal.theme, rank: 'c0', createdAt: 2000, private: true };
  const tab = (id: string, extra: Partial<TabNode>): TabNode => ({
    kind: 'tab',
    id,
    chordId: 'work',
    section: 'pinned',
    parentId: null,
    rank: 'a0',
    url: `https://${id}.test/`,
    title: id,
    pinnedUrl: `https://${id}.test/`,
    customTitle: null,
    favicon: null,
    lastActiveAt: 1500,
    createdAt: 1500,
    ...extra,
  });
  state.nodes['folder'] = { kind: 'folder', id: 'folder', chordId: 'work', section: 'pinned', parentId: null, rank: 'a0', title: 'Reading', collapsed: false, createdAt: 1500 };
  state.nodes['mail'] = tab('mail', { parentId: 'folder', favicon: ICON, customTitle: 'Mail' });
  state.nodes['docs'] = tab('docs', { rank: 'b0' });
  state.nodes['secret'] = tab('secret', { chordId: 'private', section: 'today', pinnedUrl: null });
  state.favorites['fav'] = { id: 'fav', url: 'https://calendar.test/', title: 'Calendar', favicon: ICON, rank: 'a0', createdAt: 1600 };
  state.linkRoutes['github.com'] = { host: 'github.com', chordId: 'work', createdAt: 1700 };
  state.siteZoom['docs.test'] = 1.25;
  state.sitePermissions['https://meet.test'] = { camera: 'allow', notifications: 'block' };
  state.settings.searchEngine = 'kagi';
  state.settings.uiScale = 1.25;
  state.settings.themes = [{ id: 'theme-1', name: 'Late Night', stops: [{ l: 0.5, c: 0.2, h: 280 }], grain: 0.3 }];
  state.downloads['dl'] = { id: 'dl', url: 'https://download.test/file.zip', filename: 'file.zip', path: '/tmp/file.zip', mime: 'application/zip', state: 'completed', received: 1, total: 1, speed: 0, startedAt: 1, endedAt: 2 };
  state.extensions['default:aaaabbbbccccddddeeeeffffgggghhhh'] = {
    id: 'aaaabbbbccccddddeeeeffffgggghhhh',
    profileId: 'default',
    name: 'Password Keeper',
    version: '1.0',
    source: 'store',
    path: '/ext',
    notifiedVersion: null,
    pinned: true,
    installedAt: 1,
    updatedAt: 1,
  };
  db.write(opsForState(state), 3000, [
    { k: 'visit', url: 'https://news.test/a', title: 'A story', at: 10_000 },
    { k: 'visit', url: 'https://news.test/a', title: 'A story', at: 20_000 },
    { k: 'visit', url: 'https://news.test/b', title: 'B story', at: 15_000 },
    { k: 'choice', chordId: personal.id, text: 'learned pick', destination: 'https://news.test/a', address: 'https://news.test/a', at: 30_000 },
    { k: 'archive', tab: { id: 'arch', chordId: personal.id, url: 'https://archived.test/', title: 'Archived', favicon: null, reason: 'closed', archivedAt: Date.now() }, nav: null },
  ]);
  db.write([
    { k: 'nav', id: 'mail', value: { entries: [{ url: 'https://mail.test/', title: 'Mail', pageState: 'FORM-SECRET' }], index: 0 } },
    {
      k: 'effect',
      id: 'news.test',
      value: { host: 'news.test', wet: true, css: 'h1 { color: red }', cssOn: false, hidden: [{ selector: '#ad', label: 'Ad', on: true, at: 1 }], presets: ['dark'], duet: [], createdAt: 4000, updatedAt: 4000, compiled: 'COMPILED-SHEET', sanitizer: 1 },
    },
  ]);
  db.duet({ op: 'saveThread', thread: { id: 'th', chordId: 'work', title: 'Trip', provider: 'codex', model: null, providerSessionId: 'SESSION-SECRET', scope: 'ask', createdAt: 5000, updatedAt: 5000, lastUsedAt: 5000 } });
  db.duet({ op: 'saveMessage', message: { id: 'm1', threadId: 'th', createdAt: 5001, body: { role: 'user', text: 'Draw a lighthouse', attachments: [], images: [IMAGE] } } });
  db.duet({
    op: 'saveMessage',
    message: { id: 'm2', threadId: 'th', createdAt: 5002, body: { role: 'assistant', text: 'Here [1]', citations: [{ n: 1, ref: 't1', url: 'https://maps.test/', title: 'Maps', quote: 'q', tabId: 'node-7' }], status: 'done' } },
  });
  return { db, state };
}

const options = (overrides: Partial<ExportOptions> = {}): ExportOptions => ({
  device: DEVICE,
  platform: 'linux',
  history: true,
  duet: true,
  sha256: sha256Hex,
  image: (image) => (image.id === IMAGE.id ? { data: Buffer.from('PNGDATA!'), thumb: Buffer.from('THUMB!!!') } : null),
  ...overrides,
});

/** The export, read as the export process reads it: its own read-only connection, one read transaction. */
function exported(overrides: Partial<ExportOptions> = {}): ExportItem[] {
  const ro = new DatabaseSync(file, { readOnly: true });
  try {
    ro.exec('BEGIN');
    const items = [...exportRecords((text) => ro.prepare(text), options(overrides))];
    ro.exec('COMMIT');
    return items;
  } finally {
    ro.close();
  }
}

const of = (items: ExportItem[], type: string) => items.filter((i) => i.record.type === type).map((i) => i.record);

describe('an export', () => {
  it('holds the profile’s setup, Today tabs, icons, history and Duet, in that order', () => {
    const { db, state } = seeded();
    db.close();
    const items = exported();
    const phases = items.map((i) => i.phase);
    expect([...new Set(phases)]).toEqual(['setup', 'today', 'history', 'duet']);
    expect(phases).toEqual([...phases].sort((a, b) => ['setup', 'today', 'history', 'duet'].indexOf(a) - ['setup', 'today', 'history', 'duet'].indexOf(b)));

    const personal = Object.values(state.chords).find((c) => c.name === 'Personal')!;
    expect(of(items, 'chord').map((r) => chordFromRecord(r))).toEqual([
      { ...personal },
      // A chord's own sign-ins and proxy.
      { id: 'work', profileId: 'work-signins', name: 'Work', icon: 'W', theme: personal.theme, rank: 'b0', createdAt: 2000, proxy: { mode: 'none', server: null, pac: null } },
    ]);
    // Pinned in the sidebar's order, a folder before what's in it; the icon is a record of its own.
    const pinned = items.filter((i) => i.phase === 'setup' && ['folder', 'tab', 'split'].includes(i.record.type)).map((i) => i.record.id);
    expect(pinned).toEqual(['folder', 'mail', 'docs']);
    const icon = iconId(sha256Hex(ICON_BYTES));
    expect(nodeFromRecord(of(items, 'tab').find((r) => r.id === 'mail')!, 0)?.icon).toBe(icon);
    expect(favoriteFromRecord(of(items, 'favorite')[0]!)).toEqual({ favorite: { ...state.favorites['fav']!, favicon: null }, icon });
    expect(of(items, 'icon').map((r) => iconFromRecord(r))).toEqual([{ id: icon, mime: 'image/png', data: ICON_BYTES.toString('base64') }]);
    expect(of(items, 'theme').map((r) => r.id)).toEqual(['theme-1']);
    expect(of(items, 'route').map((r) => [r.id, r.set['chord']])).toEqual([['github.com', 'work']]);
    expect(of(items, 'effects')[0]).toMatchObject({ id: 'news.test', at: [4000, 0, DEVICE], set: { css: 'h1 { color: red }', cssOn: false, presets: ['dark'], hidden: [{ selector: '#ad', label: 'Ad', on: true }] } });
    expect(of(items, 'zoom').map((r) => [r.id, r.set['factor']])).toEqual([['docs.test', 1.25]]);
    expect(of(items, 'permission')[0]).toMatchObject({ id: 'https://meet.test', set: { camera: 'allow', notifications: 'block' } });
    const settings = settingsFromFields(Object.assign({}, ...of(items, 'settings').map((r) => r.set)), 'linux');
    expect(settings['searchEngine']).toBe('kagi');
    expect(settings['uiScale']).toBeUndefined();

    // The Today tab of the first chord; the private window's never.
    expect(items.filter((i) => i.phase === 'today' && i.record.type === 'tab').map((i) => i.record.set['url'])).toEqual(['https://home.test/']);
    expect(of(items, 'page').map((r) => pageFromRecord(r))).toEqual([
      { url: 'https://news.test/a', title: 'A story', visits: [10_000, 20_000], typed: 1 },
      { url: 'https://news.test/b', title: 'B story', visits: [15_000], typed: 0 },
    ]);
    expect(of(items, 'thread').map((r) => threadFromRecord(r))).toEqual([
      { id: 'th', chordId: 'work', title: 'Trip', provider: 'codex', model: null, providerSessionId: null, scope: 'ask', createdAt: 5000, updatedAt: 5000, lastUsedAt: 5000 },
    ]);
    expect(of(items, 'message').map((r) => messageFromRecord(r)?.id)).toEqual(['m1', 'm2']);
    expect(imageFromRecord(of(items, 'image')[0]!)).toEqual({
      image: { id: IMAGE.id, mime: 'image/png', width: 2, height: 2 },
      data: Buffer.from('PNGDATA!').toString('base64'),
      thumb: Buffer.from('THUMB!!!').toString('base64'),
    });
  });

  it('stamps setup with each row’s last change and this computer, and leaves facts without', () => {
    seeded().db.close();
    for (const { record } of exported()) {
      if (['page', 'thread', 'message', 'image', 'icon'].includes(record.type)) expect(record.at).toBeUndefined();
      else expect(record.at).toEqual([expect.any(Number), 0, DEVICE]);
    }
  });

  it('never holds back/forward history, the archive, downloads, extensions, learned picks, windows, a private window or paths', () => {
    seeded().db.close();
    const text = JSON.stringify(exported().map((i) => i.record));
    for (const never of [
      'FORM-SECRET',
      'archived.test',
      'download.test',
      'Password Keeper',
      'learned pick',
      'secret.test',
      'Private',
      'SESSION-SECRET',
      'COMPILED-SHEET',
      'generated_images',
      'node-7',
      'lastActiveAt',
      'bounds',
      'sidebarWidth',
    ]) {
      expect(text).not.toContain(never);
    }
  });

  it('leaves history out, or Duet’s chats, when their switch is off', () => {
    seeded().db.close();
    const types = (items: ExportItem[]) => new Set(items.map((i) => i.record.type));
    expect(types(exported({ history: false }))).not.toContain('page');
    expect([...types(exported({ duet: false }))].filter((t) => ['thread', 'message', 'image'].includes(t))).toEqual([]);
    expect(types(exported({ history: false, duet: false }))).toContain('tab');
  });

  it('reads an image’s file only by an id Chord makes: it becomes a file name', () => {
    const { db } = seeded();
    db.duet({
      op: 'saveMessage',
      message: { id: 'm3', threadId: 'th', createdAt: 5003, body: { role: 'user', text: 'x', attachments: [], images: [{ ...IMAGE, id: '../../../etc/passwd' }] } },
    });
    db.close();
    const asked: string[] = [];
    exported({ image: (image) => (asked.push(image.id), null) });
    expect(asked).toEqual([IMAGE.id]);
  });

  it('leaves out an image whose file has gone, and keeps the message that names it', () => {
    seeded().db.close();
    const items = exported({ image: () => null });
    expect(of(items, 'image')).toEqual([]);
    expect(of(items, 'message').map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it('is one moment’s data: what chord-data writes meanwhile waits for the next export', () => {
    const { db } = seeded();
    const ro = new DatabaseSync(file, { readOnly: true });
    try {
      ro.exec('BEGIN');
      const records = exportRecords((text) => ro.prepare(text), options());
      const first: DataRecord[] = [];
      for (let next = records.next(); !next.done && next.value.phase === 'setup'; next = records.next()) first.push(next.value.record);
      // chord-data goes on: a new visit and a new chord, mid-export, with nothing waiting on the export.
      db.write([], 6000, [{ k: 'visit', url: 'https://news.test/c', title: 'C story', at: 30_000 }]);
      const rest = [...records].map((i) => i.record);
      ro.exec('COMMIT');
      expect(rest.filter((r) => r.type === 'page').map((r) => r.id)).toEqual(['https://news.test/a', 'https://news.test/b']);
      expect(first.length).toBeGreaterThan(0);
    } finally {
      ro.close();
      db.close();
    }
  });

  it('counts what it would hold, for Settings’ card', () => {
    const { db } = seeded();
    expect(db.exportCounts()).toEqual({ chords: 2, pinnedTabs: 2, folders: 1, todayTabs: 1, favorites: 1, themes: 1, routes: 1, effects: 1, pages: 2, chats: 1, images: 1 });
    const ro = new DatabaseSync(file, { readOnly: true });
    expect(exportCounts((text) => ro.prepare(text))).toEqual(db.exportCounts());
    ro.close();
    db.close();
  });
});

describe('an import’s view of what’s here (import-file.ts)', () => {
  it('reads this computer’s setup as an export would, and which pages and chats are here, over a read-only connection', () => {
    const { db } = seeded();
    db.close();
    const ro = new DatabaseSync(file, { readOnly: true });
    try {
      const sql = (text: string) => ro.prepare(text);
      const records = localRecords(sql, { device: DEVICE, platform: 'linux', sha256: sha256Hex });
      // Setup, Today tabs and their icons, stamped; never history or chats, which an import only adds to.
      expect(new Set(records.map((r) => r.type))).toEqual(new Set(['chord', 'folder', 'tab', 'favorite', 'theme', 'settings', 'route', 'effects', 'zoom', 'permission', 'icon']));
      expect(records.filter((r) => r.type !== 'icon').every((r) => r.at?.[2] === DEVICE)).toBe(true);
      const here = pagesHere(sql);
      expect([here('https://news.test/a'), here('https://www.news.test/a'), here('https://news.test/c'), here('javascript:alert(1)')]).toEqual([true, true, false, false]);
      expect(chatsHere(sql)).toEqual(new Set(['th']));
      // How much history and how many chats, counted no further than asked: whether this is a fresh Chord.
      const pages = (ro.prepare('SELECT COUNT(*) AS n FROM history_url').get() as { n: number }).n;
      expect(amountsHere(sql, 100)).toEqual({ pages, chats: 1 });
      expect(amountsHere(sql, 1)).toEqual({ pages: Math.min(pages, 1), chats: 1 });
    } finally {
      ro.close();
    }
  });
});
