/**
 * Chord's passwords in the page (main/passwords/assist.ts): the detector's events joined to the
 * vault, with fakes for both and for the window. Table-driven: which focus gets a menu, what each
 * key and click does, what may be filled where, which sign-in gets a card and what its buttons do.
 */
import { EventEmitter } from 'node:events';
import { PASSWORDS_FILL } from '@chord/ipc';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { CLICK_GRACE_MS, PasswordAssist, SAVE_CARD_MS, type AssistTab, type AssistVault } from '../../src/main/passwords/assist';
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
} = {}) {
  const events = new EventEmitter<PasswordDetectorEvents>();
  const timers = fakeTimers();
  const vault = {
    accountsFor: vi.fn(async () => accounts),
    passwordFor: vi.fn(async (id: string) => (id === 'a1' ? 'pw-one' : 'pw-two')),
    candidateFor: vi.fn(async () => candidate),
    saveCandidate: vi.fn(async (): Promise<SaveAnswer> => ({ ok: true, id: 'a1', kind: 'new' })),
    neverFor: vi.fn(async () => true),
    askUnlock: vi.fn(async () => true),
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
  return { assist, vault, host, page, events, timers, focus, blur, key, signedIn, contents };
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
    ['a sign-up form (the generator is phase 2’s): not even asked', {}, { kind: 'sign-up' }, null, false],
    ['a new-password field: not asked', {}, { role: 'new-password' }, null, false],
    ['a change-password form: not asked', {}, { kind: 'change', role: 'current-password' }, null, false],
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
    ['a sign-up form (phase 2): not asked', {}, { kind: 'sign-up' }, null, false],
    ['a change-password form (phase 2): not asked', {}, { kind: 'change' }, null, false],
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
