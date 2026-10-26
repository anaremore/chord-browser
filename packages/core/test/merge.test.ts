/**
 * Importing a Chord file (S15 §5): the merge planner, field by field by the
 * stamps, into a new profile and one with data; then the plan applied through
 * `data.merge` a part at a time, and one Undo putting everything back.
 */
import { generateNKeysBetween } from 'fractional-indexing';
import { describe, expect, it } from 'vitest';
import {
  apply,
  chordRecord,
  defaultSettings,
  effectsRecord,
  emptyState,
  favoriteRecord,
  FRESH_PAGES,
  IMPORT_LIMITS,
  importedText,
  MAX_PAGE_VISITS,
  mergeParts,
  nodeRecord,
  pageShares,
  permissionRecord,
  planMerge,
  routeRecord,
  same,
  seedState,
  settingsRecords,
  setupRecord,
  stable,
  themeRecord,
  zoomRecord,
  type Chord,
  type Command,
  type DataRecord,
  type MergeChoices,
  type MergePlan,
  type SidebarNode,
  type SiteEffects,
  type Stamp,
  type State,
  type TabNode,
} from '../src';

const HERE = '00000000000000aa';
const THERE = '00000000000000bb';
const NOW = 1_800_000_000_000;
const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const ALL: MergeChoices = { effects: true, settings: true };
const old: Stamp = [1_700_000_000_000, 0, THERE];
const mid: Stamp = [1_750_000_000_000, 0, HERE];
const late: Stamp = [1_760_000_000_000, 0, THERE];

let n = 0;
const newId = () => `new-${++n}`;

const chord = (id: string, extra: Partial<Chord> = {}): Chord => ({ id, profileId: 'default', name: id, icon: id[0]!.toUpperCase(), theme: THEME, rank: 'a0', createdAt: 1, ...extra });
const tab = (id: string, chordId: string, extra: Partial<TabNode> = {}): TabNode => ({
  kind: 'tab',
  id,
  chordId,
  section: 'pinned',
  parentId: null,
  rank: 'a0',
  url: `https://${id}.test/`,
  title: id,
  pinnedUrl: `https://${id}.test/`,
  customTitle: null,
  favicon: null,
  lastActiveAt: 1,
  createdAt: 1,
  ...extra,
});
const effects = (host: string, css: string): SiteEffects => ({ host, wet: true, css, cssOn: true, hidden: [], presets: [], duet: [], createdAt: 1, updatedAt: 1 });

/** A state's setup as an export writes it: every record with `at`, and settings that differ from the defaults as rows. */
function recordsOf(state: State, at: Stamp, extra: { effects?: SiteEffects[]; settings?: Record<string, unknown> } = {}): DataRecord[] {
  const out: DataRecord[] = [];
  for (const c of Object.values(state.chords)) {
    const r = chordRecord(c, at);
    if (r) out.push(r);
  }
  for (const node of Object.values(state.nodes)) out.push(nodeRecord(node, at));
  for (const f of Object.values(state.favorites)) out.push(favoriteRecord(f, at));
  for (const t of state.settings.themes) out.push(themeRecord(t, at));
  const rows = Object.entries({ ...state.settings, ...extra.settings }).map(([key, value]) => ({ key, value, updatedAt: at[0] }));
  out.push(...settingsRecords(rows, at[2], 'linux'));
  for (const route of Object.values(state.linkRoutes)) out.push(routeRecord(route, at));
  for (const [host, factor] of Object.entries(state.siteZoom)) out.push(zoomRecord(host, factor, at));
  for (const [origin, decisions] of Object.entries(state.sitePermissions)) {
    const r = permissionRecord(origin, decisions, at);
    if (r) out.push(r);
  }
  for (const site of extra.effects ?? []) out.push(effectsRecord(site, at));
  return out;
}

/** A first run's state: one chord with a Today tab. */
const fresh = (): State => seedState({ now: 1000, newId: () => 'first', theme: THEME, homeUrl: 'https://home.test/' });

/** A profile with data: two chords, a folder with a tab, a Favorite, a route, a zoom, a permission. */
function used(): State {
  const state = emptyState();
  state.chords['work'] = chord('work', { name: 'Work', rank: 'a0' });
  state.chords['home'] = chord('home', { name: 'Home', rank: 'b0' });
  state.nodes['folder'] = { kind: 'folder', id: 'folder', chordId: 'work', section: 'pinned', parentId: null, rank: 'a0', title: 'Reading', collapsed: false, createdAt: 1 };
  state.nodes['mail'] = tab('mail', 'work', { parentId: 'folder' });
  state.nodes['docs'] = tab('docs', 'work', { rank: 'b0' });
  state.favorites['fav'] = { id: 'fav', url: 'https://calendar.test/', title: 'Calendar', favicon: null, rank: 'a0', createdAt: 1 };
  state.linkRoutes['github.com'] = { host: 'github.com', chordId: 'work', createdAt: 1 };
  state.siteZoom['docs.test'] = 1.25;
  state.sitePermissions['https://meet.test'] = { camera: 'allow' };
  state.windows['w1'] = { id: 'w1', activeChordId: 'work', activeTab: { work: 'docs' }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  return state;
}

/** What chord.db says is here besides setup: by default, no history and no chats, as on a first run. */
const NOTHING = { pages: 0, chats: 0 };
/** `here` null: chord.db's amounts unknown. */
const plan = (local: DataRecord[], file: DataRecord[], choices = ALL, here: { pages: number; chats: number } | null = NOTHING): MergePlan =>
  planMerge({ local, file, ...(here ? { here } : {}), choices, platform: 'linux', now: NOW, newId });

/** The plan through the reducer, a part at a time, as main applies it. */
function applyPlan(state: State, p: MergePlan, importId = 'imp'): State {
  let s = state;
  let i = 0;
  const ctx = { now: NOW, newId: () => `ctx-${++i}` };
  for (const part of mergeParts(p)) s = apply(s, { t: 'data.merge', importId, ...part }, ctx).state;
  return s;
}

function undo(state: State, importId = 'imp'): State {
  let s = state;
  const ctx = { now: NOW + 1, newId: () => 'undo' };
  for (let i = 0; i < 100 && s.imports[importId]; i++) s = apply(s, { t: 'import.undo', importId, limit: 2 } satisfies Command, ctx).state;
  return s;
}

/** What a state holds that an import touches, to compare before and after. */
const setupOf = (s: State) => ({ chords: s.chords, nodes: s.nodes, favorites: s.favorites, themes: s.settings.themes, routes: s.linkRoutes, zoom: s.siteZoom, permissions: s.sitePermissions, settings: s.settings });

describe('the merge planner', () => {
  it('into a new profile, everything comes in, whatever the stamps, and the first-run chord makes way', () => {
    const here = fresh();
    const there = used();
    const p = plan(recordsOf(here, late), recordsOf(there, old, { settings: { searchEngine: 'duckduckgo' } }));
    expect(p.newProfile).toBe(true);
    expect(p.chords.map((c) => c.id).sort()).toEqual(['home', 'work']);
    expect(p.counts.new).toMatchObject({ chords: 2, pinnedTabs: 2, folders: 1, favorites: 1, routes: 1, zoom: 1, blocks: 0 });
    expect(p.makeWay).toEqual({ chordId: Object.keys(here.chords)[0], to: 'work' });
    // The file's settings win in a restore, though its stamps are older than this computer's first run.
    expect(p.settings).toMatchObject({ searchEngine: 'duckduckgo' });
    expect(p.changes.find((c) => c.field === 'searchEngine')).toMatchObject({ label: 'Search engine', from: 'Google', to: 'DuckDuckGo' });
    expect(p.chordIds.sort()).toEqual(['home', 'work']);
  });

  it.each<[string, (here: State, there: State) => void, (p: MergePlan) => void]>([
    [
      'a newer name wins; an older color doesn’t',
      (_here, there) => {
        there.chords['work'] = { ...there.chords['work']!, name: 'Work stuff' };
      },
      (p) => {
        expect(p.chords).toEqual([expect.objectContaining({ id: 'work', name: 'Work stuff' })]);
        expect(p.counts.newer.chords).toBe(1);
      },
    ],
    [
      'something deleted here comes back',
      (here) => {
        delete here.nodes['docs'];
      },
      (p) => {
        expect(p.nodes.map((n) => n.id)).toEqual(['docs']);
        expect(p.counts.new.pinnedTabs).toBe(1);
      },
    ],
    [
      'a Favorite with an address here is that Favorite, never a second',
      (_here, there) => {
        delete there.favorites['fav'];
        there.favorites['other-id'] = { id: 'other-id', url: 'https://calendar.test/', title: 'My calendar', favicon: null, rank: 'a0', createdAt: 1 };
        there.favorites['twice'] = { id: 'twice', url: 'https://calendar.test/', title: 'Again', favicon: null, rank: 'b0', createdAt: 1 };
      },
      (p) => {
        expect(p.favorites).toEqual([expect.objectContaining({ id: 'fav', title: 'My calendar' })]);
        expect(p.counts.new.favorites).toBe(0);
      },
    ],
    [
      'an allow from a file is dropped; a block comes in',
      (_here, there) => {
        there.sitePermissions['https://meet.test'] = { camera: 'allow', microphone: 'block' };
        there.sitePermissions['https://ads.test'] = { notifications: 'block', location: 'allow' };
      },
      (p) => expect(p.blocks).toEqual({ 'https://meet.test': ['microphone'], 'https://ads.test': ['notifications'] }),
    ],
    [
      'a block older than an allow here leaves the allow',
      (here, there) => {
        there.sitePermissions['https://meet.test'] = { camera: 'block' };
        here.sitePermissions['https://meet.test'] = { camera: 'allow' };
      },
      (p) => expect(p.blocks).toEqual({ 'https://meet.test': ['camera'] }),
    ],
    [
      'a tab whose folder isn’t anywhere goes to its section’s root; one whose chord isn’t anywhere stays out',
      (_here, there) => {
        there.nodes['lost'] = tab('lost', 'work', { parentId: 'nowhere' });
        there.nodes['orphan'] = tab('orphan', 'gone');
      },
      (p) => {
        expect(p.nodes.find((n) => n.id === 'lost')).toMatchObject({ parentId: null, section: 'pinned' });
        expect(p.nodes.some((n) => n.id === 'orphan')).toBe(false);
        expect(p.unreadable).toBe(1);
      },
    ],
    [
      'folders inside each other (moved on two computers) end at the root',
      (_here, there) => {
        there.nodes['a'] = { kind: 'folder', id: 'a', chordId: 'work', section: 'pinned', parentId: 'b', rank: 'c0', title: 'A', collapsed: false, createdAt: 1 };
        there.nodes['b'] = { kind: 'folder', id: 'b', chordId: 'work', section: 'pinned', parentId: 'a', rank: 'd0', title: 'B', collapsed: false, createdAt: 1 };
      },
      (p) => {
        const a = p.nodes.find((x) => x.id === 'a')!;
        const b = p.nodes.find((x) => x.id === 'b')!;
        expect([a.parentId, b.parentId]).toContain(null);
        // Parents before what's in them.
        const order = p.nodes.map((x) => x.id);
        const child = a.parentId === null ? 'b' : 'a';
        expect(order.indexOf(child)).toBeGreaterThan(order.indexOf(child === 'a' ? 'b' : 'a'));
      },
    ],
    [
      'an id that’s a folder here and a tab there isn’t the same thing',
      (_here, there) => {
        delete there.nodes['folder'];
        there.nodes['folder'] = tab('folder', 'work');
        there.nodes['mail'] = { ...(there.nodes['mail'] as TabNode), parentId: null };
      },
      (p) => expect(p.nodes.some((x) => x.id === 'folder')).toBe(false),
    ],
  ])('into a profile with data: %s', (_what, change, check) => {
    const here = used();
    const there = used();
    change(here, there);
    // Here is newer than the file, except what the file changes: the file's records are stamped later.
    const local = recordsOf(here, mid);
    const file = recordsOf(there, old).map((r) => (JSON.stringify(r.set) === JSON.stringify(local.find((l) => l.type === r.type && l.id === r.id)?.set) ? r : { ...r, at: late }));
    const p = plan(local, file);
    expect(p.newProfile).toBe(false);
    expect(p.makeWay).toBeNull();
    check(p);
  });

  it('weighs field by field: the newer stamp wins, ours stays where it’s newer', () => {
    const here = used();
    const local = recordsOf(here, mid);
    const file: DataRecord[] = [
      { type: 'chord', id: 'work', at: old, set: { name: 'Old name', icon: 'O' } },
      { type: 'chord', id: 'work', at: late, set: { theme: { stops: [{ l: 0.5, c: 0.1, h: 10 }], grain: 0.3, appearance: 'dark' } } },
    ];
    const p = plan(local, file);
    expect(p.chords).toEqual([expect.objectContaining({ id: 'work', name: 'Work', icon: 'W', theme: expect.objectContaining({ appearance: 'dark', grain: 0.3 }) })]);
  });

  it('a tombstone in a file neither deletes here nor brings the thing in', () => {
    const here = used();
    const file: DataRecord[] = [
      { type: 'chord', id: 'work', at: late, set: { deleted: true } },
      { type: 'chord', id: 'gone', at: old, set: { name: 'Gone', icon: 'G', theme: THEME, rank: 'z0', profile: 'default' } },
      { type: 'chord', id: 'gone', at: late, set: { deleted: true } },
    ];
    const p = plan(recordsOf(here, mid), file);
    expect(p.chords).toEqual([]);
    const after = applyPlan(here, p);
    expect(Object.keys(after.chords).sort()).toEqual(['home', 'work']);
  });

  it('settings: listed either way, in the plan only with Settings from the file; a value Chord can’t use stays out; one still at its default here counts as never set', () => {
    const here = used();
    here.settings.adBlocking.enabled = true;
    const local = recordsOf(here, mid);
    const file: DataRecord[] = [{ type: 'settings', id: 'settings', at: old, set: { searchEngine: 'evil.example', 'adBlocking.enabled': false, colorScheme: 'dark', 'motion.sidebar': false, proxy: { mode: 'server', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080, bypass: [] }, pac: null } } }];
    const off = plan(local, file, { effects: true, settings: false });
    // Older than ours, but ours are still Chord's defaults: never set, as far as Chord can tell.
    expect(off.changes.map((c) => `${c.label}: ${c.from} → ${c.to}`)).toEqual([
      'Animate the sidebar: On → Off',
      'Color scheme: The system’s → Dark',
      'Block ads and trackers: On → Off',
      'Proxy for every chord: The system’s proxy → SOCKS5 proxy at 10.0.0.2:1080',
    ]);
    expect(off.settings).toBeNull();
    const on = plan(local, file);
    expect(on.settings).toEqual({ adBlocking: { enabled: false }, colorScheme: 'dark', motion: { sidebar: false }, proxy: expect.objectContaining({ mode: 'server' }) });
  });

  it('settings changed here since stay ours; Google-free mode and Google search can’t both win', () => {
    const here = used();
    const local = recordsOf(here, mid, { settings: { colorScheme: 'light' } });
    const file: DataRecord[] = [{ type: 'settings', id: 'settings', at: late, set: { googleFree: true, searchEngine: 'google' } }, { type: 'settings', id: 'settings', at: old, set: { colorScheme: 'dark' } }];
    const p = plan(local, file);
    expect(p.settings).toEqual({ googleFree: true, searchEngine: 'duckduckgo' });
  });

  it('a chord’s own proxy is named, and comes only with Settings from the file; a chord here keeps its sign-ins', () => {
    const here = used();
    here.chords['work'] = chord('work', { name: 'Work', profileId: 'mine' });
    const there = used();
    const proxy = { mode: 'server' as const, server: { scheme: 'http' as const, host: 'proxy.corp.test', port: 3128, bypass: [] }, pac: null };
    there.chords['work'] = chord('work', { name: 'Work', profileId: 'theirs', proxy });
    there.chords['lab'] = chord('lab', { name: 'Lab', profileId: 'mine', proxy, rank: 'c0' });
    const local = recordsOf(here, old);
    const off = plan(local, recordsOf(there, late), { effects: true, settings: false });
    expect(off.changes.map((c) => c.label)).toEqual(['Work’s own proxy', 'Lab’s own proxy']);
    expect(off.chords.find((c) => c.id === 'work')).toBeUndefined();
    const lab = off.chords.find((c) => c.id === 'lab')!;
    // Its own sign-ins, but not Work's here: a profile of its own.
    expect(lab.profileId).not.toBe('mine');
    expect(lab.proxy).toBeUndefined();
    expect(off.proxies).toEqual({});
    expect(mergeParts(off).some((part) => part.proxies)).toBe(false);
    // On: apart from the chords, which never carry one.
    const on = plan(local, recordsOf(there, late));
    expect(on.chords.find((c) => c.id === 'work')).toBeUndefined();
    expect(on.chords.find((c) => c.id === 'lab')!.proxy).toBeUndefined();
    expect(on.proxies).toEqual({ work: proxy, lab: proxy });
    expect(mergeParts(on).at(-1)!.proxies).toEqual(on.proxies);
  });

  it('with Settings from the file off, a chord here keeps its own proxy, password and all, though its name changes', () => {
    const before = used();
    const secret = { mode: 'pac' as const, server: null, pac: 'https://me:hunter2@proxy.corp.test/proxy.pac' };
    before.chords['work'] = chord('work', { name: 'Work', profileId: 'mine', proxy: secret as never });
    const there = used();
    there.chords['work'] = chord('work', { name: 'Work, renamed', profileId: 'mine', proxy: { mode: 'server', server: { scheme: 'http', host: 'evil.test', port: 8080, bypass: [] }, pac: null } });
    // This computer's records hold its proxy as an export would: without the password.
    const p = plan(recordsOf(before, old), recordsOf(there, late), { effects: true, settings: false });
    expect(p.chords).toEqual([expect.objectContaining({ id: 'work', name: 'Work, renamed' })]);
    expect(p.chords[0]).not.toHaveProperty('proxy');
    const after = applyPlan(before, p);
    expect(after.chords['work']).toMatchObject({ name: 'Work, renamed', proxy: before.chords['work']!.proxy });
    // Nor does a chord that comes in a part carry one: only `proxies` sets it.
    const sneaky = apply(before, { t: 'data.merge', importId: 'imp2', chords: [chord('work', { name: 'W', profileId: 'mine', proxy: { mode: 'none' } as never }), chord('new', { profileId: 'own', proxy: { mode: 'none' } as never, rank: 'z0' })] }, { now: NOW, newId }).state;
    expect(sneaky.chords['work']!.proxy).toEqual(before.chords['work']!.proxy);
    expect(sneaky.chords['new']).not.toHaveProperty('proxy');
    // With it on, `proxies` sets it, and Undo puts the one before back.
    const on = applyPlan(before, plan(recordsOf(before, old), recordsOf(there, late)), 'imp3');
    expect(on.chords['work']!.proxy).toMatchObject({ mode: 'server', server: { host: 'evil.test' } });
    expect(undo(on, 'imp3').chords['work']!.proxy).toEqual(before.chords['work']!.proxy);
  });

  it('Effects: listed with or without their switch; a merge that would leave a site empty leaves it alone', () => {
    const here = used();
    const local = recordsOf(here, mid, { effects: [effects('news.test', 'h1 { color: red }')] });
    const file = recordsOf(used(), late, { effects: [effects('news.test', 'h1 { color: blue }'), effects('blog.test', 'p { margin: 0 }'), effects('empty.test', '')] });
    const off = plan(local, file, { effects: false, settings: false });
    expect(off.effectsSites).toEqual([
      { host: 'news.test', new: false },
      { host: 'blog.test', new: true },
    ]);
    expect(off.effects).toEqual([]);
    const on = plan(local, file);
    expect(on.effects.map((s) => [s.host, s.css])).toEqual([
      ['news.test', 'h1 { color: blue }'],
      ['blog.test', 'p { margin: 0 }'],
    ]);
  });

  it('a newer Chord’s types are counted and passed over', () => {
    const p = plan(recordsOf(used(), mid), [
      { type: 'reading-list', id: 'r1', set: { url: 'https://a.test/' } },
      { type: 'reading-list', id: 'r2', set: {} },
    ]);
    expect(p.skipped).toBe(2);
  });

  it('imported twice, a file brings nothing the second time', () => {
    const there = used();
    const first = plan(recordsOf(fresh(), mid), recordsOf(there, old));
    const after = applyPlan(fresh(), first);
    // What's here is now the file's, stamped as this computer stamps its rows.
    const again = plan(recordsOf(after, late), recordsOf(there, old));
    expect(again.chords).toEqual([]);
    expect(again.nodes).toEqual([]);
    expect(again.favorites).toEqual([]);
    expect(Object.keys(again.blocks)).toEqual([]);
  });

  it('comes in parts of at most 200, chords first and the first-run chord making way last', () => {
    const there = used();
    for (let i = 0; i < 450; i++) there.nodes[`t${i}`] = tab(`t${i}`, 'home', { rank: `a${String(i).padStart(4, '0')}` });
    const p = plan(recordsOf(fresh(), mid), recordsOf(there, old));
    const parts = mergeParts(p);
    for (const part of parts) {
      const size = (part.chords?.length ?? 0) + (part.nodes?.length ?? 0) + (part.favorites?.length ?? 0) + (part.routes?.length ?? 0) + Object.keys(part.zoom ?? {}).length + Object.keys(part.blocks ?? {}).length;
      expect(size).toBeLessThanOrEqual(200);
    }
    expect(parts[0]!.chords).toHaveLength(2);
    expect(parts.at(-1)!.makeWay).toEqual(p.makeWay);
    expect(parts.flatMap((part) => part.nodes ?? [])).toHaveLength(453);
  });

  it('a split comes in whole, past a part’s 200 things, and never as an empty split, wherever an import stops', () => {
    // The repro: a chord with 250 Today tabs and a split of 2 more, into a new profile.
    const there = emptyState();
    there.chords['big'] = chord('big', { name: 'Big' });
    const ranks = generateNKeysBetween(null, null, 251);
    for (let i = 0; i < 250; i++) there.nodes[`t${i}`] = tab(`t${i}`, 'big', { section: 'today', pinnedUrl: null, rank: ranks[i]! });
    there.nodes['split'] = { kind: 'split', id: 'split', chordId: 'big', section: 'today', parentId: null, rank: ranks[250]!, direction: 'row', sizes: [0.5, 0.5], createdAt: 1 };
    there.nodes['left'] = tab('left', 'big', { section: 'today', pinnedUrl: null, parentId: 'split', rank: 'a0' });
    there.nodes['right'] = tab('right', 'big', { section: 'today', pinnedUrl: null, parentId: 'split', rank: 'b0' });
    const p = plan(recordsOf(fresh(), mid), recordsOf(there, old));
    expect(p.newProfile).toBe(true);
    const parts = mergeParts(p);
    expect(parts.length).toBeGreaterThan(1);
    const holding = parts.filter((part) => part.nodes?.some((n) => n.id === 'split' || n.parentId === 'split'));
    expect(holding).toHaveLength(1);
    expect(holding[0]!.nodes!.filter((n) => n.id === 'split' || n.parentId === 'split').map((n) => n.id)).toEqual(['split', 'left', 'right']);
    const after = applyPlan(fresh(), p);
    expect(after.nodes['split']).toMatchObject({ kind: 'split', sizes: [0.5, 0.5] });
    expect([after.nodes['left']!.parentId, after.nodes['right']!.parentId]).toEqual(['split', 'split']);
    // Stopped after any part (Undo cancels it): no split without its tabs.
    let s = fresh();
    const ctx = { now: NOW, newId };
    for (const part of parts) {
      s = apply(s, { t: 'data.merge', importId: 'imp', ...part }, ctx).state;
      for (const node of Object.values(s.nodes)) if (node.kind === 'split') expect(Object.values(s.nodes).filter((n) => n.parentId === node.id).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('brings at most so many new chords, tabs and folders, and folders only so deep, and says what it left out', () => {
    const there = emptyState();
    for (let i = 0; i < IMPORT_LIMITS.chords + 3; i++) there.chords[`c${i}`] = chord(`c${i}`, { rank: `a${String(i).padStart(4, '0')}` });
    // Tabs of a chord past the limit are left out with it.
    there.nodes['lost'] = tab('lost', `c${IMPORT_LIMITS.chords + 1}`);
    for (let i = 0; i < IMPORT_LIMITS.tabs + 5; i++) there.nodes[`t${i}`] = tab(`t${i}`, 'c0', { section: 'today', pinnedUrl: null, rank: `a${String(i).padStart(6, '0')}` });
    for (let i = 0; i < IMPORT_LIMITS.folders + 2; i++) there.nodes[`f${i}`] = { kind: 'folder', id: `f${i}`, chordId: 'c1', section: 'pinned', parentId: null, rank: `a${String(i).padStart(5, '0')}`, title: `F${i}`, collapsed: false, createdAt: 1 };
    // One already here is updated whatever the count, though it comes after.
    const p = plan(recordsOf(used(), mid), [...recordsOf(there, old), { type: 'chord', id: 'work', at: late, set: { name: 'Work, renamed' } }]);
    expect(p.chords).toHaveLength(IMPORT_LIMITS.chords + 1);
    expect(p.chords.at(-1)).toMatchObject({ id: 'work', name: 'Work, renamed' });
    expect(p.counts.new.todayTabs).toBe(IMPORT_LIMITS.tabs);
    expect(p.counts.new.folders).toBe(IMPORT_LIMITS.folders);
    // The first of each, in the file's order; a chord's tabs go with it.
    expect(p.nodes.some((n) => n.id === 't0') && !p.nodes.some((n) => n.id === `t${IMPORT_LIMITS.tabs}`)).toBe(true);
    expect(p.nodes.some((n) => n.id === 'lost')).toBe(false);
    expect(p.capped).toEqual({ chords: 3, tabs: 5 + 1, folders: 2, deep: 0 });
    expect(p.unreadable).toBe(0);
  });

  it('nests folders no deeper than the limit, moving a deeper one up with what’s in it', () => {
    const there = used();
    for (let i = 0; i < IMPORT_LIMITS.depth + 3; i++) there.nodes[`d${i}`] = { kind: 'folder', id: `d${i}`, chordId: 'home', section: 'pinned', parentId: i === 0 ? null : `d${i - 1}`, rank: 'a0', title: `D${i}`, collapsed: false, createdAt: 1 };
    there.nodes['deepest'] = tab('deepest', 'home', { parentId: `d${IMPORT_LIMITS.depth + 2}` });
    const p = plan(recordsOf(used(), mid), recordsOf(there, old));
    const parentOf = (id: string) => p.nodes.find((n) => n.id === id)!.parentId;
    expect(p.capped.deep).toBe(1);
    expect(parentOf(`d${IMPORT_LIMITS.depth - 1}`)).toBe(`d${IMPORT_LIMITS.depth - 2}`);
    expect(parentOf(`d${IMPORT_LIMITS.depth}`)).toBeNull();
    expect(parentOf(`d${IMPORT_LIMITS.depth + 1}`)).toBe(`d${IMPORT_LIMITS.depth}`);
    expect(parentOf('deepest')).toBe(`d${IMPORT_LIMITS.depth + 2}`);
    const order = p.nodes.map((n) => n.id);
    for (const node of p.nodes) if (node.parentId && order.includes(node.parentId)) expect(order.indexOf(node.parentId)).toBeLessThan(order.indexOf(node.id));
  });

  it.each<[string, (s: State) => void, { pages: number; chats: number } | null, Record<string, unknown>, boolean]>([
    ['a first run, as it is', () => undefined, NOTHING, {}, true],
    ['a first run that answered Safe Browsing’s notice and looked at a few pages', () => undefined, { pages: FRESH_PAGES, chats: 0 }, { safeBrowsing: false, safeBrowsingAsked: true, autoPip: false }, true],
    ['nothing known of history or chats', () => undefined, null, {}, false],
    ['a Duet chat', () => undefined, { pages: 0, chats: 1 }, {}, false],
    ['more history than a few pages', () => undefined, { pages: FRESH_PAGES + 1, chats: 0 }, {}, false],
    ['a second Today tab', (s) => void (s.nodes['two'] = tab('two', 'first', { section: 'today', pinnedUrl: null, rank: 'b0' })), NOTHING, {}, false],
    ['a pinned tab', (s) => void (s.nodes['pin'] = tab('pin', 'first')), NOTHING, {}, false],
    ['a page zoom', (s) => void (s.siteZoom['a.test'] = 1.5), NOTHING, {}, false],
    ['a blocked permission', (s) => void (s.sitePermissions['https://a.test'] = { camera: 'block' }), NOTHING, {}, false],
    ['a second chord', (s) => void (s.chords['two'] = chord('two', { rank: 'b0' })), NOTHING, {}, false],
    ['a setting changed', () => undefined, NOTHING, { searchEngine: 'duckduckgo' }, false],
    ['a keyboard shortcut changed', () => undefined, NOTHING, { shortcuts: { 'tab.new': ['Ctrl+J'] } }, false],
  ])('a fresh Chord, restored from a file, is only a clearly fresh one: %s', (_what, change, here, settings, fresh_) => {
    const state = fresh();
    change(state);
    const p = plan(recordsOf(state, mid, { settings }), recordsOf(used(), old), ALL, here);
    expect(p.newProfile).toBe(fresh_);
    expect(p.makeWay === null).toBe(!fresh_);
  });

  it('keeps of a file’s setup only the fields it reads', () => {
    const junk = 'x'.repeat(100_000);
    const r = setupRecord({ type: 'chord', id: 'c1', at: old, set: { name: 'Work', icon: 'W', rank: 'a0', profile: 'default', junk, extra: { deep: junk } } }, 'linux');
    expect(r).toEqual({ type: 'chord', id: 'c1', at: old, set: { name: 'Work', icon: 'W', rank: 'a0', profile: 'default' } });
    expect(setupRecord({ type: 'settings', id: 'settings', set: { searchEngine: 'kagi', 'shortcuts.other': {}, 'shortcuts.mac': { x: 1 }, made_up: junk } }, 'linux')!.set).toEqual({ searchEngine: 'kagi', 'shortcuts.other': {} });
    expect(setupRecord({ type: 'page', id: 'https://a.test/', set: {} }, 'linux')).toBeNull();
  });

  it('brings a page’s newest visits, a batch’s worth at a time, however many a line holds', () => {
    const visits = Array.from({ length: 2_000_000 }, (_, i) => i + 1);
    const shares = pageShares({ url: 'https://a.test/', title: 'A', visits, typed: 7 }, 1000);
    expect(shares).toHaveLength(MAX_PAGE_VISITS / 1000);
    expect(shares.every((s) => s.visits.length === 1000)).toBe(true);
    expect(shares[0]!.visits[0]).toBe(2_000_000 - MAX_PAGE_VISITS + 1);
    expect(shares.at(-1)!.visits.at(-1)).toBe(2_000_000);
    expect(shares.map((s) => s.typedCount)).toEqual([7, ...Array.from({ length: shares.length - 1 }, () => undefined)]);
  });
});

describe('what an import says it brought', () => {
  const none = { chords: 0, tabs: 0, favorites: 0, other: 0, effects: 0, settings: 0, pages: 0, chats: 0 };
  it.each<[Partial<typeof none>, string]>([
    [{ chords: 2, tabs: 40, favorites: 3, pages: 3000 }, 'Imported 2 chords, 40 tabs, 3 Favorites and 3,000 pages of history'],
    [{ tabs: 1 }, 'Imported 1 tab'],
    [{ effects: 2, settings: 1, chats: 1 }, 'Imported Effects for 2 sites, 1 setting and 1 Duet chat'],
    [{ other: 4 }, 'Imported your setup'],
    [{}, 'Everything in the file was here already'],
  ])('%j → %s', (counts, text) => {
    expect(importedText({ ...none, ...counts })).toBe(text);
  });
});

describe('data.merge and its Undo', () => {
  it('restores a file into a new profile: the first-run chord makes way, its tab moves, nothing loads; Undo puts it all back', () => {
    const before = fresh();
    const first = Object.keys(before.chords)[0]!;
    const there = used();
    there.nodes['today'] = tab('today', 'home', { section: 'today', pinnedUrl: null });
    const p = plan(recordsOf(before, mid), recordsOf(there, old, { settings: { colorScheme: 'dark' } }));
    const after = applyPlan(before, p);
    expect(Object.keys(after.chords).sort()).toEqual(['home', 'work']);
    // The first-run chord's tab went to the first of the file's chords, and the window with it.
    expect(after.nodes['first']).toMatchObject({ chordId: 'work', section: 'today' });
    expect(after.windows['first']).toMatchObject({ activeChordId: 'work', activeTab: { work: 'first' } });
    expect(after.nodes['mail']).toMatchObject({ chordId: 'work', parentId: 'folder', pinnedUrl: 'https://mail.test/' });
    // Unloaded: only the tab already showing has a page.
    expect(Object.keys(after.live)).toEqual(['first']);
    expect(after.settings.colorScheme).toBe('dark');
    expect(after.favorites['fav']).toBeDefined();
    expect(after.sitePermissions).toEqual({});

    const back = undo(after);
    expect(setupOf(back)).toEqual(setupOf(before));
    expect(back.windows['first']).toMatchObject({ activeChordId: first, activeTab: { [first]: 'first' } });
    expect(back.imports).toEqual({});
  });

  it('into a profile with data: updates, blocks, settings, themes, routes and zoom, each put back by Undo', () => {
    const before = used();
    before.nodes['docs'] = { ...(before.nodes['docs'] as TabNode), favicon: 'data:image/png;base64,AAAA' };
    const there = used();
    there.chords['work'] = { ...there.chords['work']!, name: 'Work stuff' };
    there.nodes['docs'] = tab('docs', 'work', { parentId: 'folder', title: 'Docs, moved' });
    there.nodes['new'] = tab('new', 'home', { section: 'today', pinnedUrl: null });
    there.favorites['fav'] = { ...there.favorites['fav']!, title: 'Cal' };
    there.settings.themes = [{ id: 'theme-1', name: 'Late Night', stops: [{ l: 0.5, c: 0.2, h: 280 }], grain: 0.3 }];
    there.linkRoutes['github.com'] = { host: 'github.com', chordId: 'home', createdAt: 1 };
    there.siteZoom['docs.test'] = 1.5;
    there.sitePermissions['https://meet.test'] = { camera: 'block' };
    const p = plan(recordsOf(before, mid), recordsOf(there, late, { settings: { searchEngine: 'kagi' } }));
    const after = applyPlan(before, p);
    expect(after.chords['work']!.name).toBe('Work stuff');
    // Moved into the folder, keeping its icon and when it was last shown.
    expect(after.nodes['docs']).toMatchObject({ parentId: 'folder', title: 'Docs, moved', favicon: 'data:image/png;base64,AAAA', lastActiveAt: 1 });
    expect(after.nodes['new']).toMatchObject({ chordId: 'home', section: 'today' });
    expect(after.live['new']).toBeUndefined();
    expect(after.favorites['fav']!.title).toBe('Cal');
    expect(after.settings.themes.map((t) => t.name)).toEqual(['Late Night']);
    expect(after.linkRoutes['github.com']!.chordId).toBe('home');
    expect(after.siteZoom['docs.test']).toBe(1.5);
    expect(after.sitePermissions['https://meet.test']).toEqual({ camera: 'block' });
    expect(after.settings.searchEngine).toBe('kagi');

    const back = undo(after);
    expect(setupOf(back)).toEqual(setupOf(before));
  });

  it('Undo leaves a setting you changed since as you set it', () => {
    const before = used();
    const p = plan(recordsOf(before, mid), [{ type: 'settings', id: 'settings', at: late, set: { searchEngine: 'kagi' } }]);
    let after = applyPlan(before, p);
    after = apply(after, { t: 'settings.set', settings: { searchEngine: 'bing' } }, { now: NOW, newId }).state;
    expect(undo(after).settings.searchEngine).toBe('bing');
  });

  it.each<[string, Omit<Extract<Command, { t: 'data.merge' }>, 't' | 'importId'>, (s: State) => void]>([
    ['never an allow', { blocks: { 'https://meet.test': ['camera', 'allow' as never] } }, (s) => expect(s.sitePermissions['https://meet.test']).toEqual({ camera: 'block' })],
    ['never a permission for something that isn’t an origin', { blocks: { 'javascript:alert(1)': ['camera'] } }, (s) => expect(s.sitePermissions['javascript:alert(1)']).toBeUndefined()],
    ['never a tab that isn’t a web page', { nodes: [tab('evil', 'work', { url: 'javascript:alert(1)' })] }, (s) => expect(s.nodes['evil']).toBeUndefined()],
    ['never a Favorite that isn’t a web page', { favorites: [{ id: 'f2', url: 'file:///etc/passwd', title: 'x', favicon: null, rank: 'z', createdAt: 1 }] }, (s) => expect(s.favorites['f2']).toBeUndefined()],
    ['never into a private window’s chord', { nodes: [tab('sneak', 'private')] }, (s) => expect(s.nodes['sneak']).toBeUndefined()],
    ['never a chord with a private window’s sign-ins', { chords: [chord('spy', { profileId: 'private-w9' })] }, (s) => expect(s.chords['spy']).toBeUndefined()],
    ['never a chord’s other sign-ins: one here keeps its own', { chords: [chord('work', { name: 'Work', profileId: 'elsewhere' })] }, (s) => expect(s.chords['work']!.profileId).toBe('default')],
    ['never a folder inside itself', { nodes: [{ kind: 'folder', id: 'folder', chordId: 'work', section: 'pinned', parentId: 'mail', rank: 'a0', title: 'Reading', collapsed: false, createdAt: 1 } as SidebarNode] }, (s) => expect(s.nodes['folder']!.parentId).toBeNull()],
  ])('the reducer checks again: %s', (_what, part, check) => {
    const state = used();
    state.chords['private'] = chord('private', { private: true, profileId: 'private-w9' });
    check(apply(state, { t: 'data.merge', importId: 'imp', ...part }, { now: NOW, newId }).state);
  });

  it('a part that arrives while Undo is under way changes nothing', () => {
    const before = used();
    const part = { chords: [chord('late', { rank: 'z0' })], nodes: [tab('x', 'work', { rank: 'x0' }), tab('y', 'work', { rank: 'y0' })] };
    let s = apply(before, { t: 'data.merge', importId: 'imp', ...part }, { now: NOW, newId }).state;
    s = apply(s, { t: 'import.undo', importId: 'imp', limit: 1 }, { now: NOW, newId }).state;
    expect(s.imports['imp']).toBeDefined();
    s = apply(s, { t: 'data.merge', importId: 'imp', nodes: [tab('later', 'work')] }, { now: NOW, newId }).state;
    expect(s.nodes['later']).toBeUndefined();
    expect(setupOf(undo(s))).toEqual(setupOf(before));
  });

  it('a settings patch goes through settings.set’s checks', () => {
    const s = apply(used(), { t: 'data.merge', importId: 'imp', settings: { ...defaultSettings(), googleFree: true, searchEngine: 'google', safeBrowsing: true } }, { now: NOW, newId }).state;
    expect(s.settings).toMatchObject({ googleFree: true, searchEngine: 'duckduckgo', safeBrowsing: false });
  });
});

describe('same', () => {
  it('is exactly whether two values write out the same (keys in any order), without writing them out: a seeded table of JSON values', () => {
    let seed = 7;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const value = (depth: number): unknown => {
      const r = next();
      if (depth > 2 || r < 0.35) return [null, undefined, 0, -0, 1, 1.5, NaN, '', 'a', 'b', true, false][Math.floor(next() * 12)];
      if (r < 0.65) return Array.from({ length: Math.floor(next() * 3) }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(next() * 3) }, () => [['x', 'y', 'z'][Math.floor(next() * 3)]!, value(depth + 1)]));
    };
    const reorder = (v: unknown): unknown => (Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v);
    for (let i = 0; i < 4000; i++) {
      const a = value(0);
      const b = next() < 0.5 ? reorder(a) : value(0);
      expect(same(a, b), JSON.stringify([a, b])).toBe(stable(a) === stable(b));
    }
    expect(same({ css: 'h1 { color: red }'.repeat(4000), on: true }, { on: true, css: 'h1 { color: red }'.repeat(4000) })).toBe(true);
  });
});
