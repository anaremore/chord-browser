/**
 * #287 (round 1 of #292, Opus's SF1 and SF3): the page menu's Back, Forward and Reload go through the tab's own (tabs.go,
 * tabs.reload: a load still waiting for its session is dropped first; a page stopped before it ever loaded loads its
 * address), never straight to the page's history, where the page is a tab's.
 */
import { EventEmitter } from 'node:events';
import type { ContextMenuParams, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ clipboard: {}, Menu: { buildFromTemplate: vi.fn() } }));
vi.mock('../../src/main/platform', () => ({ platform: 'linux' }));

const { attachContextMenu, observeContextMenusForTests } = await import('../../src/main/context-menu');

function open() {
  const page = Object.assign(new EventEmitter(), {
    navigationHistory: { canGoBack: () => true, canGoForward: () => true, goBack: vi.fn(), goForward: vi.fn() },
    reload: vi.fn(),
  });
  const deps = { surface: 'web' as const, inspect: false, searchEngine: () => 'google' as const, openTab: vi.fn(), placement: () => undefined, navigates: vi.fn(), go: vi.fn(), reload: vi.fn() };
  attachContextMenu(page as unknown as WebContents, deps);
  let items: { label: string; choose(): void }[] = [];
  observeContextMenusForTests((_contents, seen) => (items = seen));
  const params = { linkURL: '', srcURL: '', pageURL: 'https://site.test/', mediaType: 'none', isEditable: false, selectionText: '', misspelledWord: '', dictionarySuggestions: [], editFlags: {}, x: 0, y: 0 } as unknown as ContextMenuParams;
  page.emit('context-menu', {}, params);
  const choose = (label: string) => items.find((i) => i.label === label)!.choose();
  return { page, deps, choose };
}

describe('the page menu’s Back, Forward and Reload (#287, round 1 of #292)', () => {
  it.each(['back', 'forward'] as const)('%s: through the tab’s own (go), never the page’s history directly', (way) => {
    const t = open();
    t.choose(way === 'back' ? 'Back' : 'Forward');
    expect(t.deps.navigates).toHaveBeenCalledWith(way);
    expect(t.deps.go).toHaveBeenCalledWith(way);
    expect(t.page.navigationHistory.goBack).not.toHaveBeenCalled();
    expect(t.page.navigationHistory.goForward).not.toHaveBeenCalled();
  });

  it('Reload: through the tab’s own (reload), never the page’s', () => {
    const t = open();
    t.choose('Reload');
    expect(t.deps.reload).toHaveBeenCalledOnce();
    expect(t.page.reload).not.toHaveBeenCalled();
  });
});
