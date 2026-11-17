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
    expect(prompt).toEqual({ id: prompt.id, origin: 'http://router.local', realm: 'Admin', proxy: false, insecure: true, retry: false, accounts: [], locked: false, remember: null });
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
 * password never leaving main before Sign in; *Remember* saving only once the server takes it; and the gates.
 */
describe('AuthBroker with the vault', () => {
  const ORIGIN = 'http://router.test:8080';
  const ADDRESS = `${ORIGIN}/admin`;

  /** A tab's page: its address, and the frames it commits (what the server answered). */
  class Page extends EventEmitter {
    constructor(
      public url: string,
      public nodeId = 'tab-1',
    ) {
      super();
    }
    getURL = () => this.url;
    isDestroyed = () => false;
    /** The server answered `code` for `url`. */
    commit(url: string, code: number, isMainFrame = true) {
      this.emit('did-frame-navigate', {}, url, code, '', isMainFrame, 1, 1);
    }
  }

  type State = 'open' | 'locked' | 'none' | 'off';
  type Account = { id: string; username: string };

  function setUp(options: { state?: State; accounts?: Account[]; private?: boolean } = {}) {
    let state: State = options.state ?? 'open';
    let accounts: Account[] = options.accounts ?? [];
    const vault = {
      accounts: vi.fn(async (..._args: unknown[]): Promise<unknown> => (state === 'open' ? { state, accounts } : { state })),
      password: vi.fn(async (id: string, ..._rest: unknown[]) => (state === 'open' && accounts.some((a) => a.id === id) ? `pw-of-${id}` : null)),
      remember: vi.fn(async (..._args: unknown[]) => (state === 'open' ? { ok: true, id: 'new', kind: 'new' } : { ok: false, problem: state })),
      askUnlock: vi.fn(async (..._args: unknown[]) => {
        state = 'open';
        return true;
      }),
    };
    const firstSave = vi.fn();
    let timers: { run: () => void; at: number }[] = [];
    let now = 0;
    const broker = new AuthBroker();
    broker.connect({
      nodeFor: (contents) => (contents as unknown as Page).nodeId as never,
      onChange: vi.fn(),
      tabOf: () => ({ chordId: options.private ? 'priv' : 'work', private: options.private ?? false }),
      windowOf: () => 'w1' as never,
      vault: vault as never,
      firstSave,
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
    return { broker, vault, firstSave, advance, set };
  }

  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };

  /** A box asked for, and shown once the vault answered. */
  async function ask(broker: AuthBroker, page: Page, more: Partial<AuthenticationResponseDetails> = {}) {
    const answer = vi.fn();
    broker.login(page as never, details(ADDRESS, more), info({ host: 'router.test', port: 8080, realm: 'Router admin' }), answer);
    await settle();
    return { answer, prompt: broker.promptFor(page.nodeId as never) };
  }

  it('fills from the vault by origin and realm: usernames only to the popover, the password from main on Sign in', async () => {
    const { broker, vault } = setUp({ accounts: [{ id: 'a', username: 'ada@example.com' }, { id: 'b', username: 'grace@example.com' }] });
    const page = new Page(ADDRESS);
    const { answer, prompt } = await ask(broker, page);
    expect(vault.accounts).toHaveBeenCalledWith(ORIGIN, 'Router admin', 'work');
    expect(prompt).toMatchObject({ accounts: ['ada@example.com', 'grace@example.com'], locked: false, remember: true });
    expect(JSON.stringify(prompt)).not.toContain('pw-of');
    // Nothing is sent until Sign in.
    expect(answer).not.toHaveBeenCalled();
    await broker.respond(prompt!.id, { account: 1 }, true);
    expect(vault.password).toHaveBeenCalledWith('b', ORIGIN, 'Router admin', 'work');
    expect(answer).toHaveBeenCalledWith('grace@example.com', 'pw-of-b');
    // The saved one: nothing to save again.
    page.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('waits a moment for the vault, then shows the box anyway, and fills it when the answer comes', async () => {
    const { broker, vault, advance } = setUp();
    let release: (value: unknown) => void = () => undefined;
    vault.accounts.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    broker.login(new Page(ADDRESS) as never, details(ADDRESS), info({ host: 'router.test', port: 8080, realm: 'Router admin' }), vi.fn());
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
    const { broker } = setUp(options);
    const { prompt } = await ask(broker, new Page(ADDRESS));
    expect(prompt!.remember).toBe(remember);
    expect(prompt!.locked).toBe(options.state === 'locked');
    // A private window still fills.
    if ('private' in options) expect(prompt!.accounts).toEqual(['ada']);
  });

  it('a proxy’s box never asks the vault, never fills, and never offers Remember', async () => {
    const { broker, vault } = setUp({ accounts: [{ id: 'a', username: 'ada' }] });
    const page = new Page('https://a.test/');
    const answer = vi.fn();
    broker.login(page as never, details('https://a.test/'), info({ isProxy: true, host: 'proxy.corp', port: 3128 }), answer);
    const prompt = broker.promptFor('tab-1' as never)!;
    expect(prompt).toMatchObject({ proxy: true, accounts: [], remember: null, locked: false });
    expect(vault.accounts).not.toHaveBeenCalled();
    // Even when asked to remember, or to use a saved account.
    await broker.respond(prompt.id, { account: 0 });
    expect(answer).not.toHaveBeenCalled();
    await broker.respond(prompt.id, { username: 'me', password: 'secret' }, true);
    expect(answer).toHaveBeenCalledWith('me', 'secret');
    page.commit('https://a.test/', 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('Remember saves once the server takes it, not on the 401 retry', async () => {
    const { broker, vault } = setUp();
    const page = new Page(ADDRESS);
    const first = await ask(broker, page);
    await broker.respond(first.prompt!.id, { username: 'ada@example.com', password: 'wrong' }, true);
    // Chromium asks again: it didn't work, and the wrong one goes.
    const retry = await ask(broker, page, { firstAuthAttempt: false });
    // The box again, with Remember still ticked.
    expect(retry.prompt).toMatchObject({ retry: true, remember: true });
    page.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
    await broker.respond(retry.prompt!.id, { username: 'ada@example.com', password: 'right' }, true);
    // Another origin's frame says nothing; the page's own commit does.
    page.commit('https://ads.test/', 200, false);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
    page.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).toHaveBeenCalledExactlyOnceWith({ origin: ORIGIN, realm: 'Router admin', chordId: 'work', username: 'ada@example.com', password: 'right' });
    expect(page.listenerCount('did-frame-navigate')).toBe(0);
  });

  it.each([
    ['Remember unticked', (_b: AuthBroker, _p: Page) => undefined, false],
    ['a 401 page', (_b: AuthBroker, p: Page) => p.commit(ADDRESS, 401), true],
    ['the tab navigating', (b: AuthBroker) => b.forgetTab('tab-1' as never), true],
    ['leaving the origin', (_b: AuthBroker, p: Page) => p.commit('https://elsewhere.test/', 200), true],
  ])('saves nothing after %s', async (_name, before, remember) => {
    const { broker, vault } = setUp();
    const page = new Page(ADDRESS);
    const { prompt } = await ask(broker, page);
    await broker.respond(prompt!.id, { username: 'ada', password: 'pw' }, remember);
    before(broker, page);
    page.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('what was typed goes after five minutes unanswered', async () => {
    const { broker, vault, advance } = setUp();
    const page = new Page(ADDRESS);
    const { prompt } = await ask(broker, page);
    await broker.respond(prompt!.id, { username: 'ada', password: 'pw' }, true);
    advance(5 * 60_000);
    expect(page.listenerCount('did-frame-navigate')).toBe(0);
    page.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('Cancel on the box that comes back drops what was typed before it', async () => {
    const { broker, vault } = setUp();
    const page = new Page(ADDRESS);
    const first = await ask(broker, page);
    await broker.respond(first.prompt!.id, { username: 'ada', password: 'pw' }, true);
    const again = await ask(broker, page);
    await broker.respond(again.prompt!.id, null);
    page.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('a private window fills and never saves', async () => {
    const { broker, vault } = setUp({ private: true, accounts: [{ id: 'a', username: 'ada' }] });
    const page = new Page(ADDRESS);
    const { prompt, answer } = await ask(broker, page);
    await broker.respond(prompt!.id, { account: 0 });
    expect(answer).toHaveBeenCalledWith('ada', 'pw-of-a');
    const next = await ask(broker, page);
    await broker.respond(next.prompt!.id, { username: 'grace', password: 'typed' }, true);
    page.commit(ADDRESS, 200);
    await settle();
    expect(vault.remember).not.toHaveBeenCalled();
  });

  it('off for the chord: no fill, no Remember, and a saved account can’t be asked for', async () => {
    const { broker, vault } = setUp({ state: 'off' });
    const { prompt, answer } = await ask(broker, new Page(ADDRESS));
    expect(prompt).toMatchObject({ accounts: [], remember: null });
    await broker.respond(prompt!.id, { account: 0 });
    expect(answer).not.toHaveBeenCalled();
    expect(vault.password).not.toHaveBeenCalled();
  });

  it('locked: Unlock passwords opens the unlock card, then the box fills; locked again, nothing is sent', async () => {
    const { broker, vault, set } = setUp({ state: 'locked', accounts: [{ id: 'a', username: 'ada' }] });
    const { prompt, answer } = await ask(broker, new Page(ADDRESS));
    expect(prompt).toMatchObject({ locked: true, accounts: [] });
    await broker.unlock(prompt!.id);
    expect(vault.askUnlock).toHaveBeenCalledWith('w1');
    expect(broker.promptFor('tab-1' as never)).toMatchObject({ id: prompt!.id, locked: false, accounts: ['ada'], remember: true });
    set({ state: 'locked' });
    await broker.respond(prompt!.id, { account: 0 });
    await settle();
    expect(answer).not.toHaveBeenCalled();
    expect(broker.promptFor('tab-1' as never)).toMatchObject({ locked: true, accounts: [] });
  });

  it('a locked vault at the save asks to unlock first; with no vault yet, the save card chooses the passphrase', async () => {
    const locked = setUp({ state: 'locked' });
    const page = new Page(ADDRESS);
    const a = await ask(locked.broker, page);
    await locked.broker.respond(a.prompt!.id, { username: 'ada', password: 'pw' }, true);
    page.commit(ADDRESS, 200);
    await settle();
    expect(locked.vault.askUnlock).toHaveBeenCalledOnce();
    expect(locked.vault.remember).toHaveBeenCalledTimes(2);

    const none = setUp({ state: 'none' });
    const other = new Page(ADDRESS);
    const b = await ask(none.broker, other);
    await none.broker.respond(b.prompt!.id, { username: 'ada', password: 'pw' }, true);
    other.commit(ADDRESS, 200);
    await settle();
    expect(none.firstSave).toHaveBeenCalledExactlyOnceWith(other, { origin: ORIGIN, realm: 'Router admin', username: 'ada', password: 'pw', until: 5 * 60_000 });
  });
});
