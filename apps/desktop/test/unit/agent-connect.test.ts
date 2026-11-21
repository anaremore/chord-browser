/**
 * The connect card and Settings → Agents in main (S18 M1d): who started the
 * agent on the card, Deny / × / Allow once / Always allow, an agent allowed for
 * good let in without a card while its sign-ins exist (and asked again once
 * they're gone), the setup lines from Chord's own executable, and the view.
 */
import { emptyState, type State } from '@chord/core';
import { describe, expect, it } from 'vitest';
import { ConnectCards, signInsExist, type ConnectAnswer } from '../../src/main/agents/connect';
import type { ProcessInfo } from '../../src/main/agents/parent';
import { agentsView, mcpCommand, setupLines, signInsName, type SetupWhere } from '../../src/main/agents/settings';
import { Store } from '../../src/main/store';

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const claude: ProcessInfo = { pid: 7, name: 'claude.exe', path: 'C:\\Tools\\claude.exe', cwd: null, ppid: 1 };

/** Your Personal chord (default sign-ins) and Work (its own), and two windows, w1 on Personal and w2 on Work. */
function setup() {
  const state: State = emptyState();
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.chords['c2'] = { id: 'c2', profileId: 'work', name: 'Work', icon: '✦', theme, rank: 'a1', createdAt: 0 };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  state.windows['w2'] = { id: 'w2', activeChordId: 'c2', activeTab: { c2: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  const store = new Store(state);
  let last: string | null = 'w1';
  let changes = 0;
  const cards = new ConnectCards({ store, lastWindow: () => last, changed: () => void changes++, now: () => 1000 });
  const who = (parent: Promise<ProcessInfo[]> = Promise.resolve([claude]), name = 'Claude Code') => ({ name, folder: 'C:\\code\\app', parent });
  return {
    store,
    cards,
    who,
    setLast: (w: string | null) => (last = w),
    changes: () => changes,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('The connect card', () => {
  it('shows in the window used last, "Started in" until Chord knows who started it, then "Started by"', async () => {
    const t = setup();
    let looked!: (chain: ProcessInfo[]) => void;
    const asked = t.cards.ask(t.who(new Promise((r) => (looked = r))), new AbortController().signal);
    await tick();
    const card = t.cards.cardFor('w1')!;
    expect(card).toMatchObject({ name: 'Claude Code', folder: 'C:\\code\\app', startedBy: null });
    expect(card.id).toMatch(/^[0-9a-f]{16}$/);
    expect(t.cards.cardFor('w2')).toBeNull();
    looked([claude]);
    await tick();
    expect(t.cards.cardFor('w1')!.startedBy).toBe('claude.exe');
    t.cards.answer(card.id, 'once', 'w1');
    expect(await asked).toEqual({ grant: 'once', profileId: 'default' });
    expect(t.cards.cardFor('w1')).toBeNull();
  });

  it('Deny (and ×, which answers the same) lets nothing in; another window’s popover can’t answer', async () => {
    const t = setup();
    const asked = t.cards.ask(t.who(), new AbortController().signal);
    await tick();
    const { id } = t.cards.cardFor('w1')!;
    t.cards.answer(id, 'always', 'w2');
    expect(t.cards.cardFor('w1')).not.toBeNull();
    t.cards.answer(id, 'deny', 'w1');
    expect(await asked).toEqual<ConnectAnswer>({ grant: 'deny', profileId: null });
    expect(t.store.state.settings.agentsAllowed).toEqual([]);
  });

  it('taken down (Stop, the agent going) is a no; no window to ask in is a no', async () => {
    const t = setup();
    const stop = new AbortController();
    const asked = t.cards.ask(t.who(), stop.signal);
    await tick();
    stop.abort();
    expect((await asked).grant).toBe('deny');
    expect(t.cards.cardFor('w1')).toBeNull();
    t.setLast(null);
    expect((await t.cards.ask(t.who(), new AbortController().signal)).grant).toBe('deny');
  });

  it('a window closing moves its card to the window used last, or answers no', async () => {
    const t = setup();
    const asked = t.cards.ask(t.who(), new AbortController().signal);
    await tick();
    t.setLast('w2');
    t.cards.windowClosed('w1');
    const card = t.cards.cardFor('w2')!;
    expect(card).not.toBeNull();
    t.setLast(null);
    t.cards.windowClosed('w2');
    expect((await asked).grant).toBe('deny');
  });
});

describe('Always allow', () => {
  it('keeps the agent with the program that started it and the sign-ins of the window answered in; next time, no card', async () => {
    const t = setup();
    t.setLast('w2');
    const first = t.cards.ask(t.who(), new AbortController().signal);
    await tick();
    t.cards.answer(t.cards.cardFor('w2')!.id, 'always', 'w2');
    expect(await first).toEqual({ grant: 'always', profileId: 'work' });
    await tick();
    expect(t.store.state.settings.agentsAllowed).toEqual([{ name: 'Claude Code', parent: claude.path, profileId: 'work', allowedAt: 1000, lastUsedAt: 1000 }]);
    // Reconnecting: let in at once, with Work's sign-ins.
    const before = t.changes();
    expect(await t.cards.ask(t.who(), new AbortController().signal)).toEqual({ grant: 'always', profileId: 'work' });
    expect(t.changes()).toBe(before);
    // Another program giving the same name: the card again.
    const other = t.cards.ask(t.who(Promise.resolve([{ ...claude, path: 'C:\\elsewhere\\claude.exe' }])), new AbortController().signal);
    await tick();
    await tick();
    expect(t.cards.cardFor('w2')).not.toBeNull();
    t.cards.answer(t.cards.cardFor('w2')!.id, 'deny', 'w2');
    expect((await other).grant).toBe('deny');
  });

  it('once its sign-ins are gone (no chord uses them), it asks again', async () => {
    const t = setup();
    t.store.dispatch({ t: 'settings.set', settings: { agentsAllowed: [{ name: 'Claude Code', parent: claude.path, profileId: 'work', allowedAt: 1, lastUsedAt: 1 }] } });
    expect(signInsExist(t.store.state, 'work')).toBe(true);
    // Work goes to Personal's sign-ins: no chord uses "work" now.
    t.store.dispatch({ t: 'chord.profile', chordId: 'c2', profileId: 'default' });
    expect(signInsExist(t.store.state, 'work')).toBe(false);
    const asked = t.cards.ask(t.who(), new AbortController().signal);
    await tick();
    await tick();
    expect(t.cards.cardFor('w1')).not.toBeNull();
    t.cards.answer(t.cards.cardFor('w1')!.id, 'once', 'w1');
    expect(await asked).toEqual({ grant: 'once', profileId: 'default' });
  });
});

describe('Settings → Agents', () => {
  const where = (over: Partial<SetupWhere>): SetupWhere => ({ platform: 'win32', packaged: true, exe: 'C:\\Chord\\Chord.exe', appPath: 'C:\\Chord\\resources\\app.asar', flatpak: null, ...over });

  it('setup lines run this Chord’s own executable, quoted when a shell would split it', () => {
    // [where, command]
    const table: [Partial<SetupWhere>, string][] = [
      [{}, 'C:\\Chord\\Chord.exe mcp'],
      [{ exe: 'C:\\Program Files\\Chord\\Chord.exe' }, '"C:\\Program Files\\Chord\\Chord.exe" mcp'],
      [{ platform: 'darwin', exe: '/Applications/Chord.app/Contents/MacOS/Chord' }, '/Applications/Chord.app/Contents/MacOS/Chord mcp'],
      [{ platform: 'linux', exe: '/opt/Chord/chord' }, '/opt/Chord/chord --ozone-platform=headless mcp'],
      [{ platform: 'linux', exe: '/tmp/.mount_x/chord', appImage: '/home/me/Apps/Chord.AppImage' }, '/home/me/Apps/Chord.AppImage --ozone-platform=headless mcp'],
      [{ platform: 'linux', flatpak: 'com.chordbrowser.Chord' }, 'flatpak run com.chordbrowser.Chord mcp'],
      [{ packaged: false, exe: 'Z:\\repo\\electron.exe', appPath: 'Z:\\repo\\apps\\desktop' }, 'Z:\\repo\\electron.exe Z:\\repo\\apps\\desktop mcp'],
    ];
    for (const [over, command] of table) expect(mcpCommand(where(over)), JSON.stringify(over)).toBe(command);
    expect(setupLines(where({}))).toEqual({ claude: 'claude mcp add chord -- C:\\Chord\\Chord.exe mcp', codex: 'codex mcp add chord -- C:\\Chord\\Chord.exe mcp' });
  });

  it('the view: stopped agents, allowed ones with whose sign-ins, connected now and their tabs', () => {
    const t = setup();
    const store = t.store;
    store.dispatch({
      t: 'settings.set',
      settings: {
        agentsAllowed: [
          { name: 'Claude Code', parent: claude.path, profileId: 'work', allowedAt: 1, lastUsedAt: 5 },
          { name: 'Codex', parent: null, profileId: 'gone', allowedAt: 1, lastUsedAt: 6 },
        ],
      },
    });
    expect(signInsName(store.state, 'work')).toBe('Work’s sign-ins');
    expect(signInsName(store.state, 'gone')).toBe('');
    const view = agentsView(
      store.state,
      [
        { id: 'agent:1', name: 'Claude Code', always: true, stopped: false, chordId: null },
        { id: 'agent:2', name: 'Codex', always: false, stopped: true, chordId: null },
      ],
      { claude: 'c', codex: 'x' },
    );
    expect(view).toEqual({
      setup: { claude: 'c', codex: 'x' },
      stopped: [{ id: 'agent:2', name: 'Codex', tabs: 0 }],
      allowed: [
        { name: 'Claude Code', parent: claude.path, signIns: 'Work’s sign-ins', connected: true, tabs: 0, lastUsedAt: 5 },
        { name: 'Codex', parent: null, signIns: '', connected: false, tabs: 0, lastUsedAt: 6 },
      ],
    });
  });
});
