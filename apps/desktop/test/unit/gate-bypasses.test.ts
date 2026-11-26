/**
 * #326 (Opus and Neon, reviewing #323): every load and history move on a tab goes through the session gate (tabs.ts'
 * whenProxied), as tabs.go and tabs.reload do. Here, the agent's navigate and back tools (control/page.ts): main sets
 * their gate (setLoadGate, from Browser), so they wait for the session, and a load already waiting is dropped for them.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// Electron as far as these modules touch it at load: anything answers itself.
vi.mock('electron', () => {
  const any: object = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any, construct: () => any });
  return new Proxy({} as Record<string | symbol, unknown>, { get: (_t, k) => (k === 'then' ? undefined : any), has: () => true });
});

const { controlPage, setLoadGate } = await import('../../src/main/control/page');

/** A tab's page as the agent's tools see it: its loads, its history, its events. */
function agentPage() {
  const entries = [{ url: 'https://one.test/' }, { url: 'https://two.test/' }];
  return Object.assign(new EventEmitter(), {
    entries,
    isDestroyed: () => false,
    loadURL: vi.fn(async () => undefined),
    getURL: () => 'https://two.test/',
    isFocused: () => false,
    focus: vi.fn(),
    navigationHistory: { getActiveIndex: () => 1, getEntryAtIndex: (i: number) => entries[i], goToIndex: vi.fn() },
  });
}

/** A gate that holds every load until the test lets it go. */
function heldGate() {
  const waiting: Array<() => void> = [];
  const gate = vi.fn((_contents: unknown, load: () => void) => void waiting.push(load));
  return { gate, release: () => waiting.splice(0).forEach((load) => load()) };
}

const turns = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

describe('the agent’s navigate and back go through the session gate (#326)', () => {
  it('navigate: no load until the session is ready', async () => {
    const page = agentPage();
    const { gate, release } = heldGate();
    setLoadGate(gate);
    void controlPage(page as never).navigate('https://three.test/');
    await turns();
    expect(gate).toHaveBeenCalledWith(page, expect.any(Function));
    expect(page.loadURL).not.toHaveBeenCalled();
    release();
    expect(page.loadURL).toHaveBeenCalledWith('https://three.test/');
    page.emit('did-stop-loading');
  });

  it('back: no history move until the session is ready, and none if the entry changed meanwhile', async () => {
    const page = agentPage();
    const { gate, release } = heldGate();
    setLoadGate(gate);
    const control = controlPage(page as never);
    void control.back({ index: 0, url: 'https://one.test/' });
    await turns();
    expect(page.navigationHistory.goToIndex).not.toHaveBeenCalled();
    release();
    expect(page.navigationHistory.goToIndex).toHaveBeenCalledWith(0);
    page.emit('did-stop-loading');

    // Asked again, but the page's history changed while it waited: nothing.
    page.navigationHistory.goToIndex.mockClear();
    void control.back({ index: 0, url: 'https://one.test/' });
    await turns();
    page.entries[0] = { url: 'https://elsewhere.test/' };
    release();
    expect(page.navigationHistory.goToIndex).not.toHaveBeenCalled();
    page.emit('did-stop-loading');
  });
});
