/**
 * Sharing (ARCHITECTURE.md §9). A page's `getDisplayMedia` asks Chord, which
 * shows its own picker in the window's popover: Chord's tabs first, then
 * screens and windows, named at once and pictured a moment later, with the
 * sound that goes with them (a tab's own; the computer's on Windows). Where
 * the system picks screens and windows itself (macOS 15 and later, Wayland's
 * portal), Chord's picker lists tabs and opens the system's for the rest.
 *
 * A shared tab goes out as its page alone (Electron captures the tab's whole
 * page from its main frame), with its sound still playing here. While it's
 * shared it never sleeps, isn't throttled in the background, and stays
 * attached to a window when it isn't on screen (Browser parks it), or its
 * stream would freeze.
 *
 * Electron can't end a share from outside the page, so while one is granted
 * Chord adds a small hook to that page's script world. It keeps the shared
 * screen's tracks as the page uses them (a call, a preview, a recording), so
 * Stop can end them and Chord can tell when sharing is over. A page that
 * never uses its stream that way can't be stopped from Chord; its own Stop
 * button still works. The hook gives the page nothing it didn't have.
 */
import type { Command, NodeId, State, TabNode } from '@chord/core';
import { SYSTEM_SHARE_SOURCE, type SharePrompt, type ShareSource } from '@chord/ipc';
import { randomUUID } from 'node:crypto';
import { desktopCapturer, webContents, type DesktopCapturerSource, type Session, type Streams, type WebContents, type WebFrameMain } from 'electron';
import { pageCall } from './page-call';

export interface ScreenShareDeps {
  state(): State;
  dispatch(command: Command): void;
  /** The tab a page belongs to (popups and Chord's own UI can't share). */
  nodeFor(contents: WebContents): NodeId | undefined;
  /** A tab's page, while it has one. */
  contentsOf(nodeId: NodeId): WebContents | undefined;
  /** The tabs the page in this tab may share, the asking one first (core's `shareableTabs`). */
  shareableTabs(nodeId: NodeId): TabNode[];
  /** The picker changed: refresh every window's popover. */
  onChange(): void;
  /** A share started or ended: presenting mode, the tinted edges and where shared tabs wait follow it. */
  sharingChanged(): void;
  /** Stop couldn't reach the share (the page never used it where Chord can see): say so. */
  cantStop(nodeId: NodeId, host: string): void;
}

/** Where screens and windows are picked when Chord's picker doesn't list them (`systemPickerFor`). */
export type SystemPicker = 'mac' | 'portal';

/** What a page is sharing: one of Chord's tabs, a screen (on a display, '' when the OS doesn't say), a window, or what the system's picker chose. */
export type SharedSource =
  | { kind: 'tab'; nodeId: NodeId; contents: WebContents }
  | { kind: 'screen'; displayId: string }
  | { kind: 'window'; id: string }
  | { kind: 'system' };

interface Pending {
  id: number;
  nodeId: NodeId;
  host: string;
  frame: WebFrameMain;
  /** The tabs offered, decided when the page asked (a private window's page sees only its own). */
  tabs: NodeId[];
  /** Screens and windows, with their pictures once they've arrived. */
  sources: DesktopCapturerSource[];
  /** The picker, less its tabs, which `promptFor` lists as they are now. */
  prompt: SharePrompt;
  /** Wayland's portal is open, asking which screen or window. */
  choosing: boolean;
  answer(streams: Streams | null): void;
}

/** How often Chord checks whether a page's share is still going. */
const CHECK_MS = 2000;
const THUMBNAIL = { width: 240, height: 135 };
/** Listing screens and windows without pictures: their names, at once. */
const NO_THUMBNAIL = { width: 0, height: 0 };
/** Capturing the computer's sound works on Windows only. */
const SYSTEM_AUDIO = process.platform === 'win32';

/**
 * Where screens and windows are picked when Chord's picker can't list them
 * itself. macOS 15 and later have the system's picker: listing them through
 * `desktopCapturer` there has macOS warn, again each month, that Chord
 * bypasses it. On Wayland, listing them opens the portal's own dialog at
 * once (`ozone`: the platform Chord was told to use, `--ozone-platform`;
 * X11 on a Wayland desktop lists them as X11 does). Null: Chord lists them.
 */
export function systemPickerFor(platform: NodeJS.Platform, osVersion: string, env: Record<string, string | undefined>, ozone = ''): SystemPicker | null {
  if (platform === 'darwin') return Number(osVersion.split('.')[0]) >= 15 ? 'mac' : null;
  if (platform === 'linux' && ozone !== 'x11' && (ozone === 'wayland' || env['XDG_SESSION_TYPE'] === 'wayland' || env['WAYLAND_DISPLAY'])) return 'portal';
  return null;
}

/**
 * The source that hands a request to macOS's own picker: what Electron answers
 * with itself for `useSystemPicker` (lib/browser/api/session.ts, Electron 45),
 * a fake window that Chromium reads as "ask the native picker". Each needs an
 * id of its own.
 */
let pickerWindow = -1;
export function macPickerSource(): { id: string; name: string } {
  return { id: `window:-4:${pickerWindow--}`, name: '' };
}

/** A tab as the picker lists it. */
function tabSource(tab: TabNode, askingId: NodeId): ShareSource {
  const host = hostOf(tab.url) ?? '';
  return { id: `tab:${tab.id}`, name: tab.customTitle || tab.title || host || tab.url, kind: 'tab', thumbnail: '', host, favicon: tab.favicon, self: tab.id === askingId };
}

/** A screen or window as the picker lists it: its picture, once there is one. */
function desktopSource(source: DesktopCapturerSource): ShareSource {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: source.thumbnail.isEmpty() ? '' : `data:image/jpeg;base64,${source.thumbnail.toJPEG(70).toString('base64')}`,
  };
}

/**
 * The names the hook answers to: new each launch and never in the global
 * symbol registry, so a page can't claim them before sharing to fake "ended"
 * (it would have hidden the sidebar's sharing state while still capturing).
 */
const KEY = randomUUID().replace(/-/g, '');
const LIVE = `__chordSharing${KEY}`;
const STOP_NAME = `__chordStopSharing${KEY}`;

/** Installed in the sharing page's own world; see the file comment. Idempotent. */
const HOOK = `(() => {
  if (window[${JSON.stringify(LIVE)}]) return;
  const tracks = new Set();
  let seen = false;
  const keep = (t) => {
    try {
      if (t && t.kind === 'video' && 'displaySurface' in t.getSettings()) { tracks.add(t); seen = true; }
    } catch {}
  };
  // A copy of a shared track captures just the same.
  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function (...args) { const c = clone.apply(this, args); try { if (tracks.has(this)) keep(c); } catch {} return c; };
  const keepStream = (s) => { try { if (s && s.getTracks) s.getTracks().forEach(keep); } catch {} };
  const wrap = (proto, name, pick) => {
    const f = proto && proto[name];
    if (typeof f !== 'function') return;
    proto[name] = function (...args) { try { pick(args); } catch {} return f.apply(this, args); };
  };
  const gdm = MediaDevices.prototype.getDisplayMedia;
  MediaDevices.prototype.getDisplayMedia = function (...args) { return gdm.apply(this, args).then((s) => (keepStream(s), s)); };
  wrap(window.RTCPeerConnection && RTCPeerConnection.prototype, 'addTrack', ([t, ...s]) => { keep(t); s.forEach(keepStream); });
  wrap(window.RTCPeerConnection && RTCPeerConnection.prototype, 'addTransceiver', ([t, init]) => { keep(t); if (init && init.streams) init.streams.forEach(keepStream); });
  wrap(window.RTCRtpSender && RTCRtpSender.prototype, 'replaceTrack', ([t]) => keep(t));
  wrap(window.MediaStream && MediaStream.prototype, 'addTrack', ([t]) => keep(t));
  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  if (src && src.set) Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { ...src, set(v) { keepStream(v); src.set.call(this, v); } });
  for (const name of ['MediaRecorder', 'MediaStreamTrackProcessor', 'ImageCapture']) {
    const C = window[name];
    if (typeof C !== 'function') continue;
    window[name] = new Proxy(C, { construct(target, args) { try { const a = args[0]; keepStream(a); keep(a && a.track ? a.track : a); } catch {} return Reflect.construct(target, args); } });
  }
  // How many shared tracks are still live: -1 until the page has used one Chord could see. Ended ones are let go,
  // so the page can drop them.
  const count = () => {
    if (!seen) return -1;
    for (const t of tracks) if (t.readyState !== 'live') tracks.delete(t);
    return tracks.size;
  };
  Object.defineProperty(window, ${JSON.stringify(LIVE)}, { value: count });
  Object.defineProperty(window, ${JSON.stringify(STOP_NAME)}, {
    value: () => {
      let stopped = 0;
      for (const t of tracks) {
        if (t.readyState !== 'live') continue;
        t.stop();
        // stop() doesn't fire "ended"; pages listen for it to say sharing stopped, as when the OS ends it.
        t.dispatchEvent(new Event('ended'));
        stopped++;
      }
      return stopped;
    },
  });
})();`;

/** Ends what the hook saw: how many tracks stopped, or -1 when it saw none Chord could stop. */
const STOP = `(() => {
  const live = window[${JSON.stringify(LIVE)}];
  const count = live ? live() : -1;
  return count < 0 ? -1 : window[${JSON.stringify(STOP_NAME)}]();
})()`;

export class ScreenShareBroker {
  private deps: ScreenShareDeps | null = null;
  private readonly pending: Pending[] = [];
  private nextId = 1;
  /** Tabs sharing now: the frame that's sharing, what it shares, and the check that notices when it ends. */
  private readonly sharing = new Map<NodeId, { frame: WebFrameMain; host: string; source: SharedSource; timer: ReturnType<typeof setInterval>; checking: boolean }>();
  /** Tabs being shared: their page, the tabs sharing each, and what ends those shares when the page goes. */
  private readonly shared = new Map<NodeId, { contents: WebContents; by: Set<NodeId>; gone(): void }>();

  /** `picker`: where screens and windows are picked on this computer (`systemPickerFor`). */
  constructor(private readonly picker: SystemPicker | null) {}

  connect(deps: ScreenShareDeps): void {
    this.deps = deps;
  }

  attach(ses: Session): void {
    // Chord's picker comes first everywhere, macOS 15+ too (no `useSystemPicker`): it hands screens and windows to
    // the system's picker itself (respond), so tabs can be offered there as well.
    ses.setDisplayMediaRequestHandler((request, callback) => {
      // Electron's callback throws once the asking frame is gone; by then there's no one to answer.
      const answer = (streams: Streams | null) => {
        try {
          callback(streams);
        } catch {
          // The page navigated or closed while the picker was open.
        }
      };
      void this.request(request.frame, request.audioRequested, answer);
    });
  }

  private async request(frame: WebFrameMain | null, audioRequested: boolean, answer: (streams: Streams | null) => void): Promise<void> {
    const contents = frame ? webContents.fromFrame(frame) : undefined;
    const nodeId = contents ? this.deps?.nodeFor(contents) : undefined;
    const host = frame ? hostOf(frame.origin) : null;
    if (!frame || !contents || !nodeId || !host || !this.deps) return answer(null);
    const tabs = this.deps.shareableTabs(nodeId);
    const id = this.nextId++;
    const pending: Pending = {
      id,
      nodeId,
      host,
      frame,
      tabs: tabs.map((t) => t.id),
      sources: [],
      choosing: false,
      answer,
      prompt: {
        id,
        host,
        sources: [],
        loading: this.picker === null,
        audio: audioRequested,
        systemAudio: SYSTEM_AUDIO,
        systemPicker: this.picker !== null,
      },
    };
    this.pending.push(pending);
    this.deps.onChange();
    if (this.picker) return;
    // Names first: picturing every window can take seconds on a busy Windows desktop.
    const named = await this.list(NO_THUMBNAIL);
    if (!this.pending.includes(pending)) return;
    if (named) this.showDesktop(pending, named);
    const pictured = await this.list(THUMBNAIL);
    if (!this.pending.includes(pending)) return;
    pending.prompt = { ...pending.prompt, loading: false };
    if (pictured) this.showDesktop(pending, pictured);
    else this.deps.onChange();
  }

  private list(thumbnailSize: { width: number; height: number }): Promise<DesktopCapturerSource[] | null> {
    return desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize }).catch(() => null);
  }

  /** The screens and windows the picker shows after its tabs, as they are now. */
  private showDesktop(pending: Pending, sources: DesktopCapturerSource[]): void {
    pending.sources = sources;
    pending.prompt = { ...pending.prompt, sources: sources.map(desktopSource) };
    this.deps?.onChange();
  }

  /**
   * The picker to show for a tab, oldest first. Its tabs are listed as they
   * are now, so a title or icon that arrives while it's up fills in (the
   * popover hears of every change), and a tab that closed leaves the list.
   */
  promptFor(nodeId: NodeId | null): SharePrompt | null {
    const pending = nodeId ? this.pending.find((p) => p.nodeId === nodeId) : undefined;
    const state = this.deps?.state();
    if (!pending || !state) return null;
    const tabs = pending.tabs.flatMap((id) => {
      const node = state.nodes[id];
      return node?.kind === 'tab' ? [tabSource(node, pending.nodeId)] : [];
    });
    return { ...pending.prompt, sources: [...tabs, ...pending.prompt.sources] };
  }

  /**
   * The picker's answer: a source to share (with its sound, if offered and
   * chosen), the system's picker for screens and windows, or null to refuse.
   */
  async respond(id: number, sourceId: string | null, audio: boolean): Promise<void> {
    const pending = this.pending.find((p) => p.id === id);
    if (!pending) return;
    // Wayland: the portal's dialog asks which screen or window; Chord's picker stays until it has answered.
    if (sourceId === SYSTEM_SHARE_SOURCE && this.picker === 'portal') return this.fromPortal(pending, audio);
    this.pending.splice(this.pending.indexOf(pending), 1);
    this.deps?.onChange();
    const chosen = sourceId ? this.choose(pending, sourceId, audio) : null;
    // Refusing reaches the page as AbortError (Chrome says NotAllowedError; Electron has no way to).
    if (!chosen || pending.frame.isDestroyed()) return pending.answer(null);
    // The hook goes in before the page gets its stream, so it sees the page use it.
    await pageCall(pending.frame.executeJavaScript(HOOK), undefined);
    if (pending.frame.isDestroyed()) return;
    // The tab picked may have closed meanwhile.
    if (chosen.source.kind === 'tab' && chosen.source.contents.isDestroyed()) return pending.answer(null);
    // Shared first: a tab that isn't on screen is attached (Browser parks it) and painting before its stream starts.
    this.started(pending.nodeId, pending.frame, pending.host, chosen.source);
    pending.answer(chosen.streams);
  }

  /** What the page gets for the source picked: only what was offered to it. */
  private choose(pending: Pending, sourceId: string, audio: boolean): { streams: Streams; source: SharedSource } | null {
    const sound = audio && pending.prompt.audio;
    if (sourceId.startsWith('tab:')) {
      const nodeId = sourceId.slice('tab:'.length);
      const contents = pending.tabs.includes(nodeId) ? this.deps?.contentsOf(nodeId) : undefined;
      if (!contents || contents.isDestroyed()) return null;
      // The whole page of the tab (its main frame stands for it), and its sound with local echo, or you'd stop hearing it.
      const streams: Streams = sound ? { video: contents.mainFrame, audio: contents.mainFrame, enableLocalEcho: true } : { video: contents.mainFrame };
      return { streams, source: { kind: 'tab', nodeId, contents } };
    }
    if (sourceId === SYSTEM_SHARE_SOURCE) return this.picker === 'mac' ? { streams: { video: macPickerSource() }, source: { kind: 'system' } } : null;
    const source = pending.sources.find((s) => s.id === sourceId);
    if (!source) return null;
    return {
      streams: { video: source, ...(sound && SYSTEM_AUDIO ? { audio: 'loopback' as const } : {}) },
      source: source.id.startsWith('screen:') ? { kind: 'screen', displayId: source.display_id } : { kind: 'window', id: source.id },
    };
  }

  /** Wayland's portal picks a screen or window; cancelled there, Chord's picker is still up, for a tab. */
  private async fromPortal(pending: Pending, audio: boolean): Promise<void> {
    if (pending.choosing) return;
    pending.choosing = true;
    const chosen = await this.list(NO_THUMBNAIL);
    pending.choosing = false;
    if (!chosen || !this.pending.includes(pending)) return;
    // Every screen and window came back, not the portal's one: it's X11 after all, so they're listed as there.
    if (chosen.length > 1) {
      pending.prompt = { ...pending.prompt, systemPicker: false, loading: false };
      return this.showDesktop(pending, chosen);
    }
    const source = chosen[0];
    if (!source) return;
    pending.sources = [source];
    await this.respond(pending.id, source.id, audio);
  }

  /** The sidebar's Stop: end the tab's share, or the shares of a tab being shared; or say Chord can't. */
  async stop(nodeId: NodeId): Promise<void> {
    const share = this.sharing.get(nodeId);
    if (!share) {
      for (const by of [...(this.shared.get(nodeId)?.by ?? [])]) await this.stop(by);
      return;
    }
    const stopped = share.frame.isDestroyed() ? 0 : ((await pageCall(share.frame.executeJavaScript(STOP), -1)) as number);
    if (stopped < 0) this.deps?.cantStop(nodeId, share.host);
    else this.ended(nodeId);
  }

  /** A tab navigated away or closed: whatever it asked for is refused, and its share is over. */
  forgetTab(nodeId: NodeId): void {
    let changed = false;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.nodeId !== nodeId) continue;
      this.pending.splice(i, 1)[0]!.answer(null);
      changed = true;
    }
    if (this.sharing.has(nodeId)) this.ended(nodeId);
    if (changed) this.deps?.onChange();
  }

  isSharing(nodeId: NodeId): boolean {
    return this.sharing.has(nodeId);
  }

  /** Whether a page is sharing this tab. */
  isShared(nodeId: NodeId): boolean {
    return this.shared.has(nodeId);
  }

  /** How many pages are sharing something. */
  get count(): number {
    return this.sharing.size;
  }

  /** What each page shares. */
  sources(): SharedSource[] {
    return [...this.sharing.values()].map((s) => s.source);
  }

  /** The tabs being shared, each with the tabs sharing it. */
  sharedTabs(): { nodeId: NodeId; by: NodeId[] }[] {
    return [...this.shared].map(([nodeId, tab]) => ({ nodeId, by: [...tab.by] }));
  }

  private started(nodeId: NodeId, frame: WebFrameMain, host: string, source: SharedSource): void {
    // A page sharing again replaces its share, without presenting mode blinking off between the two.
    this.ended(nodeId, true);
    const timer = setInterval(() => void this.check(nodeId), CHECK_MS);
    this.sharing.set(nodeId, { frame, host, source, timer, checking: false });
    this.deps?.dispatch({ t: 'tab.live', nodeId, live: { sharing: true } });
    if (source.kind === 'tab') this.share(source.nodeId, source.contents, nodeId);
    this.deps?.sharingChanged();
  }

  /** The page in `by` shares this tab. */
  private share(nodeId: NodeId, contents: WebContents, by: NodeId): void {
    let tab = this.shared.get(nodeId);
    if (tab?.contents !== contents) {
      // The tab's page closing (or loading again with other sign-ins) ends every share of it.
      const gone = () => {
        const now = this.shared.get(nodeId);
        if (now?.contents === contents) for (const capturer of [...now.by]) this.ended(capturer);
      };
      contents.once('destroyed', gone);
      // Throttled in the background, a hidden page paints less often, and the page sharing it would stutter.
      contents.setBackgroundThrottling(false);
      tab = { contents, by: new Set(), gone };
      this.shared.set(nodeId, tab);
      this.deps?.dispatch({ t: 'tab.live', nodeId, live: { shared: true } });
    }
    tab.by.add(by);
  }

  /** The page in `by` stopped sharing this tab; once none does, it's an ordinary tab again. */
  private unshare(nodeId: NodeId, by: NodeId): void {
    const tab = this.shared.get(nodeId);
    if (!tab) return;
    tab.by.delete(by);
    if (tab.by.size > 0) return;
    this.shared.delete(nodeId);
    if (!tab.contents.isDestroyed()) {
      tab.contents.off('destroyed', tab.gone);
      tab.contents.setBackgroundThrottling(true);
    }
    if (this.deps?.state().live[nodeId]) this.deps.dispatch({ t: 'tab.live', nodeId, live: { shared: false } });
  }

  /** Over once every shared track Chord saw has ended, or the frame is gone. */
  private async check(nodeId: NodeId): Promise<void> {
    const share = this.sharing.get(nodeId);
    // One check at a time: a page that's slow to answer doesn't get a pile of them.
    if (!share || share.checking) return;
    if (share.frame.isDestroyed()) return this.ended(nodeId);
    share.checking = true;
    // -1: the page hasn't used its share where Chord can see yet, the hook is gone, or the page didn't answer: keep showing it.
    const live = (await pageCall(share.frame.executeJavaScript(`window[${JSON.stringify(LIVE)}]?.() ?? -1`), -1)) as number;
    share.checking = false;
    if (live === 0) this.ended(nodeId);
  }

  /** `quiet`: another share takes its place at once, so nothing else needs to hear of it. */
  private ended(nodeId: NodeId, quiet = false): void {
    const share = this.sharing.get(nodeId);
    if (!share) return;
    clearInterval(share.timer);
    this.sharing.delete(nodeId);
    if (share.source.kind === 'tab') this.unshare(share.source.nodeId, nodeId);
    if (this.deps?.state().live[nodeId]) this.deps.dispatch({ t: 'tab.live', nodeId, live: { sharing: false } });
    if (!quiet) this.deps?.sharingChanged();
  }
}

function hostOf(origin: string): string | null {
  try {
    const url = new URL(origin);
    return /^https?:$/.test(url.protocol) ? url.host : null;
  } catch {
    return null;
  }
}
