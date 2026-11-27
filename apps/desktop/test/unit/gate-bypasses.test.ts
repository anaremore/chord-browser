/**
 * #326 (Opus and Neon, reviewing #323): every load and history move on a tab goes through the session gate (tabs.ts'
 * whenProxied), as tabs.go and tabs.reload do. Here, the agent's navigate and back tools (control/page.ts): their gate
 * is controlPage's argument (the tab manager's queueLoad), so they wait for the session, and a load already waiting is
 * dropped for them.
 *
 * Round 1 of #333 (Neon's B2, B3, SF1): the tool waits for ITS load (a stop of the page's load before it doesn't answer
 * it), a load the agent no longer wants (Stop, paused, taken over) or one overtaken never starts, and a Back whose entry
 * moved answers null at once.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// Electron as far as these modules touch it at load: anything answers itself.
vi.mock('electron', () => {
  const any: object = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any, construct: () => any });
  return new Proxy({} as Record<string | symbol, unknown>, { get: (_t, k) => (k === 'then' ? undefined : any), has: () => true });
});

const { controlPage } = await import('../../src/main/control/page');

/** A tab's page as the agent's tools see it: its loads, its history, its events. */
function agentPage() {
  const history = { index: 1, entries: [{ url: 'https://one.test/' }, { url: 'https://two.test/' }] };
  return Object.assign(new EventEmitter(), {
    history,
    isDestroyed: () => false,
    loadURL: vi.fn(async () => undefined),
    getURL: () => 'https://two.test/',
    isFocused: () => false,
    focus: vi.fn(),
    navigationHistory: { getActiveIndex: () => history.index, getEntryAtIndex: (i: number) => history.entries[i], goToIndex: vi.fn() },
  });
}

/** A gate that holds every load until the test lets it go, or overtakes it. */
function heldGate() {
  const waiting: Array<{ load: () => unknown; overtaken?: () => void }> = [];
  const gate = vi.fn((_contents: unknown, load: () => unknown, overtaken?: () => void) => void waiting.push({ load, overtaken }));
  return {
    gate,
    loaded: [] as unknown[],
    release() {
      for (const w of waiting.splice(0)) this.loaded.push(w.load());
    },
    overtake: () => waiting.splice(0).forEach((w) => w.overtaken?.()),
  };
}

const turns = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** Whether a promise has settled, and how, after a few turns. */
async function state<T>(p: Promise<T>): Promise<{ settled: false } | { settled: true; value: T }> {
  let out: { settled: false } | { settled: true; value: T } = { settled: false };
  void p.then((value) => (out = { settled: true, value }));
  await turns();
  return out;
}

describe('the agent’s navigate and back go through the session gate (#326)', () => {
  it('navigate: no load until the session is ready; the page’s earlier load stopping doesn’t answer it (Neon’s B2)', async () => {
    const page = agentPage();
    const held = heldGate();
    const going = controlPage(page as never, { queueLoad: held.gate }).navigate('https://three.test/');
    await turns();
    expect(held.gate).toHaveBeenCalledWith(page, expect.any(Function), expect.any(Function));
    expect(page.loadURL).not.toHaveBeenCalled();
    // The load before it, ending: not this one.
    page.emit('did-stop-loading');
    expect((await state(going)).settled).toBe(false);
    held.release();
    expect(page.loadURL).toHaveBeenCalledWith('https://three.test/');
    expect((await state(going)).settled).toBe(false);
    page.emit('did-stop-loading');
    expect(await state(going)).toEqual({ settled: true, value: { loading: false } });
  });

  it('navigate the agent no longer wants by the time the session is ready (Stop, paused, taken over): never starts; null, and the tab not left loading', async () => {
    const page = agentPage();
    const held = heldGate();
    let stopped = false;
    const going = controlPage(page as never, { queueLoad: held.gate }).navigate('https://three.test/', { abandoned: () => stopped });
    await turns();
    stopped = true;
    held.release();
    expect(page.loadURL).not.toHaveBeenCalled();
    expect(await state(going)).toEqual({ settled: true, value: null });
    // It tells the gate it didn't load, so the gate takes the tab's loading off.
    expect(held.loaded).toEqual([false]);
  });

  it('navigate overtaken while it waits (your load, a newer one): null at once, and nothing fires after', async () => {
    const page = agentPage();
    const held = heldGate();
    const going = controlPage(page as never, { queueLoad: held.gate }).navigate('https://three.test/');
    await turns();
    held.overtake();
    expect(await state(going)).toEqual({ settled: true, value: null });
    held.release();
    expect(page.loadURL).not.toHaveBeenCalled();
  });

  it.each([
    ['before it’s asked', true],
    ['while it waits (a gate that never answers)', false],
  ])('navigate on a page closed %s (Neon’s NB1, round 2 of #333): null, never left hanging', async (_, before) => {
    const page = Object.assign(agentPage(), { destroyed: false as boolean });
    (page as { isDestroyed: () => boolean }).isDestroyed = () => page.destroyed;
    const gate = vi.fn();
    if (before) page.destroyed = true;
    const going = controlPage(page as never, { queueLoad: gate }).navigate('https://three.test/');
    await turns();
    if (!before) {
      page.destroyed = true;
      page.emit('destroyed');
    }
    expect(await state(going)).toEqual({ settled: true, value: null });
    expect(page.loadURL).not.toHaveBeenCalled();
  });

  it('navigate the step refused while it waits (its signal: Fable’s FB1, FN3 on #333): null at once, the tab’s gate drops it, nothing fires after', async () => {
    const page = agentPage();
    const held = heldGate();
    const dropped = vi.fn();
    const gate = { queueLoad: (c: unknown, load: () => unknown, overtaken?: () => void) => (held.gate(c, load, overtaken), dropped) };
    const refusing = new AbortController();
    const started = vi.fn();
    const going = controlPage(page as never, gate).navigate('https://three.test/', { signal: refusing.signal, onStart: started });
    await turns();
    refusing.abort();
    expect(await state(going)).toEqual({ settled: true, value: null });
    expect(dropped).toHaveBeenCalledOnce();
    held.release();
    expect(page.loadURL).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it('navigate’s start is told once its load starts (Fable’s FSF2)', async () => {
    const page = agentPage();
    const held = heldGate();
    const started = vi.fn();
    void controlPage(page as never, { queueLoad: held.gate }).navigate('https://three.test/', { onStart: started });
    await turns();
    expect(started).not.toHaveBeenCalled();
    held.release();
    expect(started).toHaveBeenCalledOnce();
    page.emit('did-stop-loading');
  });

  it('back: no history move until the session is ready', async () => {
    const page = agentPage();
    const held = heldGate();
    const going = controlPage(page as never, { queueLoad: held.gate }).back({ index: 0, url: 'https://one.test/' });
    await turns();
    expect(page.navigationHistory.goToIndex).not.toHaveBeenCalled();
    held.release();
    expect(page.navigationHistory.goToIndex).toHaveBeenCalledWith(0);
    page.emit('did-stop-loading');
    expect(await state(going)).toEqual({ settled: true, value: { loading: false } });
  });

  it.each([
    ['its entry is another page now', (p: ReturnType<typeof agentPage>) => void (p.history.entries[0] = { url: 'https://elsewhere.test/' })],
    ['the page moved in its history (Neon’s SF1)', (p: ReturnType<typeof agentPage>) => void (p.history.index = 0)],
  ])('back once the session is ready, but %s: null at once (Neon’s B3), no move, the tab not left loading', async (_, change) => {
    const page = agentPage();
    const held = heldGate();
    const going = controlPage(page as never, { queueLoad: held.gate }).back({ index: 0, url: 'https://one.test/' });
    await turns();
    change(page);
    held.release();
    expect(await state(going)).toEqual({ settled: true, value: null });
    expect(page.navigationHistory.goToIndex).not.toHaveBeenCalled();
    expect(held.loaded).toEqual([false]);
  });

  it('back from a page that isn’t one past its entry (Neon’s SF1): null before it even waits', async () => {
    const page = agentPage();
    page.history.index = 0;
    const held = heldGate();
    expect(await controlPage(page as never, { queueLoad: held.gate }).back({ index: 0, url: 'https://one.test/' })).toBeNull();
    expect(held.gate).not.toHaveBeenCalled();
  });
});
