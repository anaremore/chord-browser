/**
 * Outside agents' chords in main (S18 M1c): what an agent may see and read,
 * its bar (working, paused while you type, stopped) and throttling, Keep and
 * Close all with Undo when it's done, dialogs and file pickers held in its
 * tabs, downloads refused, the vault off there, and nothing at all until an
 * agent connects.
 */
import { EventEmitter } from 'node:events';
import { AGENT_BAR_HEIGHT, CONTROL_REFUSALS, agentToolsVersion, emptyState, findShortcut, nodeOf, type Command, type State, type TabNode } from '@chord/core';
import { size } from '@chord/tokens';
import type { Toast } from '@chord/ipc';
import type { Session, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentChords } from '../../src/main/agents/chords';
import { agentConnection } from '../../src/main/agents/connection';
import { AuthBroker } from '../../src/main/http-auth';
import { agentScope, NOT_YOURS } from '../../src/main/agents/scope';
import { ControlAgent } from '../../src/main/control/gate';
import { DownloadManager } from '../../src/main/downloads';
import { PasswordService } from '../../src/main/passwords/service';
import { Store } from '../../src/main/store';
import { holdForAgent } from '../../src/preload/agent-hold';

afterEach(() => vi.useRealTimers());

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };

/** A store with your chord and one window, a tab of yours, and the pages main has made. */
function setup() {
  const state: State = emptyState();
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  const store = new Store(state);
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://mine.test/' });
  const mine = store.state.windows['w1']!.activeTab['c1']!;
  const toasts: Toast[] = [];
  const pages = new Map<string, EventEmitter & { throttled: boolean }>();
  const page = (nodeId: string) => {
    let p = pages.get(nodeId);
    if (!p) {
      const emitter = new EventEmitter() as EventEmitter & { throttled: boolean };
      emitter.throttled = true;
      pages.set(nodeId, (p = emitter));
    }
    return Object.assign(p, { isDestroyed: () => false, setBackgroundThrottling: (on: boolean) => (p!.throttled = on) }) as unknown as WebContents;
  };
  const chords = new AgentChords({ store, page, lastWindow: () => ({ id: 'w1', toast: (t) => void toasts.push(t) }) });
  const agent = new ControlAgent('agent:1', async () => 'once');
  const chordId = chords.chordFor(agent, 'Claude Code', null);
  const open = (nodeId: string, url = `https://agent.test/${nodeId}`) => store.dispatch({ t: 'agent.tab.add', chordId, nodeId, url });
  open('a1');
  open('a2');
  return { store, mine, chords, agent, chordId, toasts, pages, page, open };
}

const agentLive = (store: Store, nodeId: string) => store.state.live[nodeId]?.agent ?? null;

describe('What an agent sees', () => {
  it('only its own tabs, readable unless they’re never readable, and inspected only if they’re its own', () => {
    const t = setup();
    const scope = agentScope(t.agent, { state: () => t.store.state, chordId: () => t.chordId, neverSites: () => ['bank.test'] });
    expect(scope.tabs().map(({ node }) => node.id)).toEqual(['a1', 'a2']);
    const tab = (id: string) => nodeOf(t.store.state, id) as TabNode;
    t.open('a3', 'https://www.bank.test/statements');
    // [tab, readable, what forms and diagnostics say]
    const table: [string, boolean, string | null][] = [
      ['a1', true, null],
      ['a3', false, null],
      [t.mine, false, NOT_YOURS],
    ];
    for (const [id, readable, inspect] of table) {
      expect(scope.readable(tab(id)), id).toBe(readable);
      expect(scope.mayInspect(tab(id), 'read_form'), id).toBe(inspect);
    }
    expect(scope.needsCard('read_tab', tab('a1'))).toBeNull();
    expect(scope.refs.refFor('a1')).toBe('a1');
  });
});

describe('The bar, throttling and your hands', () => {
  it('working while a call runs on a tab (at full speed), idle after; stopped on every tab until it continues', async () => {
    const t = setup();
    let finish!: () => void;
    const running = t.agent.call('a1', () => new Promise<void>((r) => (finish = r)), () => undefined);
    expect(agentLive(t.store, 'a1')).toMatchObject({ state: 'working', name: 'Claude Code', chordId: t.chordId });
    expect(agentLive(t.store, 'a2')).toBeNull();
    expect(t.pages.get('a1')!.throttled).toBe(false);
    finish();
    await running;
    expect(agentLive(t.store, 'a1')).toBeNull();
    expect(t.pages.get('a1')!.throttled).toBe(true);
    t.chords.stopAll();
    expect([agentLive(t.store, 'a1')?.state, agentLive(t.store, 'a2')?.state]).toEqual(['stopped', 'stopped']);
    await expect(t.agent.call('a1', async () => 'ran', (why) => why)).resolves.toBe('stopped');
    t.chords.continue(t.chordId);
    expect(agentLive(t.store, 'a1')).toBeNull();
    await expect(t.agent.call('a1', async () => 'ran', (why) => why)).resolves.toBe('ran');
  });

  it('a key you press in its tab pauses the agent there until you leave the tab, or let it continue', async () => {
    vi.useFakeTimers();
    const t = setup();
    const contents = t.page('a1');
    t.chords.wire(contents, 'a1');
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: 'a1' });
    (contents as unknown as EventEmitter).emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
    expect(agentLive(t.store, 'a1')?.state).toBe('paused');
    // Its call on that tab waits, and after the wait says the user is using it.
    const held = t.agent.call('a1', async () => 'ran', (why) => why);
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(held).resolves.toBe('paused');
    expect(CONTROL_REFUSALS.paused).toContain('using this tab');
    // Its other tabs aren't held.
    await expect(t.agent.call('a2', async () => 'ran', (why) => why)).resolves.toBe('ran');
    // You leave the tab: it goes on.
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.mine });
    expect(agentLive(t.store, 'a1')).toBeNull();
    // Paused again, then "Let Claude Code continue".
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: 'a1' });
    (contents as unknown as EventEmitter).emit('before-input-event', {}, { type: 'keyDown', key: 'b' });
    t.chords.continue(t.chordId);
    expect(agentLive(t.store, 'a1')).toBeNull();
  });

  it('leaving its page never asks (beforeunload)', () => {
    const t = setup();
    const contents = t.page('a1');
    t.chords.wire(contents, 'a1');
    const event = { preventDefault: vi.fn() };
    (contents as unknown as EventEmitter).emit('will-prevent-unload', event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('When the agent’s done', () => {
  it('asks to keep its tabs: Keep moves them into the window’s chord', () => {
    const t = setup();
    t.chords.done(t.agent);
    expect(t.toasts).toEqual([
      expect.objectContaining({
        message: 'Claude Code finished. Keep these tabs?',
        action: { label: 'Keep', command: { t: 'agents.keep', windowId: 'w1', chordId: t.chordId } },
        secondary: { label: 'Close all', command: { t: 'agents.closeAll', chordId: t.chordId } },
      }),
    ]);
    // No bar once it's done.
    expect(agentLive(t.store, 'a1')).toBeNull();
    t.chords.keep('w1', t.chordId);
    expect(t.store.state.chords[t.chordId]).toBeUndefined();
    expect((nodeOf(t.store.state, 'a1') as TabNode).chordId).toBe('c1');
  });

  it('Close all closes them with Undo, which brings them back', () => {
    const t = setup();
    t.chords.done(t.agent);
    t.chords.closeAll(t.chordId);
    expect(nodeOf(t.store.state, 'a1')).toBeUndefined();
    const undo = t.toasts.at(-1)!;
    expect(undo).toMatchObject({ message: 'Closed 2 tabs', action: { label: 'Undo' } });
    t.chords.undoClose((undo.action as { command: { token: string } }).command.token);
    expect(nodeOf(t.store.state, 'a2')).toMatchObject({ chordId: t.chordId });
    // Back as a finished agent's chord: closing its last tab ends it.
    t.store.dispatch({ t: 'tab.close', windowId: 'w1', nodeId: 'a1' });
    t.store.dispatch({ t: 'tab.close', windowId: 'w1', nodeId: 'a2' });
    expect(t.store.state.chords[t.chordId]).toBeUndefined();
  });

  it('with no tabs left, its chord just goes, without asking', () => {
    const t = setup();
    t.store.dispatch({ t: 'agent.tab.remove', nodeId: 'a1' });
    t.store.dispatch({ t: 'agent.tab.remove', nodeId: 'a2' });
    t.chords.done(t.agent);
    expect(t.toasts).toEqual([]);
    expect(t.store.state.chords[t.chordId]).toBeUndefined();
  });
});

describe('What its tabs held', () => {
  it('page dialogs answer at once, file pickers open nothing, and each is reported', async () => {
    const page = globalThis as unknown as Record<string, unknown>;
    const saved = { alert: page['alert'], confirm: page['confirm'], prompt: page['prompt'], showOpenFilePicker: page['showOpenFilePicker'] };
    const native = vi.fn(() => 'native');
    Object.assign(page, { alert: native, confirm: native, prompt: native, showOpenFilePicker: native });
    try {
      const held: [string, string][] = [];
      holdForAgent((kind, detail) => void held.push([kind, detail]));
      const call = (name: string, ...args: unknown[]) => (page[name] as (...a: unknown[]) => unknown)(...args);
      expect(call('alert', 'Hello')).toBeUndefined();
      expect(call('confirm', 'Leave?')).toBe(false);
      expect(call('prompt', 'Name?')).toBeNull();
      await expect(call('showOpenFilePicker')).rejects.toMatchObject({ name: 'AbortError' });
      expect(native).not.toHaveBeenCalled();
      expect(held).toEqual([
        ['dialog', 'alert: Hello'],
        ['dialog', 'confirm: Leave?'],
        ['dialog', 'prompt: Name?'],
        ['file', 'showOpenFilePicker'],
      ]);
    } finally {
      Object.assign(page, saved);
    }
  });

  it('a download an agent’s tab starts is refused before anything is written, and the agent hears of it', () => {
    const session = new EventEmitter();
    const agentPage = {} as WebContents;
    const refused: string[] = [];
    const commands: Command[] = [];
    const downloads = new DownloadManager({
      state: () => emptyState(),
      dispatch: (c) => void commands.push(c),
      newId: () => 'd1',
      defaultSession: () => session as unknown as Session,
      refuse: (contents, _url, filename) => (contents === agentPage ? (refused.push(filename), true) : false),
    });
    downloads.attach(session as unknown as Session);
    const event = { preventDefault: vi.fn() };
    const item = { getURL: () => 'https://agent.test/f.zip', getFilename: () => 'f.zip', setSavePath: vi.fn() };
    session.emit('will-download', event, item, agentPage);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(refused).toEqual(['f.zip']);
    expect(commands).toEqual([]);
  });
});

describe('The vault in an agent’s tab', () => {
  it('a sign-in page there gets nothing: no menu, no password, no save, no generator, even when chord-data would answer', async () => {
    const chords: Record<string, { id: string; profileId: string; agent?: unknown }> = {
      mine: { id: 'mine', profileId: 'default' },
      ag: { id: 'ag', profileId: 'default', agent: { name: 'Claude Code' } },
    };
    const login = { id: 'l1', origin: 'https://shop.test', username: 'ada', realm: null, note: '', createdAt: 0, updatedAt: 0, lastUsed: null, chordUsed: null };
    // A chord-data that would hand over the password to anyone who asked.
    const careless = new PasswordService({
      chord: (id: string) => chords[id] ?? null,
      extensions: () => ({}),
      settings: () => ({ enabled: true, lockAfter: 'never', onChords: [], offChords: [] }) as never,
      keys: { available: async () => true, wrap: async () => '', unwrap: async () => new Uint8Array() },
      clipboard: { writeText: () => undefined, readText: () => '' },
      changed: () => undefined,
      data: async (op: { op: string }) => {
        if (op.op === 'status') return { status: { state: 'open', kept: false, count: 1 }, generation: 0, held: false };
        if (op.op === 'forSite') return { logins: [login], unreadable: 0 };
        if (op.op === 'fill') return { password: 'Sekrit', loginOrigin: login.origin, loginRealm: null };
        return {};
      },
    } as never);
    expect(await careless.accountsFor(login.origin, 'ag')).toEqual({ state: 'off' });
    expect(await careless.passwordFor('l1', login.origin, 'ag')).toBeNull();
    expect(await careless.generatorFor(login.origin, 'ag')).toBe('off');
    expect(await careless.candidateFor({ origin: login.origin, username: 'ada', password: 'new', chordId: 'ag' })).toEqual({ kind: 'off' });
    // The same page in your chord is offered the sign-in: it's the agent's chord that keeps the vault shut.
    expect((await careless.accountsFor(login.origin, 'mine')).state).not.toBe('off');
  });
});

describe('Stop everything, and the bar’s size', () => {
  it('Ctrl+. and ⌘. stop every agent and assistant reply, and no page can keep the keys', () => {
    const press = (mac: boolean) => ({ type: 'keyDown', key: '.', code: 'Period', control: !mac, meta: mac, alt: false, shift: false });
    expect(findShortcut(press(false), 'win32')).toMatchObject({ id: 'agents.stopAll', kind: 'reserved' });
    expect(findShortcut(press(true), 'darwin')).toMatchObject({ id: 'agents.stopAll', kind: 'reserved' });
  });

  it('main lowers the page by the height the shell draws the bar at', () => {
    expect(size.agentBar).toBe(AGENT_BAR_HEIGHT);
  });
});

describe('Review 1 of #77', () => {
  it('an agent’s tab gets no sign-in box: the request is cancelled, and the agent hears why', () => {
    const broker = new AuthBroker();
    const refused: string[] = [];
    broker.connect({
      nodeFor: (contents) => (contents as unknown as { nodeId: string }).nodeId as never,
      onChange: vi.fn(),
      agentTab: (nodeId) => nodeId === 'a1',
      agentRefused: (_nodeId, detail) => void refused.push(detail),
    });
    const pageAt = (url: string, nodeId: string) => ({ nodeId, getURL: () => url, isDestroyed: () => false }) as unknown as WebContents;
    const details = { url: 'https://intranet.test/', pid: 1, isRequestForNavigation: true, firstAuthAttempt: true, responseHeaders: {} } as never;
    const info = { isProxy: false, scheme: 'basic', host: 'intranet.test', port: 443, realm: 'Staff' } as never;
    // Not answered by Chord: Electron's default cancels it.
    expect(broker.login(pageAt('https://intranet.test/', 'a1'), details, info, vi.fn())).toBe(false);
    expect(broker.promptFor('a1' as never)).toBeNull();
    expect(refused).toEqual(['The site https://intranet.test asked for a sign-in; Chord doesn’t sign agents in.']);
    // Your tab still gets its box.
    expect(broker.login(pageAt('https://intranet.test/', 'mine'), details, info, vi.fn())).toBe(true);
  });

  it('close_tab waits while you use the tab: it answers paused, and the tab stays', async () => {
    vi.useFakeTimers();
    const t = setup();
    const sent: { id?: number; result?: { content: { text: string }[]; isError: boolean } }[] = [];
    const connection = agentConnection({ type: 'hello', initialize: { clientInfo: { title: 'Claude Code' } }, bridgePid: 1, parentPid: 1, cwd: '/', toolsVersion: agentToolsVersion() }, (m) => void sent.push(m as never), {
      present: async () => 'once',
      browser: { store: t.store, tabs: { get: () => undefined, ensure: () => undefined }, readers: { viewFor: () => undefined } },
      chords: t.chords,
      dispatch: (c) => t.store.dispatch(c),
    });
    const chordId = t.chords.chordFor(connection.agent, 'Claude Code', null);
    t.store.dispatch({ t: 'agent.tab.add', chordId, nodeId: 'b1', url: 'https://agent.test/b1' });
    const answer = async (id: number, name: string, args: Record<string, unknown> = {}) => {
      connection.message({ id, method: 'tools/call', params: { name, arguments: args } });
      await vi.advanceTimersByTimeAsync(0);
    };
    await answer(1, 'list_tabs');
    connection.agent.pause('b1', true);
    await answer(2, 'close_tab', { tab_id: 'a1' });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sent.find((m) => m.id === 2)?.result).toMatchObject({ isError: true, content: [{ text: CONTROL_REFUSALS.paused }] });
    expect(nodeOf(t.store.state, 'b1')).toBeDefined();
    // Once you leave it, it closes.
    connection.agent.pause('b1', false);
    await answer(3, 'close_tab', { tab_id: 'a1' });
    expect(sent.find((m) => m.id === 3)?.result).toMatchObject({ isError: false, content: [{ text: 'Closed.' }] });
    expect(nodeOf(t.store.state, 'b1')).toBeUndefined();
  });

  it('Keep and Close all wait until the agent is done; Undo asks again; a page made while it works runs at full speed', async () => {
    const t = setup();
    // Still at work: a toast from before can't take its tabs.
    t.chords.keep('w1', t.chordId);
    t.chords.closeAll(t.chordId);
    expect(nodeOf(t.store.state, 'a1')).toMatchObject({ chordId: t.chordId });
    // A page made while a call runs on its tab gets full speed at once.
    let finish!: () => void;
    const running = t.agent.call('a1', () => new Promise<void>((r) => (finish = r)), () => undefined);
    const late = t.page('a1');
    (late as unknown as { throttled: boolean }).throttled = true;
    t.chords.wire(late, 'a1');
    expect((late as unknown as { throttled: boolean }).throttled).toBe(false);
    finish();
    await running;
    t.chords.done(t.agent);
    t.chords.closeAll(t.chordId);
    const undo = t.toasts.at(-1)!;
    t.chords.undoClose((undo.action as { command: { token: string } }).command.token);
    expect(t.toasts.at(-1)).toMatchObject({ message: 'Claude Code finished. Keep these tabs?' });
    // And Keep works on the chord that came back.
    t.chords.keep('w1', t.chordId);
    expect(nodeOf(t.store.state, 'a1')).toMatchObject({ chordId: 'c1' });
  });
});

describe('open_tab and a Never site (security review)', () => {
  // [address asked for, where the page ends up, what the agent hears, whether its tab stays]
  const table: [string, string, string, boolean][] = [
    ['https://bank.test/', 'https://bank.test/', 'That site is one the user keeps private, so it can’t be opened for you.', false],
    ['https://agent.test/go', 'https://www.bank.test/statements', 'That site is one the user keeps private, so it can’t be opened for you.', false],
    ['https://agent.test/go', 'https://agent.test/home', 'https://agent.test/home', true],
  ];
  it.each(table)('%s, landing on %s: %s', async (asked, landed, said, stays) => {
    const t = setup();
    const events = new EventEmitter();
    let at = '';
    let loading = true;
    const contents = Object.assign(events, { isDestroyed: () => false, isLoading: () => loading, getURL: () => at, getTitle: () => 'Statements for Ada' }) as unknown as WebContents;
    const sent: { id?: number; result?: { content: { text: string }[]; isError: boolean } }[] = [];
    const connection = agentConnection({ type: 'hello', initialize: { clientInfo: { title: 'Claude Code' } }, bridgePid: 1, parentPid: 1, cwd: '/', toolsVersion: agentToolsVersion() }, (m) => void sent.push(m as never), {
      present: async () => 'once',
      browser: { store: t.store, tabs: { get: () => undefined, ensure: () => ({ webContents: contents }) as never }, readers: { viewFor: () => undefined } },
      chords: t.chords,
      dispatch: (c) => t.store.dispatch(c),
      neverSites: () => ['bank.test'],
    });
    connection.message({ id: 1, method: 'tools/call', params: { name: 'open_tab', arguments: { url: asked } } });
    await vi.waitFor(() => expect(events.listenerCount('did-stop-loading') + sent.length).toBeGreaterThan(0));
    // The page redirects, then finishes loading.
    at = landed;
    loading = false;
    events.emit('did-stop-loading');
    await vi.waitFor(() => expect(sent.find((m) => m.id === 1)).toBeDefined());
    const result = sent.find((m) => m.id === 1)!.result!;
    expect(result.isError).toBe(!stays);
    expect(result.content[0]!.text).toContain(said);
    if (!stays) expect(result.content[0]!.text).not.toMatch(/statements|Ada/i);
    const chordId = t.chords.chordOf(connection.agent);
    const tabs = Object.values(t.store.state.nodes).flatMap((b) => Object.values(b)).filter((n) => n.kind === 'tab' && n.chordId === chordId);
    expect(tabs.length).toBe(stays ? 1 : 0);
  });
});

describe('S18 M1d', () => {
  it('a site asking again and again for a sign-in is one note per tab and origin until the agent hears it', () => {
    const t = setup();
    const asked = (origin: string) => `The site ${origin} asked for a sign-in; Chord doesn’t sign agents in.`;
    for (let i = 0; i < 5; i++) t.chords.note('a1', 'signin', asked('https://a.test'));
    t.chords.note('a1', 'signin', asked('https://b.test'));
    t.chords.note('a2', 'signin', asked('https://a.test'));
    t.chords.note('a1', 'dialog', 'alert: hi');
    t.chords.note('a1', 'dialog', 'alert: hi');
    expect(t.chords.drain(t.agent).map((n) => `${n.nodeId} ${n.what} ${n.detail.slice(9, 23)}`)).toEqual([
      'a1 signin https://a.test',
      'a1 signin https://b.test',
      'a2 signin https://a.test',
      'a1 dialog ',
      'a1 dialog ',
    ]);
    // Heard: the next ask is a new note.
    t.chords.note('a1', 'signin', asked('https://a.test'));
    expect(t.chords.drain(t.agent)).toHaveLength(1);
  });
});
