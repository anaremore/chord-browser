/**
 * #336 (Neon's N2): what an agent's page reports it held (a dialog, a picker, a print) counts only while it's the tab's
 * page: a page the tab no longer shows (replaced, still alive) is never heard.
 */
import { EventEmitter } from 'node:events';
import { nodesFrom, type NodeId, type SidebarNode } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView } from './fake-view';

vi.mock('electron', async () => ({
  WebContentsView: FakeView,
  BaseWindow: class extends EventEmitter {},
  nativeTheme: { on: vi.fn(), off: vi.fn(), shouldUseDarkColors: false },
  screen: {},
  systemPreferences: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../src/main/window', async () => {
  const { FakeView: View } = await import('./fake-view');
  return { createUiView: () => new View() };
});
vi.mock('../../src/main/app-icon', () => ({ windowIcon: () => undefined }));
// An agent's page's hold (the debugger) isn't what's tested here.
vi.mock('../../src/main/agents/pickers', async (actual) => ({ ...(await actual<Record<string, unknown>>()), holdFilePickers: vi.fn(() => null) }));
const { TabManager } = await import('../../src/main/tabs');

const NODE = 'n1' as NodeId;

function setup() {
  const state = {
    nodes: nodesFrom([{ kind: 'tab', id: NODE, url: 'https://shop.test/a', title: '', section: 'today', chordId: 'c1' } as SidebarNode]),
    live: {},
    windows: {},
    chords: { c1: { id: 'c1' } },
    settings: { assistant: { neverSites: [] } },
  };
  const refused = vi.fn();
  const manager = new TabManager({
    state: () => state,
    dispatch: vi.fn(),
    sessionFor: () => ({}) as Session,
    proxyReady: () => null,
    createInternalView: () => new FakeView() as unknown as WebContentsView,
    windowFor: () => 'w1',
    onContentsCreated: vi.fn(),
    onVisit: vi.fn(),
    onTitle: vi.fn(),
    onPopupCreated: vi.fn(),
    onPeek: vi.fn(),
    agentTab: () => true,
    onAgentRefused: refused,
  } as never);
  const view = manager.ensure(NODE) as unknown as FakeView;
  const main = { origin: 'https://shop.test' };
  Object.assign(view.page, { mainFrame: main });
  const held = (kind: string) => view.page.ipc.emit('page:agentHeld', { senderFrame: main }, { kind, detail: 'window.print()' });
  return { manager, view, refused, held };
}

describe('an agent’s page’s held reports (#336, Neon’s N2)', () => {
  it('heard from the tab’s page', () => {
    const t = setup();
    t.held('print');
    expect(t.refused).toHaveBeenCalledWith(NODE, 'print', expect.stringContaining('tried to print'));
  });

  it('never from a page the tab no longer shows (replaced, still alive)', () => {
    const t = setup();
    (t.manager as unknown as { views: Map<NodeId, unknown> }).views.set(NODE, new FakeView());
    t.held('print');
    t.held('dialog');
    expect(t.refused).not.toHaveBeenCalled();
  });
});
