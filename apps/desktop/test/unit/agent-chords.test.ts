/**
 * Outside agents' chords in main (S18 M1c): what an agent may see and read,
 * its bar (working, paused while you type, stopped) and throttling, Keep and
 * Close all with Undo when it's done, dialogs and file pickers held in its
 * tabs, downloads refused, the vault off there, and nothing at all until an
 * agent connects.
 */
import { EventEmitter } from 'node:events';
import { AGENT_BAR_HEIGHT, CONTROL_REFUSALS, emptyState, findShortcut, nodeOf, type Command, type State, type TabNode } from '@chord/core';
import { size } from '@chord/tokens';
import type { Toast } from '@chord/ipc';
import type { Session, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentChords } from '../../src/main/agents/chords';
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
    t.chords.stop(t.chordId);
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
