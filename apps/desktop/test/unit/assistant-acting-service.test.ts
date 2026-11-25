/**
 * The assistant service's side of acting (S18 M2e-2a; the reviews of #147): the message's tab only when acting is on,
 * your hands ending any lease whatever the chat is doing, Stop letting tails go, the message's tab leaving the screen,
 * every way a chat ends, and only its own bars cleared.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, nodeOf, splitOf, type State } from '@chord/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, shell: {}, clipboard: {}, BrowserWindow: class {}, WebContentsView: class {}, net: {}, nativeImage: {}, ClipboardItem: class {} }));
/** The lease module, as the service sees it: whose lease is on where, and what was ended (by whom). */
const leases = vi.hoisted(() => ({ going: [] as [unknown, string][], ended: [] as unknown[], owners: new Map<unknown, string>(), begin: async (): Promise<string> => 'on', deps: null as null | { note(what: string, detail: string): void } }));
vi.mock('../../src/main/control/user-watch', () => ({
  beginUserAction: async (contents: unknown, owner: string, deps: { note(what: string, detail: string): void }) => {
    leases.deps = deps;
    const begun = await leases.begin();
    if (begun === 'on') leases.owners.set(contents, owner);
    return { begun, end: () => undefined };
  },
  endUserLease: (contents: unknown, owner?: string) => {
    const now = leases.owners.get(contents);
    if (owner !== undefined && now !== undefined && now !== owner) return;
    leases.ended.push(contents);
    leases.owners.delete(contents);
  },
  onUserLeaseEnd: () => () => undefined,
  userLeaseOwner: (contents: unknown) => leases.owners.get(contents) ?? null,
  userTabActing: (contents: unknown) => leases.owners.has(contents),
  userTabGoing: (contents: unknown, url: string) => void leases.going.push([contents, url]),
}));
const guards = vi.hoisted(() => ({ dropped: [] as unknown[] }));
vi.mock('../../src/main/control/page', async (actual) => ({ ...(await actual<Record<string, unknown>>()), dropAgentGuard: (contents: unknown) => void guards.dropped.push(contents) }));
const { AssistantService } = await import('../../src/main/assistant/service');
const { USER_TAB_REFUSALS } = await import('../../src/main/assistant/scope');
const { actCard } = await import('../../src/main/assistant/service');
const { Store } = await import('../../src/main/store');

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const dirs: string[] = [];
afterEach(() => {
  leases.ended.length = 0;
  leases.owners.clear();
  leases.begin = async () => 'on';
  guards.dropped.length = 0;
  // A chat may still be writing a row (an activity) as the test ends: retried, never a false failure.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

interface Inner {
  load(threadId: string, chordId: string): Promise<{ elsewhere: boolean }>;
  stateFor(chordId: string): Promise<{ elsewhere: boolean; streaming: unknown; actTab: { nodeId: string; windowId: string } | null; actEnded: string | null; leased: Set<string>; queue: string[]; sendGrants: Map<string, Set<string>> }>;
  send(windowId: string, state: unknown, text: string, reuse?: unknown[], reuseImages?: unknown[]): Promise<void>;
  barFor(nodeId: string, text: string | null): void;
  actingHost(s: unknown): { lease: { going(node: { id: string }, url: string): void } };
  importChanged(removed?: unknown[]): Promise<void>;
  tailCard(s: unknown, nodeId: string, contents: unknown): (sites: string[], why: string | null, signal: AbortSignal, going?: string) => Promise<string>;
}

function setup(acting = true) {
  const state: State = emptyState();
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  state.settings = { ...state.settings, assistant: { ...state.settings.assistant, enabled: true, acting } };
  const store = new Store(state);
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://game.example/table' });
  const mine = store.state.windows['w1']!.activeTab['c1']!;
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://shop.example/', background: true });
  const other = Object.values(store.state.nodes).flatMap((b) => Object.values(b)).find((n) => n.kind === 'tab' && n.id !== mine)!.id;
  const pages = new Map<string, { isDestroyed(): boolean }>();
  const page = (id: string) => {
    let p = pages.get(id);
    if (!p) pages.set(id, (p = { isDestroyed: () => false, getURL: () => 'https://game.example/table' } as { isDestroyed(): boolean }));
    return p;
  };
  const dir = mkdtempSync(join(tmpdir(), 'chord-assistant-'));
  dirs.push(dir);
  const browser = {
    store,
    // No shell here: the panel's pushes skip the window (isDestroyed); what acting asks (isMinimized) answers.
    allWindows: [{ id: 'w1', window: { isMinimized: () => false, isDestroyed: () => true } }],
    peeks: { isOpen: () => false },
    tabs: { get: (id: string) => ({ webContents: page(id) }), nodeFor: (contents: unknown) => [...pages].find(([, p]) => p === contents)?.[0] },
    assistantBars: false,
  };
  const service = new AssistantService(browser as never, { assistant: async () => ({ threads: [] }) } as never, dir);
  const inner = service as unknown as Inner;
  /** A turn under way for the message just sent (no provider: the state is as send left it). */
  const turn = async () => {
    const s = await inner.stateFor('c1');
    s.streaming = { id: 'reply' };
    s.actTab = acting ? { nodeId: mine, windowId: 'w1' } : null;
    s.actEnded = null;
    return s;
  };
  return { store, service, inner, mine, other, page, turn, browser };
}

describe('The service’s side of acting (S18 M2e-2a; the reviews of #147)', () => {
  it('acting off (Settings): no message’s tab, and your click in the tab during a reply says nothing (Claude’s B1)', async () => {
    const t = setup(false);
    const s = await t.turn();
    t.service.userUsedTab(t.mine);
    expect(s.actEnded).toBeNull();
    // An outside agent's bar on a tab is never cleared by the assistant: it only clears bars it put up.
    t.store.dispatch({ t: 'tab.live', nodeId: t.mine, live: { agent: { state: 'working', name: 'Codex', chordId: 'c1' } } });
    t.inner.barFor(t.mine, null);
    expect(t.store.state.live[t.mine]?.agent?.name).toBe('Codex');
  });

  it('your click or your page move after the turn still ends any lease of the assistant’s there (Claude’s and Neon’s B2)', async () => {
    const t = setup();
    const s = await t.inner.stateFor('c1');
    s.streaming = null;
    s.leased.add(t.mine);
    t.service.userUsedTab(t.mine);
    expect(leases.ended).toContain(t.page(t.mine));
    leases.ended.length = 0;
    t.service.userMovedPage(t.page(t.other) as never);
    expect(leases.ended).toContain(t.page(t.other));
  });

  it('Stop (Ctrl+.) lets go of a tail still running after the turn (Claude’s B2)', async () => {
    const t = setup();
    const s = await t.inner.stateFor('c1');
    s.leased.add(t.mine);
    t.service.stopAll();
    expect(leases.ended).toContain(t.page(t.mine));
    expect(s.leased.size).toBe(0);
  });

  it('the message’s tab leaving the screen ends acting for the message, with no coming back (Neon’s B6)', async () => {
    const t = setup();
    const s = await t.turn();
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.other });
    expect(s.actEnded).toBe(USER_TAB_REFUSALS.switched('another tab is on screen in its window'));
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.mine });
    expect(s.actEnded).toBe(USER_TAB_REFUSALS.switched('another tab is on screen in its window'));
  });

  it('every way a chat ends lets its leases go: a new chat, Settings’ Nothing, the chord turned off (E6)', async () => {
    for (const end of ['new', 'nothing', 'chordOff'] as const) {
      const t = setup();
      const s = await t.turn();
      s.leased.add(t.mine);
      if (end === 'new') await t.service.act('w1', { do: 'new' } as never);
      else if (end === 'nothing') t.store.dispatch({ t: 'settings.set', settings: { assistant: { readsNothing: true } } });
      else t.store.dispatch({ t: 'settings.set', settings: { assistant: { offChords: ['c1'] } } });
      expect(leases.ended, end).toContain(t.page(t.mine));
    }
  });

  it('a tail card: each origin as cards show it (its own site is “its site”), where the page goes, a closed tab denied, and no answer in time takes it down (the reviews of #147)', async () => {
    const t = setup();
    const s = (await t.inner.stateFor('c1')) as unknown as { control: { ask: (card: unknown, signal: AbortSignal, waitMs: number) => Promise<string> } };
    const cards: { step: { site: string; sends?: string[]; going?: string }; takeDown?: AbortSignal; description: string; kind: string }[] = [];
    let answer = 'waiting';
    s.control.ask = async (card, _signal, waitMs) => {
      expect(waitMs).toBeLessThan(Infinity);
      cards.push(card as never);
      return answer;
    };
    let gone = false;
    const contents = { isDestroyed: () => gone, getURL: () => 'https://game.example/table' };
    const ask = t.inner.tailCard(s, t.mine, contents);
    expect(await ask(['https://game.example'], null, new AbortController().signal)).toBe('deny');
    expect(cards[0]!.step).toMatchObject({ site: 'game.example', sends: ['game.example'] });
    expect(actCard(cards[0] as never)?.note).toContain('its site');
    expect(cards[0]!.takeDown?.aborted).toBe(true);
    answer = 'always';
    expect(await ask(['https://shop.example'], 'leave', new AbortController().signal, 'https://shop.example/checkout?secret=W-104388#done')).toBe('once');
    // Leaving: the whole address, never the bar's short one (Neon's B1 on #151).
    expect(cards[1]!.step).toMatchObject({ site: 'shop.example', going: 'https://shop.example/checkout?secret=W-104388#done' });
    expect(await ask(['https://shop.example'], null, new AbortController().signal)).toBe('until');
    gone = true;
    expect(await ask(['https://shop.example'], null, new AbortController().signal)).toBe('deny');
    expect(cards).toHaveLength(3);
  });

  it('what it types is shown first in a chat with earlier turns (resumed, continued, imported) or an image attached (Neon’s B3 on #151)', async () => {
    const t = setup();
    const thread = { id: 'th1', chordId: 'c1', title: 'Earlier', provider: 'claude', createdAt: 0, updatedAt: 0, lastUsedAt: 0 };
    const earlier = [{ id: 'm1', threadId: 'th1', createdAt: 0, body: { role: 'user', text: 'Read my mail tab', attachments: [] } }];
    (t.service as unknown as { persistence: unknown }).persistence = { assistant: async (q: { op: string; threadId?: string }) => (q.op === 'thread' ? (q.threadId === 'th1' ? { thread, messages: earlier } : { thread: { ...thread, id: q.threadId }, messages: [] }) : { threads: [] }) };
    const resumed = await t.inner.load('th1', 'c1');
    expect(resumed.elsewhere).toBe(true);
    expect((await t.inner.load('th2', 'c1')).elsewhere).toBe(false);
    // An import drops what's loaded (Claude's review of #151): loaded again, it's the same.
    await t.inner.importChanged();
    const again = await t.inner.load('th1', 'c1');
    expect(again).not.toBe(resumed);
    expect(again.elsewhere).toBe(true);
    // An image with a message: what's in it came from elsewhere.
    const u = setup();
    u.store.dispatch({ t: 'settings.set', settings: { assistant: { provider: 'claude' } } } as never);
    const s = await u.inner.stateFor('c1');
    expect(s.elsewhere).toBe(false);
    // Stopped as the message is added: no provider is started here.
    (u.service as unknown as { addMessage: () => Promise<never> }).addMessage = async () => {
      throw new Error('stop here');
    };
    await u.inner.send('w1', s, 'What does this say?', [], [{ id: 'i1', mime: 'image/png', width: 10, height: 10 }]).catch(() => undefined);
    expect(s.elsewhere).toBe(true);
  });

  it('where navigate or back goes is told to the tab’s lease, so a page there sending the tab on asks (Claude’s review of #151: a gate only the E2E caught)', async () => {
    const t = setup();
    const s = await t.turn();
    t.inner.actingHost(s).lease.going({ id: t.mine }, 'https://game.example/out');
    expect(leases.going).toEqual([[t.page(t.mine), 'https://game.example/out']]);
    leases.going.length = 0;
  });

  it('Allow for this chat is the chat’s, per tab: your using the tab, the chat ending, or Settings’ Remove ends it (the reviews of #147)', async () => {
    for (const end of ['used', 'new', 'remove'] as const) {
      const t = setup();
      t.store.dispatch({ t: 'settings.set', settings: { assistant: { actSites: ['game.example'] } } });
      const s = await t.inner.stateFor('c1');
      s.sendGrants.set(t.mine, new Set(['https://game.example']));
      s.sendGrants.set(t.other, new Set(['https://shop.example']));
      // Taken from it mid-action (its lease on there): Allow for this chat ends there.
      if (end === 'used') {
        leases.owners.set(t.page(t.mine), (s as unknown as { control: { id: string } }).control.id);
        t.service.userUsedTab(t.mine);
      }
      else if (end === 'new') await t.service.act('w1', { do: 'new' } as never);
      else t.store.dispatch({ t: 'settings.set', settings: { assistant: { actSites: [] } } });
      expect(s.sendGrants.get(t.mine)?.size ?? 0, end).toBe(0);
      expect(s.sendGrants.get(t.other)?.size ?? 0, end).toBe(end === 'used' ? 1 : 0);
    }
  });

  it('a queued message acts where it was sent: its tab dequeued with it, and one sent with no tab on screen stays with none (Claude’s S7 on #147)', async () => {
    const t = setup();
    const s = (await t.inner.stateFor('c1')) as unknown as { streaming: unknown; windowId: string; queue: string[]; queuedWith: unknown[][]; queuedTab: unknown[] };
    const inner = t.service as unknown as { send: (...args: unknown[]) => Promise<void>; finishTurn(state: unknown, outcome: { status: 'done' }): Promise<void> };
    const sent: unknown[] = [];
    inner.send = async (...args) => void sent.push(args[5]);
    s.windowId = 'w1';
    for (const tab of [{ nodeId: t.mine, windowId: 'w1' }, null]) {
      s.streaming = { id: 'reply', body: { role: 'assistant', text: '' } };
      s.queue = ['and raise'];
      s.queuedWith = [[]];
      s.queuedTab = [tab];
      await inner.finishTurn(s, { status: 'done' });
    }
    expect(sent).toEqual([{ nodeId: t.mine, windowId: 'w1' }, null]);
  });

  it('one chat ending never ends another chat’s lease, its guard or its bar (Claude’s B1, round 2)', async () => {
    const t = setup();
    const s = await t.turn();
    s.leased.add(t.mine);
    leases.owners.set(t.page(t.mine), 'another chat');
    t.inner.barFor(t.mine, 'clicking “Raise”');
    await t.service.act('w1', { do: 'stop' } as never);
    expect(leases.ended).toEqual([]);
    expect(guards.dropped).toEqual([]);
    expect(t.store.state.live[t.mine]?.agent?.name).toBe('The assistant');
    expect(s.leased.size).toBe(0);
  });

  it('a click in a tab no lease of the assistant’s is on leaves its typing guard (an outside agent’s, G4) and Allow for this chat (Neon’s B3, Claude’s S3, round 2)', async () => {
    const t = setup();
    const s = await t.inner.stateFor('c1');
    s.sendGrants.set(t.mine, new Set(['https://game.example']));
    t.service.userUsedTab(t.mine);
    t.service.userMovedPage(t.page(t.mine) as never);
    expect(guards.dropped).toEqual([]);
    expect(s.sendGrants.get(t.mine)?.size).toBe(1);
    // Its own lease on: dropped, and the grant ends.
    leases.owners.set(t.page(t.mine), (s as unknown as { control: { id: string } }).control.id);
    t.service.userMovedPage(t.page(t.mine) as never);
    expect(guards.dropped).toEqual([t.page(t.mine)]);
    expect(s.sendGrants.get(t.mine)?.size).toBe(0);
  });

  it('acting ended (your Stop, your click) while the lease was being had: let go of at once, never tracked (Neon’s B2, round 2)', async () => {
    const t = setup();
    const s = await t.turn();
    const host = (t.service as unknown as { actingHost(s: unknown): { lease: { begin(node: unknown): Promise<string | null> } } }).actingHost(s);
    let go: (v: string) => void = () => undefined;
    leases.begin = () => new Promise((done) => (go = done));
    // Its bar is up before the lease is had (tools.ts: doing, then the lease): it has acted in this message.
    (t.service as unknown as { acted: WeakSet<object> }).acted.add(s);
    const begun = host.lease.begin({ id: t.mine });
    t.service.userUsedTab(t.mine);
    go('on');
    expect(await begun).toBe(USER_TAB_REFUSALS.tookOver);
    expect(leases.owners.has(t.page(t.mine))).toBe(false);
    expect(s.leased.has(t.mine)).toBe(false);
  });

  it('every way out of a chat latches: opening another, continuing, the panel closed, the assistant hidden (E6; Neon’s B4, round 2)', async () => {
    for (const end of ['open', 'continue', 'toggle', 'hidden', 'search hit'] as const) {
      const t = setup();
      const s = (await t.turn()) as Awaited<ReturnType<typeof t.turn>> & { queuedTab: unknown[] };
      // A message queued behind the reply, with its tab: it never acts once you've left (Neon's B2, round 3).
      s.queuedTab = [{ nodeId: t.mine, windowId: 'w1' }];
      if (end === 'open') await t.service.act('w1', { do: 'open', threadId: 'nope' } as never).catch(() => undefined);
      else if (end === 'continue') await t.service.act('w1', { do: 'continue' } as never);
      else if (end === 'toggle') await t.service.act('w1', { do: 'toggle', open: false } as never);
      else if (end === 'hidden') t.store.dispatch({ t: 'settings.set', settings: { assistant: { enabled: false } } });
      else await t.service.openHit('w1', 'c1', 'another-thread').catch(() => undefined);
      expect(s.actEnded, end).toBe(USER_TAB_REFUSALS.left);
      expect(s.queuedTab, end).toEqual([null]);
    }
  });

  it('Peek over the tab, or the window minimized, ends acting at once (Neon’s S1, round 2); a split doesn’t latch (mayAct refuses it)', async () => {
    const t = setup();
    const s = await t.turn();
    let peek = false;
    (t.browser as unknown as { peeks: { isOpen: () => boolean } }).peeks.isOpen = () => peek;
    peek = true;
    t.service.screenChanged();
    expect(s.actEnded).toBe(USER_TAB_REFUSALS.switched('Peek is open over it'));
    const u = setup();
    const v = await u.turn();
    u.store.dispatch({ t: 'split.add', windowId: 'w1', withId: u.mine, nodeId: u.other });
    expect(splitOf(u.store.state, u.mine)).not.toBeNull();
    u.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: u.mine });
    u.service.screenChanged();
    expect(v.actEnded).toBeNull();
  });

  it('a closed tab’s bar leaves the list, so the bars aren’t kept in step for nothing (Claude’s S2, round 2)', async () => {
    const t = setup();
    t.inner.barFor(t.mine, 'clicking “Raise”');
    expect(t.browser.assistantBars).toBe(true);
    t.store.dispatch({ t: 'tab.close', nodeId: t.mine } as never);
    t.inner.barFor(t.mine, null);
    expect(t.browser.assistantBars).toBe(false);
  });

  it('a message queued while acting is off has no tab; acted is cleared for each message (Neon’s S4 and Claude’s nit, round 2)', async () => {
    const t = setup(false);
    const s = (await t.inner.stateFor('c1')) as unknown as { streaming: unknown; queuedTab: unknown[] };
    s.streaming = { id: 'reply' };
    await t.inner.send('w1', s, 'and raise');
    expect(s.queuedTab).toEqual([null]);
  });

  it('Retry acts in the tab its message was sent from, never the one on screen now (Claude’s S8 on #147)', async () => {
    const t = setup();
    const s = (await t.inner.stateFor('c1')) as unknown as { messages: unknown[]; sentTabs: Map<string, unknown> };
    s.messages.push({ id: 'm1', threadId: 't', createdAt: 0, body: { role: 'user', text: 'raise', attachments: [] } });
    s.sentTabs.set('m1', { nodeId: t.mine, windowId: 'w1' });
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.other });
    const sent: unknown[] = [];
    (t.service as unknown as { send: (...args: unknown[]) => Promise<void> }).send = async (...args) => void sent.push(args[5]);
    await t.service.act('w1', { do: 'retry' } as never);
    expect(sent).toEqual([{ nodeId: t.mine, windowId: 'w1' }]);
    // Make with Codex: the same (Claude's round 3).
    const inner = t.service as unknown as { codexMakesImages(): boolean; setModel(...args: unknown[]): Promise<void> };
    inner.codexMakesImages = () => true;
    inner.setModel = async () => undefined;
    await t.service.act('w1', { do: 'makeWithCodex' } as never);
    expect(sent).toEqual([{ nodeId: t.mine, windowId: 'w1' }, { nodeId: t.mine, windowId: 'w1' }]);
  });

  it('a read-only turn (its card answered), then an acting message in the same chat and tab with no switch: it may act there (the owner’s preview, 2026-11-24)', async () => {
    const t = setup();
    t.store.dispatch({ t: 'settings.set', settings: { assistant: { provider: 'claude' } } });
    // Sent from the panel, open, showing this chat.
    await t.service.act('w1', { do: 'toggle', open: true } as never);
    const s = (await t.inner.stateFor('c1')) as unknown as { actTab: unknown; actEnded: string | null; streaming: unknown; messages: unknown[] };
    const inner = t.service as unknown as {
      sessionFor(state: unknown): Promise<unknown>;
      finishTurn(state: unknown, outcome: { status: 'done' }): Promise<void>;
      scopeOf(state: unknown): { act?: { mayAct(node: unknown): string | null } };
    };
    inner.sessionFor = async () => ({ send: () => undefined, alive: true, busy: false, provider: 'claude' });
    const node = () => nodeOf(t.store.state, t.mine);
    // The read-only turn: the fill card up and answered, the page writing to itself, its title and icon changing.
    await t.inner.send('w1', s, 'fill this form for me');
    t.store.dispatch({ t: 'tab.updated', nodeId: t.mine, title: 'Sign up (filled)', favicon: null });
    t.store.dispatch({ t: 'tab.live', nodeId: t.mine, live: { loading: false } } as never);
    await inner.finishTurn(s, { status: 'done' });
    // Its tab, never touched since: the next message acts there.
    await t.inner.send('w1', s, 'click reset');
    t.store.dispatch({ t: 'tab.updated', nodeId: t.mine, title: 'Sign up' });
    t.service.screenChanged();
    expect(s.actEnded).toBeNull();
    expect(inner.scopeOf(s).act!.mayAct(node())).toBeNull();
  });

  it('the chat says what of yours stopped it: a key, a click, Back, a reload (the owner’s test of 9d1ad40: the next preview tells which)', async () => {
    const t = setup();
    const s = (await t.inner.stateFor('c1')) as unknown as { actEnded: string | null; streaming: unknown; actTab: unknown; thread: unknown; messages: { body: { role: string; summary?: string } }[] };
    s.thread = { id: 'th1', chordId: 'c1', title: 't', provider: 'claude', model: null, scope: 'ask', createdAt: 0, updatedAt: 0, lastUsedAt: 0, providerSessionId: null };
    s.streaming = { id: 'reply' };
    s.actTab = { nodeId: t.mine, windowId: 'w1' };
    (t.service as unknown as { acted: WeakSet<object> }).acted.add(s);
    t.service.userUsedTab(t.mine, 'a key: KeyA');
    await vi.waitFor(() => expect(s.messages.map((m) => m.body.summary)).toContain('Stopped: you used the tab (a key: KeyA)'));
  });

  it('your key or click in the tab during a reply ends its acting there; the chat says Stopped now if it was acting there, else at the first step it refuses (the owner’s answer 5; Claude’s S1, round 3)', async () => {
    const stopped = (s: { messages: { body: { role: string; summary?: string } }[] }) => s.messages.filter((m) => m.body.role === 'tool' && /Stopped: you used the tab/.test(m.body.summary ?? '')).length;
    for (const acting of [true, false]) {
      const t = setup();
      const s = (await t.inner.stateFor('c1')) as unknown as { actEnded: string | null; streaming: unknown; actTab: unknown; thread: unknown; messages: { body: { role: string; summary?: string } }[] };
      s.thread = { id: 'th1', chordId: 'c1', title: 't', provider: 'claude', model: null, scope: 'ask', createdAt: 0, updatedAt: 0, lastUsedAt: 0, providerSessionId: null };
      s.streaming = { id: 'reply' };
      s.actTab = { nodeId: t.mine, windowId: 'w1' };
      if (acting) (t.service as unknown as { acted: WeakSet<object> }).acted.add(s);
      t.service.userUsedTab(t.mine);
      expect(s.actEnded).toBe(USER_TAB_REFUSALS.tookOver);
      await new Promise((r) => setTimeout(r, 0));
      expect(stopped(s), `acting ${acting}`).toBe(acting ? 1 : 0);
      // Its next step is refused for it: said then, once.
      const scope = (t.service as unknown as { scopeOf(state: unknown): { act?: { mayAct(node: unknown): string | null } } }).scopeOf(s);
      expect(scope.act!.mayAct(nodeOf(t.store.state, t.mine))).toBe(USER_TAB_REFUSALS.tookOver);
      expect(scope.act!.mayAct(nodeOf(t.store.state, t.mine))).toBe(USER_TAB_REFUSALS.tookOver);
      await new Promise((r) => setTimeout(r, 0));
      expect(stopped(s), `acting ${acting}, refused`).toBe(1);
    }
  });

  it('you switch away and back between turns, then send: the new message acts in the tab on screen (the owner’s preview, 2026-11-24); a switch during a turn still ends that turn’s acting', async () => {
    const t = setup();
    t.store.dispatch({ t: 'settings.set', settings: { assistant: { provider: 'claude' } } });
    // Sent from the panel, open, showing this chat.
    await t.service.act('w1', { do: 'toggle', open: true } as never);
    const s = (await t.inner.stateFor('c1')) as unknown as { actTab: unknown; actEnded: string | null; streaming: unknown };
    const inner = t.service as unknown as {
      sessionFor(state: unknown): Promise<unknown>;
      finishTurn(state: unknown, outcome: { status: 'done' }): Promise<void>;
      scopeOf(state: unknown): { act?: { mayAct(node: unknown): string | null } };
    };
    inner.sessionFor = async () => ({ send: () => undefined, alive: true, busy: false, provider: 'claude' });
    const node = () => nodeOf(t.store.state, t.mine);
    const away = () => t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.other });
    const back = () => t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.mine });
    await t.inner.send('w1', s, 'fill this form for me');
    // The turn reads the page (its scope made, as a tool call makes it), then ends.
    expect(inner.scopeOf(s).act!.mayAct(node())).toBeNull();
    await inner.finishTurn(s, { status: 'done' });
    away();
    expect(inner.scopeOf(s).act!.mayAct(node())).toBe(USER_TAB_REFUSALS.noMessage);
    back();
    await t.inner.send('w1', s, 'click reset');
    expect(inner.scopeOf(s).act!.mayAct(node())).toBeNull();
    // During the turn: switching away ends it for this message, as before.
    away();
    back();
    expect(inner.scopeOf(s).act!.mayAct(node())).toBe(USER_TAB_REFUSALS.switched('another tab is on screen in its window'));
  });

  it('a message sent while the panel is closed, or the assistant hidden, gets no tab to act in (Neon’s B2, round 3)', async () => {
    const t = setup();
    t.store.dispatch({ t: 'settings.set', settings: { assistant: { provider: 'claude' } } });
    const s = (await t.inner.stateFor('c1')) as unknown as { actTab: unknown; streaming: unknown; queuedTab: unknown[] };
    (t.service as unknown as { sessionFor(state: unknown): Promise<unknown> }).sessionFor = async () => ({ send: () => undefined, alive: true, busy: false, provider: 'claude' });
    await t.service.act('w1', { do: 'toggle', open: false } as never);
    await t.inner.send('w1', s, 'click reset');
    expect(s.actTab).toBeNull();
    await t.service.act('w1', { do: 'toggle', open: true } as never);
    t.store.dispatch({ t: 'settings.set', settings: { assistant: { enabled: false } } });
    // Its turn over (else the next one queues and never recomputes its tab): sent with the assistant hidden, no tab.
    s.streaming = null;
    await t.inner.send('w1', s, 'click reset');
    expect(s.actTab).toBeNull();
    // Queued behind a reply with the assistant hidden: no tab either.
    await t.inner.send('w1', s, 'and again');
    expect(s.queuedTab).toEqual([null]);
  });

  it('a model switch, closing the chat, Clear all and quit latch acting off and stop its tool calls (Neon’s S2, round 3)', async () => {
    for (const end of ['model', 'clearAll', 'quit'] as const) {
      const t = setup();
      const s = (await t.turn()) as Awaited<ReturnType<typeof t.turn>> & { control: { isStopped: boolean } };
      if (end === 'model') await t.service.act('w1', { do: 'model', provider: 'claude', model: 'sonnet' } as never).catch(() => undefined);
      else if (end === 'clearAll') await t.service.clearAll().catch(() => undefined);
      else await t.service.quit().catch(() => undefined);
      expect(s.actEnded, end).toBe(USER_TAB_REFUSALS.left);
      expect(s.control.isStopped, end).toBe(true);
    }
  });

  it('the bar over the tab stays on while it works: between steps it says it’s working, never off; off at the turn’s end, or after a long idle (the owner, 2026-11-24)', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const s = (await t.turn()) as Awaited<ReturnType<typeof t.turn>> & { streaming: { body?: unknown } | null };
      const host = (t.service as unknown as { actingHost(s: unknown): { doing(nodeId: string, doing: unknown): void } }).actingHost(s);
      const bar = () => t.store.state.live[t.mine]?.agent?.doing ?? null;
      host.doing(t.mine, { tool: 'click', name: 'Raise', role: 'button' });
      expect(bar()).toContain('clicking');
      host.doing(t.mine, null);
      expect(bar()).toBe('is working in this tab');
      host.doing(t.mine, { tool: 'click', name: 'Call', role: 'button' });
      expect(bar()).toContain('Call');
      // A long idle between steps: off.
      host.doing(t.mine, null);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bar()).toBeNull();
      // The turn's end: off.
      host.doing(t.mine, { tool: 'click', name: 'Fold', role: 'button' });
      host.doing(t.mine, null);
      s.streaming = { id: 'reply', body: { role: 'assistant', text: '', citations: [], status: 'streaming' } } as never;
      await (t.service as unknown as { finishTurn(state: unknown, outcome: { status: 'done' }): Promise<void> }).finishTurn(s, { status: 'done' });
      expect(bar()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the bar never comes back once acting has ended (Stop, your hands, a switch, the panel closed): its step ending clears it (Neon’s S3 on #150)', async () => {
    vi.useFakeTimers();
    try {
      for (const end of ['stop', 'hands', 'switch', 'panel'] as const) {
        const t = setup();
        const s = await t.turn();
        const host = (t.service as unknown as { actingHost(s: unknown): { doing(nodeId: string, doing: unknown): void } }).actingHost(s);
        const bar = () => t.store.state.live[t.mine]?.agent?.doing ?? null;
        host.doing(t.mine, { tool: 'click', name: 'Raise', role: 'button' });
        if (end === 'stop') await t.service.act('w1', { do: 'stop' } as never);
        else if (end === 'hands') t.service.userUsedTab(t.mine);
        else if (end === 'switch') t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.other });
        else await t.service.act('w1', { do: 'toggle', open: false } as never);
        // The step under way ends after: no "working" bar again.
        host.doing(t.mine, null);
        expect(bar(), end).toBeNull();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bar(), end).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('what the lease caught there goes to the next result in that tab, once (Claude’s S1, round 2 of #150)', async () => {
    const t = setup();
    const s = await t.turn();
    const host = (t.service as unknown as { actingHost(s: unknown): { lease: { begin(node: unknown): Promise<string | null> }; caught(node: unknown): string[] } }).actingHost(s);
    await host.lease.begin({ id: t.mine });
    leases.deps!.note('dialog', 'confirm: “Delete?”');
    leases.deps!.note('file', 'a file picker');
    expect(host.caught({ id: t.mine })).toEqual(['The page showed a dialog (confirm: “Delete?”); it was answered Cancel', 'The page tried to open a file picker; it wasn’t shown']);
    expect(host.caught({ id: t.mine })).toEqual([]);
  });
});
