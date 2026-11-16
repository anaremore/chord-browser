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
/** Held at a list's end, how often to look again whether it got longer (a folder springing open), in ms. */
const RECHECK_MS = 200;

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
    /**
     * `carry`: the part of a pixel not scrolled yet, so a slow creep near the edge still moves. `top` and `max`:
     * how far it's scrolled and can be, kept from its scroll events, so a list already at that end (or one too
     * short to scroll, like a short Pinned) isn't scrolled: `scrollBy` lays the list out even when it can't move.
     * Held at its end, `max` is read again now and then (`checked`): rows can come below without a scroll.
     */
    let lists: { element: HTMLElement; box: Box; carry: number; top: number; max: number; checked: number; off: () => void }[] = [];
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
        const list = lists[i]!;
        if (speed === 0 || (speed < 0 && list.top <= 0)) return;
        // At the edge either way: the loop goes on while the pointer's there.
        atEdge = true;
        if (speed > 0 && list.top >= list.max) {
          if (now - list.checked < RECHECK_MS) return;
          list.checked = now;
          list.top = list.element.scrollTop;
          list.max = list.element.scrollHeight - list.element.clientHeight;
          if (list.top >= list.max) return;
        }
        const delta = list.carry + speed * elapsed;
        const whole = Math.trunc(delta);
        list.carry = delta - whole;
        // Written, never read: no layout here. Past the end of the list it's a no-op.
        if (whole !== 0) {
          list.element.scrollBy({ top: whole, behavior: 'instant' });
          list.top = Math.max(0, Math.min(list.max, list.top + whole));
        }
      });
      // Away from every edge: wait for the pointer to move again.
      frame = atEdge ? requestAnimationFrame(tick) : 0;
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      for (const list of lists) list.off();
      lists = [];
    };

    const off = [
      manager.monitor.addEventListener('dragstart', () => {
        lists = [...document.querySelectorAll<HTMLElement>('[data-edge-scroll]')].map((element) => {
          const list = { element, box: element.getBoundingClientRect(), carry: 0, top: element.scrollTop, max: element.scrollHeight - element.clientHeight, checked: 0, off: () => {} };
          // Scrolled some other way too (the wheel, rows mounting), or resized (a short Pinned reaching its cap):
          // read where it is, when it's laid out anyway.
          const scrolled = () => {
            list.top = element.scrollTop;
            list.max = element.scrollHeight - element.clientHeight;
          };
          const resized = new ResizeObserver(() => {
            list.box = element.getBoundingClientRect();
            scrolled();
          });
          element.addEventListener('scroll', scrolled, { passive: true });
          resized.observe(element);
          list.off = () => {
            element.removeEventListener('scroll', scrolled);
            resized.disconnect();
          };
          return list;
        });
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
