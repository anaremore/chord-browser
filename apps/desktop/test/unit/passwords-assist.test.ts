/**
 * Chord's passwords in the page (main/passwords/assist.ts): the detector's events joined to the
 * vault, with fakes for both and for the window. Table-driven: which focus gets a menu, what each
 * key and click does, what may be filled where, which sign-in gets a card and what its buttons do.
 */
import { EventEmitter } from 'node:events';
import { PASSWORDS_FILL } from '@chord/ipc';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { changeCard, CLICK_GRACE_MS, PasswordAssist, SAVE_CARD_MS, type AssistTab, type AssistVault } from '../../src/main/passwords/assist';
import { TAKEN_KEY_PATIENCE } from '../../src/main/passwords/menu-keys';
import { HOLD_MS } from '../../src/main/passwords/saving';
import type { PasswordDetectorEvents } from '../../src/main/passwords/detector';
import type { AccountsAnswer, CandidateAnswer, SaveAnswer } from '../../src/main/passwords/service';

const ORIGIN = 'https://github.com';
const OFFERS = [
  { id: 'a1', username: 'ada@acme.dev', host: 'github.com', match: 'origin' as const },
  { id: 'a2', username: 'ada.lovelace', host: 'gist.github.com', match: 'site' as const },
];
const VALUES = { username: 'ada@acme.dev', password: 'correct horse' };

interface FakeFrame {
  processId: number;
  routingId: number;
  origin: string;
  send: ReturnType<typeof vi.fn>;
}

function fakePage(origin = ORIGIN) {
  const page = new EventEmitter() as EventEmitter & { isDestroyed(): boolean; mainFrame: FakeFrame; destroyed: boolean };
  page.destroyed = false;
  page.isDestroyed = () => page.destroyed;
  page.mainFrame = { processId: 3, routingId: 9, origin, send: vi.fn() };
  return page;
}
type FakePage = ReturnType<typeof fakePage>;

/** A clock and timers the test moves by hand. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id: unknown) => void timers.delete(id as number),
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now || !timers.has(id)) continue;
        timers.delete(id);
        t.run();
      }
    },
  };
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

const naiveSite = async (origin: string) => new URL(origin).hostname.split('.').slice(-2).join('.');

function setup({
  accounts = { state: 'open', offers: OFFERS, insecure: false } as AccountsAnswer,
  candidate = { kind: 'new', setup: false } as CandidateAnswer,
  tab = {} as Partial<AssistTab> | null,
  shown = true,
  siteOf = naiveSite as (origin: string) => Promise<string | null>,
  generator = 'open' as 'open' | 'locked' | 'none' | 'off',
  generate = null as ((origin: string) => Promise<{ password: string; rule: string | null; strong?: boolean } | null>) | null,
  change = { state: 'open', matches: [], accounts: [] } as Awaited<ReturnType<AssistVault['changeAccounts']>>,
} = {}) {
  let made = 0;
  const events = new EventEmitter<PasswordDetectorEvents>();
  const timers = fakeTimers();
  const vault = {
    accountsFor: vi.fn(async () => accounts),
    passwordFor: vi.fn(async (id: string) => (id === 'a1' ? 'pw-one' : 'pw-two')),
    candidateFor: vi.fn(async () => candidate),
    saveCandidate: vi.fn(async (): Promise<SaveAnswer> => ({ ok: true, id: 'a1', kind: 'new' })),
    neverFor: vi.fn(async () => true),
    askUnlock: vi.fn(async () => true),
    generatorFor: vi.fn(async () => generator),
    presave: vi.fn(async (_r: { origin: string; password: string; chordId: string | null; passphrase?: string }): Promise<Awaited<ReturnType<AssistVault['presave']>>> => ({ ok: true, id: 'g1', setup: false })),
    presaved: vi.fn(async (_action: 'pending' | 'confirm', _id: string, _origin: string, _chordId: string | null, _values: { username?: string; password?: string }) => true),
    changeAccounts: vi.fn(async (_origin: string, _chordId: string | null, _current: string | null) => change),
    changePassword: vi.fn(async (_r: { origin: string; chordId: string | null; account: string; password: string; presaved?: string }): Promise<SaveAnswer> => ({ ok: true, id: 'a1', kind: 'update' })),
    deleteSaved: vi.fn(async (_id: string, _origin: string, _chordId: string | null) => true),
  } satisfies { [K in keyof AssistVault]: unknown };
  const page = fakePage();
  const theTab: AssistTab | null = tab === null ? null : { nodeId: 'n1', windowId: 'w1', chordId: 'c1', private: false, ...tab };
  const host = {
    tabOf: vi.fn((contents: WebContents) => ((contents as unknown) === page ? theTab : null)),
    shown: vi.fn(() => shown),
    changed: vi.fn(),
    focusPage: vi.fn(),
    accent: vi.fn(() => 'oklch(0.58 0.14 330)'),
    toast: vi.fn(),
    openPasswords: vi.fn(),
    passwordsOn: vi.fn((_chordId: string | null) => true),
    offer: vi.fn((_nodeId: string, _on: boolean) => {}),
    prepareMenu: vi.fn(),
  };
  const assist = new PasswordAssist({
    vault: vault as unknown as AssistVault,
    detector: { events },
    host,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    siteOf,
    generate: vi.fn(async (origin: string) => {
      const g = await (generate ?? (async () => ({ password: `Gen-${++made}`, rule: null })))(origin);
      return g && { strong: true, ...g };
    }),
  });
  assist.attachPage(page as unknown as WebContents);
  const contents = page as unknown as WebContents;
  const focus = async (over: Record<string, unknown> = {}) => {
    events.emit('focus', { contents, frame: page.mainFrame as never, origin: ORIGIN, zoomFactor: 1.5, formId: 'f1', kind: 'sign-in', role: 'username', rect: { x: 10, y: 20, width: 200, height: 30 }, ...over } as never);
    await flush();
  };
  const blur = () => events.emit('blur', { contents, formId: 'f1' });
  /** A key as Electron gives it to `before-input-event`: whether main stopped it. */
  const key = (k: string, extra: Record<string, unknown> = {}) => {
    const event = { preventDefault: vi.fn() };
    page.emit('before-input-event', event, { type: 'keyDown', key: k, ...extra });
    return event.preventDefault.mock.calls.length > 0;
  };
  const signedIn = async (over: Record<string, unknown> = {}) => {
    events.emit('signedIn', { contents, formId: 'f1', kind: 'sign-in', origin: ORIGIN, how: 'navigation', hint: null, values: { ...VALUES }, ...over } as never);
    await flush();
    await flush();
  };
  const submitted = async (over: Record<string, unknown> = {}) => {
    events.emit('submitted', { contents, formId: 'f1', kind: 'sign-up', origin: ORIGIN, signal: 'submit', values: { username: VALUES.username }, ...over } as never);
    await flush();
  };
  return { assist, vault, host, page, events, timers, focus, blur, key, signedIn, submitted, contents };
}

const sent = (page: FakePage) => page.mainFrame.send.mock.calls;

describe('the menu under the field: which focus gets one', () => {
  it.each<[string, Parameters<typeof setup>[0], Record<string, unknown>, ReturnType<PasswordAssist['menuFor']> | null, boolean]>([
    [
      'saved accounts: usernames, and the host only where it isn’t the page’s',
      {},
      {},
      { id: 1, host: 'github.com', state: 'accounts', accounts: [{ username: 'ada@acme.dev', host: null }, { username: 'ada.lovelace', host: 'gist.github.com' }], index: 0, insecure: false },
      true,
    ],
    ['locked: one row, Unlock passwords', { accounts: { state: 'locked' } }, {}, { id: 1, host: 'github.com', state: 'locked', accounts: [], index: 0, insecure: false }, true],
    ['an http page says so', { accounts: { state: 'open', offers: OFFERS.slice(0, 1), insecure: true } }, {}, { id: 1, host: 'github.com', state: 'accounts', accounts: [{ username: 'ada@acme.dev', host: null }], index: 0, insecure: true }, true],
    ['nothing saved for the site: no menu', { accounts: { state: 'open', offers: [], insecure: false } }, {}, null, true],
    ['no vault yet: no menu', { accounts: { state: 'none' } }, {}, null, true],
    ['passwords off there (the switch, an extension, a page that can’t be saved): no menu', { accounts: { state: 'off' } }, {}, null, true],
    ['the password field', {}, { role: 'current-password' }, { id: 1, host: 'github.com', state: 'accounts', accounts: [{ username: 'ada@acme.dev', host: null }, { username: 'ada.lovelace', host: 'gist.github.com' }], index: 0, insecure: false }, true],
    ['a sign-up form’s username: no menu, not asked', {}, { kind: 'sign-up' }, null, false],
    [
      'a new-password field of a form read as a sign-in: the generator’s row first, the first account highlighted (3A; review round 1)',
      {},
      { role: 'new-password' },
      {
        id: 1,
        host: 'github.com',
        state: 'generate',
        accounts: [{ username: 'ada@acme.dev', host: null }, { username: 'ada.lovelace', host: 'gist.github.com' }],
        index: 1,
        insecure: false,
        generated: { password: 'Gen-1', again: false, vault: 'open', rule: null, strong: true },
      },
      true,
    ],
    [
      'a change-password form’s current password: the accounts (phase 2)',
      {},
      { kind: 'change', role: 'current-password' },
      { id: 1, host: 'github.com', state: 'accounts', accounts: [{ username: 'ada@acme.dev', host: null }, { username: 'ada.lovelace', host: 'gist.github.com' }], index: 0, insecure: false },
      true,
    ],
    ['a page that isn’t a tab’s: not asked', { tab: null }, {}, null, false],
    ['a tab not on screen: not asked', { shown: false }, {}, null, false],
    [
      'a private window: offered (it fills, never saves)',
      { tab: { private: true } },
      {},
      { id: 1, host: 'github.com', state: 'accounts', accounts: [{ username: 'ada@acme.dev', host: null }, { username: 'ada.lovelace', host: 'gist.github.com' }], index: 0, insecure: false },
      true,
    ],
  ])('%s', async (_name, options, focus, menu, asked) => {
    const t = setup(options);
    await t.focus(focus);
    expect(t.vault.accountsFor).toHaveBeenCalledTimes(asked ? 1 : 0);
    if (asked) expect(t.vault.accountsFor).toHaveBeenCalledWith(ORIGIN, 'c1');
    expect(t.assist.menuFor('w1')).toEqual(menu);
    // Never a password in what the popover gets.
    expect(JSON.stringify(t.assist.menuFor('w1'))).not.toMatch(/pw-/);
  });

  it('placed under the field: the box and the page’s zoom, following the field as it moves', async () => {
    const t = setup();
    await t.focus();
    expect(t.assist.anchorFor('w1')).toEqual({ contents: t.contents, rect: { x: 10, y: 20, width: 200, height: 30 }, zoom: 1.5 });
    await t.focus({ rect: { x: 10, y: -80, width: 200, height: 30 } });
    expect(t.assist.anchorFor('w1')?.rect.y).toBe(-80);
    expect(t.vault.accountsFor).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (t: ReturnType<typeof setup>) => void]>([
    ['the field lost focus', (t) => t.blur()],
    ['the page navigated', (t) => t.page.emit('did-navigate', {}, 'https://github.com/next', 200)],
    ['the page started to go', (t) => t.page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })],
  ])('an answer that comes after %s opens nothing', async (_name, between) => {
    const t = setup();
    let answer!: (a: AccountsAnswer) => void;
    t.vault.accountsFor.mockImplementationOnce(() => new Promise((done) => (answer = done)));
    void t.focus();
    await flush();
    between(t);
    answer({ state: 'open', offers: OFFERS, insecure: false });
    await flush();
    expect(t.assist.menuFor('w1')).toBeNull();
  });

  it.each<[string, (t: ReturnType<typeof setup>) => void]>([
    ['the field loses focus', (t) => t.blur()],
    ['the page navigates', (t) => t.page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })],
    ['the tab leaves the screen', (t) => (t.host.shown.mockReturnValue(false), t.assist.check('w1'))],
    ['the page goes', (t) => ((t.page.destroyed = true), t.page.emit('destroyed'))],
    ['the window closes', (t) => t.assist.windowClosed('w1')],
    ['a sign-up field takes focus', (t) => void t.focus({ kind: 'sign-up', formId: 'f2' })],
  ])('closes when %s', async (_name, act) => {
    const t = setup();
    await t.focus();
    expect(t.assist.menuFor('w1')).not.toBeNull();
    act(t);
    await flush();
    expect(t.assist.menuFor('w1')).toBeNull();
    expect(t.assist.anchorFor('w1')).toBeNull();
  });

  it('listens to the page’s keys only while it’s open', async () => {
    const t = setup();
    expect(t.page.listenerCount('before-input-event')).toBe(0);
    await t.focus();
    expect(t.page.listenerCount('before-input-event')).toBe(1);
    t.blur();
    expect(t.page.listenerCount('before-input-event')).toBe(0);
  });
});

describe('keys: the page keeps focus, and never sees the menu’s', () => {
  it.each<[string, string[], { taken: boolean[]; open: boolean; index?: number; filled?: string }]>([
    ['↓ moves the highlight', ['ArrowDown'], { taken: [true], open: true, index: 1 }],
    ['↓ stops at Other passwords…', ['ArrowDown', 'ArrowDown', 'ArrowDown'], { taken: [true, true, true], open: true, index: 2 }],
    ['↑ stops at the first', ['ArrowUp'], { taken: [true], open: true, index: 0 }],
    ['Enter fills the highlighted account', ['ArrowDown', 'ArrowDown', 'ArrowUp', 'Enter'], { taken: [true, true, true, true], open: false, filled: 'ada.lovelace' }],
    ['Enter on the first', ['Enter'], { taken: [true], open: false, filled: 'ada@acme.dev' }],
    ['Escape closes', ['Escape'], { taken: [true], open: false }],
    ['Tab goes to the page and closes', ['Tab'], { taken: [false], open: false }],
    ['typing goes to the page and leaves it open', ['a', 'b'], { taken: [false, false], open: true, index: 0 }],
  ])('%s', async (_name, keys, expected) => {
    const t = setup();
    await t.focus();
    const taken = keys.map((k) => t.key(k));
    await flush();
    await flush();
    expect(taken).toEqual(expected.taken);
    expect(t.assist.menuFor('w1') !== null).toBe(expected.open);
    if (expected.index !== undefined) expect(t.assist.menuFor('w1')?.index).toBe(expected.index);
    const fills = sent(t.page);
    if (expected.filled) {
      expect(fills).toHaveLength(1);
      expect(fills[0]![0]).toBe(PASSWORDS_FILL);
      expect(fills[0]![1]).toMatchObject({ formId: 'f1', username: expected.filled, password: expected.filled === 'ada@acme.dev' ? 'pw-one' : 'pw-two', highlight: { color: 'oklch(0.58 0.14 330)' } });
    } else expect(fills).toHaveLength(0);
  });

  it('a key with a modifier is never the menu’s', async () => {
    const t = setup();
    await t.focus();
    expect(t.key('Enter', { control: true })).toBe(false);
    expect(t.key('ArrowDown', { meta: true })).toBe(false);
    expect(t.assist.menuFor('w1')?.index).toBe(0);
  });

  it('“not again in this form” is the page’s: the next document’s form (f1 again) gets its menu', async () => {
    const t = setup();
    await t.focus();
    t.key('Enter');
    await flush();
    t.page.emit('did-navigate', {}, 'https://github.com/login', 200);
    await t.focus();
    expect(t.assist.menuFor('w1')).not.toBeNull();
  });

  it('a first step picked from, then its password step in the same form with no blur (the page moved focus): the password gets its menu', async () => {
    const t = setup();
    await t.focus({ kind: 'username-only', role: 'username' });
    t.key('Enter');
    await flush();
    // The first step's field again, still a first step: quiet.
    await t.focus({ kind: 'username-only', role: 'username' });
    expect(t.assist.menuFor('w1')).toBeNull();
    // Next swapped in the password step: the form is a sign-in now.
    await t.focus({ kind: 'sign-in', role: 'current-password' });
    expect(t.assist.menuFor('w1')).not.toBeNull();
  });

  it('Escape on a first step, then typing shows the password (the form a sign-in now, the same field): no menu under the typing', async () => {
    const t = setup();
    await t.focus({ kind: 'username-only', role: 'username' });
    t.key('Escape');
    await t.focus({ kind: 'sign-in', role: 'username' });
    expect(t.assist.menuFor('w1')).toBeNull();
    // The same after a pick.
    t.blur();
    await t.focus({ kind: 'username-only', role: 'username' });
    t.key('Enter');
    await flush();
    await t.focus({ kind: 'sign-in', role: 'username' });
    expect(t.assist.menuFor('w1')).toBeNull();
  });

  it('once answered (a choice, Escape), not again in that form until you leave it', async () => {
    const t = setup();
    await t.focus();
    t.key('Escape');
    await t.focus();
    await t.focus({ role: 'current-password' });
    expect(t.assist.menuFor('w1')).toBeNull();
    t.blur();
    await t.focus();
    expect(t.assist.menuFor('w1')).not.toBeNull();
  });
});

describe('a click on the menu (M0 §3)', () => {
  it('keeps the menu through the blur it causes, fills, and gives the page its focus back', async () => {
    const t = setup();
    await t.focus();
    t.assist.popoverMouse('w1', 'mouseDown');
    t.blur();
    expect(t.assist.menuFor('w1')).not.toBeNull();
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 1);
    t.assist.popoverMouse('w1', 'mouseUp');
    t.timers.advance(0);
    await flush();
    expect(t.host.focusPage).toHaveBeenCalledWith(t.contents);
    expect(sent(t.page)[0]![1]).toMatchObject({ username: 'ada.lovelace', password: 'pw-two' });
    // The field's focus coming back doesn't open the menu again.
    await t.focus();
    expect(t.assist.menuFor('w1')).toBeNull();
  });

  it('without a press first, a blur closes it; and the grace runs out', async () => {
    const t = setup();
    await t.focus();
    t.assist.popoverMouse('w1', 'mouseDown');
    t.timers.advance(CLICK_GRACE_MS + 1);
    t.blur();
    expect(t.assist.menuFor('w1')).toBeNull();
  });

  it.each<[string, number, number | null]>([
    ['another menu’s id', 99, null],
    ['a row past the last', 1, 7],
  ])('refuses %s', async (_name, id, index) => {
    const t = setup();
    await t.focus();
    t.assist.chooseRow('w1', id === 1 ? t.assist.menuFor('w1')!.id : id, index ?? 0);
    await flush();
    expect(sent(t.page)).toHaveLength(0);
    expect(t.vault.passwordFor).not.toHaveBeenCalled();
  });

  it('another window’s popover can’t choose', async () => {
    const t = setup();
    await t.focus();
    t.assist.chooseRow('w2', t.assist.menuFor('w1')!.id, 0);
    await flush();
    expect(t.vault.passwordFor).not.toHaveBeenCalled();
  });
});

describe('filling: only that frame, that origin, that document (S17 §5)', () => {
  const choose = async (t: ReturnType<typeof setup>, before?: () => void) => {
    await t.focus();
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    t.vault.passwordFor.mockImplementationOnce(async () => {
      await gate;
      return 'pw-one';
    });
    t.key('Enter');
    await flush();
    before?.();
    release();
    await flush();
    await flush();
  };

  it.each<[string, ((t: ReturnType<typeof setup>) => void) | undefined, boolean]>([
    ['as it was: sent to the frame', undefined, true],
    ['another document since: nothing', (t) => void t.page.emit('did-navigate', {}, 'https://github.com/other', 200), false],
    ['another frame since (a crash, a new process): nothing', (t) => void (t.page.mainFrame = { ...t.page.mainFrame, routingId: 10, send: vi.fn() }), false],
    ['another origin in the frame: nothing', (t) => void (t.page.mainFrame.origin = 'https://evil.example'), false],
    ['the page went: nothing', (t) => void (t.page.destroyed = true), false],
  ])('%s', async (_name, act, ok) => {
    const t = setup();
    const frame = t.page.mainFrame;
    await choose(t, act ? () => act(t) : undefined);
    expect(t.vault.passwordFor).toHaveBeenCalledWith('a1', ORIGIN, 'c1');
    const calls = [...frame.send.mock.calls, ...(t.page.mainFrame !== frame ? t.page.mainFrame.send.mock.calls : [])];
    expect(calls.length).toBe(ok ? 1 : 0);
  });

  it('nothing when the vault won’t give it (no match for the origin, locked since)', async () => {
    const t = setup();
    t.vault.passwordFor.mockResolvedValueOnce(null as never);
    await t.focus();
    t.key('Enter');
    await flush();
    expect(sent(t.page)).toHaveLength(0);
  });

  it('Other passwords… opens Settings → Passwords', async () => {
    const t = setup();
    await t.focus();
    t.key('ArrowDown');
    t.key('ArrowDown');
    t.key('Enter');
    await flush();
    expect(t.host.openPasswords).toHaveBeenCalledWith('w1');
    expect(t.vault.passwordFor).not.toHaveBeenCalled();
  });

  it('Unlock passwords asks for the passphrase, then gives the field its focus back (its menu comes again)', async () => {
    const t = setup({ accounts: { state: 'locked' } });
    await t.focus();
    t.key('Enter');
    await flush();
    expect(t.vault.askUnlock).toHaveBeenCalledWith('w1');
    expect(t.host.focusPage).toHaveBeenCalledWith(t.contents);
    t.vault.accountsFor.mockResolvedValueOnce({ state: 'open', offers: OFFERS, insecure: false });
    await t.focus();
    expect(t.assist.menuFor('w1')?.state).toBe('accounts');
  });

  it('the agent found the form changed: a toast says so', () => {
    const t = setup();
    t.events.emit('filled', { contents: t.contents, formId: 'f1', ok: false });
    t.events.emit('filled', { contents: t.contents, formId: 'f1', ok: true });
    expect(t.host.toast).toHaveBeenCalledTimes(1);
  });

  it('the agent refused half a fill: a toast and a log line say so, with no value, origin or field', () => {
    const t = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      t.events.emit('filled', { contents: t.contents, formId: 'f1', ok: false, reason: 'password' });
      expect(t.host.toast).toHaveBeenCalledWith('w1', 'passwords:fill', expect.stringContaining('where the password goes'));
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(warn.mock.calls[0]).toHaveLength(1);
      for (const secret of ['f1', 'ada', 'pw-', 'github', 'http']) expect(line).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the save and update cards: which sign-in gets one', () => {
  it.each<[string, Parameters<typeof setup>[0], Record<string, unknown>, Partial<ReturnType<PasswordAssist['cardFor']>> | null, boolean]>([
    ['a new password', {}, {}, { kind: 'new', host: 'github.com', username: 'ada@acme.dev', setup: false, busy: false, problem: null }, true],
    ['the first ever: it chooses the passphrase too', { candidate: { kind: 'new', setup: true } }, {}, { kind: 'new', setup: true }, true],
    ['a changed password', { candidate: { kind: 'update', id: 'a1' } }, {}, { kind: 'update', username: 'ada@acme.dev' }, true],
    ['locked: offered, and Save asks to unlock', { candidate: { kind: 'locked' } }, {}, { kind: 'new', setup: false }, true],
    ['the same password: no card', { candidate: { kind: 'same', id: 'a1' } }, {}, null, true],
    ['a site you said never to: no card', { candidate: { kind: 'never' } }, {}, null, true],
    ['passwords off there: no card', { candidate: { kind: 'off' } }, {}, null, true],
    ['refused (a proxy, a value too long): no card', { candidate: { kind: 'refused' } }, {}, null, true],
    ['a private window: never, not even asked', { tab: { private: true } }, {}, null, false],
    ['not a tab’s page: not asked', { tab: null }, {}, null, false],
    ['nothing typed came with it: not asked', {}, { values: null }, null, false],
    ['a sign-up with a password you typed: the save card (phase 2)', {}, { kind: 'sign-up' }, { kind: 'new', username: 'ada@acme.dev' }, true],
    ['a change-password form: its own way (below), not the sign-in’s', {}, { kind: 'change' }, { kind: 'new' }, false],
  ])('%s', async (_name, options, event, card, asked) => {
    const t = setup(options);
    await t.signedIn(event);
    expect(t.vault.candidateFor).toHaveBeenCalledTimes(asked ? 1 : 0);
    if (asked) expect(t.vault.candidateFor).toHaveBeenCalledWith({ origin: ORIGIN, username: VALUES.username, password: VALUES.password, chordId: 'c1' });
    const shown = t.assist.cardFor('n1');
    if (card) expect(shown).toMatchObject(card);
    else expect(shown).toBeNull();
    // The popover never gets the password with the card.
    expect(JSON.stringify(shown)).not.toContain(VALUES.password);
  });
});

describe('the cards’ buttons', () => {
  const offered = async (options: Parameters<typeof setup>[0] = {}) => {
    const t = setup(options);
    await t.signedIn();
    return { ...t, card: t.assist.cardFor('n1')! };
  };

  it('Save: the username as you left it, the password typed; the card and what was typed go', async () => {
    const t = await offered();
    await t.assist.answer('w1', t.card.id, 'save', { username: 'ada' });
    expect(t.vault.saveCandidate).toHaveBeenCalledWith({ origin: ORIGIN, username: 'ada', password: VALUES.password, chordId: 'c1' });
    expect(t.assist.cardFor('n1')).toBeNull();
    expect(t.assist.reveal('w1', t.card.id)).toBeNull();
    expect(t.host.toast).not.toHaveBeenCalled();
  });

  it('the first Save sets the passphrase, and says where it went', async () => {
    const t = await offered({ candidate: { kind: 'new', setup: true } });
    // No passphrase: nothing sent.
    await t.assist.answer('w1', t.card.id, 'save', { username: 'ada@acme.dev' });
    expect(t.vault.saveCandidate).not.toHaveBeenCalled();
    await t.assist.answer('w1', t.card.id, 'save', { username: 'ada@acme.dev', passphrase: 'a long enough passphrase' });
    expect(t.vault.saveCandidate).toHaveBeenCalledWith({ origin: ORIGIN, username: 'ada@acme.dev', password: VALUES.password, chordId: 'c1', passphrase: 'a long enough passphrase' });
    expect(t.host.toast).toHaveBeenCalledWith('w1', 'passwords:saved', 'Saved. It’s in Settings → Passwords.');
  });

  it('a passphrase is never sent for a card that isn’t the first', async () => {
    const t = await offered();
    await t.assist.answer('w1', t.card.id, 'save', { passphrase: 'a long enough passphrase' });
    expect((t.vault.saveCandidate.mock.calls as unknown as [Record<string, unknown>][])[0]![0]).not.toHaveProperty('passphrase');
  });

  it('Update: always for the username it was offered for', async () => {
    const t = await offered({ candidate: { kind: 'update', id: 'a1' } });
    await t.assist.answer('w1', t.card.id, 'save', { username: 'someone.else' });
    expect(t.vault.saveCandidate).toHaveBeenCalledWith(expect.objectContaining({ username: VALUES.username }));
  });

  it.each<[string, SaveAnswer, { card: boolean; problem?: 'io' | null; setup?: boolean }]>([
    ['chord-data failed: the card stays and says so', { ok: false, problem: 'io' }, { card: true, problem: 'io' }],
    ['the vault went since (Start over): the card asks for a passphrase now', { ok: false, problem: 'none' }, { card: true, setup: true }],
    ['passwords turned off since: the card goes', { ok: false, problem: 'off' }, { card: false }],
    ['the site went on the never list: the card goes', { ok: false, problem: 'never' }, { card: false }],
  ])('%s', async (_name, answer, expected) => {
    const t = await offered();
    t.vault.saveCandidate.mockResolvedValueOnce(answer);
    await t.assist.answer('w1', t.card.id, 'save', {});
    const card = t.assist.cardFor('n1');
    expect(card !== null).toBe(expected.card);
    if (expected.problem !== undefined) expect(card?.problem).toBe(expected.problem);
    if (expected.setup !== undefined) expect(card?.setup).toBe(expected.setup);
  });

  it('locked when you press Save: asks to unlock, then saves', async () => {
    const t = await offered({ candidate: { kind: 'locked' } });
    t.vault.saveCandidate.mockResolvedValueOnce({ ok: false, problem: 'locked' });
    await t.assist.answer('w1', t.card.id, 'save', {});
    expect(t.vault.askUnlock).toHaveBeenCalledWith('w1');
    expect(t.vault.saveCandidate).toHaveBeenCalledTimes(2);
    expect(t.assist.cardFor('n1')).toBeNull();
  });

  it('…and the unlock card cancelled: the save card stays', async () => {
    const t = await offered({ candidate: { kind: 'locked' } });
    t.vault.saveCandidate.mockResolvedValueOnce({ ok: false, problem: 'locked' });
    t.vault.askUnlock.mockResolvedValueOnce(false);
    await t.assist.answer('w1', t.card.id, 'save', {});
    expect(t.assist.cardFor('n1')).toMatchObject({ busy: false });
  });

  it('Never for this site: the vault hears it, and the card goes', async () => {
    const t = await offered();
    await t.assist.answer('w1', t.card.id, 'never');
    expect(t.vault.neverFor).toHaveBeenCalledWith(ORIGIN, 'c1');
    expect(t.assist.cardFor('n1')).toBeNull();
  });

  it('Never while locked: asks to unlock first', async () => {
    const t = await offered();
    t.vault.neverFor.mockResolvedValueOnce(false);
    await t.assist.answer('w1', t.card.id, 'never');
    expect(t.vault.askUnlock).toHaveBeenCalled();
    expect(t.vault.neverFor).toHaveBeenCalledTimes(2);
    expect(t.assist.cardFor('n1')).toBeNull();
  });

  it('×: the card hides, nothing is saved, and the key in the address can bring it back', async () => {
    const t = await offered();
    await t.assist.answer('w1', t.card.id, 'close');
    expect(t.assist.cardFor('n1')).toBeNull();
    // Hidden, its eye and buttons answer nothing.
    expect(t.assist.reveal('w1', t.card.id)).toBeNull();
    await t.assist.answer('w1', t.card.id, 'save', {});
    expect(t.vault.saveCandidate).not.toHaveBeenCalled();
    expect(t.host.offer).toHaveBeenLastCalledWith('n1', true);
    t.assist.reopen('w1', 'n1');
    expect(t.assist.cardFor('n1')).toEqual(t.card);
    expect(t.host.offer).toHaveBeenLastCalledWith('n1', false);
  });

  it('the eye: the password, to the card’s own window only', async () => {
    const t = await offered();
    expect(t.assist.reveal('w1', t.card.id)).toEqual({ password: VALUES.password });
    expect(t.assist.reveal('w2', t.card.id)).toBeNull();
    expect(t.assist.reveal('w1', t.card.id + 1)).toBeNull();
  });

  it('another window’s popover can’t answer it', async () => {
    const t = await offered();
    await t.assist.answer('w2', t.card.id, 'save', {});
    expect(t.vault.saveCandidate).not.toHaveBeenCalled();
    expect(t.assist.cardFor('n1')).not.toBeNull();
  });
});

describe('how long a card lasts: shown, hidden (the key brings it back), gone', () => {
  type Where = 'shown' | 'hidden' | 'gone';
  /** Shown in the popover; hidden with the key in the address (it comes back); or gone, values with it. */
  const whereIs = (t: ReturnType<typeof setup>, id: number): Where => {
    if (t.assist.cardFor('n1')?.id === id) return 'shown';
    const offered = t.host.offer.mock.calls.filter(([nodeId]) => nodeId === 'n1').at(-1)?.[1] === true;
    if (!offered) return 'gone';
    t.assist.reopen('w1', 'n1');
    return t.assist.cardFor('n1')?.id === id ? 'hidden' : 'gone';
  };
  const nav = async (t: ReturnType<typeof setup>, url: string, initiator: unknown) => {
    t.page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, initiator });
    t.page.emit('did-navigate', {}, url, 200);
    await flush();
    await flush();
  };

  it.each<[string, (t: ReturnType<typeof setup>, id: number) => Promise<unknown> | unknown, Where]>([
    ['a minute unused: it hides', (t) => t.timers.advance(SAVE_CARD_MS), 'hidden'],
    ['just under a minute: still shown', (t) => t.timers.advance(SAVE_CARD_MS - 1), 'shown'],
    ['while you’re in it, it stays', async (t, id) => (await t.assist.answer('w1', id, 'hold'), t.timers.advance(SAVE_CARD_MS * 3)), 'shown'],
    ['…and once you leave it, a minute, then hidden', async (t, id) => (await t.assist.answer('w1', id, 'hold'), await t.assist.answer('w1', id, 'release'), t.timers.advance(SAVE_CARD_MS)), 'hidden'],
    ['×: hidden', (t, id) => t.assist.answer('w1', id, 'close'), 'hidden'],
    ['the candidate’s deadline (5 minutes from the typing): gone, shown or not', (t) => t.timers.advance(HOLD_MS), 'gone'],
    ['…hidden first, then the deadline: gone', (t, id) => (t.assist.answer('w1', id, 'close'), t.timers.advance(HOLD_MS)), 'gone'],
    ['Save: gone', (t, id) => t.assist.answer('w1', id, 'save', {}), 'gone'],
    ['Never: gone', (t, id) => t.assist.answer('w1', id, 'never'), 'gone'],
    ['passwords off for the chord, hidden: gone', (t, id) => (t.assist.answer('w1', id, 'close'), t.host.passwordsOn.mockReturnValue(false), t.assist.switched()), 'gone'],
    ['the page goes on within the site (a link): still there', (t, id) => (t.assist.answer('w1', id, 'close'), nav(t, 'https://gist.github.com/ada', {})), 'hidden'],
    ['leaving the site, hidden: gone', (t, id) => (t.assist.answer('w1', id, 'close'), nav(t, 'https://example.org/', {})), 'gone'],
    ['a navigation of your own (the address bar, Back), even on the site: gone', (t, id) => (t.assist.answer('w1', id, 'close'), nav(t, 'https://github.com/settings', null)), 'gone'],
    ['a sign-in there that failed: gone', (t, id) => (t.assist.answer('w1', id, 'close'), t.events.emit('failed', { contents: t.contents, formId: 'f1', kind: 'sign-in', origin: ORIGIN, why: 'still-shown' })), 'gone'],
    ['the tab closing: gone', (t) => ((t.page.destroyed = true), t.page.emit('destroyed')), 'gone'],
    ['its window closing: gone', (t) => t.assist.windowClosed('w1'), 'gone'],
  ])('%s', async (_name, act, where) => {
    const t = setup();
    await t.signedIn();
    const card = t.assist.cardFor('n1')!;
    await act(t, card.id);
    await flush();
    expect(whereIs(t, card.id)).toBe(where);
    if (where === 'gone') expect(t.assist.reveal('w1', card.id)).toBeNull();
  });

  it('the deadline is the candidate’s, handed over by the tracker: a card made late gets what’s left of it, not 5 minutes more', async () => {
    const t = setup();
    t.timers.advance(1000);
    await t.signedIn({ valuesUntil: 1000 + 60_000 });
    const card = t.assist.cardFor('n1')!;
    t.assist.answer('w1', card.id, 'close');
    t.timers.advance(59_999);
    expect(whereIs(t, card.id)).toBe('hidden');
    t.timers.advance(1);
    expect(whereIs(t, card.id)).toBe('gone');
  });

  it('a candidate already past its deadline makes no card', async () => {
    const t = setup();
    t.timers.advance(10_000);
    await t.signedIn({ valuesUntil: 10_000 });
    expect(t.assist.cardFor('n1')).toBeNull();
  });

  it('the key answers only its own window, and only a card that’s hidden', async () => {
    const t = setup();
    await t.signedIn();
    const card = t.assist.cardFor('n1')!;
    t.assist.reopen('w1', 'n1');
    expect(t.host.offer).not.toHaveBeenCalled();
    await t.assist.answer('w1', card.id, 'close');
    t.assist.reopen('w2', 'n1');
    expect(t.assist.cardFor('n1')).toBeNull();
    t.assist.reopen('w1', 'n1');
    expect(t.assist.cardFor('n1')?.id).toBe(card.id);
  });

  it('a private window keeps nothing: no card, no key', async () => {
    const t = setup({ tab: { private: true } });
    await t.signedIn();
    expect(t.assist.cardFor('n1')).toBeNull();
    expect(t.host.offer).not.toHaveBeenCalled();
  });

  it('a newer card replaces the old one, and the old one’s password with it', async () => {
    const t = setup();
    await t.signedIn();
    const first = t.assist.cardFor('n1')!;
    await t.signedIn({ values: { username: 'grace', password: 'other' } });
    expect(t.assist.reveal('w1', first.id)).toBeNull();
    expect(t.assist.cardFor('n1')).toMatchObject({ username: 'grace' });
  });
});

describe('a card is only for the page you’re on (security review of 0fdf159)', () => {
  /** A promise the test resolves when it likes. */
  const gate = <T,>() => {
    let open!: (value: T) => void;
    const promise = new Promise<T>((done) => (open = done));
    return { promise, open };
  };

  it('the tab commits another site while the vault answers: no card, and nothing of the sign-in kept', async () => {
    const t = setup();
    const answer = gate<CandidateAnswer>();
    t.vault.candidateFor.mockImplementationOnce(() => answer.promise);
    const signedIn = t.signedIn();
    t.page.emit('did-navigate', {}, 'https://example.org/', 200);
    answer.open({ kind: 'new', setup: false });
    await signedIn;
    await flush();
    expect(t.assist.cardFor('n1')).toBeNull();
    expect(t.host.changed).not.toHaveBeenCalled();
  });

  it('…or while its site is worked out', async () => {
    const site = gate<string | null>();
    const t = setup({ siteOf: () => site.promise });
    const signedIn = t.signedIn();
    await flush();
    expect(t.vault.candidateFor).toHaveBeenCalled();
    t.page.emit('did-navigate', {}, 'https://example.org/', 200);
    site.open('github.com');
    await signedIn;
    await flush();
    expect(t.assist.cardFor('n1')).toBeNull();
  });

  it('the card goes while the unlock card is up: the vault isn’t asked to save after the unlock', async () => {
    const t = setup({ candidate: { kind: 'locked' } });
    await t.signedIn();
    const card = t.assist.cardFor('n1')!;
    t.vault.saveCandidate.mockResolvedValueOnce({ ok: false, problem: 'locked' });
    const unlocked = gate<boolean>();
    t.vault.askUnlock.mockImplementationOnce(() => unlocked.promise);
    const saving = t.assist.answer('w1', card.id, 'save', {});
    await flush();
    expect(t.vault.askUnlock).toHaveBeenCalled();
    // The tab leaves the site while you type the passphrase: the card goes, values with it.
    t.page.emit('did-navigate', {}, 'https://example.org/', 200);
    await flush();
    await flush();
    expect(t.assist.cardFor('n1')).toBeNull();
    unlocked.open(true);
    await saving;
    expect(t.vault.saveCandidate).toHaveBeenCalledTimes(1);
    expect(t.host.toast).not.toHaveBeenCalled();
  });
});

describe('a key the menu took is the menu’s to its keyUp (general review of 37bd619)', () => {
  const up = (t: ReturnType<typeof setup>, k: string) => t.key(k, { type: 'keyUp' });

  it('↓ and ↑: their keyUp never reaches the page; another key’s does', async () => {
    const t = setup();
    await t.focus();
    expect([t.key('ArrowDown'), up(t, 'ArrowDown'), t.key('ArrowUp'), up(t, 'ArrowUp')]).toEqual([true, true, true, true]);
    expect([t.key('a'), up(t, 'a')]).toEqual([false, false]);
    expect(t.assist.menuFor('w1')).not.toBeNull();
  });

  it.each<[string, string]>([
    ['Enter (it fills)', 'Enter'],
    ['Escape', 'Escape'],
  ])('%s closes the menu, and its keyUp (and Enter’s character) is still the menu’s; then the listener goes', async (_name, k) => {
    const t = setup();
    await t.focus();
    expect(t.key(k)).toBe(true);
    expect(t.assist.menuFor('w1')).toBeNull();
    expect(t.page.listenerCount('before-input-event')).toBe(1);
    if (k === 'Enter') expect(t.key('\r', { type: 'char' })).toBe(true);
    expect(up(t, k)).toBe(true);
    expect(t.page.listenerCount('before-input-event')).toBe(0);
    // From then on the page has its keys.
    expect(up(t, k)).toBe(false);
  });

  it('closed with a key still down, another key pressed before its keyUp: that keyUp is still the menu’s', async () => {
    const t = setup();
    await t.focus();
    t.key('Escape', { code: 'Escape' });
    // The page's own key, down and up, in between.
    expect([t.key('b', { code: 'KeyB' }), t.key('b', { type: 'keyUp', code: 'KeyB' })]).toEqual([false, false]);
    expect(t.page.listenerCount('before-input-event')).toBe(1);
    expect(t.key('Escape', { type: 'keyUp', code: 'Escape' })).toBe(true);
    expect(t.page.listenerCount('before-input-event')).toBe(0);
  });

  it('…matched by the physical key: Enter taken, its keyUp seen as Enter by code even if its key reads otherwise', async () => {
    const t = setup();
    await t.focus();
    t.key('Enter', { code: 'NumpadEnter' });
    expect(t.key('Enter', { type: 'keyUp', code: 'NumpadEnter' })).toBe(true);
    expect(t.page.listenerCount('before-input-event')).toBe(0);
  });

  it('a keyUp that never comes (focus left the window): the listener goes after a few events', async () => {
    const t = setup();
    await t.focus();
    t.key('Escape', { code: 'Escape' });
    for (let i = 0; i < TAKEN_KEY_PATIENCE - 1; i++) t.key('x', { code: 'KeyX' });
    expect(t.page.listenerCount('before-input-event')).toBe(1);
    expect(t.key('x', { code: 'KeyX' })).toBe(false);
    expect(t.page.listenerCount('before-input-event')).toBe(0);
  });

  it('closed by a blur with nothing down: the listener goes at once', async () => {
    const t = setup();
    await t.focus();
    t.key('ArrowDown');
    up(t, 'ArrowDown');
    t.blur();
    expect(t.page.listenerCount('before-input-event')).toBe(0);
  });
});

describe('one menu a window, in the window its tab is in (general review of 37bd619)', () => {
  it('another pane’s menu replaces the first, and the first page loses its key listener', async () => {
    const t = setup();
    const second = fakePage();
    const secondTab: AssistTab = { nodeId: 'n2', windowId: 'w1', chordId: 'c1', private: false };
    const firstTab = t.host.tabOf(t.contents);
    t.host.tabOf.mockImplementation((c: WebContents) => ((c as unknown) === second ? secondTab : (c as unknown) === t.page ? firstTab : null));
    t.assist.attachPage(second as unknown as WebContents);
    await t.focus();
    t.events.emit('focus', { contents: second, frame: second.mainFrame, origin: ORIGIN, zoomFactor: 1, formId: 'f1', kind: 'sign-in', role: 'username', rect: { x: 0, y: 0, width: 100, height: 20 } } as never);
    await flush();
    expect(t.assist.anchorFor('w1')?.contents).toBe(second);
    expect(t.page.listenerCount('before-input-event')).toBe(0);
    expect(second.listenerCount('before-input-event')).toBe(1);
    // The first page's keys are its own again.
    expect(t.key('ArrowDown')).toBe(false);
  });

  it('a tab dragged to another window: its menu closes at the next sync', async () => {
    const t = setup();
    await t.focus();
    t.host.tabOf.mockReturnValue({ nodeId: 'n1', windowId: 'w2', chordId: 'c1', private: false });
    t.assist.check('w1');
    expect(t.assist.menuFor('w1')).toBeNull();
    expect(t.page.listenerCount('before-input-event')).toBe(0);
  });
});

describe('save cards follow the switch (general review of 37bd619)', () => {
  it('passwords turned off for the chord (the switch, a password manager’s extension): its card goes, values with it', async () => {
    const t = setup();
    await t.signedIn();
    const card = t.assist.cardFor('n1')!;
    t.assist.switched();
    expect(t.assist.cardFor('n1')).not.toBeNull();
    t.host.passwordsOn.mockReturnValue(false);
    t.assist.switched();
    expect(t.host.passwordsOn).toHaveBeenCalledWith('c1');
    expect(t.assist.cardFor('n1')).toBeNull();
    expect(t.assist.reveal('w1', card.id)).toBeNull();
  });
});

describe('a first step gets no password (general review of 37bd619)', () => {
  it.each<[string, string, boolean]>([
    ['a username-only first step: the username alone', 'username-only', false],
    ['a sign-in form: both', 'sign-in', true],
  ])('%s', async (_name, kind, withPassword) => {
    const t = setup();
    await t.focus({ kind });
    t.key('Enter');
    await flush();
    await flush();
    const fill = sent(t.page)[0]![1] as Record<string, unknown>;
    expect(fill['username']).toBe('ada@acme.dev');
    expect('password' in fill).toBe(withPassword);
  });

  // A one-step sign-in that shows its password field once the email has focus: the menu opened on a first step, and
  // the form is a sign-in by the time you pick. The kind is read when you pick (review of 303ced9).
  it.each<[string, (t: ReturnType<typeof setup>) => Promise<void> | void, boolean]>([
    ['a forms report since says sign-in: both', (t) => void t.events.emit('forms', { contents: t.contents, forms: [{ formId: 'f1', kind: 'sign-in' }] }), true],
    ['a focus in the same form since says sign-in: both', (t) => t.focus({ kind: 'sign-in', role: 'username', rect: { x: 10, y: 20, width: 200, height: 31 } }), true],
    ['another form’s report changes nothing', (t) => void t.events.emit('forms', { contents: t.contents, forms: [{ formId: 'f1', kind: 'username-only' }, { formId: 'f2', kind: 'sign-in' }] }), false],
    ['still a first step when you pick: the username alone', () => {}, false],
  ])('%s', async (_name, since, withPassword) => {
    const t = setup();
    t.events.emit('forms', { contents: t.contents, forms: [{ formId: 'f1', kind: 'username-only' }] });
    await t.focus({ kind: 'username-only' });
    expect(t.assist.menuFor('w1')).not.toBeNull();
    await since(t);
    expect(t.assist.menuFor('w1')).not.toBeNull();
    t.key('Enter');
    await flush();
    await flush();
    const fill = sent(t.page)[0]![1] as Record<string, unknown>;
    expect(fill['username']).toBe('ada@acme.dev');
    expect(fill['password']).toBe(withPassword ? 'pw-one' : undefined);
  });

  it('a forms report while you pick (the vault reading the password) counts too', async () => {
    const t = setup();
    await t.focus({ kind: 'username-only' });
    let release: (pw: 'pw-one') => void = () => {};
    t.vault.passwordFor.mockImplementationOnce(() => new Promise<'pw-one'>((done) => (release = done)));
    t.key('Enter');
    await flush();
    t.events.emit('forms', { contents: t.contents, forms: [{ formId: 'f1', kind: 'sign-in' }] });
    release('pw-one');
    await flush();
    await flush();
    expect((sent(t.page)[0]![1] as Record<string, unknown>)['password']).toBe('pw-one');
  });

  it('a form that turned into a sign-up while the menu is open: the menu goes', async () => {
    const t = setup();
    await t.focus({ kind: 'username-only' });
    t.events.emit('forms', { contents: t.contents, forms: [{ formId: 'f1', kind: 'sign-up' }] });
    expect(t.assist.menuFor('w1')).toBeNull();
  });

  it('the next document’s kinds are its own', async () => {
    const t = setup();
    t.events.emit('forms', { contents: t.contents, forms: [{ formId: 'f1', kind: 'sign-in' }] });
    t.page.emit('did-navigate', {}, 'https://github.com/login', 200);
    await t.focus({ kind: 'username-only' });
    t.key('Enter');
    await flush();
    await flush();
    expect('password' in (sent(t.page)[0]![1] as Record<string, unknown>)).toBe(false);
  });
});

describe('the menu and the cards at once (the owner, 2026-11-16)', () => {
  it('a save card, its username typed over, stays as it was while a menu opens and closes: the same card, same id', async () => {
    const t = setup();
    await t.signedIn();
    const card = t.assist.cardFor('n1')!;
    // The menu's view is made the first time a sign-in field takes focus in the window, before the vault answers.
    await t.focus();
    expect(t.host.prepareMenu).toHaveBeenCalledWith('w1');
    expect(t.assist.menuFor('w1')).not.toBeNull();
    expect(t.assist.cardFor('n1')).toEqual(card);
    t.key('Escape');
    expect(t.assist.menuFor('w1')).toBeNull();
    expect(t.assist.cardFor('n1')).toEqual(card);
    // Saving afterwards takes the username as it was left in the card.
    await t.assist.answer('w1', card.id, 'save', { username: 'ada.edited' });
    expect(t.vault.saveCandidate).toHaveBeenCalledWith(expect.objectContaining({ username: 'ada.edited' }));
  });
});

describe('the password while the unlock card is up (security review, round 2)', () => {
  it('a save waiting on the unlock card holds no copy: the request is made again from the card, and a card gone sends nothing', async () => {
    const t = setup({ candidate: { kind: 'locked' } });
    await t.signedIn();
    const card = t.assist.cardFor('n1')!;
    t.vault.saveCandidate.mockResolvedValueOnce({ ok: false, problem: 'locked' });
    let unlock!: (open: boolean) => void;
    t.vault.askUnlock.mockImplementationOnce(() => new Promise<boolean>((done) => (unlock = done)));
    const saving = t.assist.answer('w1', card.id, 'save', { username: 'ada.edited' });
    await flush();
    // The candidate's deadline passes while the passphrase is typed.
    t.timers.advance(HOLD_MS);
    expect(t.assist.reveal('w1', card.id)).toBeNull();
    unlock(true);
    await saving;
    expect(t.vault.saveCandidate).toHaveBeenCalledTimes(1);
  });

  it('…and a card still there is saved after the unlock, with the username as you left it', async () => {
    const t = setup({ candidate: { kind: 'locked' } });
    await t.signedIn();
    const card = t.assist.cardFor('n1')!;
    t.vault.saveCandidate.mockResolvedValueOnce({ ok: false, problem: 'locked' });
    await t.assist.answer('w1', card.id, 'save', { username: 'ada.edited' });
    expect(t.vault.saveCandidate).toHaveBeenCalledTimes(2);
    expect(t.vault.saveCandidate.mock.calls[1]).toEqual([{ origin: ORIGIN, username: 'ada.edited', password: VALUES.password, chordId: 'c1' }]);
  });
});

describe('the first save from the browser’s own sign-in box (S17 §10)', () => {
  const ROUTER = 'http://router.test:8080';
  const signIn = { origin: ROUTER, realm: 'Router admin', username: 'ada@example.com', password: 'box-Sekrit' };

  it('shows the save card with its passphrase step, and saves with the realm', async () => {
    const t = setup();
    await t.assist.offerFirstSave(t.contents, { ...signIn, until: HOLD_MS });
    const card = t.assist.cardFor('n1')!;
    expect(card).toMatchObject({ kind: 'new', setup: true, host: 'router.test:8080', username: 'ada@example.com' });
    expect(JSON.stringify(card)).not.toContain('box-Sekrit');
    await t.assist.answer('w1', card.id, 'save', { username: 'ada@example.com', passphrase: 'a long enough passphrase' });
    expect(t.vault.saveCandidate).toHaveBeenCalledWith({ origin: ROUTER, realm: 'Router admin', username: 'ada@example.com', password: 'box-Sekrit', chordId: 'c1', passphrase: 'a long enough passphrase' });
  });

  it.each([
    ['in a private window', { tab: { private: true } }, HOLD_MS],
    ['once what was typed has expired', {}, 0],
  ])('never %s', async (_name, options, until) => {
    const t = setup(options);
    await t.assist.offerFirstSave(t.contents, { ...signIn, until });
    expect(t.assist.cardFor('n1')).toBeNull();
  });

  it('goes, and what was typed with it, at the deadline it was given', async () => {
    const t = setup();
    await t.assist.offerFirstSave(t.contents, { ...signIn, until: 1000 });
    const card = t.assist.cardFor('n1')!;
    t.timers.advance(1000);
    expect(t.assist.cardFor('n1')).toBeNull();
    expect(t.assist.reveal('w1', card.id)).toBeNull();
  });
});

/* ---------- phase 2: the generator, sign-up and change forms (S17 §6) ---------- */

const NEW = { kind: 'sign-up', role: 'new-password' };
const filledWith = (page: FakePage) => sent(page).map(([channel, fill]) => [channel, (fill as { generated?: string; password?: string }).generated ?? (fill as { password?: string }).password]);
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await flush();
};

describe('the generator’s row: which new password’s field gets one', () => {
  it.each<[string, Parameters<typeof setup>[0], Record<string, unknown>, Partial<NonNullable<ReturnType<PasswordAssist['menuFor']>>> | null]>([
    ['a sign-up’s new password, the vault open: the row, then the accounts', {}, NEW, { state: 'generate', generated: { password: 'Gen-1', again: false, vault: 'open', rule: null , strong: true }, accounts: [{ username: 'ada@acme.dev', host: null }, { username: 'ada.lovelace', host: 'gist.github.com' }] }],
    ['none saved for the site: the row alone, and Other passwords…', { accounts: { state: 'open', offers: [], insecure: false } }, NEW, { state: 'generate', accounts: [] }],
    ['a site’s rules shaped it: they say so', { generate: async () => ({ password: 'Xq7mR4tKw9Hb3Pz2', rule: 'Letters and digits, 12–16, as this site asks' }) }, NEW, { generated: { password: 'Xq7mR4tKw9Hb3Pz2', again: false, vault: 'open', rule: 'Letters and digits, 12–16, as this site asks' , strong: true } }],
    [
      'a Not confirmed account says when it was made',
      { accounts: { state: 'open', offers: [{ ...OFFERS[0]!, madeAt: 5 }], insecure: false } },
      NEW,
      { accounts: [{ username: 'ada@acme.dev', host: null, madeAt: 5 }] },
    ],
    [
      'rules that can’t be met, with accounts: the accounts alone',
      { generate: async () => null },
      NEW,
      { state: 'accounts', accounts: [{ username: 'ada@acme.dev', host: null }, { username: 'ada.lovelace', host: 'gist.github.com' }] },
    ],
    ['its confirmation', {}, { ...NEW, role: 'confirmation-password' }, { state: 'generate' }],
    ['a change form’s new password', {}, { kind: 'change', role: 'new-password' }, { state: 'generate' }],
    ['a reset form’s', {}, { kind: 'reset', role: 'new-password' }, { state: 'generate' }],
    ['a form of no kind, its field new (autocomplete=new-password)', {}, { kind: 'unknown', role: 'new-password' }, { state: 'generate' }],
    ['locked: offered, and choosing asks to unlock', { generator: 'locked' }, NEW, { generated: { password: 'Gen-1', again: false, vault: 'locked', rule: null , strong: true }, accounts: [] }],
    ['no vault yet: offered, and choosing asks for the first passphrase', { generator: 'none' }, NEW, { generated: { password: 'Gen-1', again: false, vault: 'none', rule: null , strong: true }, accounts: [] }],
    ['passwords off there (the switch, a password manager’s extension): none', { generator: 'off' }, NEW, null],
    ['a private window (it never saves): none', { tab: { private: true } }, NEW, null],
    ['rules that can’t be met, nothing saved: none', { generate: async () => null, accounts: { state: 'open', offers: [], insecure: false } }, NEW, null],
    ['a first step: none', {}, { kind: 'username-only', role: 'new-password' }, null],
    ['a tab not on screen: none', { shown: false }, NEW, null],
  ])('%s', async (_name, options, focus, menu) => {
    const t = setup(options);
    await t.focus(focus);
    await settle(2);
    const shown = t.assist.menuFor('w1');
    if (menu) expect(shown).toMatchObject(menu);
    else expect(shown).toBeNull();
    // Nothing is saved by a focus, and the popover gets no account's password.
    expect(t.vault.presave).not.toHaveBeenCalled();
    expect(JSON.stringify(shown)).not.toMatch(/pw-/);
  });

  it('passes the field’s rules and the frame’s origin to the generator, and ↻ makes another to the same rules', async () => {
    const t = setup();
    const rules = { passwordrules: 'minlength: 30; required: digit;', minLength: -1, maxLength: 40 };
    await t.focus({ ...NEW, rules });
    await settle(2);
    const generate = (t.assist as unknown as { generate: ReturnType<typeof vi.fn> }).generate;
    expect(generate).toHaveBeenCalledWith(ORIGIN, rules);
    const { id } = t.assist.menuFor('w1')!;
    await t.assist.regenerate('w1', id);
    expect(t.assist.menuFor('w1')!.generated!.password).toBe('Gen-2');
    expect(generate).toHaveBeenLastCalledWith(ORIGIN, rules);
    // Another window's ↻, or a stale menu's: nothing.
    await t.assist.regenerate('w2', id);
    await t.assist.regenerate('w1', id + 1);
    expect(t.assist.menuFor('w1')!.generated!.password).toBe('Gen-2');
  });

  it('Enter chooses it, and the keys are the menu’s', async () => {
    const t = setup();
    await t.focus(NEW);
    await settle(2);
    // Not in its first moments: a page can focus the field by script as you press Enter elsewhere (security review).
    expect(t.key('Enter')).toBe(true);
    await settle();
    expect(filledWith(t.page)).toEqual([]);
    expect(t.assist.menuFor('w1')).not.toBeNull();
    t.timers.advance(500);
    expect(t.key('Enter')).toBe(true);
    await settle();
    expect(filledWith(t.page)).toEqual([[PASSWORDS_FILL, 'Gen-1']]);
  });

  it('rules that can’t be met are worked out once a document, however often a page moves focus between such fields (security review)', async () => {
    const t = setup({ generate: async () => null, accounts: { state: 'open', offers: [], insecure: false } });
    const generate = (t.assist as unknown as { generate: ReturnType<typeof vi.fn> }).generate;
    const rules = { passwordrules: 'allowed: [ab]; max-consecutive: 1;', minLength: 1000, maxLength: -1 };
    for (let i = 0; i < 20; i++) {
      await t.focus({ ...NEW, formId: i % 2 ? 'f1' : 'f2', rules });
      await settle(2);
      t.blur();
    }
    expect(generate).toHaveBeenCalledTimes(1);
    // A new document asks again.
    t.page.emit('did-navigate', {}, 'https://github.com/signup', 200);
    await t.focus({ ...NEW, rules });
    await settle(2);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('↓ to an account and Enter fills the account, not a generated password', async () => {
    const t = setup();
    await t.focus(NEW);
    await settle(2);
    t.key('ArrowDown');
    expect(t.assist.menuFor('w1')!.index).toBe(1);
    t.timers.advance(500);
    t.key('Enter');
    await settle();
    expect(filledWith(t.page)).toEqual([[PASSWORDS_FILL, 'pw-one']]);
    expect(t.vault.presave).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    [process.platform === 'darwin' ? '⇧⌘K' : 'Ctrl+Shift+K', process.platform === 'darwin' ? { meta: true, shift: true } : { control: true, shift: true }, true],
    ['Shift+K (typing)', { shift: true }, false],
    ['Alt+K', { alt: true }, false],
  ])('↻ by key: %s → %s, and the page never sees it', async (_name, mods, taken) => {
    const t = setup();
    await t.focus(NEW);
    await settle(2);
    expect(t.key('K', { code: 'KeyK', ...mods })).toBe(taken);
    await settle(2);
    expect(t.assist.menuFor('w1')!.generated!.password).toBe(taken ? 'Gen-2' : 'Gen-1');
  });
});

describe('choosing it: saved first, then filled, never lost', () => {
  const chosen = async (options: Parameters<typeof setup>[0] = {}, before?: (t: ReturnType<typeof setup>) => void) => {
    const t = setup(options);
    before?.(t);
    await t.focus(NEW);
    await settle(2);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    return t;
  };

  it('open: presaved for the frame’s origin, then filled into that form only, with nothing else', async () => {
    const t = await chosen();
    expect(t.vault.presave).toHaveBeenCalledWith({ origin: ORIGIN, password: 'Gen-1', chordId: 'c1' });
    expect(sent(t.page)).toEqual([[PASSWORDS_FILL, { formId: 'f1', generated: 'Gen-1', highlight: expect.any(Object) }]]);
    expect(t.vault.presave.mock.invocationCallOrder[0]!).toBeLessThan(t.page.mainFrame.send.mock.invocationCallOrder[0]!);
  });

  it.each<[string, (t: ReturnType<typeof setup>) => void, { filled: boolean; unlock: boolean; toast?: boolean; card?: boolean }]>([
    ['locked: the unlock card, then saved and filled', (t) => t.vault.presave.mockResolvedValueOnce({ ok: false, problem: 'locked' }), { filled: true, unlock: true }],
    [
      'locked and the unlock card cancelled: nothing filled',
      (t) => (t.vault.presave.mockResolvedValue({ ok: false, problem: 'locked' }), t.vault.askUnlock.mockResolvedValue(false)),
      { filled: false, unlock: true },
    ],
    ['it couldn’t be saved: nothing filled, and a toast says so', (t) => t.vault.presave.mockResolvedValue({ ok: false, problem: 'io' }), { filled: false, unlock: false, toast: true }],
    ['no vault yet: the save card’s passphrase step, nothing filled yet', (t) => t.vault.presave.mockResolvedValue({ ok: false, problem: 'none' }), { filled: false, unlock: false, card: true }],
  ])('%s', async (_name, before, want) => {
    const t = await chosen({}, before);
    expect(sent(t.page).length > 0).toBe(want.filled);
    expect(t.vault.askUnlock).toHaveBeenCalledTimes(want.unlock ? 1 : 0);
    expect(t.host.toast.mock.calls.some(([, id]) => id === 'passwords:fill')).toBe(!!want.toast);
    expect(t.assist.cardFor('n1')).toEqual(want.card ? expect.objectContaining({ kind: 'new', setup: true, generated: true, username: '' }) : null);
  });

  it('no vault yet: the card’s Save chooses the passphrase, saves, then fills; the first save says where it went', async () => {
    const t = await chosen({}, (t) => t.vault.presave.mockResolvedValueOnce({ ok: false, problem: 'none' }).mockResolvedValueOnce({ ok: true, id: 'g1', setup: true }));
    const card = t.assist.cardFor('n1')!;
    expect(JSON.stringify(card)).not.toContain('Gen-1');
    await t.assist.answer('w1', card.id, 'save', { passphrase: 'a long enough passphrase' });
    await settle();
    expect(t.vault.presave).toHaveBeenLastCalledWith({ origin: ORIGIN, password: 'Gen-1', chordId: 'c1', passphrase: 'a long enough passphrase' });
    expect(filledWith(t.page)).toEqual([[PASSWORDS_FILL, 'Gen-1']]);
    expect(t.host.toast).toHaveBeenCalledWith('w1', 'passwords:saved', expect.any(String));
    expect(t.assist.cardFor('n1')).toBeNull();
  });

  it.each<[string, (t: ReturnType<typeof setup>) => void]>([
    ['the page navigated', (t) => t.page.emit('did-navigate', {}, 'https://github.com/next', 200)],
    ['the main frame is another', (t) => (t.page.mainFrame = { ...t.page.mainFrame, routingId: 99, send: vi.fn() })],
    ['the frame’s origin changed', (t) => (t.page.mainFrame.origin = 'https://github.com.evil.example')],
  ])('saved, but never sent, when %s since the menu showed', async (_name, between) => {
    const t = setup();
    let answer!: (a: Awaited<ReturnType<AssistVault['presave']>>) => void;
    t.vault.presave.mockImplementationOnce(() => new Promise((done) => (answer = done)));
    await t.focus(NEW);
    await settle(2);
    const send = t.page.mainFrame.send;
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await flush();
    between(t);
    answer({ ok: true, id: 'g1', setup: false });
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(t.page.mainFrame.send).not.toHaveBeenCalled();
    expect(t.vault.presave).toHaveBeenCalledTimes(1);
  });
});

describe('the tab’s presave: offered again, given its username, confirmed', () => {
  const generated = async (t: ReturnType<typeof setup>, focus: Record<string, unknown> = NEW) => {
    await t.focus(focus);
    await settle(2);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    t.blur();
  };

  it.each<[string, (t: ReturnType<typeof setup>) => Promise<void> | void, boolean]>([
    ['a second step’s confirmation, on the next page', (t) => void t.page.emit('did-navigate', {}, 'https://github.com/signup/2', 200), true],
    ['the page reloaded (a navigation of your own)', (t) => void (t.page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }), t.page.emit('did-navigate', {}, 'https://github.com/signup', 200)), true],
    ['after another site', (t) => void t.page.emit('did-navigate', {}, 'https://example.org/', 200), false],
    ['ten minutes on', (t) => t.timers.advance(10 * 60_000), false],
    ['passwords turned off for the chord', (t) => (t.host.passwordsOn.mockReturnValue(false), t.assist.switched()), false],
  ])('offered again, not made anew: %s → %s', async (_name, between, again) => {
    const t = setup();
    await generated(t);
    await between(t);
    await settle(2);
    await t.focus({ ...NEW, role: 'confirmation-password', formId: 'f2' });
    await settle(2);
    expect(t.assist.menuFor('w1')!.generated).toMatchObject(again ? { password: 'Gen-1', again: true } : { password: 'Gen-2', again: false });
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    // Offered again, it's filled and not saved twice.
    expect(t.vault.presave).toHaveBeenCalledTimes(again ? 1 : 2);
  });

  it('locked since (by you, or its clock): the presave isn’t shown or filled again; a new one is made, and choosing it asks to unlock (security review)', async () => {
    const t = setup();
    await generated(t);
    t.vault.generatorFor.mockResolvedValue('locked');
    await t.focus({ ...NEW, role: 'confirmation-password', formId: 'f2' });
    await settle(2);
    expect(t.assist.menuFor('w1')!.generated).toMatchObject({ password: 'Gen-2', again: false, vault: 'locked' });
    expect(JSON.stringify(t.assist.menuFor('w1'))).not.toContain('Gen-1');
  });

  it('…and locked between the menu and your pick: it asks to unlock before filling the one offered again', async () => {
    const t = setup();
    await generated(t);
    await t.focus({ ...NEW, role: 'confirmation-password', formId: 'f2' });
    await settle(2);
    expect(t.assist.menuFor('w1')!.generated).toMatchObject({ again: true });
    t.page.mainFrame.send.mockClear();
    t.vault.generatorFor.mockResolvedValue('locked');
    t.vault.askUnlock.mockResolvedValue(false);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    expect(t.vault.askUnlock).toHaveBeenCalled();
    expect(t.page.mainFrame.send).not.toHaveBeenCalled();
  });

  it('↻ and choose again in the same form, before a submit: the same entry takes the new one (kept as the one before)', async () => {
    const t = setup();
    await generated(t);
    await t.focus(NEW);
    await settle(2);
    await t.assist.regenerate('w1', t.assist.menuFor('w1')!.id);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    expect(t.vault.presave).toHaveBeenCalledTimes(1);
    expect(t.vault.presaved).toHaveBeenCalledWith('pending', 'g1', ORIGIN, 'c1', { password: 'Gen-2' });
    expect(filledWith(t.page).at(-1)).toEqual([PASSWORDS_FILL, 'Gen-2']);
  });

  it('…but after a submit, a new one is a new entry: the site may have the first', async () => {
    const t = setup();
    await generated(t);
    await t.submitted({ values: { username: 'ada' } });
    await t.focus(NEW);
    await settle(2);
    await t.assist.regenerate('w1', t.assist.menuFor('w1')!.id);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    expect(t.vault.presave).toHaveBeenCalledTimes(2);
  });

  it.each<[string, Record<string, unknown>, Parameters<AssistVault['presaved']>[4] | null]>([
    ['its submit gives it the username', { values: { username: 'ada@example.com', password: 'Gen-1' } }, { username: 'ada@example.com' }],
    ['the password is never told at the submit: the username alone', { values: { username: 'ada' } }, { username: 'ada' }],
    ['a change form’s submit: no username (the account’s is found when it works)', { kind: 'change', values: { username: 'ada' } }, null],
    ['another form’s: not this one’s (a second step’s sign-in confirms it, with its username)', { formId: 'f9', values: { username: 'x' } }, null],
    ['another page’s', { values: { username: 'x' } }, null],
    ['no values (a private window, a value too long)', { values: null }, null],
  ])('%s', async (_name, event, values) => {
    const t = setup();
    await generated(t);
    t.vault.presaved.mockClear();
    if (_name.startsWith('another page')) t.page.emit('did-navigate', {}, 'https://github.com/next', 200);
    await t.submitted(event);
    if (values) expect(t.vault.presaved).toHaveBeenCalledWith('pending', 'g1', ORIGIN, 'c1', values);
    else expect(t.vault.presaved).not.toHaveBeenCalled();
  });

  it('a sign-in that worked with it confirms it, and the saved card says so (the owner’s design 5A)', async () => {
    const t = setup();
    await generated(t);
    await t.signedIn({ kind: 'sign-up', values: { username: 'ada', password: 'Gen-1' } });
    await settle(2);
    expect(t.vault.presaved).toHaveBeenCalledWith('confirm', 'g1', ORIGIN, 'c1', { username: 'ada', password: 'Gen-1' });
    expect(t.vault.candidateFor).not.toHaveBeenCalled();
    const card = t.assist.cardFor('n1')!;
    expect(card).toMatchObject({ kind: 'saved', username: 'ada', host: 'github.com' });
    // It has no password to show.
    expect(t.assist.reveal('w1', card.id)).toBeNull();
  });

  it.each<[string, 'save' | 'close' | 'delete', boolean]>([
    ['Done', 'save', false],
    ['×', 'close', false],
    ['Delete it', 'delete', true],
  ])('the saved card’s %s: it goes; deleted → %s', async (_name, action, deleted) => {
    const t = setup();
    await generated(t);
    await t.signedIn({ kind: 'sign-up', values: { username: 'ada', password: 'Gen-1' } });
    await settle(2);
    await t.assist.answer('w1', t.assist.cardFor('n1')!.id, action);
    expect(t.vault.deleteSaved).toHaveBeenCalledTimes(deleted ? 1 : 0);
    if (deleted) expect(t.vault.deleteSaved).toHaveBeenCalledWith('g1', ORIGIN, 'c1');
    expect(t.assist.cardFor('n1')).toBeNull();
    // Gone, not hidden: the key in the address has nothing to bring back.
    expect(t.host.offer).not.toHaveBeenCalledWith('n1', true);
  });

  it('Delete it is only the saved card’s, and Save as new only the change card’s', async () => {
    const t = setup();
    await t.signedIn({ kind: 'sign-up' });
    const card = t.assist.cardFor('n1')!;
    expect(card).toMatchObject({ kind: 'new', signUp: true });
    await t.assist.answer('w1', card.id, 'delete');
    await t.assist.answer('w1', card.id, 'new');
    expect(t.vault.deleteSaved).not.toHaveBeenCalled();
    expect(t.vault.saveCandidate).not.toHaveBeenCalled();
    expect(t.assist.cardFor('n1')).not.toBeNull();
  });

  it('a sign-up with another password (typed over, after the submit): the save card, as for any', async () => {
    const t = setup();
    await generated(t);
    await t.signedIn({ kind: 'sign-up', values: { username: 'ada', password: 'something else' } });
    expect(t.vault.presaved).not.toHaveBeenCalledWith('confirm', expect.anything(), expect.anything(), expect.anything(), expect.anything());
    expect(t.assist.cardFor('n1')).toMatchObject({ kind: 'new', username: 'ada' });
  });

  it('a private window has no presave and saves nothing', async () => {
    const t = setup({ tab: { private: true } });
    await t.focus(NEW);
    await settle(2);
    expect(t.assist.menuFor('w1')).toBeNull();
    await t.submitted();
    await t.signedIn({ kind: 'sign-up' });
    expect(t.vault.presave).not.toHaveBeenCalled();
    expect(t.vault.presaved).not.toHaveBeenCalled();
    expect(t.assist.cardFor('n1')).toBeNull();
  });

  it('the tab going forgets it (the entry stays in the vault)', async () => {
    const t = setup();
    await generated(t);
    t.page.destroyed = true;
    t.page.emit('destroyed');
    expect((t.assist as unknown as { presaves: Map<unknown, unknown> }).presaves.size).toBe(0);
  });
});

describe('a change-password form that worked: which account (S17 §6)', () => {
  const A = { id: 'a1', username: 'ada@example.com' };
  const B = { id: 'a2', username: 'bob@example.com' };
  const CHANGE = { kind: 'change', values: { username: '', password: 'new-Pw', current: 'old-Pw' } };
  type Change = Awaited<ReturnType<AssistVault['changeAccounts']>>;
  it.each<[string, Change, Record<string, unknown>, Partial<NonNullable<ReturnType<PasswordAssist['cardFor']>>> | null]>([
    ['one account has the current password: the update card for it', { state: 'open', matches: [A], accounts: [A, B] }, CHANGE, { kind: 'update', username: A.username }],
    ['several have it: the card asks which, from those', { state: 'open', matches: [A, B], accounts: [A, B] }, CHANGE, { kind: 'change', accounts: [A.username, B.username] }],
    ['none has it: the card asks which, from the site’s', { state: 'open', matches: [], accounts: [B, A] }, CHANGE, { kind: 'change', accounts: [B.username, A.username] }],
    ['no current field (a reset form): asks which', { state: 'open', matches: [], accounts: [A, B] }, { kind: 'reset', values: { username: '', password: 'new-Pw' } }, { kind: 'change' }],
    [
      'the form names its username: that account',
      { state: 'open', matches: [A, B], accounts: [A, B] },
      { kind: 'change', values: { username: B.username, password: 'new-Pw', current: 'old-Pw' } },
      { kind: 'update', username: B.username },
    ],
    ['nothing saved for the site: the save card, new', { state: 'open', matches: [], accounts: [] }, CHANGE, { kind: 'new', username: '' }],
    ['locked: the update card, which unlocks first (review round 1)', { state: 'locked' }, CHANGE, { kind: 'update' }],
    ['passwords off there: nothing', { state: 'off' }, CHANGE, null],
  ])('%s', async (_name, change, event, card) => {
    const t = setup({ change, candidate: { kind: 'locked' } });
    await t.signedIn(event);
    await settle(2);
    const shown = t.assist.cardFor('n1');
    if (card) expect(shown).toMatchObject(card);
    else expect(shown).toBeNull();
    expect(JSON.stringify(shown)).not.toMatch(/Pw/);
  });

  it('looks the account up by the form’s current password, for the frame’s origin', async () => {
    const t = setup();
    await t.signedIn(CHANGE);
    expect(t.vault.changeAccounts).toHaveBeenCalledWith(ORIGIN, 'c1', 'old-Pw');
  });

  it('the card’s Save: the account you chose takes the new password', async () => {
    const t = setup({ change: { state: 'open', matches: [A, B], accounts: [A, B] } });
    await t.signedIn(CHANGE);
    const card = t.assist.cardFor('n1')!;
    await t.assist.answer('w1', card.id, 'save', { account: 1 });
    expect(t.vault.changePassword).toHaveBeenCalledWith({ origin: ORIGIN, chordId: 'c1', account: 'a2', password: 'new-Pw' });
    expect(t.assist.cardFor('n1')).toBeNull();
  });

  it('Update waits for a pick: without one, nothing', async () => {
    const t = setup({ change: { state: 'open', matches: [A, B], accounts: [A, B] } });
    await t.signedIn(CHANGE);
    await t.assist.answer('w1', t.assist.cardFor('n1')!.id, 'save');
    expect(t.vault.changePassword).not.toHaveBeenCalled();
    expect(t.assist.cardFor('n1')).not.toBeNull();
  });

  it('Save as new, a password you typed: another sign-in, as the save card would', async () => {
    const t = setup({ change: { state: 'open', matches: [A, B], accounts: [A, B] } });
    await t.signedIn(CHANGE);
    await t.assist.answer('w1', t.assist.cardFor('n1')!.id, 'new');
    expect(t.vault.saveCandidate).toHaveBeenCalledWith({ origin: ORIGIN, username: A.username, password: 'new-Pw', chordId: 'c1' });
  });

  it('…an account it didn’t offer: nothing', async () => {
    const t = setup({ change: { state: 'open', matches: [A, B], accounts: [A, B] } });
    await t.signedIn(CHANGE);
    await t.assist.answer('w1', t.assist.cardFor('n1')!.id, 'save', { account: 7 });
    expect(t.vault.changePassword).not.toHaveBeenCalled();
  });

  describe('with a generated password', () => {
    const withPresave = async (change: Change) => {
      const t = setup({ change });
      await t.focus({ kind: 'change', role: 'new-password' });
      await settle(2);
      t.timers.advance(500);
      t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
      await settle();
      await t.signedIn({ kind: 'change', values: { username: '', password: 'Gen-1', current: 'old-Pw' } });
      await settle(3);
      return t;
    };
    it('one account: the Update card (the owner’s design 5A), and Update applies it and deletes the presave', async () => {
      const t = await withPresave({ state: 'open', matches: [A], accounts: [A, B] });
      const card = t.assist.cardFor('n1')!;
      expect(card).toMatchObject({ kind: 'update', username: A.username });
      expect(t.vault.changePassword).not.toHaveBeenCalled();
      await t.assist.answer('w1', card.id, 'save');
      expect(t.vault.changePassword).toHaveBeenCalledWith({ origin: ORIGIN, chordId: 'c1', account: 'a1', password: 'Gen-1', presaved: 'g1' });
      expect(t.assist.cardFor('n1')).toBeNull();
    });
    it('Save as new: the presave confirmed as another account', async () => {
      const t = await withPresave({ state: 'open', matches: [A, B], accounts: [A, B] });
      await t.assist.answer('w1', t.assist.cardFor('n1')!.id, 'new');
      expect(t.vault.presaved).toHaveBeenCalledWith('confirm', 'g1', ORIGIN, 'c1', { username: A.username, password: 'Gen-1' });
      expect(t.vault.changePassword).not.toHaveBeenCalled();
    });
    it('several: the card asks, and its Save applies it and deletes the presave', async () => {
      const t = await withPresave({ state: 'open', matches: [A, B], accounts: [A, B] });
      const card = t.assist.cardFor('n1')!;
      expect(card).toMatchObject({ kind: 'change' });
      await t.assist.answer('w1', card.id, 'save', { account: 0 });
      expect(t.vault.changePassword).toHaveBeenCalledWith({ origin: ORIGIN, chordId: 'c1', account: 'a1', password: 'Gen-1', presaved: 'g1' });
    });
    it('nothing saved for the site: the new card’s Save confirms the presave with the username you typed', async () => {
      const t = await withPresave({ state: 'open', matches: [], accounts: [] });
      const card = t.assist.cardFor('n1')!;
      await t.assist.answer('w1', card.id, 'save', { username: 'ada' });
      expect(t.vault.presaved).toHaveBeenCalledWith('confirm', 'g1', ORIGIN, 'c1', { username: 'ada', password: 'Gen-1' });
      expect(t.vault.saveCandidate).not.toHaveBeenCalled();
    });
    it('the card closed: the presave stays, Not confirmed (never lost)', async () => {
      const t = await withPresave({ state: 'open', matches: [A, B], accounts: [A, B] });
      await t.assist.answer('w1', t.assist.cardFor('n1')!.id, 'close');
      expect(t.vault.changePassword).not.toHaveBeenCalled();
      expect(t.vault.presaved).not.toHaveBeenCalledWith('confirm', expect.anything(), expect.anything(), expect.anything(), expect.anything());
    });
  });
});

/* ---------- review round 1 of #53 ---------- */

describe('a change’s account: by the current password, the username only among several (S17 §6, the owner’s decision)', () => {
  const A = { id: 'a1', username: 'ada@example.com' };
  const B = { id: 'a2', username: 'bob@example.com' };
  const P = { id: 'g1', username: '' };
  it.each<[string, Parameters<typeof changeCard>[0], string, string | undefined, { kind: string; accounts?: string[]; username?: string }]>([
    ['one has the current password, the form names another: that one', { matches: [A], accounts: [A, B] }, B.username, undefined, { kind: 'update', username: A.username }],
    ['none has it, the form names one: the chooser, never the name alone', { matches: [], accounts: [A, B] }, A.username, undefined, { kind: 'change', accounts: ['a1', 'a2'] }],
    ['several have it, the form names one of them: that one', { matches: [A, B], accounts: [A, B] }, B.username, undefined, { kind: 'update', username: B.username }],
    ['several have it, the form names none of them: the chooser, among them', { matches: [A, B], accounts: [A, B] }, 'cy', undefined, { kind: 'change', accounts: ['a1', 'a2'] }],
    ['the change’s own presave isn’t a match', { matches: [A, P], accounts: [A, B, P] }, '', 'g1', { kind: 'update', username: A.username }],
    ['…nor in the chooser, which asks even with one left (none had the current password)', { matches: [], accounts: [A, P] }, '', 'g1', { kind: 'change', accounts: ['a1'] }],
    ['nothing saved for the site but the presave: a new one', { matches: [], accounts: [P] }, '', 'g1', { kind: 'new' }],
  ])('%s', (_name, found, username, presaved, want) => {
    const got = changeCard(found, { username, password: 'new-Pw' }, presaved);
    expect(got.kind).toBe(want.kind);
    if (want.accounts) expect(got.accounts!.map((a) => a.id)).toEqual(want.accounts);
    if (want.username !== undefined) expect(got.values.username).toBe(want.username);
  });
});

describe('the presave after a failed submit, and across a reload (review round 1 of #53)', () => {
  const generateAndChoose = async (t: ReturnType<typeof setup>, focus: Record<string, unknown> = NEW) => {
    await t.focus(focus);
    await settle(2);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    t.blur();
  };
  const regenerateAndChoose = async (t: ReturnType<typeof setup>, focus: Record<string, unknown> = NEW) => {
    await t.focus(focus);
    await settle(2);
    await t.assist.regenerate('w1', t.assist.menuFor('w1')!.id);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
  };

  it.each<[string, (t: ReturnType<typeof setup>) => Promise<void> | void, number]>([
    ['a rejected sign-up (failed): ↻ changes the same entry', (t) => void t.events.emit('failed', { contents: t.contents, formId: 'f1', kind: 'sign-up', origin: ORIGIN, why: 'reappeared' }), 1],
    ['submitted, then reloaded with nothing failed: another entry (it may have worked)', (t) => void t.page.emit('did-navigate', {}, 'https://github.com/signup', 200), 2],
    ['a rejected sign-up, then the page reloaded: still the same entry', (t) => void (t.events.emit('failed', { contents: t.contents, formId: 'f1', kind: 'sign-up', origin: ORIGIN, why: 'error-response' }), t.page.emit('did-navigate', {}, 'https://github.com/signup', 200)), 1],
    ['a submit nothing has failed (it may have worked): another entry', () => undefined, 2],
  ])('%s', async (_name, between, entries) => {
    const t = setup();
    await generateAndChoose(t);
    await t.submitted({ values: { username: 'ada' } });
    await between(t);
    await settle(2);
    t.vault.presaved.mockClear();
    await regenerateAndChoose(t);
    expect(t.vault.presave).toHaveBeenCalledTimes(entries);
    if (entries === 1) expect(t.vault.presaved).toHaveBeenCalledWith('pending', 'g1', ORIGIN, 'c1', { password: 'Gen-2' });
  });

  it('reloaded with no submit at all: ↻ changes the same entry, never a second', async () => {
    const t = setup();
    await generateAndChoose(t);
    t.page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    t.page.emit('did-navigate', {}, 'https://github.com/signup', 200);
    await regenerateAndChoose(t);
    expect(t.vault.presave).toHaveBeenCalledTimes(1);
    expect(t.vault.presaved).toHaveBeenCalledWith('pending', 'g1', ORIGIN, 'c1', { password: 'Gen-2' });
  });

  it('another form on the same page: another entry', async () => {
    const t = setup();
    await generateAndChoose(t);
    await regenerateAndChoose(t, { ...NEW, formId: 'f2' });
    expect(t.vault.presave).toHaveBeenCalledTimes(2);
  });
});

describe('the generator’s row by click, and the frame, first (review round 1 of #53)', () => {
  it('a click in its first moments does nothing; an account’s row is clicked at once', async () => {
    const t = setup();
    await t.focus(NEW);
    await settle(2);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    expect(t.vault.presave).not.toHaveBeenCalled();
    expect(t.assist.menuFor('w1')).not.toBeNull();
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 1);
    await settle();
    expect(filledWith(t.page)).toEqual([[PASSWORDS_FILL, 'pw-one']]);
  });

  it('a frame that changed before the pick: nothing saved, nothing sent', async () => {
    const t = setup();
    await t.focus(NEW);
    await settle(2);
    t.page.mainFrame.origin = 'https://github.com.evil.example';
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    expect(t.vault.presave).not.toHaveBeenCalled();
    expect(t.page.mainFrame.send).not.toHaveBeenCalled();
  });

  it('says when the site’s rules hold it under the floor: not strong, and why', async () => {
    const t = setup({ generate: async () => ({ password: '4827', rule: 'Only 4 digits, as this site asks', strong: false }) });
    await t.focus(NEW);
    await settle(2);
    expect(t.assist.menuFor('w1')!.generated).toMatchObject({ password: '4827', strong: false, rule: 'Only 4 digits, as this site asks' });
  });
});

describe('a change that worked while the vault was locked (review round 1 of #53)', () => {
  const A = { id: 'a1', username: 'ada@example.com' };
  it('the update card; Update unlocks, finds the account by its current password, and updates it, with the presave', async () => {
    const t = setup();
    await t.focus({ kind: 'change', role: 'new-password' });
    await settle(2);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    t.vault.changeAccounts.mockResolvedValueOnce({ state: 'locked' }).mockResolvedValueOnce({ state: 'open', matches: [A], accounts: [A] });
    await t.signedIn({ kind: 'change', values: { username: '', password: 'Gen-1', current: 'old-Pw' } });
    await settle(2);
    const card = t.assist.cardFor('n1')!;
    expect(card).toMatchObject({ kind: 'update' });
    await t.assist.answer('w1', card.id, 'save');
    await settle(2);
    expect(t.vault.askUnlock).toHaveBeenCalled();
    expect(t.vault.changeAccounts).toHaveBeenLastCalledWith(ORIGIN, 'c1', 'old-Pw');
    expect(t.vault.changePassword).toHaveBeenCalledWith({ origin: ORIGIN, chordId: 'c1', account: 'a1', password: 'Gen-1', presaved: 'g1' });
    expect(t.assist.cardFor('n1')).toBeNull();
  });
  it('…several match once unlocked: the card asks which', async () => {
    const B = { id: 'a2', username: 'bob@example.com' };
    const t = setup({ change: { state: 'locked' } });
    await t.signedIn({ kind: 'change', values: { username: '', password: 'new-Pw', current: 'old-Pw' } });
    await settle(2);
    t.vault.changeAccounts.mockResolvedValueOnce({ state: 'open', matches: [A, B], accounts: [A, B] });
    await t.assist.answer('w1', t.assist.cardFor('n1')!.id, 'save');
    await settle(2);
    expect(t.assist.cardFor('n1')).toMatchObject({ kind: 'change', accounts: [A.username, B.username] });
    expect(t.vault.changePassword).not.toHaveBeenCalled();
  });
  it('…the unlock card cancelled: the card stays, nothing saved', async () => {
    const t = setup({ change: { state: 'locked' } });
    t.vault.askUnlock.mockResolvedValue(false);
    await t.signedIn({ kind: 'change', values: { username: '', password: 'new-Pw', current: 'old-Pw' } });
    await settle(2);
    await t.assist.answer('w1', t.assist.cardFor('n1')!.id, 'save');
    await settle(2);
    expect(t.assist.cardFor('n1')).toMatchObject({ kind: 'update', busy: false });
    expect(t.vault.changePassword).not.toHaveBeenCalled();
  });
});

/* ---------- review round 2 of #53 ---------- */

describe('a change that worked while locked: never one account named and another updated (review round 2 of #53)', () => {
  const ADA = { id: 'a1', username: 'ada@example.com' };
  const BOB = { id: 'a2', username: 'bob' };
  const lockedChange = async (username: string, unlocked: Awaited<ReturnType<AssistVault['changeAccounts']>>) => {
    const t = setup({ change: { state: 'locked' } });
    await t.signedIn({ kind: 'change', values: { username, password: 'new-Pw', current: 'old-Pw' } });
    await settle(2);
    const card = t.assist.cardFor('n1')!;
    t.vault.changeAccounts.mockResolvedValueOnce(unlocked);
    return { t, card };
  };

  it.each<[string, string]>([
    ['with a username on the form', 'bob'],
    ['with none', ''],
  ])('locked, %s: titled by the site, no username', async (_name, username) => {
    const { card } = await lockedChange(username, { state: 'open', matches: [ADA], accounts: [ADA, BOB] });
    expect(card).toMatchObject({ kind: 'update', username: '', host: 'github.com' });
  });

  it.each<[string, string, Awaited<ReturnType<AssistVault['changeAccounts']>>, { updated: string | null; card?: Partial<NonNullable<ReturnType<PasswordAssist['cardFor']>>> }]>([
    ['the form showed bob, the current password is Ada’s: Ada’s card, waiting for Update', 'bob', { state: 'open', matches: [ADA], accounts: [ADA, BOB] }, { updated: null, card: { kind: 'update', username: ADA.username } }],
    ['the form showed Ada, Ada matched: updated at once', ADA.username, { state: 'open', matches: [ADA], accounts: [ADA, BOB] }, { updated: 'a1' }],
    ['the form showed none, one matched: updated at once', '', { state: 'open', matches: [ADA], accounts: [ADA, BOB] }, { updated: 'a1' }],
    ['several matched: the chooser', 'cy', { state: 'open', matches: [ADA, BOB], accounts: [ADA, BOB] }, { updated: null, card: { kind: 'change' } }],
    ['none matched: the chooser, among the site’s', 'bob', { state: 'open', matches: [], accounts: [ADA, BOB] }, { updated: null, card: { kind: 'change' } }],
  ])('%s', async (_name, username, unlocked, want) => {
    const { t, card } = await lockedChange(username, unlocked);
    await t.assist.answer('w1', card.id, 'save');
    await settle(2);
    if (want.updated) {
      expect(t.vault.changePassword).toHaveBeenCalledWith(expect.objectContaining({ account: want.updated }));
      expect(t.assist.cardFor('n1')).toBeNull();
      return;
    }
    expect(t.vault.changePassword).not.toHaveBeenCalled();
    const shown = t.assist.cardFor('n1')!;
    expect(shown).toMatchObject(want.card!);
    // A second Update applies what the card now names (or, in the chooser, the account you pick).
    await t.assist.answer('w1', shown.id, 'save', shown.kind === 'change' ? { account: 0 } : {});
    expect(t.vault.changePassword).toHaveBeenCalledWith(expect.objectContaining({ account: 'a1' }));
  });

  it('the card going takes the form’s current password with it', async () => {
    const { t, card } = await lockedChange('bob', { state: 'open', matches: [ADA], accounts: [ADA] });
    const held = (t.assist as unknown as { cards: Map<string, { change?: { current: string | null } }> }).cards.get('n1')!;
    expect(held.change?.current).toBe('old-Pw');
    await t.assist.answer('w1', card.id, 'close');
    // Hidden, the candidate lasts; gone at its deadline, nothing of it stays.
    t.timers.advance(HOLD_MS);
    expect(held.change).toBeUndefined();
  });

  it('…and so does the unlock: read from the card, then let go', async () => {
    const { t, card } = await lockedChange('bob', { state: 'open', matches: [ADA], accounts: [ADA] });
    const held = (t.assist as unknown as { cards: Map<string, { change?: { current: string | null } }> }).cards.get('n1')!;
    await t.assist.answer('w1', card.id, 'save');
    await settle(2);
    expect(t.vault.changeAccounts).toHaveBeenLastCalledWith(ORIGIN, 'c1', 'old-Pw');
    expect(held.change).toBeUndefined();
  });
});

describe('the presave’s form, kept to its own (review round 2 of #53)', () => {
  const generateAndChoose = async (t: ReturnType<typeof setup>, focus: Record<string, unknown> = NEW) => {
    await t.focus(focus);
    await settle(2);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    t.blur();
  };
  const regenerateAndChoose = async (t: ReturnType<typeof setup>, focus: Record<string, unknown> = NEW) => {
    await t.focus(focus);
    await settle(2);
    await t.assist.regenerate('w1', t.assist.menuFor('w1')!.id);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
  };

  it.each<[string, Record<string, unknown>, number]>([
    ['its own form failed: ↻ changes the same entry', { formId: 'f1', kind: 'sign-up' }, 1],
    ['another form on the site failed (a sign-in): the presave stays submitted, another entry', { formId: 'f7', kind: 'sign-in' }, 2],
  ])('%s', async (_name, failed, entries) => {
    const t = setup();
    await generateAndChoose(t);
    await t.submitted({ values: { username: 'ada' } });
    t.events.emit('failed', { contents: t.contents, origin: ORIGIN, why: 'still-shown', ...failed } as never);
    await regenerateAndChoose(t);
    expect(t.vault.presave).toHaveBeenCalledTimes(entries);
  });

  it.each<[string, Record<string, unknown>, number]>([
    ['a sign-up, reloaded: the same entry', NEW, 1],
    ['a change form on the next page: its own entry', { kind: 'change', role: 'new-password' }, 2],
    ['a reset form on the next page: its own entry', { kind: 'reset', role: 'new-password' }, 2],
  ])('the site’s next page, before any submit: %s', async (_name, next, entries) => {
    const t = setup();
    await generateAndChoose(t);
    t.page.emit('did-navigate', {}, 'https://github.com/next', 200);
    await settle(2);
    await regenerateAndChoose(t, next);
    expect(t.vault.presave).toHaveBeenCalledTimes(entries);
  });

  it('…and a change form’s entry never goes to a sign-up', async () => {
    const t = setup();
    await generateAndChoose(t, { kind: 'change', role: 'new-password' });
    t.page.emit('did-navigate', {}, 'https://github.com/signup', 200);
    await settle(2);
    await regenerateAndChoose(t);
    expect(t.vault.presave).toHaveBeenCalledTimes(2);
  });
});

describe("a first step's username (phase 3: S17 §4, Chromium's possible_usernames_)", () => {
  /** A first step submitted on the tab, then a password step whose form has no username (`username: ''`). */
  const step = async (t: ReturnType<typeof setup>, over: Record<string, unknown> = {}) => {
    t.events.emit('firstStep', { contents: t.contents, origin: ORIGIN, formId: 'f1', username: 'ada@acme.dev', ...over } as never);
    await flush();
  };
  const noUsername = { values: { username: '', password: VALUES.password } };

  it.each<[string, Parameters<typeof setup>[0], (t: ReturnType<typeof setup>) => Promise<void>, Record<string, unknown>, string]>([
    ['the password step on the same page takes it', {}, async () => {}, noUsername, 'ada@acme.dev'],
    ['…on another host of the same site (accounts.x then login.x)', {}, async () => {}, { ...noUsername, origin: 'https://login.github.com' }, 'ada@acme.dev'],
    ['…on another site: not taken', {}, async () => {}, { ...noUsername, origin: 'https://gitlab.com' }, ''],
    ['a password step with a username of its own keeps it', {}, async () => {}, { values: { username: 'other@acme.dev', password: VALUES.password } }, 'other@acme.dev'],
    ['after FIRST_STEP_MS: gone', {}, async (t) => t.timers.advance(HOLD_MS + 1), noUsername, ''],
    ['passwords turned off there since: gone', {}, async (t) => {
      t.host.passwordsOn.mockReturnValue(false);
      t.assist.switched();
      t.host.passwordsOn.mockReturnValue(true);
    }, noUsername, ''],
    ['a change form never takes it (its account is found by its current password)', { change: { state: 'none' } as never }, async () => {}, { ...noUsername, kind: 'change' }, ''],
  ])('%s', async (_name, options, between, signIn, username) => {
    const t = setup(options);
    await step(t);
    await between(t);
    await t.signedIn(signIn);
    const asked = t.vault.candidateFor.mock.calls as unknown as [{ username: string }][];
    expect(asked.at(-1)?.[0].username ?? '').toBe(username);
  });

  it('a private window keeps none (it never saves)', async () => {
    const t = setup({ tab: { private: true } });
    await step(t);
    t.host.tabOf.mockReturnValue({ nodeId: 'n1', windowId: 'w1', chordId: 'c1', private: false });
    await t.signedIn(noUsername);
    expect((t.vault.candidateFor.mock.calls.at(-1) as unknown as [{ username: string }])[0].username).toBe('');
  });

  it('a save uses it once: the next password step on the tab has none', async () => {
    const t = setup();
    await step(t);
    await t.signedIn(noUsername);
    const card = t.assist.cardFor('n1')!;
    await t.assist.answer('w1', card.id, 'save', {});
    expect(t.vault.saveCandidate).toHaveBeenCalledWith({ origin: ORIGIN, username: 'ada@acme.dev', password: VALUES.password, chordId: 'c1' });
    await t.signedIn(noUsername);
    expect((t.vault.candidateFor.mock.calls.at(-1) as unknown as [{ username: string }])[0].username).toBe('');
  });

  it('the tab closing forgets it', async () => {
    const t = setup();
    await step(t);
    t.page.destroyed = true;
    t.page.emit('destroyed');
    t.page.destroyed = false;
    await t.signedIn(noUsername);
    expect((t.vault.candidateFor.mock.calls.at(-1) as unknown as [{ username: string }])[0].username).toBe('');
  });

  it('a newer first step replaces it', async () => {
    const t = setup();
    await step(t);
    await step(t, { username: 'ada.lovelace' });
    await t.signedIn(noUsername);
    expect((t.vault.candidateFor.mock.calls.at(-1) as unknown as [{ username: string }])[0].username).toBe('ada.lovelace');
  });

  it.each<[string, string, Record<string, unknown>, string[]]>([
    ['the password step’s menu lists that account first', 'ada.lovelace', { role: 'current-password' }, ['ada.lovelace', 'ada@acme.dev']],
    ['…matched ignoring case', 'ADA.Lovelace', { role: 'current-password' }, ['ada.lovelace', 'ada@acme.dev']],
    ['an account not saved: the order as the vault gave it', 'someone@else.dev', { role: 'current-password' }, ['ada@acme.dev', 'ada.lovelace']],
    ['the username field’s menu: as the vault gave it', 'ada.lovelace', { role: 'username' }, ['ada@acme.dev', 'ada.lovelace']],
  ])('%s', async (_name, username, focus, order) => {
    const t = setup();
    await step(t, { username });
    await t.focus(focus);
    expect(t.assist.menuFor('w1')?.accounts.map((a) => a.username)).toEqual(order);
  });

  it('a generated password saved before a password step with no username takes it at the submit', async () => {
    const t = setup();
    await step(t);
    await t.focus(NEW);
    await settle(2);
    // The generator's row takes no click for its first 500 ms.
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    t.blur();
    await t.submitted({ values: { username: '' } });
    await settle();
    expect(t.vault.presaved).toHaveBeenCalledWith('pending', 'g1', ORIGIN, 'c1', { username: 'ada@acme.dev' });
  });
});

describe("a first step's username while main waits (review round 1 of #59)", () => {
  /** A site lookup the test holds open: what changes meanwhile is what's checked again after it. */
  function held() {
    let release: () => void = () => {};
    let gate: Promise<void> | null = null;
    return {
      siteOf: async (origin: string) => {
        if (gate) await gate;
        return naiveSite(origin);
      },
      hold: () => void (gate = new Promise<void>((done) => (release = done))),
      release: async () => {
        const go = release;
        gate = null;
        go();
        await flush();
        await flush();
      },
    };
  }
  const step = (t: ReturnType<typeof setup>) => t.events.emit('firstStep', { contents: t.contents, origin: ORIGIN, formId: 'f1', username: 'ada@acme.dev' } as never);
  const noUsername = { values: { username: '', password: VALUES.password } };
  const lastUsername = (t: ReturnType<typeof setup>) => (t.vault.candidateFor.mock.calls.at(-1) as unknown as [{ username: string }] | undefined)?.[0].username;

  it.each<[string, (t: ReturnType<typeof setup>) => void, (t: ReturnType<typeof setup>) => void]>([
    [
      'the tab closes while the site is looked up: nothing kept',
      (t) => {
        t.page.destroyed = true;
        t.page.emit('destroyed');
      },
      (t) => void (t.page.destroyed = false),
    ],
    ['passwords turned off there while the site is looked up: nothing kept', (t) => t.host.passwordsOn.mockReturnValue(false), (t) => t.host.passwordsOn.mockReturnValue(true)],
    ['the tab leaves the window (no tab any more) meanwhile: nothing kept', (t) => t.host.tabOf.mockReturnValue(null), (t) => t.host.tabOf.mockReturnValue({ nodeId: 'n1', windowId: 'w1', chordId: 'c1', private: false })],
  ])('%s', async (_name, meanwhile, after) => {
    const site = held();
    const t = setup({ siteOf: site.siteOf });
    site.hold();
    step(t);
    await flush();
    meanwhile(t);
    await site.release();
    after(t);
    await t.signedIn(noUsername);
    expect(lastUsername(t)).toBe('');
  });

  it('a presave that goes while the first step is looked up at its submit gets no username', async () => {
    const site = held();
    const t = setup({ siteOf: site.siteOf });
    step(t);
    await flush();
    await t.focus(NEW);
    await settle(2);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    t.blur();
    t.vault.presaved.mockClear();
    site.hold();
    t.events.emit('submitted', { contents: t.contents, formId: 'f1', kind: 'sign-up', origin: ORIGIN, signal: 'submit', values: { username: '' } } as never);
    await flush();
    // Another document meanwhile: the presave there isn't this submit's.
    t.page.emit('did-navigate', {}, 'https://github.com/elsewhere', 200);
    await site.release();
    await settle();
    expect(t.vault.presaved).not.toHaveBeenCalledWith('pending', expect.anything(), expect.anything(), expect.anything(), { username: 'ada@acme.dev' });
  });

  it('…and one that stays gets it, as before', async () => {
    const site = held();
    const t = setup({ siteOf: site.siteOf });
    step(t);
    await flush();
    await t.focus(NEW);
    await settle(2);
    t.timers.advance(500);
    t.assist.chooseRow('w1', t.assist.menuFor('w1')!.id, 0);
    await settle();
    t.blur();
    site.hold();
    t.events.emit('submitted', { contents: t.contents, formId: 'f1', kind: 'sign-up', origin: ORIGIN, signal: 'submit', values: { username: '' } } as never);
    await flush();
    await site.release();
    await settle();
    expect(t.vault.presaved).toHaveBeenCalledWith('pending', 'g1', ORIGIN, 'c1', { username: 'ada@acme.dev' });
  });

  it('to another site and back within FIRST_STEP_MS: the first step is still the tab’s for the site (by design)', async () => {
    const t = setup();
    step(t);
    await flush();
    t.page.emit('did-navigate', {}, 'https://gitlab.com/explore', 200);
    t.timers.advance(60_000);
    t.page.emit('did-navigate', {}, 'https://github.com/login', 200);
    await flush();
    // On the other site, a password step there doesn't take it.
    await t.signedIn({ ...noUsername, origin: 'https://gitlab.com' });
    expect(lastUsername(t)).toBe('');
    // Back on the first site's password step: it does.
    await t.signedIn(noUsername);
    expect(lastUsername(t)).toBe('ada@acme.dev');
  });
});

describe("a first step's username is used once (review of 3A-1)", () => {
  const step = async (t: ReturnType<typeof setup>, username = 'alice@acme.dev', origin = ORIGIN) => {
    t.events.emit('firstStep', { contents: t.contents, origin, formId: 'f1', username } as never);
    await flush();
    await flush();
  };
  const noUsername = { values: { username: '', password: VALUES.password } };
  const lastUsername = (t: ReturnType<typeof setup>) => (t.vault.candidateFor.mock.calls.at(-1) as unknown as [{ username: string }] | undefined)?.[0].username;

  it('two sign-ins in a row: alice’s saved one (no card), then bob picked from the site’s chooser (no new first step): bob’s step gets no username', async () => {
    const t = setup({ candidate: { kind: 'same', id: 'a1' } });
    await step(t, 'alice@acme.dev');
    await t.signedIn(noUsername);
    expect(lastUsername(t)).toBe('alice@acme.dev');
    expect(t.assist.cardFor('n1')).toBeNull();
    await t.signedIn({ values: { username: '', password: 'bobs password' } });
    expect(lastUsername(t)).toBe('');
  });

  it('a sign-in that failed uses it up too: the retry on the same step has none', async () => {
    const t = setup();
    await step(t);
    t.events.emit('failed', { contents: t.contents, formId: 'f1', kind: 'sign-in', origin: ORIGIN, why: 'still-shown' } as never);
    await flush();
    await flush();
    await t.signedIn(noUsername);
    expect(lastUsername(t)).toBe('');
  });

  it('…but a sign-in on another site leaves it alone', async () => {
    const t = setup();
    await step(t);
    await t.signedIn({ ...noUsername, origin: 'https://gitlab.com' });
    await t.signedIn(noUsername);
    expect(lastUsername(t)).toBe('alice@acme.dev');
  });

  it('a newer first step replaces only its own site’s', async () => {
    const t = setup();
    await step(t, 'alice@acme.dev', ORIGIN);
    await step(t, 'bob@other.dev', 'https://gitlab.com');
    await t.signedIn(noUsername);
    expect(lastUsername(t)).toBe('alice@acme.dev');
    await t.signedIn({ ...noUsername, origin: 'https://gitlab.com' });
    expect(lastUsername(t)).toBe('bob@other.dev');
  });

  it('a navigation while the first step is looked up at the sign-in: no card for the page left', async () => {
    let release: () => void = () => {};
    let gate: Promise<void> | null = null;
    const t = setup({
      siteOf: async (origin: string) => {
        if (gate) await gate;
        return naiveSite(origin);
      },
    });
    await step(t);
    gate = new Promise<void>((done) => (release = done));
    t.events.emit('signedIn', { contents: t.contents, formId: 'f1', kind: 'sign-in', origin: ORIGIN, how: 'form-gone', hint: null, values: { username: '', password: VALUES.password } } as never);
    await flush();
    t.page.emit('did-navigate', {}, 'https://github.com/elsewhere', 200);
    gate = null;
    release();
    await settle();
    expect(t.vault.candidateFor).not.toHaveBeenCalled();
    expect(t.assist.cardFor('n1')).toBeNull();
  });
});
