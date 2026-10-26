/**
 * Your data's records (S15 §1): every type, model → record → model, through
 * JSON as a file carries it; the fields that must never appear; which
 * settings travel; and records that aren't what they say.
 */
import { describe, expect, it } from 'vitest';
import {
  chordFromRecord,
  chordRecord,
  defaultSettings,
  effectsFromRecord,
  effectsRecord,
  favoriteFromRecord,
  favoriteRecord,
  iconFromRecord,
  iconId,
  iconRecord,
  imageFromRecord,
  imageRecord,
  isDataRecord,
  messageFromRecord,
  messageRecord,
  nodeFromRecord,
  nodeRecord,
  pageFromRecord,
  pageRecord,
  permissionFromRecord,
  permissionRecord,
  routeFromRecord,
  routeRecord,
  SETTING_TRAVEL,
  settingFields,
  settingsFromFields,
  settingsRecords,
  themeFromRecord,
  themeRecord,
  themeRecords,
  threadFromRecord,
  threadRecord,
  zoomFromRecord,
  zoomRecord,
  type Chord,
  type DataRecord,
  type DuetImage,
  type DuetMessage,
  type DuetThread,
  type Favorite,
  type FolderNode,
  type Settings,
  type SiteEffects,
  type SplitNode,
  type Stamp,
  type TabNode,
} from '../src';

const DEVICE = '9f2c4e1a7b3d5c60';
const at: Stamp = [1764511391204, 0, DEVICE];
const NOW = 1764600000000;
const ICON = iconId('ab'.repeat(32));
/** Through a file and back: what a reader sees is what JSON keeps. */
const viaFile = (r: DataRecord): DataRecord => JSON.parse(JSON.stringify(r)) as DataRecord;

const chord: Chord = {
  id: '019a3c2e-0000-7000-8000-000000000001',
  profileId: 'default',
  name: 'Work',
  icon: '💼',
  theme: { stops: [{ l: 0.72, c: 0.12, h: 250 }, { l: 0.6, c: 0.1, h: 300 }], grain: 0.2, appearance: 'auto', themeId: 'preset:dusk' },
  rank: 'a0',
  createdAt: 1700000000000,
};
const ownChord: Chord = {
  ...chord,
  id: '019a3c2e-0000-7000-8000-000000000002',
  name: 'Client',
  profileId: '019a3c2e-0000-7000-8000-0000000000ff',
  theme: { stops: [{ l: 0.7, c: 0.1, h: 30 }], grain: 0.1, appearance: 'dark' },
  proxy: { mode: 'server', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080, bypass: ['<local>'] }, pac: null },
};
const folder: FolderNode = { kind: 'folder', id: 'f1', chordId: chord.id, section: 'pinned', parentId: null, rank: 'a0', title: 'Reading', collapsed: true, createdAt: 1700000000100 };
const pinned: TabNode = {
  kind: 'tab',
  id: 't1',
  chordId: chord.id,
  section: 'pinned',
  parentId: 'f1',
  rank: 'a1',
  url: 'https://mail.example/inbox/42',
  title: 'Inbox (3)',
  pinnedUrl: 'https://mail.example/',
  customTitle: 'Mail',
  favicon: 'data:image/png;base64,iVBORw0KGgo=',
  lastActiveAt: 1764000000000,
  createdAt: 1700000000200,
  muted: true,
};
const { muted: _muted, ...unmuted } = pinned;
const today: TabNode = { ...unmuted, id: 't2', section: 'today', parentId: 's1', pinnedUrl: null, customTitle: null, favicon: null };
const split: SplitNode = { kind: 'split', id: 's1', chordId: chord.id, section: 'today', parentId: null, rank: 'b0', direction: 'column', sizes: [0.4, 0.6], createdAt: 1700000000300 };
const favorite: Favorite = { id: 'fav1', url: 'https://calendar.example/', title: 'Calendar', favicon: 'data:image/png;base64,AAAA', rank: 'a0', createdAt: 1700000000400 };
const thread: DuetThread = {
  id: 'th1',
  chordId: chord.id,
  title: 'Trip planning',
  provider: 'codex',
  model: 'gpt-5',
  providerSessionId: 'secret-session-0000',
  scope: 'chord',
  createdAt: 1764000000000,
  updatedAt: 1764000001000,
  lastUsedAt: 1764000002000,
};
const image: DuetImage = { id: '0123456789abcdef01234567', mime: 'image/png', width: 640, height: 480, prompt: 'A lighthouse at dusk', codexCopy: 'C:\\Users\\me\\.codex\\generated_images\\x.png' };
const effects: SiteEffects = {
  host: 'news.test',
  wet: true,
  css: 'h1 { color: red }',
  cssOn: true,
  hidden: [{ selector: '#ad', label: 'div#ad', on: false, at: 1764511391204 }],
  presets: ['dark'],
  duet: [],
  createdAt: 1764511391204,
  updatedAt: 1764511391204,
};

describe('every type, model → record → model', () => {
  it.each<[string, DataRecord, (r: DataRecord) => unknown, unknown]>([
    ['a chord that shares sign-ins', chordRecord(chord, at)!, chordFromRecord, chord],
    ['a chord with its own sign-ins and proxy', chordRecord(ownChord, at)!, chordFromRecord, ownChord],
    ['a folder', nodeRecord(folder, at), (r) => nodeFromRecord(r, NOW), { node: folder, icon: null }],
    ['a pinned tab, its icon by id, unloaded', nodeRecord(pinned, at, ICON), (r) => nodeFromRecord(r, NOW), { node: { ...pinned, favicon: null, lastActiveAt: NOW }, icon: ICON }],
    ['a Today tab in a split', nodeRecord(today, at), (r) => nodeFromRecord(r, NOW), { node: { ...today, lastActiveAt: NOW }, icon: null }],
    ['a split', nodeRecord(split, at), (r) => nodeFromRecord(r, NOW), { node: split, icon: null }],
    ['a Favorite', favoriteRecord(favorite, at, ICON), favoriteFromRecord, { favorite: { ...favorite, favicon: null }, icon: ICON }],
    ['a theme', themeRecord({ id: 'theme-1', name: 'Late Night', stops: [{ l: 0.5, c: 0.2, h: 280 }], grain: 0.3 }, at), themeFromRecord, { id: 'theme-1', name: 'Late Night', stops: [{ l: 0.5, c: 0.2, h: 280 }], grain: 0.3 }],
    ['a link route with a path', routeRecord({ host: 'github.com/acme', chordId: chord.id, createdAt: 5 }, at), routeFromRecord, { host: 'github.com/acme', chordId: chord.id, createdAt: 5 }],
    ['a site’s Effects', effectsRecord(effects, at), (r) => effectsFromRecord(r, () => 'x', NOW), effects],
    ['an icon', iconRecord({ id: ICON, mime: 'image/png', data: 'iVBORw0KGgo=' }), iconFromRecord, { id: ICON, mime: 'image/png', data: 'iVBORw0KGgo=' }],
    ['a site’s zoom', zoomRecord('docs.example', 1.25, at), zoomFromRecord, { host: 'docs.example', factor: 1.25 }],
    ['a site’s permissions', permissionRecord('https://meet.example', { camera: 'allow', notifications: 'block' }, at)!, permissionFromRecord, { origin: 'https://meet.example', decisions: { camera: 'allow', notifications: 'block' } }],
    ['a history page, visits oldest first', pageRecord({ url: 'https://news.test/a?b=1', title: 'A', visits: [30, 10, 20], typed: 2 }), pageFromRecord, { url: 'https://news.test/a?b=1', title: 'A', visits: [10, 20, 30], typed: 2 }],
    ['a Duet chat, without its provider session', threadRecord(thread), threadFromRecord, { ...thread, providerSessionId: null }],
    ['an image, without Codex’s own copy', imageRecord(image, 'iVBORw0KGgo=', '/9j/4AAQ'), imageFromRecord, { image: { id: image.id, mime: 'image/png', width: 640, height: 480, prompt: 'A lighthouse at dusk' }, data: 'iVBORw0KGgo=', thumb: '/9j/4AAQ' }],
  ])('%s', (_what, r, decode, expected) => {
    expect(isDataRecord(viaFile(r))).toBe(true);
    expect(decode(viaFile(r))).toEqual(expected);
  });

  it.each<[string, DuetMessage, DuetMessage]>([
    [
      'what you wrote, with a tab and an image you attached',
      { id: 'm1', threadId: 'th1', createdAt: 1, body: { role: 'user', text: 'Plan it', attachments: [{ ref: 't3', url: 'https://maps.example/', title: 'Maps' }], images: [image] } },
      { id: 'm1', threadId: 'th1', createdAt: 1, body: { role: 'user', text: 'Plan it', attachments: [{ ref: 't3', url: 'https://maps.example/', title: 'Maps' }], images: [{ id: image.id, mime: 'image/png', width: 640, height: 480, prompt: 'A lighthouse at dusk' }] } },
    ],
    [
      'a reply with a citation, without its tab',
      {
        id: 'm2',
        threadId: 'th1',
        createdAt: 2,
        body: { role: 'assistant', text: 'Go by train [1].', citations: [{ n: 1, ref: 't3', url: 'https://rail.example/', title: 'Rail', quote: 'Fast', tabId: 'node-9', page: 4 }], status: 'done', making: 1 },
      },
      { id: 'm2', threadId: 'th1', createdAt: 2, body: { role: 'assistant', text: 'Go by train [1].', citations: [{ n: 1, ref: 't3', url: 'https://rail.example/', title: 'Rail', quote: 'Fast', tabId: null, page: 4 }], status: 'done' } },
    ],
    [
      'a tool’s line, without a fill card’s values',
      {
        id: 'm3',
        threadId: 'th1',
        createdAt: 3,
        body: { role: 'tool', tool: 'propose_fill', summary: 'Filled 4 fields', detail: 'Sign up', ok: true, fill: { formId: 'f', fields: [] } as never },
      },
      { id: 'm3', threadId: 'th1', createdAt: 3, body: { role: 'tool', tool: 'propose_fill', summary: 'Filled 4 fields', detail: 'Sign up', ok: true } },
    ],
    [
      'an approval',
      { id: 'm4', threadId: 'th1', createdAt: 4, body: { role: 'approval', tool: 'read_tab', description: 'Read “Maps”', target: ['t3'], decision: 'once' } },
      { id: 'm4', threadId: 'th1', createdAt: 4, body: { role: 'approval', tool: 'read_tab', description: 'Read “Maps”', target: ['t3'], decision: 'once' } },
    ],
    ['a divider', { id: 'm5', threadId: 'th1', createdAt: 5, body: { role: 'divider', text: 'New session' } }, { id: 'm5', threadId: 'th1', createdAt: 5, body: { role: 'divider', text: 'New session' } }],
  ])('a message: %s', (_what, message, expected) => {
    expect(messageFromRecord(viaFile(messageRecord(message)))).toEqual(expected);
  });
});

describe('never in a record', () => {
  it('a private window’s chord', () => {
    expect(chordRecord({ ...chord, private: true }, at)).toBeNull();
  });

  it.each<[string, DataRecord, string[]]>([
    ['a chord', chordRecord(chord, at)!, ['name', 'icon', 'theme', 'rank', 'profile', 'created', 'proxy']],
    // Not its back/forward history, when it was last shown, its icon's bytes, or anything live.
    ['a tab', nodeRecord(pinned, at, ICON), ['pos', 'url', 'pinnedUrl', 'title', 'customTitle', 'icon', 'muted', 'created']],
    ['a folder', nodeRecord(folder, at), ['pos', 'title', 'collapsed', 'created']],
    ['a split', nodeRecord(split, at), ['pos', 'direction', 'sizes', 'created']],
    ['a Favorite', favoriteRecord(favorite, at, null), ['url', 'title', 'icon', 'rank', 'created']],
    ['a Duet chat', threadRecord(thread), ['chord', 'title', 'provider', 'model', 'scope', 'created', 'updated', 'lastUsed']],
    ['an image', imageRecord(image, 'AAAA', null), ['mime', 'width', 'height', 'data', 'thumb', 'prompt']],
  ])('%s has exactly its fields', (_what, r, fields) => {
    expect(Object.keys(r.set)).toEqual(fields);
  });

  it('live state, back/forward history and paths on this computer, anywhere in the text', () => {
    const live = { ...pinned, live: { loading: true, audible: true }, nav: { entries: [{ url: 'https://mail.example/', pageState: 'FORM-SECRET' }], index: 0 } } as TabNode;
    const message: DuetMessage = { id: 'm1', threadId: 'th1', createdAt: 1, body: { role: 'user', text: 'x', attachments: [], images: [image] } };
    const text = JSON.stringify([nodeRecord(live, at, ICON), threadRecord(thread), messageRecord(message)]);
    for (const never of ['FORM-SECRET', 'pageState', 'loading', 'audible', 'lastActiveAt', 'favicon', 'data:image', 'secret-session', 'providerSessionId', 'codexCopy', 'generated_images']) {
      expect(text).not.toContain(never);
    }
  });

  it('a record keeps its stamp; facts have none', () => {
    expect(chordRecord(chord, at)!.at).toEqual(at);
    for (const fact of [pageRecord({ url: 'https://a.test/', title: '', visits: [1], typed: 0 }), threadRecord(thread), iconRecord({ id: ICON, mime: 'image/png', data: 'AAAA' }), imageRecord(image, 'AAAA', null)]) {
      expect('at' in fact).toBe(false);
    }
  });
});

describe('which settings travel', () => {
  const settings: Settings = {
    ...defaultSettings(),
    searchEngine: 'duckduckgo',
    uiScale: 1.25,
    checkForUpdates: false,
    onboarded: true,
    miniWindowSize: { width: 500, height: 700 },
    devtools: { ...defaultSettings().devtools, side: 'bottom' },
    themes: [{ id: 'theme-1', name: 'Late Night', stops: [{ l: 0.5, c: 0.2, h: 280 }], grain: 0.3 }],
    shortcuts: { 'tab.new': ['Ctrl+Alt+T'] },
    adBlocking: { enabled: true, offSites: ['nytimes.com'] },
    duet: { ...defaultSettings().duet, provider: 'claude', model: 'opus', neverSites: ['https://bank.example'] },
    proxy: { mode: 'pac', server: null, pac: 'https://wpad.corp.example/proxy.pac' },
    encryptExports: true,
  };
  const rows = (Object.keys(settings) as (keyof Settings)[]).map((key, i) => ({ key, value: settings[key], updatedAt: i < 10 ? 1000 : 2000 }));

  it('every setting says how it travels', () => {
    expect(Object.keys(SETTING_TRAVEL).sort()).toEqual(Object.keys(defaultSettings()).sort());
  });

  it.each<[string, string, unknown]>([
    ['the search engine', 'searchEngine', 'duckduckgo'],
    ['a group’s part, by a dotted name', 'adBlocking.offSites', ['nytimes.com']],
    ['Duet’s Never list', 'duet.neverSites', ['https://bank.example']],
    ['the proxy for every chord, whole (exported, never synced)', 'proxy', { mode: 'pac', server: null, pac: 'https://wpad.corp.example/proxy.pac' }],
    ['whether exports are encrypted', 'encryptExports', true],
    ['Windows’ and Linux’s shortcuts, as their family', 'shortcuts.other', { 'tab.new': ['Ctrl+Alt+T'] }],
  ])('in: %s', (_what, field, value) => {
    const set = Object.assign({}, ...settingsRecords(rows, DEVICE, 'win32').map((r) => r.set)) as Record<string, unknown>;
    expect(set[field]).toEqual(value);
  });

  it.each([
    ['the interface size', 'uiScale'],
    ['update checks', 'checkForUpdates'],
    ['first run done', 'onboarded'],
    ['the one-time switch-off', 'autoPipDefaultOff'],
    ['the mini window’s size', 'miniWindowSize'],
    ['developer tools’ side', 'devtools.side'],
    ['Duet’s app', 'duet.provider'],
    ['Duet’s model', 'duet.model'],
    ['themes, which are records of their own', 'themes'],
    ['a Mac’s shortcuts, on Windows', 'shortcuts.mac'],
  ])('out: %s', (_what, field) => {
    const set = Object.assign({}, ...settingsRecords(rows, DEVICE, 'win32').map((r) => r.set)) as Record<string, unknown>;
    expect(field in set).toBe(false);
  });

  it('one record per stamp, oldest first', () => {
    const records = settingsRecords(rows, DEVICE, 'darwin');
    expect(records.map((r) => r.at)).toEqual([
      [1000, 0, DEVICE],
      [2000, 0, DEVICE],
    ]);
    expect(records.every((r) => r.type === 'settings' && r.id === 'settings')).toBe(true);
  });

  it('read back as chord-data keeps them, for restore’s checks, with this computer’s family of shortcuts', () => {
    const fields = Object.assign({}, ...settingsRecords(rows, DEVICE, 'darwin').map((r) => viaFile(r).set)) as Record<string, unknown>;
    const back = settingsFromFields(fields, 'darwin');
    expect(back['searchEngine']).toBe('duckduckgo');
    expect(back['adBlocking']).toEqual({ enabled: true, offSites: ['nytimes.com'] });
    expect(back['duet']).toEqual({ enabled: true, keep: 'forever', scope: 'ask', readsNothing: false, neverSites: ['https://bank.example'], offChords: [], codexImages: true });
    expect(back['shortcuts']).toEqual({ 'tab.new': ['Ctrl+Alt+T'] });
    expect(back['proxy']).toEqual(settings.proxy);
    expect(settingsFromFields(fields, 'linux')['shortcuts']).toBeUndefined();
    for (const key of ['uiScale', 'checkForUpdates', 'onboarded', 'devtools', 'themes', 'miniWindowSize']) expect(back[key]).toBeUndefined();
  });

  it('fields that aren’t settings, or don’t travel, aren’t read', () => {
    expect(settingsFromFields({ uiScale: 1.5, 'motion.nothing': true, 'searchEngine.x': 1, unknown: 2, 'duet.provider': 'claude' }, 'win32')).toEqual({});
    expect(settingFields('nothing', 1, 'win32')).toBeNull();
  });

  it('themes come from their row, each a record with its stamp', () => {
    const themes = themeRecords({ key: 'themes', value: [...settings.themes, { id: 'bad' }], updatedAt: 3000 }, DEVICE);
    expect(themes).toEqual([themeRecord(settings.themes[0]!, [3000, 0, DEVICE])]);
  });
});

describe('records that aren’t what they say', () => {
  it.each<[string, unknown, boolean]>([
    ['a record', { type: 'tab', id: 'a', set: {} }, true],
    ['with a stamp', { type: 'tab', id: 'a', at, set: {} }, true],
    ['a newer Chord’s type', { type: 'reading-list', id: 'a', set: {} }, true],
    ['no fields', { type: 'tab', id: 'a' }, false],
    ['fields as a list', { type: 'tab', id: 'a', set: [] }, false],
    ['no id', { type: 'tab', set: {} }, false],
    ['a bad stamp', { type: 'tab', id: 'a', at: [1, 2], set: {} }, false],
    ['a type that isn’t a name', { type: 'Tab Type', id: 'a', set: {} }, false],
    ['the end line', { end: 3 }, false],
  ])('%s: %s', (_what, raw, ok) => {
    expect(isDataRecord(raw)).toBe(ok);
  });

  it.each<[string, () => unknown]>([
    ['a chord with no name', () => chordFromRecord({ type: 'chord', id: 'c', at, set: { icon: 'x', theme: chord.theme, rank: 'a', profile: 'default' } })],
    ['a chord with a color out of range', () => chordFromRecord({ type: 'chord', id: 'c', at, set: { ...chordRecord(chord, at)!.set, theme: { stops: [{ l: 2, c: 0, h: 0 }], grain: 0, appearance: 'auto' } } })],
    ['a folder in Today', () => nodeFromRecord({ type: 'folder', id: 'f', at, set: { pos: { chord: 'c', section: 'today', parent: null, rank: 'a' }, title: 'x' } }, NOW)],
    ['a tab with no place', () => nodeFromRecord({ type: 'tab', id: 't', at, set: { url: 'https://a.test/', title: '' } }, NOW)],
    ['a Favorite that runs script', () => favoriteFromRecord({ type: 'favorite', id: 'f', at, set: { url: 'javascript:alert(1)', title: 'x', rank: 'a' } })],
    ['a route that isn’t a site', () => routeFromRecord({ type: 'route', id: 'not a site', at, set: { chord: 'c' } })],
    ['zoom past Chromium’s range', () => zoomFromRecord({ type: 'zoom', id: 'a.test', at, set: { factor: 9 } })],
    ['a permission for a page, not an origin', () => permissionFromRecord({ type: 'permission', id: 'https://a.test/page', at, set: { camera: 'allow' } })],
    ['an icon that isn’t base64', () => iconFromRecord({ type: 'icon', id: ICON, set: { mime: 'image/png', data: '<svg onload=x>' } })],
    ['an icon of another type', () => iconFromRecord({ type: 'icon', id: ICON, set: { mime: 'text/html', data: 'AAAA' } })],
    ['a page with no visits', () => pageFromRecord({ type: 'page', id: 'https://a.test/', set: { title: '', visits: [], typed: 0 } })],
    ['a page that isn’t a web page', () => pageFromRecord({ type: 'page', id: 'file:///etc/passwd', set: { title: '', visits: [1], typed: 0 } })],
    ['a chat with an unknown app', () => threadFromRecord({ type: 'thread', id: 'th', set: { chord: 'c', title: '', provider: 'gpt', created: 1 } })],
    ['an image that isn’t PNG, JPEG or WebP', () => imageFromRecord({ type: 'image', id: image.id, set: { mime: 'image/svg+xml', width: 1, height: 1, data: 'AAAA' } })],
  ])('refused: %s', (_what, decode) => {
    expect(decode()).toBeNull();
  });

  it('a reply’s links that aren’t web pages are dropped', () => {
    const r: DataRecord = {
      type: 'message',
      id: 'm1',
      set: {
        thread: 'th1',
        created: 1,
        body: { role: 'assistant', text: 'x', status: 'done', citations: [{ n: 1, ref: 't1', url: 'javascript:alert(1)', title: 'x', quote: 'q', tabId: 'n' }] },
      },
    };
    expect(messageFromRecord(r)?.body).toEqual({ role: 'assistant', text: 'x', status: 'done', citations: [] });
  });

  it.each<[string, unknown, boolean]>([
    ['a web page', 'https://a.test/', true],
    ['the archive page', 'chord://archive/', true],
    ['script', 'javascript:alert(1)', false],
    ['a file on this computer', 'file:///etc/passwd', false],
    ['another of Chord’s pages', 'chord://settings/', false],
  ])('a tab at %s: %s', (_what, url, ok) => {
    const r = nodeRecord({ ...pinned, url: url as string }, at);
    expect(nodeFromRecord(viaFile(r), NOW) !== null).toBe(ok);
  });

  it('a proxy never with a password, not even in a configuration file’s address', () => {
    const pac = { mode: 'pac', server: null, pac: 'https://me:secret@wpad.corp.test/proxy.pac' };
    const withPac = chordRecord({ ...ownChord, proxy: pac as Chord['proxy'] }, at)!;
    expect(JSON.stringify(withPac)).not.toContain('secret');
    expect(withPac.set['proxy']).toEqual({ mode: 'pac', server: null, pac: 'https://wpad.corp.test/proxy.pac' });
    expect(settingFields('proxy', pac, 'linux')).toEqual({ proxy: { mode: 'pac', server: null, pac: 'https://wpad.corp.test/proxy.pac' } });
    // One Chord couldn't use isn't written at all.
    expect(settingFields('proxy', { mode: 'server', server: null, pac: null }, 'linux')).toBeNull();
  });

  it('a chord’s own proxy only with its own sign-ins, as restore keeps it', () => {
    const shared = chordRecord({ ...chord, proxy: ownChord.proxy! }, at)!;
    expect(chordFromRecord(shared)).toEqual(chord);
  });
});
