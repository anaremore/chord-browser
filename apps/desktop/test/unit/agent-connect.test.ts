/**
 * The connect card and Settings → Agents in main (S18 M1d): who started the
 * agent on the card, Deny / × / Allow once / Always allow, an agent allowed for
 * good let in without a card while its sign-ins exist (and asked again once
 * they're gone), the setup lines from Chord's own executable, and the view.
 * Plus #81's hardening: plain text only on the card, never a name-only
 * allowance, the cap dropping the oldest, versioned install folders, POSIX
 * quoting, and a card that waits for a normal window.
 */
import { AGENTS_ALLOWED_MAX, cleanAgentsAllowed, emptyState, type State } from '@chord/core';
import { describe, expect, it } from 'vitest';
import { cardFolder, ConnectCards, plain, signInsExist, startedByOf, unversioned, type ConnectAnswer } from '../../src/main/agents/connect';
import { clientName } from '../../src/main/agents/connection';
import type { ProcessInfo } from '../../src/main/agents/parent';
import { agentsView, mcpCommand, quote, setupLines, signInsName, type SetupWhere } from '../../src/main/agents/settings';
import { Store } from '../../src/main/store';

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const CLAUDE_PATH = 'C:\\Tools\\claude.exe';
const claude: ProcessInfo = { pid: 7, name: 'claude.exe', path: CLAUDE_PATH, cwd: null, ppid: 1 };

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

  it('taken down (Stop, the agent going) is a no', async () => {
    const t = setup();
    const stop = new AbortController();
    const asked = t.cards.ask(t.who(), stop.signal);
    await tick();
    stop.abort();
    expect((await asked).grant).toBe('deny');
    expect(t.cards.cardFor('w1')).toBeNull();
  });

  it('with no normal window (none, or only private ones) the card waits for one, and shows there', async () => {
    const t = setup();
    t.setLast(null);
    const asked = t.cards.ask(t.who(), new AbortController().signal);
    await tick();
    expect(t.cards.cardFor('w1')).toBeNull();
    expect(t.cards.cardFor('w2')).toBeNull();
    t.cards.windowFocused('w2');
    const card = t.cards.cardFor('w2')!;
    t.cards.answer(card.id, 'once', 'w2');
    expect(await asked).toEqual({ grant: 'once', profileId: 'work' });
  });

  it('a window closing moves its card to the window used last, or parks it until a normal window comes', async () => {
    const t = setup();
    const asked = t.cards.ask(t.who(), new AbortController().signal);
    await tick();
    t.setLast('w2');
    t.cards.windowClosed('w1');
    expect(t.cards.cardFor('w2')).not.toBeNull();
    t.setLast(null);
    t.cards.windowClosed('w2');
    expect(t.cards.cardFor('w2')).toBeNull();
    // Not a no: a window comes, and the card is there (cardFor adopts it for the window used last).
    t.setLast('w1');
    const card = t.cards.cardFor('w1')!;
    expect(card).not.toBeNull();
    t.cards.answer(card.id, 'deny', 'w1');
    expect((await asked).grant).toBe('deny');
  });

  it('shows only plain text: no control or bidi characters, and a folder only if it is an absolute path', async () => {
    // [folder from the agent, as the card shows it (null: "an unknown folder")]
    const table: [string, string | null][] = [
      ['C:\\code\\app', 'C:\\code\\app'],
      ['/home/me/app', '/home/me/app'],
      ['\\\\server\\share\\app', '\\\\server\\share\\app'],
      ['code/app', null],
      ['', null],
      ['Allowed by your administrator', null],
      ['/home/me/\u202Eppa', null],
      ['C:\\code\napp', null],
      ['/home/\u200Bme', null],
    ];
    for (const [folder, shown] of table) expect(cardFolder(folder), JSON.stringify(folder)).toBe(shown);
    const long = `/home/me/${'a'.repeat(200)}/project`;
    const short = cardFolder(long)!;
    expect([...short]).toHaveLength(120);
    expect(short.startsWith('/home/me/aaa')).toBe(true);
    expect(short.endsWith('a/project')).toBe(true);
    expect(short).toContain('…');
    expect(plain('Claude\u202E Code\u0007')).toBe('Claude Code');
    expect(clientName({ initialize: { clientInfo: { title: '\u202EedoC edualC', name: 'x' } } })).toBe('edoC edualC');
    expect(clientName({ initialize: { clientInfo: { title: '\u200B\u0000', name: 'codex\u2066' } } })).toBe('codex');
    expect(clientName({ initialize: { clientInfo: { title: '\u200B' } } })).toBe('An agent');
    // On the card itself, and who started it too.
    const t = setup();
    const asked = t.cards.ask({ name: 'Claude\u202E Code', folder: 'code/app', parent: Promise.resolve([{ ...claude, name: 'claude\u200B.exe' }]) }, new AbortController().signal);
    await tick();
    await tick();
    expect(t.cards.cardFor('w1')).toMatchObject({ name: 'Claude Code', folder: null, startedBy: 'claude.exe' });
    t.cards.answer(t.cards.cardFor('w1')!.id, 'deny', 'w1');
    await asked;
  });
});

describe('Always allow', () => {
  it('keeps the agent with the program that started it and the sign-ins of the window answered in; next time, no card', async () => {
    const t = setup();
    t.setLast('w2');
    const first = t.cards.ask(t.who(), new AbortController().signal);
    await tick();
    t.cards.answer(t.cards.cardFor('w2')!.id, 'always', 'w2');
    expect(await first).toEqual({ grant: 'always', profileId: 'work', allowedParent: CLAUDE_PATH });
    expect(t.store.state.settings.agentsAllowed).toEqual([{ name: 'Claude Code', parent: CLAUDE_PATH, profileId: 'work', allowedAt: 1000, lastUsedAt: 1000 }]);
    // Reconnecting: let in at once, with Work's sign-ins.
    const before = t.changes();
    expect(await t.cards.ask(t.who(), new AbortController().signal)).toEqual({ grant: 'always', profileId: 'work', allowedParent: CLAUDE_PATH });
    expect(t.changes()).toBe(before);
    // Another program giving the same name: the card again.
    const other = t.cards.ask(t.who(Promise.resolve([{ ...claude, path: 'C:\\elsewhere\\claude.exe' }])), new AbortController().signal);
    await tick();
    await tick();
    expect(t.cards.cardFor('w2')).not.toBeNull();
    t.cards.answer(t.cards.cardFor('w2')!.id, 'deny', 'w2');
    expect((await other).grant).toBe('deny');
  });

  it('without the program that started it (the lookup failed), this connection is let in but nothing is kept: the next asks', async () => {
    const t = setup();
    const first = t.cards.ask(t.who(Promise.reject(new Error('no lookup'))), new AbortController().signal);
    await tick();
    t.cards.answer(t.cards.cardFor('w1')!.id, 'always', 'w1');
    expect(await first).toEqual({ grant: 'always', profileId: 'default', allowedParent: null });
    expect(t.store.state.settings.agentsAllowed).toEqual([]);
    // Nor does a saved row without one count (restore drops it): a name never matches alone.
    expect(cleanAgentsAllowed([{ name: 'Claude Code', parent: null, profileId: 'default' }, { name: 'Codex', parent: '', profileId: 'default' }])).toEqual([]);
    const next = t.cards.ask(t.who(Promise.resolve([])), new AbortController().signal);
    await tick();
    expect(t.cards.cardFor('w1')).not.toBeNull();
    t.cards.answer(t.cards.cardFor('w1')!.id, 'deny', 'w1');
    await next;
  });

  it('an update in a versioned install folder is the same program: let in without a card, and never a second row', async () => {
    // [kept, new, same program]
    const table: [string, string, boolean][] = [
      ['/home/me/.local/share/claude/versions/2.1.3', '/home/me/.local/share/claude/versions/2.1.4', true],
      ['/home/me/.local/share/claude/versions/2.1.3/claude', '/home/me/.local/share/claude/versions/2.2.0/claude', true],
      ['/Users/me/.claude/versions/v1.0.58-beta.1/claude', '/Users/me/.claude/versions/v1.0.60/claude', true],
      ['/home/me/.local/share/claude/versions/2.1.3/claude', '/home/me/.local/share/claude/versions/2.1.4/codex', false],
      ['/home/me/a/versions/2.1.3/claude', '/home/me/b/versions/2.1.3/claude', false],
      ['C:\\Tools\\claude.exe', 'C:\\Tools\\claude.exe', true],
    ];
    for (const [kept, next, same] of table) expect(unversioned(kept) === unversioned(next), `${kept} → ${next}`).toBe(same);
    const t = setup();
    const at = (path: string) => [{ ...claude, path }];
    t.store.dispatch({ t: 'settings.set', settings: { agentsAllowed: [{ name: 'Claude Code', parent: '/opt/c/versions/2.1.3/claude', profileId: 'default', allowedAt: 5, lastUsedAt: 5 }, { name: 'Codex', parent: '/opt/x/codex', profileId: 'default', allowedAt: 6, lastUsedAt: 6 }] } });
    // Updated (another version folder): the same program, let in at once with its sign-ins; its row is the one it had.
    expect(await t.cards.ask(t.who(Promise.resolve(at('/opt/c/versions/2.1.4/claude'))), new AbortController().signal)).toEqual({ grant: 'always', profileId: 'default', allowedParent: '/opt/c/versions/2.1.3/claude' });
    expect(t.store.state.settings.agentsAllowed.map((a) => [a.name, a.parent, a.lastUsedAt])).toEqual([
      ['Claude Code', '/opt/c/versions/2.1.3/claude', 1000],
      ['Codex', '/opt/x/codex', 6],
    ]);
    // Another program by that name (another folder): asked, and Always allow keeps a row of its own.
    const asked = t.cards.ask(t.who(Promise.resolve(at('/elsewhere/versions/2.1.4/claude'))), new AbortController().signal);
    await tick();
    await tick();
    t.cards.answer(t.cards.cardFor('w1')!.id, 'always', 'w1');
    await asked;
    expect(t.store.state.settings.agentsAllowed.map((a) => a.parent)).toEqual(['/opt/c/versions/2.1.3/claude', '/opt/x/codex', '/elsewhere/versions/2.1.4/claude']);
  });

  it('who started it, past a helper the agent runs tools from (language_server_*) to the app behind it', async () => {
    const helper = { pid: 9, name: 'language_server_linux_x64', path: '/opt/Antigravity/resources/bin/language_server_linux_x64', cwd: null, ppid: 8 };
    const app = { pid: 8, name: 'antigravity', path: '/opt/Antigravity/antigravity', cwd: null, ppid: 1 };
    const at = (name: string, path: string) => ({ pid: 1, name, path, cwd: null, ppid: 1 });
    // [the bridge's parent, its parent, who started it]
    const table: [string, ProcessInfo, ProcessInfo | null, string][] = [
      ['Linux: the helper in the app’s folder', helper, app, 'antigravity'],
      [
        'macOS: the helper in the app bundle',
        at('language_server_macos_arm', '/Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm'),
        at('Antigravity', '/Applications/Antigravity.app/Contents/MacOS/Antigravity'),
        'Antigravity',
      ],
      [
        'Windows: the helper in the app’s folder (any case)',
        at('language_server_windows_x64.exe', 'C:\\Users\\me\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server_windows_x64.exe'),
        at('Antigravity.exe', 'C:\\Users\\Me\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe'),
        'Antigravity.exe',
      ],
      // The attack: a program that calls itself so, anywhere else, is named as itself (and so gets a card).
      ['a language_server_x outside its parent’s folder', at('language_server_x', '/tmp/evil/language_server_x'), at('claude', '/home/me/.local/bin/claude'), 'language_server_x'],
      ['a language_server_x in a folder named like its parent’s', at('language_server_x', '/home/me/.local/bin-evil/language_server_x'), at('claude', '/home/me/.local/bin/claude'), 'language_server_x'],
      ['a helper with no parent', helper, null, 'language_server_linux_x64'],
      ['no helper', claude, app, 'claude.exe'],
    ];
    for (const [what, first, next, named] of table) expect(startedByOf(next ? [first, next] : [first])?.name, what).toBe(named);
    expect(startedByOf([])).toBeNull();
    const t = setup();
    const asked = t.cards.ask({ name: 'antigravity-cli', folder: '/home/me/code', parent: Promise.resolve([helper, app]) }, new AbortController().signal);
    await tick();
    await tick();
    expect(t.cards.cardFor('w1')).toMatchObject({ name: 'antigravity-cli', startedBy: 'antigravity' });
    t.cards.answer(t.cards.cardFor('w1')!.id, 'always', 'w1');
    expect(await asked).toMatchObject({ grant: 'always', allowedParent: '/opt/Antigravity/antigravity' });

    // Claude Code is allowed for good; a helper-named program it didn't install, giving Claude Code's name, is asked.
    const u = setup();
    u.store.dispatch({ t: 'settings.set', settings: { agentsAllowed: [{ name: 'Claude Code', parent: '/home/me/.local/bin/claude', profileId: 'default', allowedAt: 1, lastUsedAt: 1 }] } });
    const borrowed = u.cards.ask({ name: 'Claude Code', folder: '/home/me', parent: Promise.resolve([at('language_server_x', '/tmp/evil/language_server_x'), at('claude', '/home/me/.local/bin/claude')]) }, new AbortController().signal);
    await tick();
    await tick();
    expect(u.cards.cardFor('w1')).toMatchObject({ name: 'Claude Code', startedBy: 'language_server_x' });
    u.cards.answer(u.cards.cardFor('w1')!.id, 'deny', 'w1');
    expect((await borrowed).grant).toBe('deny');
  });

  it('over the cap, the ones used longest ago go', () => {
    const rows = Array.from({ length: AGENTS_ALLOWED_MAX + 2 }, (_, i) => ({ name: `Agent ${i}`, parent: `/bin/a${i}`, profileId: 'default', allowedAt: i, lastUsedAt: i === 0 ? 10_000 : i }));
    const kept = cleanAgentsAllowed(rows);
    expect(kept).toHaveLength(AGENTS_ALLOWED_MAX);
    // Agent 0 was used last of all; Agents 1 and 2 longest ago. The order stays, and the newest row is kept.
    expect(kept.map((a) => a.name)).not.toContain('Agent 1');
    expect(kept.map((a) => a.name)).not.toContain('Agent 2');
    expect(kept[0]!.name).toBe('Agent 0');
    expect(kept.at(-1)!.name).toBe(`Agent ${AGENTS_ALLOWED_MAX + 1}`);
  });

  it('once its sign-ins are gone (no chord uses them), it asks again', async () => {
    const t = setup();
    t.store.dispatch({ t: 'settings.set', settings: { agentsAllowed: [{ name: 'Claude Code', parent: CLAUDE_PATH, profileId: 'work', allowedAt: 1, lastUsedAt: 1 }] } });
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
      // macOS and Linux: POSIX single quotes for anything a shell would read.
      [{ platform: 'darwin', exe: "/Users/me/Apps/Chord Beta.app/Contents/MacOS/Chord" }, "'/Users/me/Apps/Chord Beta.app/Contents/MacOS/Chord' mcp"],
      [{ platform: 'linux', exe: "/home/o'brien/Chord/chord" }, "'/home/o'\\''brien/Chord/chord' --ozone-platform=headless mcp"],
      [{ platform: 'linux', exe: '/opt/chord/$(rm -rf ~)/chord' }, "'/opt/chord/$(rm -rf ~)/chord' --ozone-platform=headless mcp"],
    ];
    for (const [over, command] of table) expect(mcpCommand(where(over)), JSON.stringify(over)).toBe(command);
    expect(setupLines(where({}))).toEqual({ claude: 'claude mcp add chord -- C:\\Chord\\Chord.exe mcp', codex: 'codex mcp add chord -- C:\\Chord\\Chord.exe mcp' });
    // [path, platform, as a terminal takes it]
    const quoted: [string, NodeJS.Platform, string][] = [
      ['/usr/bin/chord', 'linux', '/usr/bin/chord'],
      ['/a/b@c%d+e=f:g,h.i-j_k', 'linux', '/a/b@c%d+e=f:g,h.i-j_k'],
      ['/a b', 'darwin', "'/a b'"],
      ['/a`b`', 'linux', "'/a`b`'"],
      ["/it's", 'linux', "'/it'\\''s'"],
      ['/a;b', 'linux', "'/a;b'"],
      ['C:\\Program Files\\Chord\\Chord.exe', 'win32', '"C:\\Program Files\\Chord\\Chord.exe"'],
      ['C:\\Chord\\Chord.exe', 'win32', 'C:\\Chord\\Chord.exe'],
    ];
    for (const [path, platform, shown] of quoted) expect(quote(path, platform), path).toBe(shown);
  });

  it('the view: stopped agents, allowed ones with whose sign-ins, connected now and their tabs', () => {
    const t = setup();
    const store = t.store;
    store.dispatch({
      t: 'settings.set',
      settings: {
        agentsAllowed: [
          { name: 'Claude Code', parent: CLAUDE_PATH, profileId: 'work', allowedAt: 1, lastUsedAt: 5 },
          { name: 'Codex', parent: '/opt/codex', profileId: 'gone', allowedAt: 1, lastUsedAt: 6 },
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
        { name: 'Claude Code', parent: CLAUDE_PATH, signIns: 'Work’s sign-ins', connected: true, tabs: 0, lastUsedAt: 5 },
        { name: 'Codex', parent: '/opt/codex', signIns: '', connected: false, tabs: 0, lastUsedAt: 6 },
      ],
    });
  });
});
