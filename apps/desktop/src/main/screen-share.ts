/**
 * Screen sharing (ARCHITECTURE.md §9). A page's `getDisplayMedia` asks
 * Chord, which shows its own picker in the window's popover: screens and
 * windows with thumbnails, and "Share audio" where the OS can capture it
 * (Windows). On macOS 15+ the system's own picker is used instead.
 *
 * Electron can't end a share from outside the page, so while one is granted
 * Chord adds a small hook to that page's script world. It keeps the shared
 * screen's tracks as the page uses them (a call, a preview, a recording), so
 * Stop can end them and Chord can tell when sharing is over. A page that
 * never uses its stream that way can't be stopped from Chord; its own Stop
 * button still works. The hook gives the page nothing it didn't have.
 */
import type { Command, NodeId, State } from '@chord/core';
import type { SharePrompt, ShareSource } from '@chord/ipc';
import { desktopCapturer, webContents, type DesktopCapturerSource, type Session, type Streams, type WebContents, type WebFrameMain } from 'electron';

export interface ScreenShareDeps {
  state(): State;
  dispatch(command: Command): void;
  /** The tab a page belongs to (popups and Chord's own UI can't share). */
  nodeFor(contents: WebContents): NodeId | undefined;
  /** The picker changed: refresh every window's popover. */
  onChange(): void;
  /** Stop couldn't reach the share (the page never used it where Chord can see): say so. */
  cantStop(nodeId: NodeId, host: string): void;
}

interface Pending {
  id: number;
  nodeId: NodeId;
  host: string;
  frame: WebFrameMain;
  sources: DesktopCapturerSource[];
  thumbnails: ShareSource[];
  audio: boolean;
  answer(streams: Streams | null): void;
}

/** How often Chord checks whether a page's share is still going. */
const CHECK_MS = 2000;
const THUMBNAIL = { width: 240, height: 135 };

/** Installed in the sharing page's own world; see the file comment. Idempotent. */
const HOOK = `(() => {
  const live = Symbol.for('chord.sharing');
  if (window[live]) return;
  const tracks = new Set();
  let seen = false;
  const keep = (t) => {
    try {
      if (t && t.kind === 'video' && 'displaySurface' in t.getSettings()) { tracks.add(t); seen = true; }
    } catch {}
  };
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
  // How many shared tracks are still live: -1 until the page has used one Chord could see.
  Object.defineProperty(window, live, { value: () => (seen ? [...tracks].filter((t) => t.readyState === 'live').length : -1) });
  Object.defineProperty(window, Symbol.for('chord.stopSharing'), {
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
  const live = window[Symbol.for('chord.sharing')];
  const count = live ? live() : -1;
  return count < 0 ? -1 : window[Symbol.for('chord.stopSharing')]();
})()`;

export class ScreenShareBroker {
  private deps: ScreenShareDeps | null = null;
  private readonly pending: Pending[] = [];
  private nextId = 1;
  /** Tabs sharing now, with the frame that's sharing and the check that notices when it ends. */
  private readonly sharing = new Map<NodeId, { frame: WebFrameMain; host: string; timer: ReturnType<typeof setInterval> }>();

  connect(deps: ScreenShareDeps): void {
    this.deps = deps;
  }

  attach(ses: Session): void {
    // macOS 15+: the system's own picker, which asks for screen-recording permission itself.
    ses.setDisplayMediaRequestHandler(
      (request, callback) => {
        // Electron's callback throws once the asking frame is gone; by then there's no one to answer.
        const answer = (streams: Streams | null) => {
          try {
            callback(streams);
          } catch {
            // The page navigated or closed while the picker was open.
          }
        };
        void this.request(request.frame, request.audioRequested, answer);
      },
      { useSystemPicker: true },
    );
  }

  private async request(frame: WebFrameMain | null, audioRequested: boolean, answer: (streams: Streams | null) => void): Promise<void> {
    const contents = frame ? webContents.fromFrame(frame) : undefined;
    const nodeId = contents ? this.deps?.nodeFor(contents) : undefined;
    const host = frame ? hostOf(frame.origin) : null;
    if (!frame || !contents || !nodeId || !host || !this.deps) return answer(null);
    let sources: DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: THUMBNAIL });
    } catch {
      return answer(null);
    }
    if (sources.length === 0) return answer(null);
    this.pending.push({
      id: this.nextId++,
      nodeId,
      host,
      frame,
      sources,
      thumbnails: sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? '' : `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString('base64')}`,
      })),
      // Capturing the computer's sound works on Windows only.
      audio: audioRequested && process.platform === 'win32',
      answer,
    });
    this.deps.onChange();
  }

  /** The picker to show for a tab, oldest first. */
  promptFor(nodeId: NodeId | null): SharePrompt | null {
    const next = nodeId ? this.pending.find((p) => p.nodeId === nodeId) : undefined;
    return next ? { id: next.id, host: next.host, sources: next.thumbnails, audio: next.audio } : null;
  }

  /** The picker's answer: a source to share (with the computer's sound, if offered and chosen), or null to refuse. */
  async respond(id: number, sourceId: string | null, audio: boolean): Promise<void> {
    const index = this.pending.findIndex((p) => p.id === id);
    if (index < 0) return;
    const [prompt] = this.pending.splice(index, 1);
    this.deps?.onChange();
    const source = sourceId ? prompt!.sources.find((s) => s.id === sourceId) : undefined;
    // Refusing reaches the page as AbortError (Chrome says NotAllowedError; Electron has no way to).
    if (!source || prompt!.frame.isDestroyed()) return prompt!.answer(null);
    // The hook goes in before the page gets its stream, so it sees the page use it.
    await prompt!.frame.executeJavaScript(HOOK).catch(() => undefined);
    if (prompt!.frame.isDestroyed()) return;
    prompt!.answer({ video: source, ...(audio && prompt!.audio ? { audio: 'loopback' as const } : {}) });
    this.started(prompt!.nodeId, prompt!.frame, prompt!.host);
  }

  /** The sidebar's Stop: end the tab's share, or say Chord can't. */
  async stop(nodeId: NodeId): Promise<void> {
    const share = this.sharing.get(nodeId);
    if (!share) return;
    const stopped = share.frame.isDestroyed() ? 0 : ((await share.frame.executeJavaScript(STOP).catch(() => -1)) as number);
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

  private started(nodeId: NodeId, frame: WebFrameMain, host: string): void {
    this.ended(nodeId);
    const timer = setInterval(() => void this.check(nodeId), CHECK_MS);
    this.sharing.set(nodeId, { frame, host, timer });
    this.deps?.dispatch({ t: 'tab.live', nodeId, live: { sharing: true } });
  }

  /** Over once every shared track Chord saw has ended, or the frame is gone. */
  private async check(nodeId: NodeId): Promise<void> {
    const share = this.sharing.get(nodeId);
    if (!share) return;
    if (share.frame.isDestroyed()) return this.ended(nodeId);
    // -1: the page hasn't used its share where Chord can see yet (or the hook is gone): keep showing it.
    const live = (await share.frame.executeJavaScript(`window[Symbol.for('chord.sharing')]?.() ?? -1`).catch(() => -1)) as number;
    if (live === 0) this.ended(nodeId);
  }

  private ended(nodeId: NodeId): void {
    const share = this.sharing.get(nodeId);
    if (!share) return;
    clearInterval(share.timer);
    this.sharing.delete(nodeId);
    if (this.deps?.state().live[nodeId]) this.deps.dispatch({ t: 'tab.live', nodeId, live: { sharing: false } });
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
