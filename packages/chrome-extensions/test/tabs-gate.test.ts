// Chord (#326): chrome.tabs.update({ url }), reload, goBack and goForward go through the app's own hooks when it has
// them (Chord's: the tab's session gate, which waits for its proxy and rules and drops a load already waiting), never
// straight to the page. Without the hooks, as upstream.
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, ipcMain: {}, BaseWindow: { getAllWindows: () => [] }, BrowserWindow: { getAllWindows: () => [] }, nativeImage: {} }))

const { TabsAPI } = await import('../src/browser/api/tabs')

/** A tab's page, and the library's context around it: its router's handlers, and its store with the app's hooks. */
function setup(impl: Record<string, unknown>) {
  const tab = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    loadURL: vi.fn(async () => undefined),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    setAudioMuted: vi.fn(),
    getURL: () => 'https://a.test/',
    getTitle: () => '',
    isLoading: () => false,
    isAudioMuted: () => false,
    isCurrentlyAudible: () => false,
    navigationHistory: { goBack: vi.fn(), goForward: vi.fn() },
  })
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const store = Object.assign(new EventEmitter(), {
    impl,
    getTabById: (id: number) => (id === 7 ? tab : undefined),
    getActiveTabOfCurrentWindow: () => tab,
    tabToWindow: new Map(),
    tabDetailsCache: new Map(),
  })
  const ctx = { router: { apiHandler: () => (name: string, fn: (...args: unknown[]) => unknown) => void (handlers[name] = fn), broadcastEvent: vi.fn() }, store }
  new TabsAPI(ctx as never)
  const event = { extension: { id: 'ext', url: 'chrome-extension://ext/' } }
  return { tab, handlers, event }
}

describe('chrome.tabs moving a tab, through the app’s hooks (#326)', () => {
  it('update({ url }): the app navigates it; the page isn’t loaded directly', async () => {
    const navigateTab = vi.fn()
    const t = setup({ navigateTab })
    await t.handlers['tabs.update']!(t.event, 7, { url: 'https://b.test/' }).catch(() => undefined)
    expect(navigateTab).toHaveBeenCalledWith(t.tab, 'https://b.test/')
    expect(t.tab.loadURL).not.toHaveBeenCalled()
  })

  it.each([
    [{}, false],
    [{ bypassCache: true }, true],
  ])('reload(%j): the app reloads it', (props, bypassCache) => {
    const reloadTab = vi.fn()
    const t = setup({ reloadTab })
    t.handlers['tabs.reload']!(t.event, 7, props)
    expect(reloadTab).toHaveBeenCalledWith(t.tab, bypassCache)
    expect(t.tab.reload).not.toHaveBeenCalled()
    expect(t.tab.reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it.each(['back', 'forward'] as const)('go %s: the app moves it', (way) => {
    const goTab = vi.fn()
    const t = setup({ goTab })
    t.handlers[way === 'back' ? 'tabs.goBack' : 'tabs.goForward']!(t.event, 7)
    expect(goTab).toHaveBeenCalledWith(t.tab, way)
    expect(t.tab.navigationHistory.goBack).not.toHaveBeenCalled()
    expect(t.tab.navigationHistory.goForward).not.toHaveBeenCalled()
  })

  it('without the hooks: the page’s own, as upstream', () => {
    const t = setup({})
    t.handlers['tabs.reload']!(t.event, 7, {})
    t.handlers['tabs.goBack']!(t.event, 7)
    expect(t.tab.reload).toHaveBeenCalledOnce()
    expect(t.tab.navigationHistory.goBack).toHaveBeenCalledOnce()
  })
})
