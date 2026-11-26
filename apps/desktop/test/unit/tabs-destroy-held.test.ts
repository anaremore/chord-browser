/**
 * #115 (SF1 of Argon's review): a tab closed fails what its hold holds BEFORE its page closes, while the debugger that
 * holds it is still attached: never a held send resumed by the close (a keepalive POST, a beacon).
 */
import { EventEmitter } from 'node:events';
import { nodesFrom, type NodeId, type SidebarNode } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView } from './fake-view';

const order: string[] = [];
/** The page destroy closes: what failHeld must be given (#322's N3). */
let closing: unknown = null;

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
vi.mock('../../src/main/control/sends', async (actual) => ({ ...(await actual<Record<string, unknown>>()), failHeld: vi.fn((page: unknown) => void order.push(page === closing ? 'failHeld' : 'failHeld: another page')) }));
const { TabManager } = await import('../../src/main/tabs');

const NODE = 'n1' as NodeId;

describe('a tab closed: its held sends failed first (#115, SF1)', () => {
  it('destroy fails what the hold holds, then closes the page', () => {
    const state = { nodes: nodesFrom([{ kind: 'tab', id: NODE, url: 'https://shop.test/', title: '', section: 'today', chordId: 'c1' } as SidebarNode]), live: {}, windows: {}, chords: { c1: { id: 'c1' } }, settings: { assistant: { neverSites: [] } } };
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
    } as never);
    const view = manager.ensure(NODE) as unknown as FakeView;
    view.page.close.mockImplementation(() => void order.push('close'));
    closing = view.page;
    order.length = 0;
    manager.destroy(NODE);
    expect(order).toEqual(['failHeld', 'close']);
  });
});
