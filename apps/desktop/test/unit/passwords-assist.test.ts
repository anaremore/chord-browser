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

function setup({ accounts = { state: 'open', offers: OFFERS, insecure: false } as AccountsAnswer, candidate = { kind: 'new', setup: false } as CandidateAnswer, tab = {} as Partial<AssistTab> | null, shown = true } = {}) {
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
  };
  const assist = new PasswordAssist({
    vault: vault as unknown as AssistVault,
    detector: { events },
    host,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    siteOf: async (origin) => new URL(origin).hostname.split('.').slice(-2).join('.'),
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

  it('×: the card and what was typed go, and nothing is saved', async () => {
    const t = await offered();
    await t.assist.answer('w1', t.card.id, 'close');
    expect(t.assist.cardFor('n1')).toBeNull();
    expect(t.assist.reveal('w1', t.card.id)).toBeNull();
    expect(t.vault.saveCandidate).not.toHaveBeenCalled();
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

describe('how long a card lasts', () => {
  it.each<[string, (t: ReturnType<typeof setup>, id: number) => Promise<void> | void, boolean]>([
    ['a minute unused: it goes', (t) => t.timers.advance(SAVE_CARD_MS), false],
    ['just under a minute: still there', (t) => t.timers.advance(SAVE_CARD_MS - 1), true],
    ['while you’re in it, it stays', async (t, id) => (await t.assist.answer('w1', id, 'hold'), t.timers.advance(SAVE_CARD_MS * 3)), true],
    ['…and once you leave it, a minute again', async (t, id) => (await t.assist.answer('w1', id, 'hold'), await t.assist.answer('w1', id, 'release'), t.timers.advance(SAVE_CARD_MS)), false],
    ['through the next page on the same site', async (t) => (t.page.emit('did-navigate', {}, 'https://gist.github.com/ada', 200), await flush(), await flush()), true],
    ['leaving the site: it goes', async (t) => (t.page.emit('did-navigate', {}, 'https://example.org/', 200), await flush(), await flush()), false],
    ['the tab closing: it goes', (t) => ((t.page.destroyed = true), t.page.emit('destroyed')), false],
    ['its window closing: it goes', (t) => t.assist.windowClosed('w1'), false],
    ['another sign-in on the tab: the new one replaces it', async (t) => t.signedIn({ values: { username: 'grace', password: 'other' } }), true],
  ])('%s', async (_name, act, stays) => {
    const t = setup();
    await t.signedIn();
    const card = t.assist.cardFor('n1')!;
    await act(t, card.id);
    expect(t.assist.cardFor('n1') !== null).toBe(stays);
    if (!stays) expect(t.assist.reveal('w1', card.id)).toBeNull();
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
