/**
 * Peek's card in motion (DESIGN.md §8.5): a drag or resize following the
 * pointer, and the glide back home. While either runs, the card is drawn
 * straight into the DOM once a frame (`draw`) and its box goes to main,
 * latest wins (`move`, `peek:move`); React gets the box once it ends
 * (`commit`). `stop` ends all of it at once, sending nothing more: before
 * Open as tab grows the page from where it is, and when Peek closes.
 */
import { clampPeekCard, dragPeekCard, type PeekBox, type PeekGrip } from '@chord/core';
import { latestWins, type LatestWins } from '../shared/latest';

export interface CardMotionDeps {
  /** The card at `box` this frame, without a render. */
  draw(box: PeekBox): void;
  /** React's box: what's on screen once nothing draws over it. */
  commit(box: PeekBox): void;
  /** Main places Peek's page in `card` (null: home) and answers with the card as placed. */
  move(card: PeekBox | null): Promise<PeekBox | null>;
  /** The next frame (requestAnimationFrame), and its cancel. */
  frame(run: () => void): number;
  cancelFrame(id: number): void;
  /** A glide from 0 to 1 on Peek's spring, or null with motion off (the card jumps). */
  glide(onUpdate: (k: number) => void, onComplete: () => void): { stop(): void } | null;
}

interface Gesture {
  grip: PeekGrip;
  start: PeekBox;
  x: number;
  y: number;
  pointerId: number;
}

export class CardMotion {
  /** The card as it is on screen. */
  box: PeekBox;
  private gesture: Gesture | null = null;
  private gliding: { stop(): void } | null = null;
  private frameId = 0;
  private next: PeekBox | null = null;
  private lastSent: PeekBox | null | undefined = undefined;
  private readonly mover: LatestWins<PeekBox | null>;

  constructor(
    initial: PeekBox,
    private readonly deps: CardMotionDeps,
  ) {
    this.box = initial;
    this.mover = latestWins(async (card) => {
      const placed = await deps.move(card);
      // The card as main placed it, once nothing newer is on its way.
      if (placed && this.lastSent === card && !this.busy) this.commit(placed);
    });
  }

  /** A drag or a glide is drawing the card. */
  get busy(): boolean {
    return this.gesture !== null || this.gliding !== null;
  }

  /** What the current drag holds, if one is on. */
  get grip(): PeekGrip | null {
    return this.gesture?.grip ?? null;
  }

  /** Main's box (`peek:state`): drawn unless ours are on their way, which are newer (the reply puts it right). */
  fromMain(card: PeekBox): void {
    if (!this.busy && this.mover.idle) this.commit(card);
  }

  /** A press took hold of `grip`: a glide home stops where it got to. */
  press(grip: PeekGrip, x: number, y: number, pointerId: number): void {
    this.stopGlide();
    this.gesture = { grip, start: this.box, x, y, pointerId };
  }

  /** The pointer moved: the card follows on the next frame. False when it isn't this drag's or didn't move. */
  drag(pointerId: number, x: number, y: number, area: PeekBox): boolean {
    const g = this.gesture;
    if (!g || pointerId !== g.pointerId) return false;
    const dx = x - g.x;
    const dy = y - g.y;
    if (dx === 0 && dy === 0) return false;
    this.next = dragPeekCard(g.start, g.grip, dx, dy, area);
    if (!this.frameId) this.frameId = this.deps.frame(() => this.flush());
    return true;
  }

  /** Let go: where it was let go is where it stays, its last box sent now, not a frame later. The grip it held, or null. */
  release(pointerId: number): PeekGrip | null {
    const g = this.gesture;
    if (!g || pointerId !== g.pointerId) return null;
    this.deps.cancelFrame(this.frameId);
    this.flush();
    this.gesture = null;
    this.commit(this.box);
    return g.grip;
  }

  /** Back to `home` at the default size: gliding there, or at once with motion off. */
  goHome(home: PeekBox, area: PeekBox): void {
    const from = this.box;
    this.stopGlide();
    const at = (k: number) =>
      clampPeekCard(
        { x: from.x + (home.x - from.x) * k, y: from.y + (home.y - from.y) * k, width: from.width + (home.width - from.width) * k, height: from.height + (home.height - from.height) * k },
        area,
      );
    // This glide's own token: a stopped or replaced glide's late callbacks do nothing.
    const token = { stop: () => controls?.stop() };
    this.gliding = token;
    const controls = this.deps.glide(
      (k) => {
        if (this.gliding === token) this.draw(at(k));
      },
      () => {
        if (this.gliding !== token) return;
        this.gliding = null;
        this.commit(home);
        this.send(null);
      },
    );
    if (!controls && this.gliding === token) {
      this.gliding = null;
      this.commit(home);
      this.send(null);
    }
  }

  /**
   * Everything stops, and nothing more goes to main: no frame waiting, no drag, no glide, no box waiting behind one
   * on its way. The card stays where it's drawn. Before Open as tab, so the page grows from where it is; and when Peek closes.
   */
  stop(): void {
    this.deps.cancelFrame(this.frameId);
    this.frameId = 0;
    this.next = null;
    this.gesture = null;
    this.stopGlide();
    this.mover.cancel();
  }

  private stopGlide(): void {
    const g = this.gliding;
    this.gliding = null;
    g?.stop();
  }

  private flush(): void {
    this.frameId = 0;
    const next = this.next;
    if (!next) return;
    this.next = null;
    this.draw(next);
  }

  private draw(box: PeekBox): void {
    this.box = box;
    this.deps.draw(box);
    this.send(box);
  }

  private commit(box: PeekBox): void {
    this.box = box;
    this.deps.commit(box);
  }

  private send(card: PeekBox | null): void {
    this.lastSent = card;
    this.mover.push(card);
  }
}
