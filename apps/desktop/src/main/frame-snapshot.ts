/**
 * The snapshot technique (ARCHITECTURE.md §5; DESIGN.md §6.1 rule 4): how
 * the content frame changes size without moving web content every frame.
 *
 * 1. Picture each page in the frame (`capturePage`; every pane of a split).
 * 2. The shell, which draws the frame behind the pages, paints the pictures
 *    exactly where the pages are, and says so.
 * 3. The pages move out of sight, past the window's right edge, already at
 *    their final size: each relayouts once, hidden behind its picture.
 * 4. The frame changes. The shell moves the pictures to the new pane rects
 *    (the same `paneRects` math) by CSS transform, on the compositor, on the
 *    frame's spring (`smooth`).
 * 5. The pictures arrive: the pages move into place, painted already, and the
 *    shell drops the pictures. Each page moves twice in all, never per frame.
 *
 * Nothing waits on this. The shell stays interactive throughout, focus stays
 * in the page, and a key typed into the page brings it back at once. With no
 * page shown, a page in fullscreen or hidden behind an error, motion switched
 * off, or a picture that fails or takes longer than PREPARE_TIMEOUT_MS, the
 * frame just changes at once.
 *
 * The pictures stay in memory, main's and the shell's (the shell's session is
 * in-memory too). Nothing here touches the disk, so a private window's pages
 * never land there.
 */
import type { FrameSnapshotEvent, Rect, SnapshotPane } from '@chord/ipc';
import { springCurve, springs } from '@chord/tokens';
import type { Event, Input, WebContents, WebContentsView } from 'electron';

/** From asking for the pictures to the shell showing them. Any longer and the frame changes at once. */
export const PREPARE_TIMEOUT_MS = 200;
/** If the shell never says the pictures arrived, the pages come back anyway. */
const MOVE_TIMEOUT_MS = springCurve(springs.smooth).durationMs + 300;

/**
 * What the snapshot needs from its window. Rects are the layout's, in the
 * shell's CSS pixels (what it draws the pictures with), not window pixels.
 */
export interface FrameHost {
  /** Tell the shell (frame:snapshot). */
  tell(event: FrameSnapshotEvent): void;
  /** The pages in the frame, in order, and where each is now. */
  panes(): { view: WebContentsView; rect: Rect }[];
  /** Whether the frame's pages can be pictured now. */
  canSnapshot(): boolean;
  /** Where the pages go: the frame's pane rects as things stand. */
  targets(): Rect[];
  /** Lay the window out. While pictures move (`active`), the pages are laid out out of sight. */
  layout(): void;
}

interface Transition {
  seq: number;
  timer: ReturnType<typeof setTimeout>;
  /** Stops listening for keys in the focused page. */
  unlisten(): void;
}

/**
 * Where a page waits while its picture moves, at the size it's going to be:
 * all but its top-left pixel past the window's bottom-right corner. A view
 * entirely outside its window is hidden by Chromium (it stops painting and
 * loses focus); this one stays shown, so it keeps the keyboard and paints at
 * its new size, ready to come back. The one pixel left inside is the page's
 * own top-left corner, which its rounded corner (`setBorderRadius`, the frame
 * radius on every platform) cuts away, so nothing of it shows, whatever the
 * window's corners. In window pixels, both `rect` and `window`: it's where
 * the view is placed.
 */
export function offscreen(rect: Rect, window: { width: number; height: number }): Rect {
  return { x: window.width - 1, y: window.height - 1, width: rect.width, height: rect.height };
}

/** Keys that type into the page (not a modifier on its own, not a held key repeating). */
export function isTyping(input: Pick<Input, 'type' | 'key' | 'isAutoRepeat'>): boolean {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown' && input.type !== 'char') return false;
  return !input.isAutoRepeat && !['Control', 'Shift', 'Alt', 'Meta'].includes(input.key);
}

/** Resolves with the value, or null if it fails or takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve(null);
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * A page's picture at its device pixels, or null if there's nothing to show.
 * The pixels stay as captured (BGRA, Skia's order on every desktop platform
 * Chromium builds for): the shell's worker turns them into RGBA, so main
 * never loops over them (ARCHITECTURE.md §1, performance rule 1).
 */
async function picture(contents: WebContents): Promise<Omit<SnapshotPane, 'rect'> | null> {
  const image = await contents.capturePage();
  if (image.isEmpty()) return null;
  const scale = Math.max(1, ...image.getScaleFactors());
  const { width, height } = image.getSize(scale);
  const pixels = image.toBitmap({ scaleFactor: scale });
  if (width < 1 || height < 1 || pixels.length !== width * height * 4) return null;
  return { width, height, pixels };
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export class FrameSnapshots {
  private seq = 0;
  private running: Transition | null = null;
  /** Inside a change's callback: layout changes there are the change itself, not something interrupting it. */
  private changing = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly replies = new Map<string, { promise: Promise<void>; resolve(): void }>();
  private disposed = false;

  constructor(private readonly host: FrameHost) {}

  /** Pictures are moving: the pages are out of sight. */
  get active(): boolean {
    return this.running !== null;
  }

  /** Whether a layout change happens inside a change (it's the change) or apart from one (it interrupts it). */
  get inChange(): boolean {
    return this.changing;
  }

  /**
   * Change the frame's size: `change` changes it (the window lays itself out
   * as it does). With `animate`, the pages are pictured first and the
   * pictures glide to the new frame. Changes run in order; one that comes
   * while pictures are moving sends them on to the new place instead.
   */
  change(change: () => void, animate: boolean): void {
    const run = async () => {
      if (this.disposed || !animate) {
        // Changing at once: pictures still moving would be going to the wrong place.
        this.finish();
        return this.apply(change);
      }
      if (this.running) {
        this.apply(change);
        this.move();
        return;
      }
      const seq = await this.prepare();
      if (seq === null) return this.apply(change);
      this.begin(seq);
      this.apply(change);
      this.move();
    };
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    // A failure is main's to report (index.ts logs unhandled rejections); the next change still runs.
    void next;
  }

  /** Resolves once every change asked for so far has happened (not when its pictures arrive). */
  settled(): Promise<void> {
    return this.queue;
  }

  /** The shell's reply for one snapshot. */
  ack(seq: number, phase: 'shown' | 'moved'): void {
    this.replies.get(`${seq}:${phase}`)?.resolve();
  }

  /** Bring the pages back now: the window resized, the tabs changed, a key was typed. */
  finish(): void {
    const t = this.running;
    if (!t) return;
    this.running = null;
    clearTimeout(t.timer);
    t.unlisten();
    this.replies.delete(`${t.seq}:moved`);
    // The pages' second move: into place, at the size they already have.
    this.host.layout();
    this.tell({ seq: t.seq, phase: 'drop' });
  }

  /** The window closed: stop, with nothing left to lay out. */
  dispose(): void {
    const t = this.running;
    this.running = null;
    if (t) {
      clearTimeout(t.timer);
      t.unlisten();
    }
    this.disposed = true;
    this.replies.clear();
  }

  private apply(change: () => void): void {
    this.changing = true;
    try {
      change();
    } finally {
      this.changing = false;
    }
    this.host.layout();
  }

  /** Picture the pages and have the shell paint the pictures where they are. Null: change at once instead. */
  private async prepare(): Promise<number | null> {
    if (!this.host.canSnapshot()) return null;
    const panes = this.host.panes();
    const seq = ++this.seq;
    this.replies.clear();
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    const pictures = await within(Promise.all(panes.map((p) => picture(p.view.webContents))), PREPARE_TIMEOUT_MS);
    // Something moved on while the pages were pictured (another tab, a resize): the change just happens.
    if (!pictures || pictures.some((p) => p === null) || !this.unchanged(panes)) return null;
    const shown = this.reply(seq, 'shown');
    this.tell({ seq, phase: 'show', panes: panes.map((p, i) => ({ rect: p.rect, ...pictures[i]! })) });
    const ready = (await within(shown, deadline - Date.now())) !== null && this.unchanged(panes) && this.host.canSnapshot();
    this.replies.delete(`${seq}:shown`);
    if (ready) return seq;
    this.tell({ seq, phase: 'drop' });
    return null;
  }

  private begin(seq: number): void {
    // Typing into the page brings it back first: input never waits for motion.
    const focused = this.host.panes().find((p) => p.view.webContents.isFocused())?.view.webContents;
    const onKey = (_event: Event, input: Input) => {
      if (isTyping(input)) this.finish();
    };
    focused?.on('before-input-event', onKey);
    // From now on the window lays the pages out of sight, behind their pictures: the change's own
    // layout is their first move, straight to their final size.
    this.running = {
      seq,
      timer: setTimeout(() => this.finish(), MOVE_TIMEOUT_MS),
      unlisten: () => focused?.off('before-input-event', onKey),
    };
  }

  /** Send the pictures where the pages are going now; they're back once the pictures arrive. */
  private move(): void {
    const t = this.running;
    if (!t) return;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => this.finish(), MOVE_TIMEOUT_MS);
    void this.reply(t.seq, 'moved').then(() => {
      if (this.running === t) this.finish();
    });
    this.tell({ seq: t.seq, phase: 'move', rects: this.host.targets() });
  }

  private unchanged(panes: { view: WebContentsView; rect: Rect }[]): boolean {
    const now = this.host.panes();
    return now.length === panes.length && now.every((p, i) => p.view === panes[i]!.view && sameRect(p.rect, panes[i]!.rect));
  }

  private reply(seq: number, phase: 'shown' | 'moved'): Promise<void> {
    const key = `${seq}:${phase}`;
    const waiting = this.replies.get(key);
    if (waiting) return waiting.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    this.replies.set(key, {
      promise,
      resolve: () => {
        this.replies.delete(key);
        resolve();
      },
    });
    return promise;
  }

  private tell(event: FrameSnapshotEvent): void {
    this.host.tell(event);
  }
}
