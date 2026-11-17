import type { AuthInfo, AuthenticationResponseDetails, WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_FILL_WAIT_MS, AuthBroker } from '../../src/main/http-auth';

/** Just enough of a page: its address, and the tab it belongs to. */
const page = (url: string, nodeId: string | null = 'tab-1') => ({ url, nodeId: nodeId ?? undefined, getURL: () => url, isDestroyed: () => false }) as unknown as WebContents & { nodeId?: string };

function setUp() {
  const broker = new AuthBroker();
  const onChange = vi.fn();
  broker.connect({ nodeFor: (contents) => (contents as unknown as { nodeId?: string }).nodeId as never, onChange });
  return { broker, onChange };
}

const details = (url: string, more: Partial<AuthenticationResponseDetails> = {}) =>
  ({ url, pid: 1, isRequestForNavigation: true, firstAuthAttempt: true, responseHeaders: {}, ...more }) as AuthenticationResponseDetails;
const info = (more: Partial<AuthInfo> = {}): AuthInfo => ({ isProxy: false, scheme: 'basic', host: 'router.local', port: 80, realm: 'Admin', ...more });

describe('AuthBroker', () => {
  it("asks over the tab, signs in with what was typed, and keeps nothing", () => {
    const { broker, onChange } = setUp();
    const answer = vi.fn();
    expect(broker.login(page('https://example.com/'), details('http://router.local/'), info(), answer)).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
    const prompt = broker.promptFor('tab-1' as never)!;
    expect(prompt).toEqual({ id: prompt.id, origin: 'http://router.local', realm: 'Admin', proxy: false, insecure: true, retry: false, accounts: [], locked: false, remember: null, fill: false, embeddedIn: null });
    expect(broker.promptFor('tab-2' as never)).toBeNull();

    void broker.respond(prompt.id, { username: 'me', password: 'secret' });
    expect(answer).toHaveBeenCalledWith('me', 'secret');
    expect(broker.promptFor('tab-1' as never)).toBeNull();
  });

  it('cancels a box when asked to, and when its tab navigates away or closes', () => {
    const { broker } = setUp();
    const first = vi.fn();
    broker.login(page('https://a.test/'), details('https://a.test/'), info(), first);
    void broker.respond(broker.promptFor('tab-1' as never)!.id, null);
    expect(first).toHaveBeenCalledWith();

    const second = vi.fn();
    broker.login(page('https://a.test/'), details('https://a.test/'), info(), second);
    broker.forgetTab('tab-1' as never);
    expect(second).toHaveBeenCalledWith();
    expect(broker.promptFor('tab-1' as never)).toBeNull();
  });

  it('leaves to Electron (which cancels) whatever no tab asked for, and other sites’ images and scripts', () => {
    const { broker, onChange } = setUp();
    expect(broker.login(null, details('https://a.test/'), info(), vi.fn())).toBe(false);
    expect(broker.login(page('chord://shell/', null), details('https://a.test/'), info(), vi.fn())).toBe(false);
    expect(broker.login(page('https://news.test/'), details('https://tracker.test/pixel.gif', { isRequestForNavigation: false }), info(), vi.fn())).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    // The page's own site may ask for its subresources.
    expect(broker.login(page('https://intranet.test/'), details('https://intranet.test/api', { isRequestForNavigation: false }), info(), vi.fn())).toBe(true);
  });

  it('answers every request waiting on the same box at once, and says when the last answer failed', () => {
    const { broker } = setUp();
    const a = vi.fn();
    const b = vi.fn();
    broker.login(page('https://a.test/'), details('https://a.test/'), info(), a);
    broker.login(page('https://a.test/'), details('https://a.test/', { firstAuthAttempt: false }), info(), b);
    const prompt = broker.promptFor('tab-1' as never)!;
    expect(prompt.retry).toBe(true);
    void broker.respond(prompt.id, { username: 'u', password: 'p' });
    expect(a).toHaveBeenCalledWith('u', 'p');
    expect(b).toHaveBeenCalledWith('u', 'p');
  });

  it('names a proxy by host and port, trims the realm to one short line, and trusts HTTPS and this computer', () => {
    const { broker } = setUp();
    broker.login(page('https://a.test/'), details('https://a.test/'), info({ isProxy: true, host: 'proxy.corp', port: 3128, realm: `  Corp\n\n${'x'.repeat(300)}` }), vi.fn());
    const proxy = broker.promptFor('tab-1' as never)!;
    expect(proxy).toMatchObject({ origin: 'proxy.corp:3128', proxy: true, insecure: false });
    expect(proxy.realm.startsWith('Corp x')).toBe(true);
    expect(proxy.realm).toHaveLength(120);
    void broker.respond(proxy.id, null);

    broker.login(page('http://localhost:8080/'), details('http://localhost:8080/'), info(), vi.fn());
    expect(broker.promptFor('tab-1' as never)!.insecure).toBe(false);
  });
});

/**
 * The box with Chord's passwords (S17 §10): filled from the vault for the request's own origin and realm, the
 * password never leaving main before Sign in; *Remember* saving only once the server answers the request that was
 * answered; a frame of another site's page never filled; and the gates.
 */
describe('AuthBroker with the vault', () => {
  const ORIGIN = 'http://router.test:8080';
  const ADDRESS = `${ORIGIN}/admin`;
  /** Frame tree node ids: the page's main frame, and two of its subframes. */
  const MAIN = 1;
  const FRAME = 2;
  const SIBLING = 3;

  /**
   * A tab's page: its address, its frames' navigations (main tracks them, `attachPage`), and the frames it commits
   * (the server's answer). Committed frames are named by tree node id as their process and routing ids.
   */
  class Page extends EventEmitter {
    mainFrame = { frameTreeNodeId: MAIN };
    constructor(
      public url: string,
      public nodeId = 'tab-1',
    ) {
      super();
    }
    getURL = () => this.url;
    isDestroyed = () => false;
    /** A frame starts navigating to `url`. */
    navigate(url: string, frame = MAIN) {
      this.emit('did-start-navigation', { url, isSameDocument: false, isMainFrame: frame === MAIN, frame: { frameTreeNodeId: frame } });
    }
    redirect(url: string, frame = MAIN) {
      this.emit('did-redirect-navigation', { url, isSameDocument: false, isMainFrame: frame === MAIN, frame: { frameTreeNodeId: frame } });
    }
    /** The server answered `code` and the frame committed `url`. */
    commit(url: string, code: number, frame = MAIN) {
      this.emit('did-frame-navigate', {}, url, code, '', frame === MAIN, frame, frame);
    }
  }

  type State = 'open' | 'locked' | 'none' | 'off';
  type Account = { id: string; username: string };

  function setUp(options: { state?: State; accounts?: Account[]; private?: boolean; saved?: 'new' | 'update' } = {}) {
    let state: State = options.state ?? 'open';
    let accounts: Account[] = options.accounts ?? [];
    const vault = {
      accounts: vi.fn(async (..._args: unknown[]): Promise<unknown> => (state === 'open' ? { state, accounts } : { state })),
      password: vi.fn(async (id: string, ..._rest: unknown[]) => (state === 'open' && accounts.some((a) => a.id === id) ? `pw-of-${id}` : null)),
      remember: vi.fn(async (..._args: unknown[]) => (state === 'open' ? { ok: true, id: 'saved-1', kind: options.saved ?? 'new' } : { ok: false, problem: state })),
      askUnlock: vi.fn(async (..._args: unknown[]) => {
        state = 'open';
        return true;
      }),
    };
    const firstSave = vi.fn();
    const updated = vi.fn();
    let timers: { run: () => void; at: number }[] = [];
    let now = 0;
    const broker = new AuthBroker();
    broker.connect({
      nodeFor: (contents) => (contents as unknown as Page).nodeId as never,
      onChange: vi.fn(),
      tabOf: () => ({ chordId: options.private ? 'priv' : 'work', private: options.private ?? false }),
      windowOf: () => 'w1' as never,
      frameOf: (processId) => processId,
      vault: vault as never,
      firstSave,
      updated,
      now: () => now,
      setTimeout: (run, ms) => timers.push({ run, at: now + ms }),
      clearTimeout: () => undefined,
    });
    const advance = (ms: number) => {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.run();
    };
    const set = (next: { state?: State; accounts?: Account[] }) => {
      state = next.state ?? state;
      accounts = next.accounts ?? accounts;
    };
    /** A tab's page, tracked as main tracks every page. */
    const page = (url = ADDRESS, nodeId = 'tab-1') => {
      const p = new Page(url, nodeId);
      broker.attachPage(p as never);
      return p;
    };
    return { broker, vault, firstSave, updated, advance, set, page };
  }

  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };

  /** A frame navigates to the router (unless it already is), the router asks, and the box is shown once the vault answered. */
  async function ask(broker: AuthBroker, page: Page, more: Partial<AuthenticationResponseDetails> & { frame?: number; navigate?: boolean } = {}) {
    const { frame = MAIN, navigate = true, ...rest } = more;
    if (navigate && rest.isRequestForNavigation !== false) page.navigate(rest.url ?? ADDRESS, frame);
    const answer = vi.fn();
    broker.login(page as never, details(rest.url ?? ADDRESS, rest), info({ host: 'router.test', port: 8080, realm: 'Router admin' }), answer);
    await settle();
    return { answer, prompt: broker.promptFor(page.nodeId as never) };
  }

  it('fills from the vault by origin and realm: usernames only to the popover, the password from main on Sign in', async () => {
    const { broker, vault, page } = setUp({ accounts: [{ id: 'a', username: 'ada@example.com' }, { id: 'b', username: 'grace@example.com' }] });
    const tab = page();
    const { answer, prompt } = await ask(broker, tab);
    expect(vault.accounts).toHaveBeenCalledWith(ORIGIN, 'Router admin', 'work');
    expect(prompt).toMatchObject({ accounts: ['ada@example.com', 'grace@example.com'], locked: false, remember: true, fill: true, embeddedIn: null });
    expect(JSON.stringify(prompt)).not.toContain('pw-of');
    // Nothing is sent until Sign in.
    expect(answer).not.toHaveBeenCalled();
    await broker.respond(prompt!.id, { account: 1, username: 'grace@example.com' }, true, 'w1' as never);
    expect(vault.password).toHaveBeenCalledWith('b', ORIGIN, 'Router admin', 'work');
    expect(answer).toHaveBeenCalledWith('grace@example.com', 'pw-of-b');
    // The saved one: nothing to save again.
    tab.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it.each([
    ['out of range', { account: 2, username: 'ada' }, 'w1'],
    ['for another username than the list has there', { account: 0, username: 'grace' }, 'w1'],
    ['from another window’s popover', { account: 0, username: 'ada' }, 'w2'],
  ])('refuses a saved sign-in %s', async (_name, choice, windowId) => {
    const { broker, vault, page } = setUp({ accounts: [{ id: 'a', username: 'ada' }, { id: 'b', username: 'bob' }] });
    const { prompt, answer } = await ask(broker, page());
    await broker.respond(prompt!.id, choice, false, windowId as never);
    expect(vault.password).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    // The box is still there, for the right answer.
    expect(broker.promptFor('tab-1' as never)).toMatchObject({ id: prompt!.id });
  });

  it('refuses an index the list no longer means: locked and opened again with other sign-ins', async () => {
    const { broker, vault, set, page } = setUp({ accounts: [{ id: 'a', username: 'ada' }, { id: 'b', username: 'bob' }] });
    const { prompt, answer } = await ask(broker, page());
    // The popover drew [ada, bob]; the vault locks, opens, and now holds [carol, ada].
    set({ state: 'locked' });
    await broker.respond(prompt!.id, { account: 0, username: 'ada' });
    await settle();
    expect(broker.promptFor('tab-1' as never)).toMatchObject({ locked: true, accounts: [] });
    set({ state: 'open', accounts: [{ id: 'c', username: 'carol' }, { id: 'a', username: 'ada' }] });
    await broker.unlock(prompt!.id);
    await settle();
    expect(broker.promptFor('tab-1' as never)).toMatchObject({ accounts: ['carol', 'ada'] });
    vault.password.mockClear();
    // Index 1 was bob when it was drawn: refused, never carol's nor ada's password.
    await broker.respond(prompt!.id, { account: 1, username: 'bob' });
    expect(vault.password).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    await broker.respond(prompt!.id, { account: 1, username: 'ada' });
    expect(answer).toHaveBeenCalledWith('ada', 'pw-of-a');
  });

  it('a frame of another site’s page: says whose page, isn’t filled, and signs in only with a username chosen', async () => {
    const { broker, page } = setUp({ accounts: [{ id: 'a', username: 'ada@example.com' }] });
    const tab = page('https://evil.example/');
    const { prompt, answer } = await ask(broker, tab, { frame: FRAME });
    expect(prompt).toMatchObject({ origin: ORIGIN, embeddedIn: 'evil.example', fill: false, accounts: ['ada@example.com'], remember: false });
    expect(answer).not.toHaveBeenCalled();
    await broker.respond(prompt!.id, { account: 0, username: 'ada@example.com' });
    expect(answer).toHaveBeenCalledWith('ada@example.com', 'pw-of-a');
  });

  it('a top-level navigation from another site, and a frame of the same site, are filled as before', async () => {
    const { broker, page } = setUp({ accounts: [{ id: 'a', username: 'ada' }] });
    // Leaving evil.example for the router: the main frame, so the box is filled.
    const top = await ask(broker, page('https://evil.example/'));
    expect(top.prompt).toMatchObject({ fill: true, embeddedIn: null });
    const other = setUp({ accounts: [{ id: 'a', username: 'ada' }] });
    const own = await ask(other.broker, other.page(`${ORIGIN}/`), { frame: FRAME });
    expect(own.prompt).toMatchObject({ fill: true, embeddedIn: null });
  });

  it('waits a moment for the vault, then shows the box anyway, and fills it when the answer comes', async () => {
    const { broker, vault, advance, page } = setUp();
    let release: (value: unknown) => void = () => undefined;
    vault.accounts.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const tab = page();
    tab.navigate(ADDRESS);
    broker.login(tab as never, details(ADDRESS), info({ host: 'router.test', port: 8080, realm: 'Router admin' }), vi.fn());
    expect(broker.promptFor('tab-1' as never)).toBeNull();
    advance(AUTH_FILL_WAIT_MS);
    expect(broker.promptFor('tab-1' as never)).toMatchObject({ accounts: [], remember: null });
    release({ state: 'open', accounts: [{ id: 'a', username: 'ada@example.com' }] });
    await settle();
    expect(broker.promptFor('tab-1' as never)).toMatchObject({ accounts: ['ada@example.com'], remember: true });
  });

  it.each([
    ['nothing saved', { state: 'open' as const }, false],
    ['no vault yet', { state: 'none' as const }, false],
    ['a locked vault', { state: 'locked' as const }, false],
    ['saved sign-ins', { state: 'open' as const, accounts: [{ id: 'a', username: 'ada' }] }, true],
    ['passwords off for the chord', { state: 'off' as const }, null],
    ['a private window', { state: 'open' as const, accounts: [{ id: 'a', username: 'ada' }], private: true }, null],
  ])('Remember’s default with %s', async (_name, options, remember) => {
    const { broker, page } = setUp(options);
    const { prompt } = await ask(broker, page());
    expect(prompt!.remember).toBe(remember);
    expect(prompt!.locked).toBe(options.state === 'locked');
    // A private window still fills.
    if ('private' in options) expect(prompt!.accounts).toEqual(['ada']);
  });

  it('a page’s own script request (not a navigation) has no answer to read: no Remember, nothing held', async () => {
    const { broker, vault, page } = setUp();
    const tab = page(`${ORIGIN}/`);
    const { prompt } = await ask(broker, tab, { url: `${ORIGIN}/api`, isRequestForNavigation: false });
    expect(prompt!.remember).toBeNull();
    await broker.respond(prompt!.id, { username: 'ada', password: 'pw' }, true);
    tab.commit(`${ORIGIN}/api`, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('a proxy’s box never asks the vault, never fills, and never offers Remember', async () => {
    const { broker, vault, page } = setUp({ accounts: [{ id: 'a', username: 'ada' }] });
    const tab = page('https://a.test/');
    tab.navigate('https://a.test/');
    const answer = vi.fn();
    broker.login(tab as never, details('https://a.test/'), info({ isProxy: true, host: 'proxy.corp', port: 3128 }), answer);
    const prompt = broker.promptFor('tab-1' as never)!;
    expect(prompt).toMatchObject({ proxy: true, accounts: [], remember: null, locked: false });
    expect(vault.accounts).not.toHaveBeenCalled();
    // Even when asked to remember, or to use a saved account.
    await broker.respond(prompt.id, { account: 0, username: 'ada' });
    expect(answer).not.toHaveBeenCalled();
    await broker.respond(prompt.id, { username: 'me', password: 'secret' }, true);
    expect(answer).toHaveBeenCalledWith('me', 'secret');
    tab.commit('https://a.test/', 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('Remember saves once the answered request’s frame commits it, not on the 401 retry, and follows its redirects', async () => {
    const { broker, vault, page } = setUp();
    const tab = page();
    const first = await ask(broker, tab);
    await broker.respond(first.prompt!.id, { username: 'ada@example.com', password: 'wrong' }, true);
    // Chromium asks again for the same navigation: it didn't work, and the wrong one goes.
    const retry = await ask(broker, tab, { firstAuthAttempt: false, navigate: false });
    expect(retry.prompt).toMatchObject({ retry: true, remember: true });
    tab.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
    // The right one: the server redirects, and the frame commits where it was sent.
    tab.navigate(ADDRESS);
    const again = await ask(broker, tab, { navigate: false });
    await broker.respond(again.prompt!.id, { username: 'ada@example.com', password: 'right' }, true);
    tab.redirect(`${ORIGIN}/admin/home`);
    tab.commit(`${ORIGIN}/admin/home`, 200);
    await settle();
    expect(vault.remember).toHaveBeenCalledExactlyOnceWith({ origin: ORIGIN, realm: 'Router admin', chordId: 'work', username: 'ada@example.com', password: 'right' });
    expect(tab.listenerCount('did-frame-navigate')).toBe(1);
  });

  it('a sibling frame of the same site committing first says nothing: a wrong password isn’t saved', async () => {
    const { broker, vault, page } = setUp({ accounts: [{ id: 'a', username: 'ada' }] });
    // evil.example frames the router's admin page, and keeps reloading a public router page beside it.
    const tab = page('https://evil.example/');
    tab.navigate(`${ORIGIN}/public`, SIBLING);
    const { prompt } = await ask(broker, tab, { frame: FRAME });
    await broker.respond(prompt!.id, { username: 'ada', password: 'wrong' }, true);
    tab.commit(`${ORIGIN}/public`, 200, SIBLING);
    tab.commit(ADDRESS, 200, MAIN);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
    // Then the retry: the wrong one goes.
    await ask(broker, tab, { frame: FRAME, firstAuthAttempt: false, navigate: false });
    tab.commit(ADDRESS, 200, FRAME);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it.each([
    ['Remember unticked', (_b: AuthBroker, _p: Page) => undefined, false],
    ['a 401 page', (_b: AuthBroker, p: Page) => p.commit(ADDRESS, 401), true],
    ['the tab navigating', (b: AuthBroker) => b.forgetTab('tab-1' as never), true],
    ['the frame committing somewhere else', (_b: AuthBroker, p: Page) => p.commit('https://elsewhere.test/', 200), true],
  ])('saves nothing after %s', async (_name, before, remember) => {
    const { broker, vault, page } = setUp();
    const tab = page();
    const { prompt } = await ask(broker, tab);
    await broker.respond(prompt!.id, { username: 'ada', password: 'pw' }, remember);
    before(broker, tab);
    tab.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('what was typed goes after five minutes unanswered', async () => {
    const { broker, vault, advance, page } = setUp();
    const tab = page();
    const { prompt } = await ask(broker, tab);
    await broker.respond(prompt!.id, { username: 'ada', password: 'pw' }, true);
    advance(5 * 60_000);
    tab.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('Cancel on the box that comes back drops what was typed before it', async () => {
    const { broker, vault, page } = setUp();
    const tab = page();
    const first = await ask(broker, tab);
    await broker.respond(first.prompt!.id, { username: 'ada', password: 'pw' }, true);
    const again = await ask(broker, tab, { navigate: false });
    await broker.respond(again.prompt!.id, null);
    tab.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('a private window fills and never saves', async () => {
    const { broker, vault, page } = setUp({ private: true, accounts: [{ id: 'a', username: 'ada' }] });
    const tab = page();
    const { prompt, answer } = await ask(broker, tab);
    await broker.respond(prompt!.id, { account: 0, username: 'ada' });
    expect(answer).toHaveBeenCalledWith('ada', 'pw-of-a');
    const next = await ask(broker, tab);
    await broker.respond(next.prompt!.id, { username: 'grace', password: 'typed' }, true);
    tab.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('off for the chord: no fill, no Remember, and a saved account can’t be asked for', async () => {
    const { broker, vault, page } = setUp({ state: 'off' });
    const { prompt, answer } = await ask(broker, page());
    expect(prompt).toMatchObject({ accounts: [], remember: null });
    await broker.respond(prompt!.id, { account: 0, username: 'ada' });
    expect(answer).not.toHaveBeenCalled();
    expect(vault.password).not.toHaveBeenCalled();
  });

  it('locked: Unlock passwords opens the unlock card, then the box fills; locked again, nothing is sent', async () => {
    const { broker, vault, set, page } = setUp({ state: 'locked', accounts: [{ id: 'a', username: 'ada' }] });
    const { prompt, answer } = await ask(broker, page());
    expect(prompt).toMatchObject({ locked: true, accounts: [] });
    // Not from another window's popover.
    await broker.unlock(prompt!.id, 'w2' as never);
    expect(vault.askUnlock).not.toHaveBeenCalled();
    await broker.unlock(prompt!.id, 'w1' as never);
    expect(vault.askUnlock).toHaveBeenCalledWith('w1');
    expect(broker.promptFor('tab-1' as never)).toMatchObject({ id: prompt!.id, locked: false, accounts: ['ada'], remember: true });
    set({ state: 'locked' });
    await broker.respond(prompt!.id, { account: 0, username: 'ada' });
    await settle();
    expect(answer).not.toHaveBeenCalled();
    expect(broker.promptFor('tab-1' as never)).toMatchObject({ locked: true, accounts: [] });
  });

  it('a locked vault at the save asks to unlock first; with no vault yet, the save card chooses the passphrase', async () => {
    const locked = setUp({ state: 'locked' });
    const tab = locked.page();
    const a = await ask(locked.broker, tab);
    await locked.broker.respond(a.prompt!.id, { username: 'ada', password: 'pw' }, true);
    tab.commit(ADDRESS, 200);
    await settle();
    expect(locked.vault.askUnlock).toHaveBeenCalledOnce();
    expect(locked.vault.remember).toHaveBeenCalledTimes(2);

    const none = setUp({ state: 'none' });
    const other = none.page();
    const b = await ask(none.broker, other);
    await none.broker.respond(b.prompt!.id, { username: 'ada', password: 'pw' }, true);
    other.commit(ADDRESS, 200);
    await settle();
    expect(none.firstSave).toHaveBeenCalledExactlyOnceWith(other, { origin: ORIGIN, realm: 'Router admin', username: 'ada', password: 'pw', until: 5 * 60_000 });
  });

  it('accepted while the vault is locked: closing the tab during the unlock card drops it; a navigation doesn’t', async () => {
    for (const [leave, saves] of [
      [(b: AuthBroker) => b.forgetTab('tab-1' as never, true), 1],
      [(b: AuthBroker) => b.forgetTab('tab-1' as never), 2],
    ] as const) {
      const t = setUp({ state: 'locked' });
      let unlock: (open: boolean) => void = () => undefined;
      t.vault.askUnlock.mockImplementationOnce(() => new Promise<boolean>((resolve) => (unlock = resolve)));
      const tab = t.page();
      const { prompt } = await ask(t.broker, tab);
      await t.broker.respond(prompt!.id, { username: 'ada', password: 'pw' }, true);
      tab.commit(ADDRESS, 200);
      await settle();
      leave(t.broker);
      t.set({ state: 'open' });
      unlock(true);
      await settle();
      expect(t.vault.remember).toHaveBeenCalledTimes(saves);
    }
  });

  it('a new sign-in is saved quietly; an updated password says so, with Undo', async () => {
    const fresh = setUp({ saved: 'new' });
    const a = fresh.page();
    const one = await ask(fresh.broker, a);
    await fresh.broker.respond(one.prompt!.id, { username: 'ada', password: 'pw' }, true);
    a.commit(ADDRESS, 200);
    await settle();
    expect(fresh.updated).not.toHaveBeenCalled();

    const changed = setUp({ saved: 'update' });
    const b = changed.page();
    const two = await ask(changed.broker, b);
    await changed.broker.respond(two.prompt!.id, { username: 'ada', password: 'new' }, true);
    b.commit(ADDRESS, 200);
    await settle();
    expect(changed.updated).toHaveBeenCalledExactlyOnceWith('w1', { id: 'saved-1', host: 'router.test:8080' });
  });
});
