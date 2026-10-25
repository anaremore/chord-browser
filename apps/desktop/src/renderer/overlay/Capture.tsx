/**
 * Taking a screenshot (DESIGN.md §7.12): the overlay over the page, in one
 * mode. Hover shows the element under the pointer (click takes it), a drag
 * draws an area, and the bar offers what's on screen and the whole page.
 * Keys: ↑ and ↓ step to the element's parent or child, Enter takes it, V
 * and F take what's on screen and the whole page, Esc cancels. The wheel
 * still scrolls the page, which never sees the pointer: main asks it what's
 * there from Chord's own isolated world.
 *
 * The same layer picks elements to hide for Effects (`capture.hide`, DESIGN.md
 * §7.15): a click hides the element under the pointer on the site and picking
 * goes on, until Done (Esc). No areas, nothing taken.
 */
import { MIN_AREA, rectFromPoints, intersectRect, type ShotRect } from '@chord/core';
import type { CaptureHit, CaptureStart, ScreenshotChoice } from '@chord/ipc';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { api } from './api';
import styles from './Capture.module.css';

interface Point {
  x: number;
  y: number;
}

const box = (r: ShotRect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });
const inside = (p: Point, r: ShotRect) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;

export function CaptureLayer({ capture, onClose, onTaken }: { capture: CaptureStart; onClose(): void; onTaken(): void }) {
  const { pane } = capture;
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [hit, setHit] = useState<CaptureHit | null>(null);
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const hiding = capture.hide ?? null;
  const [hidden, setHidden] = useState(0);
  const [said, setSaid] = useState('');
  // One question to the page at a time; meanwhile only the newest point waits.
  const asking = useRef(false);
  // Where the pointer was when ↑ or ↓ chose an element: that choice holds until the pointer really moves.
  const steppedAt = useRef<Point | null>(null);
  const pointer = useRef<Point | null>(null);
  const next = useRef<Point | null>(null);

  useEffect(() => root.current?.focus(), []);

  const hover = (point: Point) => {
    next.current = point;
    if (asking.current) return;
    asking.current = true;
    void (async () => {
      while (next.current) {
        const at = next.current;
        next.current = null;
        const answer = await api.capture.hover(at.x, at.y).catch(() => null);
        if (!next.current) setHit(answer);
      }
      asking.current = false;
    })();
  };

  const take = (choice: ScreenshotChoice) => {
    onTaken();
    void api.capture.take(choice);
  };

  /** Effects: hide what's outlined, and look again under the pointer (what was behind it shows now). */
  const hide = () => {
    if (!hit) return;
    setHit(null);
    void api.capture.hide().then((done) => {
      if (!done) return;
      setHidden((n) => n + 1);
      setSaid(`Hid ${done.label}`);
      if (pointer.current) hover(pointer.current);
    });
  };

  const area = drag ? intersectRect(rectFromPoints(drag.from, drag.to), pane) : null;
  const dragging = area !== null && area.width >= MIN_AREA && area.height >= MIN_AREA;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = { x: event.clientX, y: event.clientY };
    // A click outside the page cancels, as a click outside the command bar does.
    if (!inside(at, pane)) return onClose();
    // Picking for Effects has no areas: a click is a click.
    if (hiding) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ from: at, to: at });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = { x: event.clientX, y: event.clientY };
    pointer.current = at;
    // What was hidden has been said; what's under the pointer is said again from here.
    if (said) setSaid('');
    const held = steppedAt.current;
    if (held && Math.hypot(at.x - held.x, at.y - held.y) < MIN_AREA) return;
    steppedAt.current = null;
    if (drag) setDrag({ from: drag.from, to: at });
    // Over the bar, nothing on the page is what you're pointing at.
    else if (bar.current?.contains(event.target as Node)) setHit(null);
    else hover(at);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (hiding) {
      if (event.button === 0 && !bar.current?.contains(event.target as Node)) hide();
      return;
    }
    if (!drag) return;
    setDrag(null);
    if (dragging && area) take({ kind: 'area', rect: area });
    else if (hit) take({ kind: 'element' });
  };
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    void api.capture.scroll(event.clientX, event.clientY, event.deltaX, event.deltaY).then(() => hover({ x: event.clientX, y: event.clientY }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') onClose();
    else if (key === 'arrowup' || key === 'arrowdown') {
      steppedAt.current = pointer.current;
      void api.capture.step(key === 'arrowup' ? 'parent' : 'child').then((answer) => answer && setHit(answer));
    }
    else if (key === 'enter' && hit) {
      if (hiding) hide();
      else take({ kind: 'element' });
    } else if (key === 'v' && !hiding && !event.metaKey && !event.ctrlKey) take({ kind: 'visible' });
    else if (key === 'f' && !hiding && !event.metaKey && !event.ctrlKey) take({ kind: 'page' });
    else return;
    event.preventDefault();
  };

  const shown = dragging && area ? area : !drag ? hit?.rect : null;
  const label = dragging && area ? `${Math.round(area.width)} × ${Math.round(area.height)}` : hit && !drag ? `${hit.label} · ${hit.width} × ${hit.height}` : '';
  return (
    <div
      ref={root}
      className={styles.root}
      role="dialog"
      aria-label={hiding ? `Hide elements on ${hiding.host}` : 'Take a screenshot'}
      aria-describedby={hintId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    >
      {/* The page stays clear; around it, the window dims. */}
      <div className={styles.pane} style={box(pane)} />
      {shown && (
        <div className={dragging ? styles.area : styles.highlight} style={box(shown)}>
          <span className={styles.label}>{label}</span>
        </div>
      )}
      <div ref={bar} className={styles.bar} style={{ left: pane.x + pane.width / 2, top: pane.y + 12 }} onPointerDown={(event) => event.stopPropagation()}>
        {hiding ? (
          <>
            <span id={hintId} className={styles.hint}>
              Click what to hide on {hiding.host}
            </span>
            {hidden > 0 && <span className={styles.hint}>{hidden} hidden</span>}
            <button type="button" className={styles.button} onClick={onClose}>
              Done <kbd className={styles.key}>Esc</kbd>
            </button>
          </>
        ) : (
          <>
            <span id={hintId} className={styles.hint}>
              Click an element or drag an area
            </span>
            <button type="button" className={styles.button} onClick={() => take({ kind: 'visible' })}>
              Visible <kbd className={styles.key}>V</kbd>
            </button>
            <button type="button" className={styles.button} onClick={() => take({ kind: 'page' })}>
              Full page <kbd className={styles.key}>F</kbd>
            </button>
            <button type="button" className={styles.close} aria-label="Cancel" title="Cancel (Esc)" onClick={onClose}>
              <X size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {said || (hit && !drag ? `${hit.label}, ${hit.width} by ${hit.height}` : '')}
      </div>
    </div>
  );
}
