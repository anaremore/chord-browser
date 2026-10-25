/**
 * Automatic picture-in-picture (ARCHITECTURE.md §9, DESIGN.md §7, spike S7):
 * when you switch away from a tab whose video is playing, the video pops out
 * into Chromium's own floating PiP window, and it goes back in when you return.
 *
 * Electron has no browser-initiated PiP, so Chord asks the page itself, from
 * an isolated world (the page's DOM, not its scripts), with `userGesture` so
 * Chromium's user-activation rule is met. That works on a tab already off
 * screen (S7), so switching tabs is never delayed.
 *
 * The PiP window's "Back to tab" doesn't reach Electron (S7): it just ends
 * picture-in-picture with the video still playing. Chord watches for that,
 * and brings the tab back itself. Its ✕ ends PiP and pauses the video, which
 * is how the two are told apart.
 */
import { isInternalUrl, type Command, type NodeId, type State } from '@chord/core';
import type { WebContents, WebFrameMain } from 'electron';
import { PAGE_CALL_MS, pageCall } from './page-call';

/** Chord's isolated world for this: same DOM as the page, none of its scripts. */
const WORLD = 1007;
/** Smaller than this is a preview or an ad tile, not something you were watching (DESIGN.md §7). */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 112;
/** Chromium pauses the video just after ✕ ends PiP; wait this long before reading the outcome. */
const SETTLE_MS = 300;

/**
 * The largest playing video worth popping out, searched through open shadow
 * roots. Muted videos count only if the page has made sound since it loaded
 * (a background loop never pops out; a video you muted while watching does).
 */
const FIND = (heard: boolean) => `(() => {
  const videos = [];
  const collect = (root, depth) => {
    videos.push(...root.querySelectorAll('video'));
    if (depth < 3) for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, depth + 1);
  };
  collect(document, 0);
  let best = null, bestArea = 0;
  for (const v of videos) {
    if (v.paused || v.ended || v.readyState < 2 || v.disablePictureInPicture) continue;
    if ((v.muted || v.volume === 0) && !${heard}) continue;
    const r = v.getBoundingClientRect();
    if (r.width < ${MIN_WIDTH} || r.height < ${MIN_HEIGHT}) continue;
    if (r.width * r.height > bestArea) { best = v; bestArea = r.width * r.height; }
  }
  return { best, bestArea };
})()`;

/** How big a candidate this frame has (0 for none), or -1 if something there is already in PiP. */
const SCAN = (heard: boolean) => `document.pictureInPictureElement ? -1 : ${FIND(heard)}.bestArea`;

const REQUEST = (heard: boolean) => `(async () => {
  if (document.pictureInPictureElement) return 'already';
  const { best } = ${FIND(heard)};
  if (!best) return 'none';
  try {
    await best.requestPictureInPicture();
    globalThis.__chordPipVideo = best;
    return 'entered';
  } catch (e) {
    return 'error:' + e.name;
  }
})()`;

/** Resolves when the video leaves PiP: 'left' if it's still playing ("Back to tab"), 'closed' if ✕ paused it. */
const WATCH = `new Promise((resolve) => {
  const v = globalThis.__chordPipVideo;
  if (!v || document.pictureInPictureElement === null) return resolve('gone');
  v.addEventListener('leavepictureinpicture', () => setTimeout(() => resolve(v.paused ? 'closed' : 'left'), ${SETTLE_MS}), { once: true });
})`;

const EXIT = `document.pictureInPictureElement ? document.exitPictureInPicture().then(() => true, () => false) : false`;
const IN_PIP = `Boolean(document.pictureInPictureElement)`;

export interface AutoPipDeps {
  state(): State;
  dispatch(command: Command): void;
  nodeFor(contents: WebContents): NodeId | undefined;
  contents(nodeId: NodeId): WebContents | undefined;
  /** Tabs with a page loaded. */
  loaded(): NodeId[];
  /** Whether a window shows this tab right now. */
  isShown(nodeId: NodeId): boolean;
  /** Show the tab in its window and bring the window forward. */
  bringBack(nodeId: NodeId): void;
}

interface Popped {
  nodeId: NodeId;
  contents: WebContents;
  frame: WebFrameMain;
  /** Chord itself is ending PiP because you came back to the tab. */
  returning: boolean;
}

export class AutoPip {
  /** The tab Chord popped a video out of. Chromium has one PiP window, so there's at most one. */
  private popped: Popped | null = null;
  /** Tabs whose page has made sound since it loaded. */
  private readonly heard = new Set<NodeId>();

  constructor(private readonly deps: AutoPipDeps) {}

  /** Watch a tab's page for sound (its muted videos then still count as watched). */
  attach(contents: WebContents, nodeId: NodeId): void {
    contents.on('audio-state-changed', (event) => {
      if (event.audible) this.heard.add(nodeId);
    });
    contents.on('did-navigate', () => this.heard.delete(nodeId));
    contents.once('destroyed', () => this.heard.delete(nodeId));
  }

  /** You switched away from this page: pop its video out if one is playing. */
  left(contents: WebContents): void {
    const nodeId = this.deps.nodeFor(contents);
    const node = nodeId ? this.deps.state().nodes[nodeId] : undefined;
    if (!nodeId || node?.kind !== 'tab' || isInternalUrl(node.url)) return;
    // A crashed page has no frames to ask (reading mainFrame throws), and no video playing.
    if (!this.deps.state().settings.autoPip || this.popped || contents.isDestroyed() || contents.isCrashed()) return;
    void this.popOut(nodeId, contents);
  }

  /**
   * The Now playing card's button: this tab's playing video pops out now; or,
   * if it's out already (by Chord, or by the site's own button), the tab comes
   * on screen and the video goes back into it, playing on, as the
   * picture-in-picture window's "back to tab" does. Chromium has one
   * picture-in-picture window, so a video already in it goes back to its own
   * page as this one takes it.
   */
  async toggle(nodeId: NodeId): Promise<void> {
    const popped = this.popped;
    const contents = this.deps.contents(nodeId);
    if (popped?.nodeId === nodeId) {
      this.deps.bringBack(nodeId);
      return this.returned(nodeId);
    }
    if (!contents || contents.isDestroyed() || contents.isCrashed()) return;
    if (await this.run(contents, contents.mainFrame, IN_PIP, false)) {
      this.deps.bringBack(nodeId);
      await this.run(contents, contents.mainFrame, EXIT, false);
      return;
    }
    if (popped) {
      popped.returning = true;
      await this.run(popped.contents, popped.frame, EXIT, false);
      if (this.popped === popped) {
        this.popped = null;
        this.setLive(popped.nodeId, false);
      }
    }
    // You asked for it: a video you muted counts too.
    await this.popOut(nodeId, contents, true);
  }

  /** You're back on this tab: its video goes back in. */
  returned(nodeId: NodeId): void {
    const popped = this.popped;
    if (popped?.nodeId !== nodeId || popped.contents.isDestroyed()) return;
    popped.returning = true;
    void this.run(popped.contents, popped.frame, EXIT, false);
  }

  /**
   * You came back to a tab that wasn't on screen: a video in picture-in-picture
   * comes back into it, whoever popped it out (the site's own button, too), as
   * Chord's own does. Only a page that has made sound is asked: a video you
   * were watching. Each of its frames is asked, as an embedded player's video
   * is in a frame of its own.
   */
  cameBack(nodeId: NodeId): void {
    if (this.popped?.nodeId === nodeId) return;
    const contents = this.deps.contents(nodeId);
    if (!contents || contents.isDestroyed() || contents.isCrashed() || !this.heard.has(nodeId)) return;
    let frames: WebFrameMain[];
    try {
      frames = contents.mainFrame.framesInSubtree;
    } catch {
      return;
    }
    for (const frame of frames.slice(0, 16)) void this.run(contents, frame, EXIT, false);
  }

  private async popOut(nodeId: NodeId, contents: WebContents, heard = this.heard.has(nodeId)): Promise<void> {
    // Most pages have one frame; an embedded player (a video in an article) is in a frame of its own.
    // Its renderer can go away at any moment (a crash, a reload): then there's nothing to pop out.
    let frames: WebFrameMain[];
    try {
      frames = contents.mainFrame.framesInSubtree;
    } catch {
      return;
    }
    const areas = await Promise.all(frames.map((frame) => this.run(contents, frame, SCAN(heard), false).then(Number)));
    // Something on the page is already in PiP (you started it yourself): leave it alone.
    if (areas.some((area) => area < 0)) return;
    let best = -1;
    for (const [i, area] of areas.entries()) if (area > 0 && (best < 0 || area > areas[best]!)) best = i;
    if (best < 0) return;
    // Asking took a moment: you may already be back, or another video may have popped out.
    if (this.popped || this.deps.isShown(nodeId) || contents.isDestroyed()) return;
    const frame = frames[best]!;
    if ((await this.run(contents, frame, REQUEST(heard), true)) !== 'entered') return;
    const popped: Popped = { nodeId, contents, frame, returning: false };
    this.popped = popped;
    this.setLive(nodeId, true);
    // Came back while it was opening: straight back in.
    if (this.deps.isShown(nodeId)) this.returned(nodeId);
    void this.watch(popped);
  }

  private async watch(popped: Popped): Promise<void> {
    // Pending until the video leaves PiP; rejects if the page goes away (closed, navigated, slept).
    const outcome = await this.run(popped.contents, popped.frame, WATCH, false, null);
    if (this.popped !== popped) return;
    this.popped = null;
    this.setLive(popped.nodeId, false);
    if (popped.returning || outcome !== 'left') return;
    // Still playing and Chord didn't end it: "Back to tab" was pressed. Unless another video
    // took the PiP window (you popped one out yourself), which ends this one the same way.
    if (await this.anotherInPip(popped.nodeId)) return;
    this.deps.bringBack(popped.nodeId);
  }

  private async anotherInPip(except: NodeId): Promise<boolean> {
    const others = this.deps.loaded().filter((id) => id !== except);
    const answers = await Promise.all(
      others.map((id) => {
        const contents = this.deps.contents(id);
        return contents && !contents.isDestroyed() ? this.run(contents, contents.mainFrame, IN_PIP, false) : false;
      }),
    );
    return answers.some(Boolean);
  }

  /** Only a tab whose page is loaded has live state; a slept or closed one stays as it is. */
  private setLive(nodeId: NodeId, pip: boolean): void {
    if (this.deps.state().live[nodeId]) this.deps.dispatch({ t: 'tab.live', nodeId, live: { pip } });
  }

  /**
   * Runs in Chord's isolated world in the page's main frame. Embedded frames
   * are asked through their own main world (Electron has no isolated world
   * for subframes); a page could only fool itself there.
   */
  /**
   * `ms`: how long the page has to answer (`pageCall`); null for WATCH, which answers only
   * when the video leaves picture-in-picture, however long that takes (a time limit made
   * Chord forget, two seconds in, which video it had popped out).
   */
  private run(contents: WebContents, frame: WebFrameMain, code: string, userGesture: boolean, ms: number | null = PAGE_CALL_MS): Promise<unknown> {
    if (contents.isDestroyed() || frame.isDestroyed()) return Promise.resolve(null);
    const done = frame === contents.mainFrame ? contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], userGesture) : frame.executeJavaScript(code, userGesture);
    return ms === null ? done.catch(() => null) : pageCall<unknown>(done, null, ms);
  }
}
