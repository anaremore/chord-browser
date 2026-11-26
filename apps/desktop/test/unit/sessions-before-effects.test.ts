/**
 * #328 (Neon, reviewing #323): a tab never loads in a session before that session's proxy is set, also when a change
 * of a chord's sign-ins is undone or a chord is restored. Main's store listeners run in the order they subscribed, and
 * Browser's (its effects: a tab's view made, its page loaded) came before index.ts' (proxies.sync()). So Undo of
 * "share sign-ins" made the tab again in its own sign-ins' session, which still had no proxy (it was set back to the
 * system's while no chord used it), and its page loaded over the direct connection before the chord's proxy was set.
 *
 * With the real store, the real proxies and the real tab manager; the effects listener does what Browser's runEffects
 * does for these (view.destroy, view.ensure), subscribed first, as Browser's is.
 */
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyState, proxyFor, setNode, IDLE_LIVE, type Chord, type Command, type ProxySettings, type State, type TabNode } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView } from './fake-view';
import { code } from './source-code';

/** Each page's loads, with the proxy its session had in place at the time. */
const loads: Array<{ url: string; proxy: string }> = [];
/** What each session's proxy is now: set once setProxy has answered. */
const applied = new WeakMap<object, string>();

vi.mock('electron', async () => {
  const { FakeView: View } = await import('./fake-view');
  /** A view whose page is in the session it was made for, and says what proxy it loaded behind. */
  class SessionView extends View {
    constructor(options?: { webPreferences?: { session?: object } }) {
      super();
      const session = options?.webPreferences?.session ?? {};
      Object.assign(this.page, { session });
      this.page.loadURL.mockImplementation(async (url: string) => void loads.push({ url, proxy: applied.get(session) ?? 'system' }));
    }
  }
  return {
    WebContentsView: SessionView,
    BaseWindow: class extends EventEmitter {},
    nativeTheme: { on: vi.fn(), off: vi.fn(), shouldUseDarkColors: false },
    screen: {},
    systemPreferences: {},
    ipcMain: { handle: vi.fn(), on: vi.fn() },
  };
});
vi.mock('../../src/main/window', async () => {
  const { FakeView: View } = await import('./fake-view');
  return { createUiView: () => new View() };
});
vi.mock('../../src/main/app-icon', () => ({ windowIcon: () => undefined }));
vi.mock('../../src/main/platform', () => ({ platform: 'linux', applyMaterial: vi.fn(), onUiScale: () => () => undefined, systemInfo: () => ({}), titleBarOverlay: () => ({}), trafficLightPosition: () => ({ x: 0, y: 0 }), windowChromeOptions: () => ({}) }));
const { Store } = await import('../../src/main/store');
const { Proxies } = await import('../../src/main/proxy');
const { TabManager } = await import('../../src/main/tabs');
const { pageGate } = await import('../../src/main/page-gate');
const { followSessions } = await import('../../src/main/sessions-follow');

const P: ProxySettings = { mode: 'server', server: { scheme: 'http', host: '10.0.0.2', port: 3128, bypass: [] }, pac: null };
const TAB = 'tab-l';
const URL = 'https://a.test/';

function initial(): State {
  const state = emptyState();
  const chord = (id: string, profileId: string, proxy?: ProxySettings): Chord => ({
    id,
    profileId,
    name: id,
    icon: '✦',
    theme: { stops: [{ l: 0.7, c: 0.1, h: 200 }], grain: 0.2, appearance: 'auto' },
    rank: id,
    createdAt: 0,
    ...(proxy ? { proxy } : {}),
  });
  state.chords = { personal: chord('personal', 'default'), lab: chord('lab', 'p-lab', P) };
  state.windows['w1'] = { id: 'w1', activeChordId: 'lab', activeTab: { lab: TAB }, sidebar: 'docked', sidebarWidth: 248, bounds: null } as State['windows'][string];
  setNode(state, { kind: 'tab', id: TAB, chordId: 'lab', section: 'today', parentId: null, rank: 'a0', url: URL, title: '', pinnedUrl: null, customTitle: null, favicon: null, lastActiveAt: 0, createdAt: 0 } as never);
  state.live[TAB] = { ...IDLE_LIVE };
  return state;
}

/** Main as it's put together: the store, Chord's proxies, a session per sign-ins, the tab manager, and Browser's effects. */
function app() {
  loads.length = 0;
  const store = new Store(initial());
  const proxies = new Proxies();
  const sessions = new Map<string, Session>();
  const sessionFor = (profileId: string) =>
    proxies.make(profileId, () => {
      let ses = sessions.get(profileId);
      if (!ses) {
        const made = {
          name: profileId,
          setProxy: (config: { mode: string; proxyRules?: string }) => new Promise<void>((resolve) => setTimeout(() => (applied.set(made, config.proxyRules ?? config.mode), resolve()), 5)),
          closeAllConnections: async () => undefined,
        };
        ses = made as unknown as Session;
        sessions.set(profileId, ses);
      }
      return ses;
    });
  proxies.start({ proxyFor: (owner) => proxyFor(store.state, owner), contents: () => [] });
  const tabs = new TabManager({
    state: () => store.state,
    dispatch: (c: Command) => store.dispatch(c),
    sessionFor: (node: TabNode) => sessionFor(store.state.chords[node.chordId]?.profileId ?? 'default'),
    proxyReady: pageGate<Session>({ proxy: (ses) => proxies.ready(ses), rules: () => null }),
    createInternalView: () => new FakeView() as unknown as WebContentsView,
    windowFor: () => 'w1',
    onContentsCreated: vi.fn(),
    onVisit: vi.fn(),
    onTitle: vi.fn(),
    onPopupCreated: vi.fn(),
    onPeek: vi.fn(),
  } as never);
  // Browser's listener, subscribed first (its constructor runs before index.ts subscribes).
  store.subscribe((change) => {
    for (const effect of change.effects) {
      if (effect.e === 'view.destroy') tabs.destroy(effect.nodeId);
      if (effect.e === 'view.ensure') tabs.ensure(effect.nodeId);
    }
  });
  // index.ts': sessions follow the settings before any effect runs.
  store.setBeforeEffects((change) => followSessions(change, { proxies, adBlocking: { sync: vi.fn() } }));
  return { store, tabs, proxies, sessionFor };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const lastLoad = () => loads.at(-1);
const proxyOf = (rules: ProxySettings) => `http://${rules.server!.host}:${rules.server!.port}`;

describe('a tab never loads before its session’s proxy is set (#328)', () => {
  it('sharing sign-ins, then Undo: the tab loads in its own sign-ins again only behind the chord’s proxy', async () => {
    const { store, tabs } = app();
    tabs.ensure(TAB as never);
    await settle();
    expect(lastLoad()).toEqual({ url: URL, proxy: proxyOf(P) });
    // Settings → the chord: share sign-ins (its own proxy goes with them; its own sign-ins' session goes direct).
    store.dispatch({ t: 'chord.profile', chordId: 'lab', profileId: 'default' });
    await settle();
    // Undo puts both back.
    store.dispatch({ t: 'chord.proxy', chordId: 'lab', proxy: P, profileId: 'p-lab' });
    await settle();
    // Behind the proxy, then in the shared sign-ins (the proxy for every chord: the system's), then behind it again.
    expect(loads).toEqual([
      { url: URL, proxy: proxyOf(P) },
      { url: URL, proxy: 'system' },
      { url: URL, proxy: proxyOf(P) },
    ]);
  });

  it('a chord deleted, then restored (its Undo): its tab loads in its own sign-ins again only behind its proxy', async () => {
    const { store, tabs } = app();
    tabs.ensure(TAB as never);
    await settle();
    store.dispatch({ t: 'chord.delete', chordId: 'lab' });
    await settle();
    store.dispatch({ t: 'chord.restore', windowId: 'w1', chordId: 'lab' });
    await settle();
    expect(loads.length).toBeGreaterThan(1);
    expect(loads.filter((l) => l.proxy !== proxyOf(P))).toEqual([]);
  });

  it('a chord’s own proxy changed while its tab shows: the tab’s next load is behind the new one', async () => {
    const { store, tabs } = app();
    tabs.ensure(TAB as never);
    await settle();
    const Q: ProxySettings = { ...P, server: { ...P.server!, host: '10.0.0.9' } };
    store.dispatch({ t: 'chord.proxy', chordId: 'lab', proxy: Q });
    tabs.navigate(TAB as never, 'https://b.test/');
    await settle();
    expect(lastLoad()).toEqual({ url: 'https://b.test/', proxy: proxyOf(Q) });
  });
});

describe('the store’s listeners (#328)', () => {
  it('the before-effects listener runs before every other, whenever it was set', () => {
    const store = new Store(initial());
    const order: string[] = [];
    store.subscribe(() => order.push('effects'));
    store.setBeforeEffects(() => order.push('sessions'));
    store.subscribe(() => order.push('later'));
    store.dispatch({ t: 'chord.update', chordId: 'lab', name: 'Lab 2' });
    expect(order).toEqual(['sessions', 'effects', 'later']);
  });

  it('only one runs before the effects (Opus’s SF1, round 1 of #332): a second throws, and the first stays', () => {
    const store = new Store(initial());
    const order: string[] = [];
    store.setBeforeEffects(() => order.push('sessions'));
    expect(() => store.setBeforeEffects(() => order.push('another'))).toThrow();
    store.dispatch({ t: 'chord.update', chordId: 'lab', name: 'Lab 2' });
    expect(order).toEqual(['sessions']);
  });

  it('its disposer takes it away (Neon’s round 1 of #332): it runs no more, and another can be set', () => {
    const store = new Store(initial());
    const order: string[] = [];
    const off = store.setBeforeEffects(() => order.push('sessions'));
    off();
    store.dispatch({ t: 'chord.update', chordId: 'lab', name: 'Lab 2' });
    expect(order).toEqual([]);
    store.setBeforeEffects(() => order.push('again'));
    // A disposer used late leaves the newer one alone.
    off();
    store.dispatch({ t: 'chord.update', chordId: 'lab', name: 'Lab 3' });
    expect(order).toEqual(['again']);
  });
});

describe('what sessions follow (#328)', () => {
  const change = (path: (string | number)[]) => ({ patches: [{ op: 'replace', path, value: null }] }) as never;
  it.each([
    [['settings', 'proxy'], 'proxies'],
    [['chords', 'lab', 'proxy'], 'proxies'],
    [['chords', 'lab', 'profileId'], 'proxies'],
    [['chords', 'lab'], 'proxies'],
    [['chords'], 'proxies'],
    [['settings', 'adBlocking'], 'adBlocking'],
    [['chords', 'lab', 'blockingOff'], 'adBlocking'],
    [['chords', 'lab', 'name'], null],
    [['settings', 'colorScheme'], null],
  ] as const)('%j: %s', (path, which) => {
    const proxies = { sync: vi.fn() };
    const adBlocking = { sync: vi.fn() };
    followSessions(change([...path]), { proxies, adBlocking });
    expect(proxies.sync).toHaveBeenCalledTimes(which === 'proxies' ? 1 : 0);
    expect(adBlocking.sync).toHaveBeenCalledTimes(which === 'adBlocking' ? 1 : 0);
  });
});

describe('the order, as main wires it (#328)', () => {
  const main = join(import.meta.dirname, '../../src/main');
  /** A file's code, comments blanked out (a comment that mentions a call neither makes nor breaks the rule). */
  const source = (file: string) => code(readFileSync(join(main, file), 'utf8'));

  it('index.ts has sessions follow the settings as the store’s before-effects listener', () => {
    const wired = /\.setBeforeEffects\(\s*\(?\s*\w+\s*\)?\s*=>\s*followSessions\(/;
    expect(wired.test(source('index.ts')), 'index.ts: store.setBeforeEffects((change) => followSessions(change, …))').toBe(true);
  });

  it('nothing else in main syncs proxies (a listener that could run after the effects)', () => {
    const calls = readdirSync(main, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /\bproxies\??\.sync\s*\(/.test(source(f)))
      .map((f) => f.replaceAll('\\', '/'));
    expect(calls).toEqual(['sessions-follow.ts']);
  });
});
