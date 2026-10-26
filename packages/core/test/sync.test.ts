/**
 * Sync's pure parts (S15 §4, §9 step 3): what another computer's records may
 * be, the field merge (concurrent edits, edit against delete, a thing brought
 * back, the same tab moved twice, settings that conflict, a newer Chord's
 * types kept and written back), what this computer stamps, what a change does
 * here (folders inside each other, a split and its panes, settings checked
 * together), and a property test: any set of logs, merged in any order and any
 * number of times, gives the same result.
 */
import { describe, expect, it } from 'vitest';
import {
  apply,
  checkSyncRecord,
  defaultSettings,
  emptyState,
  isGone,
  localChanges,
  localChordFields,
  localNodeFields,
  localSettingFields,
  mergeRecord,
  planApply,
  seedState,
  stable,
  SYNC_LIMITS,
  syncParts,
  thingKey,
  thingRecords,
  valuesOf,
  type ApplyContext,
  type Chord,
  type DataRecord,
  type SidebarNode,
  type Stamp,
  type State,
  type SyncChange,
  type SyncThing,
  type TabNode,
} from '../src';

const A = '00000000000000aa';
const B = '00000000000000bb';
const C = '00000000000000cc';
const NOW = 1_800_000_000_000;
const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const at = (ms: number, device = A, counter = 0): Stamp => [NOW - 1_000_000 + ms, counter, device];

const rec = (type: string, id: string, stamp: Stamp | undefined, set: Record<string, unknown>): DataRecord => (stamp ? { type, id, at: stamp, set } : { type, id, set });

/** Every record merged in order into a map of things, as chord-data's sync_record holds them. */
function mergeAll(records: readonly DataRecord[], into = new Map<string, SyncThing>()): Map<string, SyncThing> {
  for (const r of records) {
    const key = thingKey(r.type, r.id);
    into.set(key, mergeRecord(into.get(key), r).thing);
  }
  return into;
}
const canonical = (things: Map<string, SyncThing>) => stable([...things.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

describe('what another computer’s log may hold', () => {
  const ok = rec('chord', 'work', at(1), { name: 'Work' });
  it.each<[string, DataRecord, boolean]>([
    ['a chord', ok, true],
    ['history: never synced', rec('page', 'https://a.test/', undefined, { title: 'A', visits: [1] }), false],
    ['a Duet chat: never synced', rec('thread', 'th', undefined, { chord: 'work', title: 'T' }), false],
    ['a Duet message: never synced (a chat never gains turns through sync)', rec('message', 'm1', undefined, { thread: 'th' }), false],
    ['an image: never synced', rec('image', 'abcdefabcdefabcdefabcdef', undefined, { data: 'AAAA' }), false],
    ['zoom: this computer’s display', rec('zoom', 'docs.test', at(1), { factor: 1.25 }), false],
    ['a permission: never synced, not even a block', rec('permission', 'https://meet.test', at(1), { camera: 'allow' }), false],
    ['a chord without a stamp', rec('chord', 'work', undefined, { name: 'Work' }), false],
    ['a stamp more than a year ahead', rec('chord', 'work', [NOW + SYNC_LIMITS.aheadMs + 1, 0, A], { name: 'Work' }), false],
    ['an id that isn’t one', rec('tab', '../../etc', at(1), { title: 'x' }), false],
    ['a route whose id isn’t its own key', rec('route', 'https://GitHub.com/acme/', at(1), { chord: 'work' }), false],
    ['settings under another id', rec('settings', 'other', at(1), { searchEngine: 'google' }), false],
    ['a device that isn’t a computer’s id', rec('device', 'laptop', at(1), { name: 'X' }), false],
    ['a field name with a slash', rec('chord', 'work', at(1), { 'a/b': 1 }), false],
    ['too many fields', rec('chord', 'work', at(1), Object.fromEntries(Array.from({ length: SYNC_LIMITS.fields + 1 }, (_, i) => [`f${i}`, i]))), false],
    ['too big', rec('effects', 'news.test', at(1), { css: 'x'.repeat(SYNC_LIMITS.thingChars + 1) }), false],
    ['a newer Chord’s type: kept', rec('widget', 'w1', at(1), { size: 3 }), true],
    ['an icon that isn’t one', rec('icon', `sha256-${'0'.repeat(64)}`, undefined, { mime: 'text/html', data: 'AAAA' }), false],
  ])('%s', (_what, record, kept) => {
    expect(checkSyncRecord(record, NOW) !== null).toBe(kept);
  });

  it('an icon loses any stamp it came with: it’s a fact', () => {
    expect(checkSyncRecord(rec('icon', `sha256-${'a'.repeat(64)}`, at(1), { mime: 'image/png', data: 'AAAA' }), NOW)).toEqual({ type: 'icon', id: `sha256-${'a'.repeat(64)}`, set: { mime: 'image/png', data: 'AAAA' } });
  });

  it('a `deleted` that isn’t true or false is left out', () => {
    expect(checkSyncRecord(rec('chord', 'work', at(1), { deleted: 'yes', name: 'Work' }), NOW)?.set).toEqual({ name: 'Work' });
    expect(checkSyncRecord(rec('chord', 'work', at(1), { deleted: 1 }), NOW)).toBeNull();
  });
});

describe('the field merge', () => {
  it.each<[string, DataRecord[], Record<string, unknown>]>([
    ['the higher stamp wins', [rec('chord', 'w', at(2), { name: 'New' }), rec('chord', 'w', at(1), { name: 'Old' })], { name: 'New' }],
    ['edits to different fields both stay', [rec('chord', 'w', at(1, A), { name: 'Renamed' }), rec('chord', 'w', at(1, B), { icon: '🎵' })], { name: 'Renamed', icon: '🎵' }],
    ['concurrent edits to one field: the later stamp, wherever it came from', [rec('chord', 'w', at(5, B), { name: 'B’s' }), rec('chord', 'w', at(5, A, 1), { name: 'A’s' })], { name: 'A’s' }],
    ['equal stamps: the device breaks the tie', [rec('chord', 'w', at(5, A), { name: 'A’s' }), rec('chord', 'w', at(5, B), { name: 'B’s' })], { name: 'B’s' }],
    [
      'edit against delete: the delete stays, the edit is kept',
      [rec('chord', 'w', at(1), { name: 'Work' }), rec('chord', 'w', at(2, A), { deleted: true }), rec('chord', 'w', at(3, B), { name: 'Edited' })],
      { name: 'Edited', deleted: true },
    ],
    ['brought back: only `deleted: false` restores a thing', [rec('chord', 'w', at(2), { deleted: true }), rec('chord', 'w', at(3, B), { deleted: false, name: 'Back' })], { deleted: false, name: 'Back' }],
    [
      'the same tab moved twice: the later move wins whole',
      [
        rec('tab', 't', at(2, A), { pos: { chord: 'w', section: 'pinned', parent: 'f1', rank: 'a1' } }),
        rec('tab', 't', at(3, B), { pos: { chord: 'x', section: 'pinned', parent: null, rank: 'b0' } }),
      ],
      { pos: { chord: 'x', section: 'pinned', parent: null, rank: 'b0' } },
    ],
    ['an icon is a fact: the first one stays', [rec('icon', 'sha256-x', undefined, { mime: 'image/png', data: 'AA==' }), rec('icon', 'sha256-x', undefined, { mime: 'image/gif', data: 'BB==' })], { mime: 'image/png', data: 'AA==' }],
    ['a newer Chord’s field is kept beside the ones Chord knows', [rec('chord', 'w', at(1), { name: 'W', sparkle: 3 })], { name: 'W', sparkle: 3 }],
  ])('%s', (_what, records, values) => {
    const thing = mergeAll(records).values().next().value!;
    expect(valuesOf(thing)).toEqual(values);
  });

  it('says which fields changed: a newer stamp with the same value changes no value, only its stamp', () => {
    const first = mergeRecord(undefined, rec('chord', 'w', at(1), { name: 'W', icon: 'W' }));
    expect(first.changed.sort()).toEqual(['icon', 'name']);
    const again = mergeRecord(first.thing, rec('chord', 'w', at(2, B), { name: 'W', icon: 'X' }));
    expect(again.changed).toEqual(['icon']);
    expect(again.thing.fields['name']!.at).toEqual(at(2, B));
    expect(mergeRecord(again.thing, rec('chord', 'w', at(1), { name: 'Old' })).changed).toEqual([]);
  });

  it('a newer Chord’s types are kept as they came and written back, each field with its own stamp', () => {
    const things = mergeAll([rec('widget', 'w1', at(1, A), { size: 3 }), rec('widget', 'w1', at(2, B), { color: 'red' })]);
    const back = thingRecords(things.get(thingKey('widget', 'w1'))!);
    expect(back).toEqual([rec('widget', 'w1', at(1, A), { size: 3 }), rec('widget', 'w1', at(2, B), { color: 'red' })]);
    expect(canonical(mergeAll(back))).toBe(canonical(things));
  });
});

describe('a property: any set of logs, merged in any order and any number of times, gives the same result', () => {
  /** A small seeded generator, so a failure can be run again. */
  const random = (seed: number) => () => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff);
  const TYPES = ['chord', 'tab', 'settings', 'widget'] as const;
  const FIELDS = ['name', 'pos', 'deleted', 'title', 'extra'] as const;
  const DEVICES = [A, B, C] as const;

  function logs(rnd: () => number): DataRecord[][] {
    return DEVICES.map((device) =>
      Array.from({ length: 5 + Math.floor(rnd() * 25) }, () => {
        const type = TYPES[Math.floor(rnd() * TYPES.length)]!;
        const id = type === 'settings' ? 'settings' : `x${Math.floor(rnd() * 4)}`;
        const set: Record<string, unknown> = {};
        for (const field of FIELDS) {
          if (rnd() < 0.4) set[field] = field === 'deleted' ? rnd() < 0.5 : field === 'pos' ? { chord: `c${Math.floor(rnd() * 2)}`, rank: `a${Math.floor(rnd() * 3)}` } : `${field}-${Math.floor(rnd() * 3)}`;
        }
        if (Object.keys(set).length === 0) set['name'] = 'n';
        // Few distinct times, so equal stamps (other devices) and equal values happen often.
        return rec(type, id, [Math.floor(rnd() * 6), Math.floor(rnd() * 2), device], set);
      }),
    );
  }

  it.each(Array.from({ length: 60 }, (_, i) => i + 1))('seed %i', (seed) => {
    const rnd = random(seed);
    const all = logs(rnd);
    const expected = canonical(mergeAll(all.flat()));
    for (let trial = 0; trial < 8; trial++) {
      // Every record at least once, some twice, all shuffled; logs read whole or in pieces.
      const shuffled = all.flat().flatMap((r) => (rnd() < 0.3 ? [r, r] : [r]));
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const cut = Math.floor(rnd() * shuffled.length);
      const merged = mergeAll(shuffled.slice(cut), mergeAll(shuffled.slice(0, cut)));
      expect(canonical(merged)).toBe(expected);
      // Merging the result's own records again (a snapshot read twice) changes nothing.
      expect(canonical(mergeAll([...merged.values()].flatMap(thingRecords), merged))).toBe(expected);
    }
    // A snapshot of the result, read into an empty copy, is the result.
    const merged = mergeAll(all.flat());
    expect(canonical(mergeAll([...merged.values()].flatMap(thingRecords)))).toBe(expected);
  });
});

const chord = (id: string, extra: Partial<Chord> = {}): Chord => ({ id, profileId: 'default', name: id, icon: 'W', theme: THEME, rank: 'a0', createdAt: 1, ...extra });
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

describe('what this computer writes', () => {
  it('a chord without its own proxy, and never a private window’s', () => {
    const fields = localChordFields(chord('w', { profileId: 'own', proxy: { mode: 'server', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080, bypass: [] }, pac: null } as never }));
    expect(fields).not.toHaveProperty('proxy');
    expect(fields?.['profile']).toBe('own');
    expect(localChordFields(chord('p', { private: true }))).toBeNull();
  });

  it.each<[string, TabNode, Record<string, unknown> | null]>([
    ['a pinned tab on its home: its home, title and icon, never its address', tab('t', 'w'), { title: 't', icon: 'sha256-i', pinnedUrl: 'https://t.test/' }],
    ['browsed away from its home: no title or icon', tab('t', 'w', { url: 'https://t.test/elsewhere', title: 'Elsewhere' }), { pinnedUrl: 'https://t.test/' }],
    ['in Today: not synced at all', tab('t', 'w', { section: 'today', pinnedUrl: null }), null],
  ])('%s', (_what, node, expected) => {
    const fields = localNodeFields(node, 'sha256-i');
    if (expected === null) return void expect(fields).toBeNull();
    expect(fields).not.toHaveProperty('url');
    expect(fields).toMatchObject(expected);
    if (!('title' in expected)) expect(fields).not.toHaveProperty('title');
    if (!('icon' in expected)) expect(fields).not.toHaveProperty('icon');
  });

  it('settings: the ones that sync, a group part by part, this family’s shortcuts; never the proxy, the interface size or a one-time flag', () => {
    expect(localSettingFields('searchEngine', 'duckduckgo', 'linux')).toEqual({ searchEngine: 'duckduckgo' });
    expect(localSettingFields('adBlocking', { enabled: false, offSites: ['a.test'] }, 'linux')).toEqual({ 'adBlocking.enabled': false, 'adBlocking.offSites': ['a.test'] });
    expect(localSettingFields('shortcuts', { 'tab.new': ['Ctrl+N'] }, 'linux')).toEqual({ 'shortcuts.other': { 'tab.new': ['Ctrl+N'] } });
    for (const key of ['proxy', 'uiScale', 'onboarded', 'themes', 'devtools']) expect(localSettingFields(key, defaultSettings()[key as keyof ReturnType<typeof defaultSettings>], 'linux')).toBeNull();
  });

  describe('what gets a stamp', () => {
    const known = mergeAll([rec('chord', 'w', at(1), { name: 'W', icon: 'W' })]).get(thingKey('chord', 'w'))!;
    const gone = mergeAll([rec('chord', 'w', at(1), { name: 'W' }), rec('chord', 'w', at(2), { deleted: true })]).get(thingKey('chord', 'w'))!;
    it.each<[string, SyncThing | undefined, Record<string, unknown> | null, Record<string, unknown> | null, Record<string, unknown> | null]>([
      ['a field you changed', known, { name: 'W', icon: 'W' }, { name: 'Work', icon: 'W' }, { name: 'Work' }],
      ['nothing you changed', known, { name: 'W', icon: 'W' }, { name: 'W', icon: 'W' }, null],
      ['a change that’s the merged value already (it came from another computer)', known, { name: 'Old', icon: 'W' }, { name: 'W', icon: 'W' }, null],
      ['gone here, and known: a tombstone', known, { name: 'W' }, null, { deleted: true }],
      ['gone here, and never synced: nothing', undefined, { name: 'W' }, null, null],
      ['gone here, and gone already: nothing', gone, { deleted: true }, null, null],
      ['new here: every field', undefined, null, { name: 'New', icon: 'N' }, { name: 'New', icon: 'N' }],
      ['back after being gone (pinned again): every field, and deleted: false', gone, { deleted: true }, { name: 'W' }, { name: 'W', deleted: false }],
      ['a field it leaves out (a title off its home) isn’t a change', known, { name: 'W', icon: 'W' }, { name: 'W' }, null],
    ])('%s', (_what, merged, before, after, expected) => {
      expect(localChanges(merged, before, after)).toEqual(expected);
    });
  });
});

/** A merged copy for planApply, from records. */
function context(records: DataRecord[], local: Record<string, unknown> = {}): { ctx: ApplyContext; things: Map<string, SyncThing>; changed: SyncChange[] } {
  const things = new Map<string, SyncThing>();
  const changed = new Map<string, Set<string>>();
  for (const r of records) {
    const key = thingKey(r.type, r.id);
    const merged = mergeRecord(things.get(key), r);
    things.set(key, merged.thing);
    const names = changed.get(key) ?? new Set();
    for (const name of merged.changed) names.add(name);
    changed.set(key, names);
  }
  let n = 0;
  const ctx: ApplyContext = {
    get: (type, id) => things.get(thingKey(type, id)),
    panes: (splitId) => [...things.values()].filter((t) => t.type === 'tab' && !isGone(t) && (t.fields['pos']?.v as { parent?: string } | undefined)?.parent === splitId),
    localSettings: local,
    platform: 'linux',
    now: NOW,
    newId: () => `id-${++n}`,
  };
  return { ctx, things, changed: [...changed].map(([key, names]) => ({ thing: things.get(key)!, names: [...names] })) };
}
const pos = (chordId: string, parent: string | null, rank = 'a0') => ({ chord: chordId, section: 'pinned', parent, rank });

describe('what a change does here', () => {
  it('reads each thing through its Chord-file codec: no proxy, no private sign-ins, only web pages', () => {
    const { ctx, changed } = context([
      rec('chord', 'w', at(1), { name: 'Work', icon: 'W', theme: THEME, rank: 'a0', profile: 'default', proxy: { mode: 'none' } }),
      rec('chord', 'p', at(1), { name: 'Sneaky', icon: 'S', theme: THEME, rank: 'a1', profile: 'private-win' }),
      rec('tab', 't1', at(1), { pos: pos('w', null), pinnedUrl: 'https://mail.test/', title: 'Mail', customTitle: null, icon: null, muted: false, created: 1 }),
      rec('tab', 't2', at(1), { pos: pos('w', null), pinnedUrl: 'javascript:alert(1)', title: 'Bad' }),
      rec('favorite', 'f1', at(1), { url: 'javascript:alert(1)', title: 'Bad', rank: 'a0' }),
      rec('page', 'https://a.test/', undefined, { visits: [1] }),
    ]);
    const out = planApply(changed, ctx);
    expect(out.chords.map((c) => c.id)).toEqual(['w']);
    expect(out.chords[0]).not.toHaveProperty('proxy');
    expect(out.nodes.map((n) => [n.id, n.kind === 'tab' ? n.url : null])).toEqual([['t1', 'https://mail.test/']]);
    expect(out.favorites).toEqual([]);
  });

  it('a split goes with its panes, and waits until it has two', () => {
    const one = context([
      rec('split', 's', at(1), { pos: pos('w', null), direction: 'row', sizes: [0.5, 0.5], created: 1 }),
      rec('tab', 'a', at(1), { pos: pos('w', 's', 'a0'), pinnedUrl: 'https://a.test/', title: 'A' }),
    ]);
    const first = planApply(one.changed, one.ctx);
    expect(first.nodes.map((n) => n.id)).toEqual(['a']);
    expect(first.nodes[0]!.parentId).toBeNull();
    // The second pane arrives in a later batch: the split comes now, with both, in one part.
    const two = context([...[rec('split', 's', at(1), { pos: pos('w', null), direction: 'row', sizes: [0.5, 0.5], created: 1 }), rec('tab', 'a', at(1), { pos: pos('w', 's', 'a0'), pinnedUrl: 'https://a.test/', title: 'A' })], rec('tab', 'b', at(2), { pos: pos('w', 's', 'a1'), pinnedUrl: 'https://b.test/', title: 'B' })]);
    const second = planApply([two.changed.find((c) => c.thing.id === 'b')!], two.ctx);
    expect(second.nodes.map((n) => n.id)).toEqual(['s', 'a', 'b']);
    const parts = syncParts({ ...second, nodes: [...Array.from({ length: 199 }, (_, i) => ({ ...second.nodes[1]!, id: `x${i}`, parentId: null }) as SidebarNode), ...second.nodes] }, 200);
    expect(parts[1]!.nodes.map((n) => n.id)).toEqual(['s', 'a', 'b']);
  });

  it('folders moved into each other on two computers: every computer breaks the cycle the same way, the one moved last to the top', () => {
    const records = [
      rec('folder', 'fa', at(1), { pos: pos('w', null), title: 'A', collapsed: false, created: 1 }),
      rec('folder', 'fb', at(1), { pos: pos('w', null), title: 'B', collapsed: false, created: 1 }),
      rec('folder', 'fa', at(5, A), { pos: pos('w', 'fb') }),
      rec('folder', 'fb', at(6, B), { pos: pos('w', 'fa') }),
    ];
    for (const order of [records, [...records].reverse()]) {
      const { ctx, changed } = context(order);
      const out = planApply(changed, ctx);
      const where = Object.fromEntries(out.nodes.map((n) => [n.id, n.parentId]));
      expect(where).toEqual({ fa: 'fb', fb: null });
    }
  });

  it('settings are checked together: Google-free mode from one computer and Google search from another can’t both win', () => {
    const { ctx, changed } = context([rec('settings', 'settings', at(1, A), { googleFree: true }), rec('settings', 'settings', at(2, B), { searchEngine: 'google', 'adBlocking.enabled': 'not a switch' })]);
    const out = planApply(changed, ctx);
    expect(out.settings).toMatchObject({ googleFree: true });
    expect(out.settings?.searchEngine).not.toBe('google');
    expect(out.settings).not.toHaveProperty('adBlocking');
  });

  it('a tombstone names one thing of its type, and Effects that end up empty go', () => {
    const { ctx, changed } = context([
      rec('tab', 't', at(1), { pos: pos('w', null), pinnedUrl: 'https://t.test/', title: 'T' }),
      rec('tab', 't', at(2), { deleted: true }),
      rec('effects', 'news.test', at(1), { css: 'h1 { color: red }', hidden: [], presets: [], duet: [] }),
      rec('effects', 'news.test', at(2), { css: '' }),
      rec('widget', 'w1', at(1), { size: 3 }),
    ]);
    const out = planApply(changed, ctx);
    expect(out.gone.nodes).toEqual([{ id: 't', kind: 'tab' }]);
    expect(out.gone.effects).toEqual(['news.test']);
    expect(out.effects).toEqual([]);
  });
});

describe('sync.apply in the store', () => {
  const ctx = { now: NOW, newId: (() => {
    let n = 0;
    return () => `new-${++n}`;
  })() };
  function state(): State {
    const s = seedState({ now: NOW, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });
    const home = Object.keys(s.chords)[0]!;
    s.chords['w'] = chord('w', { rank: 'b0', profileId: 'mine', proxy: { mode: 'server', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080, bypass: [] }, pac: null } as never });
    s.nodes['t'] = tab('t', 'w', { url: 'https://t.test/inbox', title: 'Inbox' });
    s.live['t'] = { loading: false } as never;
    s.nodes['u'] = tab('u', 'w', { rank: 'a1' });
    void home;
    return s;
  }

  it('updates a chord but never its sign-ins or proxy; adds a new one with sign-ins no chord here has', () => {
    const before = state();
    const after = apply(before, { t: 'sync.apply', chords: [chord('w', { name: 'Renamed', profileId: 'other' }), chord('n', { profileId: 'mine', rank: 'c0' })] }, ctx).state;
    expect(after.chords['w']).toMatchObject({ name: 'Renamed', profileId: 'mine' });
    expect(after.chords['w']!.proxy).toEqual(before.chords['w']!.proxy);
    expect(after.chords['n']!.profileId).not.toBe('mine');
  });

  it('a tab keeps its own address and, off its home, its title; a new one opens at its home, unloaded', () => {
    const after = apply(state(), { t: 'sync.apply', nodes: [tab('t', 'w', { title: 'Mail', customTitle: 'Work mail' }), tab('n', 'w', { url: 'https://ignored.test/', pinnedUrl: 'https://new.test/', rank: 'b0' })] }, ctx).state;
    expect(after.nodes['t']).toMatchObject({ url: 'https://t.test/inbox', title: 'Inbox', customTitle: 'Work mail' });
    expect(after.nodes['n']).toMatchObject({ url: 'https://new.test/', pinnedUrl: 'https://new.test/' });
    expect(after.live['n']).toBeUndefined();
  });

  it('refuses a private window’s chord, folders out of Pinned, and parents that can’t hold what’s put in them', () => {
    const s = state();
    s.chords['p'] = chord('p', { private: true, profileId: 'private-x' });
    const after = apply(
      s,
      {
        t: 'sync.apply',
        nodes: [
          tab('x', 'p'),
          { kind: 'folder', id: 'f', chordId: 'w', section: 'today', parentId: null, rank: 'a0', title: 'F', collapsed: false, createdAt: 1 } as unknown as SidebarNode,
          tab('y', 'w', { parentId: 't' }),
        ],
      },
      ctx,
    ).state;
    expect(after.nodes['x']).toBeUndefined();
    expect(after.nodes['f']).toBeUndefined();
    expect(after.nodes['y']!.parentId).toBeNull();
  });

  it('what went: an open pinned tab moves to Today, an unloaded one goes; a chord goes with its tabs, never the last', () => {
    const after = apply(state(), { t: 'sync.apply', gone: { nodes: [{ id: 't', kind: 'tab' }, { id: 'u', kind: 'tab' }, { id: 'w', kind: 'folder' }] } }, ctx).state;
    expect(after.nodes['t']).toMatchObject({ section: 'today', pinnedUrl: null });
    expect(after.nodes['u']).toBeUndefined();
    const dropped = apply(state(), { t: 'sync.apply', gone: { chords: ['w'] } }, ctx).state;
    expect(dropped.chords['w']).toBeUndefined();
    expect(Object.values(dropped.nodes).some((n) => n.chordId === 'w')).toBe(false);
    const last = apply(emptyState(), { t: 'sync.apply', chords: [chord('only')] }, ctx).state;
    expect(apply(last, { t: 'sync.apply', gone: { chords: ['only'] } }, ctx).state.chords['only']).toBeDefined();
  });

  it('joining with the synced setup: this computer’s chords go, kept for Undo, and their Today tabs move', () => {
    const s = state();
    const home = Object.keys(s.chords).find((id) => id !== 'w')!;
    const today = Object.values(s.nodes).find((n) => n.chordId === home)!.id;
    const joined = apply(s, { t: 'sync.replace', chordIds: [home], to: 'w' }, ctx).state;
    expect(joined.chords[home]).toBeUndefined();
    expect(joined.nodes[today]).toMatchObject({ chordId: 'w', section: 'today' });
    const windowId = Object.keys(joined.windows)[0] ?? 'w1';
    const undone = apply({ ...joined, windows: { [windowId]: { id: windowId, activeChordId: 'w', activeTab: {}, sidebar: 'docked', sidebarWidth: 248, bounds: null } } }, { t: 'sync.unreplace', windowId, chordIds: [home] }, ctx).state;
    expect(undone.chords[home]).toBeDefined();
  });
});
