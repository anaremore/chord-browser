/**
 * Scrolling a list while a drag holds near its top or bottom edge, in place
 * of dnd-kit's AutoScroller. That one finds what to scroll on every pointer
 * move (`elementFromPoint`, then every scrollable ancestor's style and box),
 * which lays the shell out each time: about 16 ms over a drag through 200 tabs.
 * Chord knows its scrolling lists (`data-edge-scroll`), so this measures them
 * once when the drag starts and scrolls from a frame loop, reading no layout.
 */
import { Plugin } from '@dnd-kit/abstract';
import type { DragDropManager } from '@dnd-kit/dom';

/** How close to an edge (px, at most a quarter of the list) a drag starts scrolling it. */
const EDGE = 48;
/** Speed at the edge and past it, in px per ms (about 20 px a frame at 60 Hz). */
const MAX_SPEED = 1.2;

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * How fast to scroll a list with the pointer at (x, y): negative up, positive
 * down, 0 away from its edges or beside it. Faster the closer to the edge
 * (squared, so a drag only brushing the edge creeps).
 */
export function edgeSpeed(x: number, y: number, box: Box): number {
  if (x < box.left || x > box.right) return 0;
  const band = Math.min(EDGE, (box.bottom - box.top) / 4);
  if (band <= 0) return 0;
  const closeness = (into: number) => Math.min(1, into / band) ** 2;
  if (y < box.top + band) return -MAX_SPEED * closeness(box.top + band - y);
  if (y > box.bottom - band) return MAX_SPEED * closeness(y - (box.bottom - band));
  return 0;
}

export class EdgeScroller extends Plugin<DragDropManager> {
  constructor(manager: DragDropManager) {
    super(manager);
    /** `carry`: the part of a pixel not scrolled yet, so a slow creep near the edge still moves. */
    let lists: { element: HTMLElement; box: Box; carry: number }[] = [];
    let frame = 0;
    let last = 0;

    const speeds = () => {
      const { x, y } = manager.dragOperation.position.current;
      return lists.map((list) => edgeSpeed(x, y, list.box));
    };
    const tick = (now: number) => {
      // A frame's time can be a little before the moment the loop started.
      const elapsed = Math.max(0, Math.min(32, now - last));
      last = now;
      let atEdge = false;
      speeds().forEach((speed, i) => {
        if (speed === 0) return;
        atEdge = true;
        const list = lists[i]!;
        const delta = list.carry + speed * elapsed;
        const whole = Math.trunc(delta);
        list.carry = delta - whole;
        // Written, never read: no layout here. Past the end of the list it's a no-op.
        if (whole !== 0) list.element.scrollBy({ top: whole, behavior: 'instant' });
      });
      // Away from every edge: wait for the pointer to move again.
      frame = atEdge ? requestAnimationFrame(tick) : 0;
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      lists = [];
    };

    const off = [
      manager.monitor.addEventListener('dragstart', () => {
        lists = [...document.querySelectorAll<HTMLElement>('[data-edge-scroll]')].map((element) => ({ element, box: element.getBoundingClientRect(), carry: 0 }));
      }),
      // dragmove comes before the move is applied (it can be prevented), so the next frame decides: the loop
      // stops itself away from the edges.
      manager.monitor.addEventListener('dragmove', () => {
        if (frame || lists.length === 0) return;
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }),
      manager.monitor.addEventListener('dragend', stop),
    ];
    this.destroy = () => {
      stop();
      for (const unsubscribe of off) unsubscribe();
    };
  }
}
