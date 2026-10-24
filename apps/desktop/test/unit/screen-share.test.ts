import { EventEmitter } from 'node:events';
import type { Command, TabNode } from '@chord/core';
import { emptyState } from '@chord/core';
import { SYSTEM_SHARE_SOURCE } from '@chord/ipc';
import type { DesktopCapturerSource, Session, Streams, WebContents, WebFrameMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ getSources: vi.fn(), fromFrame: vi.fn() }));
vi.mock('electron', () => ({ desktopCapturer: { getSources: electron.getSources }, webContents: { fromFrame: electron.fromFrame } }));

const { ScreenShareBroker, systemPickerFor } = await import('../../src/main/screen-share');

/** A tab's page as main sees it: events, its main frame, and whether it's throttled in the background. */
class FakePage extends EventEmitter {
  destroyed = false;
  throttled = true;
  readonly mainFrame: WebFrameMain;
  constructor(origin: string) {
    super();
    this.mainFrame = { origin, isDestroyed: () => this.destroyed, executeJavaScript: vi.fn(async () => 1) } as unknown as WebFrameMain;
  }
  isDestroyed() {
    return this.destroyed;
  }
  setBackgroundThrottling(on: boolean) {
    this.throttled = on;
  }
  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

/** A screen or window as desktopCapturer lists it, pictured or not. */
const source = (id: string, name: string, pictured: boolean): DesktopCapturerSource =>
  ({
    id,
    name,
    display_id: id.startsWith('screen:') ? '7' : '',
    thumbnail: { isEmpty: () => !pictured, toJPEG: () => Buffer.from('jpeg') },
  }) as unknown as DesktopCapturerSource;

const tab = (id: string, url: string, title: string): TabNode => ({
  kind: 'tab',
  id,
  chordId: 'c1',
  section: 'today',
  parentId: null,
  rank: 'a0',
  url,
  title,
  pinnedUrl: null,
  customTitle: null,
  favicon: null,
  lastActiveAt: 0,
  createdAt: 0,
});

function setup(picker: 'mac' | 'portal' | null = null) {
  const meet = new FakePage('https://meet.test');
  const slides = new FakePage('https://slides.test');
  const pages: Record<string, FakePage> = { meet, slides };
  const state = emptyState();
  state.live['meet'] = { loading: false, canGoBack: false, canGoForward: false, audible: false, crashed: false, error: null, pip: false, sharing: false, shared: false, threat: null };
  state.live['slides'] = { ...state.live['meet'] };
  state.nodes['meet'] = tab('meet', 'https://meet.test/', 'Meeting');
  state.nodes['slides'] = tab('slides', 'https://slides.test/', 'Slides');
  const dispatched: Command[] = [];
  const changes = { popover: 0, sharing: 0 };
  const broker = new ScreenShareBroker(picker);
  broker.connect({
    state: () => state,
    dispatch: (command) => dispatched.push(command),
    nodeFor: (contents) => Object.keys(pages).find((id) => (pages[id] as unknown) === contents),
    contentsOf: (nodeId) => pages[nodeId] as unknown as WebContents | undefined,
    // Only the two tabs, the asking one first: a private window's are never among them (core's shareableTabs decides).
    shareableTabs: () => [state.nodes['meet'] as TabNode, state.nodes['slides'] as TabNode],
    onChange: () => changes.popover++,
    sharingChanged: () => changes.sharing++,
    cantStop: () => {},
  });
  let handler: ((request: { frame: WebFrameMain; audioRequested: boolean }, callback: (streams: Streams | null) => void) => void) | undefined;
  const opts: unknown[] = [];
  broker.attach({
    setDisplayMediaRequestHandler: (h: typeof handler, o?: unknown) => {
      handler = h;
      opts.push(o);
    },
  } as unknown as Session);
  electron.fromFrame.mockImplementation((frame: WebFrameMain) => Object.values(pages).find((p) => p.mainFrame === frame));
  /** The page in `meet` asks to share; resolves with what it's answered. */
  const ask = (audioRequested = true) => {
    let answered: (streams: Streams | null) => void = () => {};
    const answer = new Promise<Streams | null>((resolve) => (answered = resolve));
    handler!({ frame: meet.mainFrame, audioRequested }, answered);
    return answer;
  };
  return { broker, state, meet, slides, dispatched, changes, ask, opts };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the share picker', () => {
  beforeEach(() => electron.getSources.mockReset());
  afterEach(() => vi.useRealTimers());

  it('lists tabs at once, then screens and windows by name, then fills in their pictures', async () => {
    let picture: (sources: DesktopCapturerSource[]) => void = () => {};
    electron.getSources
      .mockResolvedValueOnce([source('screen:1:0', 'Screen 1', false), source('window:9:0', 'Notes', false)])
      .mockReturnValueOnce(new Promise((resolve) => (picture = resolve)));
    const t = setup();
    void t.ask();
    // Before anything is listed: the tabs, the asking one first.
    let prompt = t.broker.promptFor('meet')!;
    expect(prompt.sources.map((s) => [s.kind, s.name, s.self ?? false])).toEqual([
      ['tab', 'Meeting', true],
      ['tab', 'Slides', false],
    ]);
    expect(prompt.loading).toBe(true);
    await flush();
    // Named first, with no pictures asked for…
    expect(electron.getSources.mock.calls[0]![0]).toEqual({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    prompt = t.broker.promptFor('meet')!;
    expect(prompt.sources.filter((s) => s.kind !== 'tab').map((s) => [s.name, s.thumbnail])).toEqual([
      ['Screen 1', ''],
      ['Notes', ''],
    ]);
    // A tab's title that arrives while the picker is up fills in.
    t.state.nodes['slides'] = { ...(t.state.nodes['slides'] as TabNode), title: 'Quarterly slides' };
    expect(t.broker.promptFor('meet')!.sources[1]!.name).toBe('Quarterly slides');
    // …then pictured.
    picture([source('screen:1:0', 'Screen 1', true), source('window:9:0', 'Notes', true)]);
    await flush();
    prompt = t.broker.promptFor('meet')!;
    expect(prompt.loading).toBe(false);
    expect(prompt.sources.filter((s) => s.kind !== 'tab').every((s) => s.thumbnail.startsWith('data:image/jpeg;base64,'))).toBe(true);
    // Chord's picker comes first on every OS: Electron's own system picker is never asked for.
    expect(t.opts).toEqual([undefined]);
  });

  it('shares a tab as its whole page, with its sound still playing here; the tab is never throttled while shared', async () => {
    electron.getSources.mockResolvedValue([]);
    const t = setup();
    const answer = t.ask();
    const id = t.broker.promptFor('meet')!.id;
    await t.broker.respond(id, 'tab:slides', true);
    expect(await answer).toEqual({ video: t.slides.mainFrame, audio: t.slides.mainFrame, enableLocalEcho: true });
    expect(t.dispatched).toContainEqual({ t: 'tab.live', nodeId: 'meet', live: { sharing: true } });
    expect(t.dispatched).toContainEqual({ t: 'tab.live', nodeId: 'slides', live: { shared: true } });
    expect(t.slides.throttled).toBe(false);
    expect(t.broker.isShared('slides')).toBe(true);
    expect(t.broker.sharedTabs()).toEqual([{ nodeId: 'slides', by: ['meet'] }]);
    expect(t.broker.count).toBe(1);
    expect(t.changes.sharing).toBe(1);
    t.broker.forgetTab('meet');
    expect(t.slides.throttled).toBe(true);
    expect(t.dispatched).toContainEqual({ t: 'tab.live', nodeId: 'slides', live: { shared: false } });
    expect(t.broker.count).toBe(0);
  });

  it('without its sound when you say so, and refuses a tab it didn’t offer', async () => {
    electron.getSources.mockResolvedValue([]);
    const t = setup();
    let answer = t.ask();
    await t.broker.respond(t.broker.promptFor('meet')!.id, 'tab:slides', false);
    expect(await answer).toEqual({ video: t.slides.mainFrame });
    t.broker.forgetTab('meet');
    answer = t.ask();
    await t.broker.respond(t.broker.promptFor('meet')!.id, 'tab:somewhere-private', true);
    expect(await answer).toBeNull();
  });

  it('a shared tab’s page closing (or loading again with other sign-ins) ends the share', async () => {
    electron.getSources.mockResolvedValue([]);
    const t = setup();
    void t.ask();
    await t.broker.respond(t.broker.promptFor('meet')!.id, 'tab:slides', true);
    t.slides.destroy();
    expect(t.dispatched).toContainEqual({ t: 'tab.live', nodeId: 'meet', live: { sharing: false } });
    expect(t.broker.isShared('slides')).toBe(false);
    expect(t.broker.count).toBe(0);
    expect(t.changes.sharing).toBe(2);
  });

  it('Stop on the shared tab’s row stops the page sharing it', async () => {
    electron.getSources.mockResolvedValue([]);
    const t = setup();
    void t.ask();
    await t.broker.respond(t.broker.promptFor('meet')!.id, 'tab:slides', true);
    await t.broker.stop('slides');
    expect(t.broker.isSharing('meet')).toBe(false);
    expect(t.broker.isShared('slides')).toBe(false);
  });

  it('macOS 15+: lists tabs only, and hands screens and windows to the system’s picker', async () => {
    const t = setup('mac');
    const answer = t.ask();
    const prompt = t.broker.promptFor('meet')!;
    expect(prompt.systemPicker).toBe(true);
    expect(prompt.loading).toBe(false);
    expect(prompt.sources.every((s) => s.kind === 'tab')).toBe(true);
    expect(electron.getSources).not.toHaveBeenCalled();
    await t.broker.respond(prompt.id, SYSTEM_SHARE_SOURCE, true);
    const streams = await answer;
    // Electron's own stand-in for "ask macOS's picker" (lib/browser/api/session.ts).
    expect(streams?.video).toEqual({ id: expect.stringMatching(/^window:-4:-\d+$/), name: '' });
    expect(t.broker.sources()).toEqual([{ kind: 'system' }]);
    t.broker.forgetTab('meet');
  });

  it('Wayland: the portal picks the screen or window; cancelled there, Chord’s picker is still up', async () => {
    const t = setup('portal');
    const answer = t.ask();
    const id = t.broker.promptFor('meet')!.id;
    electron.getSources.mockResolvedValueOnce([]);
    await t.broker.respond(id, SYSTEM_SHARE_SOURCE, false);
    expect(t.broker.promptFor('meet')).not.toBeNull();
    electron.getSources.mockResolvedValueOnce([source('screen:2:0', 'Built-in display', false)]);
    await t.broker.respond(id, SYSTEM_SHARE_SOURCE, false);
    expect((await answer)?.video).toMatchObject({ id: 'screen:2:0' });
    expect(t.broker.sources()).toEqual([{ kind: 'screen', displayId: '7' }]);
    t.broker.forgetTab('meet');
  });

  it('“Wayland” that hands back every screen and window is X11 after all: they’re listed in Chord’s picker', async () => {
    const t = setup('portal');
    void t.ask();
    const id = t.broker.promptFor('meet')!.id;
    electron.getSources.mockResolvedValueOnce([source('screen:1:0', 'Screen 1', false), source('window:9:0', 'Notes', false)]);
    await t.broker.respond(id, SYSTEM_SHARE_SOURCE, false);
    const prompt = t.broker.promptFor('meet')!;
    expect(prompt.systemPicker).toBe(false);
    expect(prompt.sources.filter((s) => s.kind !== 'tab').map((s) => s.name)).toEqual(['Screen 1', 'Notes']);
    t.broker.forgetTab('meet');
  });

  it('a screen or window can’t be picked where the system picks them', async () => {
    const t = setup('mac');
    const answer = t.ask();
    await t.broker.respond(t.broker.promptFor('meet')!.id, 'screen:1:0', false);
    expect(await answer).toBeNull();
  });
});

describe('where screens and windows are picked', () => {
  it('macOS 15 and later, and Wayland, have the system’s own picker; elsewhere Chord lists them', () => {
    expect(systemPickerFor('darwin', '15.1.0', {})).toBe('mac');
    expect(systemPickerFor('darwin', '26.0.1', {})).toBe('mac');
    expect(systemPickerFor('darwin', '14.7.2', {})).toBeNull();
    expect(systemPickerFor('linux', '', { XDG_SESSION_TYPE: 'wayland' })).toBe('portal');
    expect(systemPickerFor('linux', '', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('portal');
    expect(systemPickerFor('linux', '', { XDG_SESSION_TYPE: 'x11' })).toBeNull();
    // Told to use X11 on a Wayland desktop, Chord lists them as on X11.
    expect(systemPickerFor('linux', '', { XDG_SESSION_TYPE: 'wayland' }, 'x11')).toBeNull();
    expect(systemPickerFor('linux', '', {}, 'wayland')).toBe('portal');
    expect(systemPickerFor('win32', '10.0.26200', {})).toBeNull();
  });
});
