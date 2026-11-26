/**
 * The chord swipe (DESIGN.md §6.4): a two-finger horizontal swipe over the
 * sidebar or the minimal bar moves the chord panes with the fingers, blends
 * the tint toward the neighbor, and on release settles on the nearest chord.
 *
 * Chromium hands the shell wheel events (`deltaX`); they don't say when the
 * fingers lift, so on macOS main forwards the trackpad's gesture phases
 * (`gesture:phase`), and elsewhere the gesture ends when its events stop
 * (GestureEnd). Momentum after a release is ignored until it pauses, and
 * after a fling until the OS says a new gesture began. A mouse's tilt wheel
 * switches one chord per notch.
 */
import { animate, motionValue, type AnimationPlaybackControls, type MotionValue, type Transition } from 'motion/react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { api } from './api';
import { FLING_MOMENTUM_MAX_MS, GestureEnd, MOMENTUM_GAP_MS, VelocityTracker, isWheelNotch, lockAxis, rawOffset, settle, shownOffset } from './swipe';

/** How a chord pane comes and goes: the usual slide, a swipe's commit, or a crossfade (reduced motion). */
export type PaneMotion = { kind: 'slide'; dir: 1 | -1 } | { kind: 'swipe'; exitTo: number; transition: Transition } | { kind: 'fade'; transition: Transition };

/** A notch from a mouse's tilt wheel switches one chord, then waits this long before the next. */
const NOTCH_COOLDOWN_MS = 300;
/** If the switch never arrives (the chord went away), give up on the commit after this long. */
const COMMIT_TIMEOUT_MS = 800;
const FADE: Transition = { duration: 0.12 };

interface Options {
  /** The element the wheel events bubble to; swipes count inside its `[data-swipe-area]` children. */
  root: RefObject<HTMLElement | null>;
  /** The chord panes' container: its width is one chord. */
  track: RefObject<HTMLElement | null>;
  windowId: string;
  /** This window's chords, in switcher order. */
  chordIds: string[];
  currentId: string | undefined;
  /** Whether the panes are on screen (not with the sidebar collapsed, unless it peeks). */
  panes: boolean;
  /** The release spring (instant when "Slide between chords" is off). */
  release: Transition;
  /** The OS asks for less motion: releases crossfade instead of springing. */
  reduced: boolean;
  /** "Blend colors between chords" is on: the tint follows the fingers. */
  blend: boolean;
}

export interface ChordSwipe {
  /** Chords whose panes show beside the current one while a swipe tracks, settles or commits. */
  ghosts: { id: string; side: -1 | 1 }[];
  /** A chord pane's horizontal offset in px. */
  xFor(id: string): MotionValue<number>;
  /** How much of the neighbor's tint shows over the current one (0–1), and whose. */
  blend: MotionValue<number>;
  blendId: string | null;
  /** How the next chord change animates; null for the usual slide. */
  paneMotion: PaneMotion | null;
  /** The swipe already blended the tint: the switch shouldn't crossfade it again. */
  tintInstant: boolean;
}

/**
 * idle → deciding (which axis?) → tracking (panes follow) → settling (spring back) or committing
 * (switching chords). A gesture during a settle is `catching`: it takes the pane where it is once
 * it locks sideways. `vertical` gestures belong to the list until they end.
 */
type Phase = 'idle' | 'deciding' | 'catching' | 'vertical' | 'tracking' | 'settling' | 'committing';

export function useChordSwipe(options: Options): ChordSwipe {
  const latest = useRef(options);
  latest.current = options;
  const values = useRef(new Map<string, MotionValue<number>>());
  const xFor = (id: string) => {
    let value = values.current.get(id);
    if (!value) values.current.set(id, (value = motionValue(0)));
    return value;
  };
  const [blend] = useState(() => motionValue(0));
  const [ghosts, setGhosts] = useState<ChordSwipe['ghosts']>([]);
  const [blendId, setBlendId] = useState<string | null>(null);
  const [paneMotion, setPaneMotion] = useState<PaneMotion | null>(null);
  const [tintInstant, setTintInstant] = useState(false);

  const g = useRef({
    phase: 'idle' as Phase,
    dx: 0,
    dy: 0,
    raw: 0,
    shown: 0,
    lastAt: 0,
    ignoreUntil: 0,
    /** After a fling, momentum is ignored until a new begin, or until then (FLING_MOMENTUM_MAX_MS). */
    flungUntil: 0,
    /** The gesture's first event: never cancelled, so macOS starts its scroll and says when it began (its phases). */
    first: false,
    commitTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    tracker: new VelocityTracker(),
    context: null as null | { currentId: string; prevId: string | null; nextId: string | null; width: number },
    target: null as null | { id: string; transition: Transition },
    blendId: null as string | null,
    running: [] as AnimationPlaybackControls[],
    onSwitched: undefined as undefined | ((currentId: string | undefined) => void),
  });

  useEffect(() => {
    const s = g.current;
    const stopAll = () => {
      for (const a of s.running) a.stop();
      s.running = [];
    };
    const setBlendTo = (id: string | null) => {
      if (s.blendId === id) return;
      s.blendId = id;
      setBlendId(id);
    };
    // The gesture's end: the OS's on macOS, or when its events stop (GestureEnd). At the speed as of the last event, or
    // at rest (an end that never came, a hidden window): never a speed as old as the wait.
    const end = new GestureEnd(
      {
        now: () => performance.now(),
        frame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (id) => cancelAnimationFrame(id),
        timer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (id) => clearTimeout(id),
      },
      (at, speed) => release(at, speed === 'last' ? s.tracker.velocity(s.lastAt) : 0),
    );
    const reset = () => {
      end.stop();
      clearTimeout(s.commitTimer);
      s.phase = 'idle';
      s.context = null;
      s.target = null;
      setGhosts([]);
      setBlendTo(null);
      blend.jump(0);
      setPaneMotion(null);
      setTintInstant(false);
    };

    /** Position every pane for the current offset. */
    const place = () => {
      const c = s.context!;
      s.shown = shownOffset(s.raw, c.width, Boolean(c.prevId), Boolean(c.nextId));
      xFor(c.currentId).set(s.shown);
      if (c.prevId) xFor(c.prevId).set(s.shown - c.width);
      if (c.nextId) xFor(c.nextId).set(s.shown + c.width);
      const neighbor = s.shown < 0 ? c.nextId : s.shown > 0 ? c.prevId : null;
      setBlendTo(neighbor);
      blend.set(latest.current.blend && neighbor ? Math.min(1, Math.abs(s.shown) / c.width) : 0);
    };

    /** The gesture is sideways: the panes follow from here, caught where they are if settling. */
    const engage = (now: number, settling: boolean) => {
      const o = latest.current;
      if (!o.currentId) return false;
      const index = o.chordIds.indexOf(o.currentId);
      const prevId = o.chordIds[index - 1] ?? null;
      const nextId = o.chordIds[index + 1] ?? null;
      const width = o.track.current?.clientWidth || o.root.current?.querySelector('nav')?.clientWidth || 232;
      const current = xFor(o.currentId);
      const caught = settling ? current.get() : 0;
      const velocity = settling ? current.getVelocity() / 1000 : 0;
      stopAll();
      s.context = { currentId: o.currentId, prevId, nextId, width };
      s.raw = rawOffset(caught, width, Boolean(prevId), Boolean(nextId)) - s.dx;
      s.phase = 'tracking';
      if (o.panes) setGhosts([...(prevId ? [{ id: prevId, side: -1 as const }] : []), ...(nextId ? [{ id: nextId, side: 1 as const }] : [])]);
      place();
      // A caught pane keeps its speed, so it never jumps back to zero.
      s.tracker.reset(now, s.shown, velocity);
      return true;
    };

    const springBack = (velocity: number) => {
      const o = latest.current;
      const c = s.context!;
      s.phase = 'settling';
      const t: Transition = o.reduced ? { duration: 0 } : { ...o.release, velocity: velocity * 1000 };
      const run = (value: MotionValue<number>, to: number) => s.running.push(animate(value, to, t));
      run(xFor(c.currentId), 0);
      if (c.prevId) run(xFor(c.prevId), -c.width);
      if (c.nextId) run(xFor(c.nextId), c.width);
      run(blend, 0);
      void Promise.all(s.running.map((a) => a.finished)).then(() => {
        if (s.phase === 'settling' || s.phase === 'catching') reset();
      });
    };

    const commit = (dir: -1 | 1, velocity: number) => {
      const o = latest.current;
      const c = s.context!;
      const id = (dir === 1 ? c.nextId : c.prevId)!;
      s.phase = 'committing';
      const transition: Transition = o.reduced ? FADE : { ...o.release, velocity: velocity * 1000 };
      s.target = { id, transition };
      // Only the chord being committed to stays beside the current one until the switch arrives.
      if (o.panes) setGhosts([{ id, side: dir }]);
      setPaneMotion(o.reduced ? { kind: 'fade', transition } : { kind: 'swipe', exitTo: -dir * c.width, transition });
      setTintInstant(true);
      if (o.blend) s.running.push(animate(blend, 1, o.reduced ? FADE : transition));
      void api.state.dispatch({ t: 'chord.activate', windowId: o.windowId, chordId: id });
      s.commitTimer = setTimeout(() => {
        if (s.phase === 'committing') {
          xFor(c.currentId).jump(0);
          reset();
        }
      }, COMMIT_TIMEOUT_MS);
    };

    /** The gesture ended at `now`: settled or committed with `speed` (the tracker's as of `now` if not given). */
    const release = (now: number, speed?: number) => {
      end.stop();
      if (s.phase === 'deciding' || s.phase === 'vertical') {
        s.phase = 'idle';
        return;
      }
      // Ended before it locked sideways: the pane just finishes settling.
      if (s.phase === 'catching') {
        s.phase = 'settling';
        return;
      }
      if (s.phase !== 'tracking' || !s.context) return;
      s.ignoreUntil = now + MOMENTUM_GAP_MS;
      const c = s.context;
      const velocity = speed ?? s.tracker.velocity(now);
      const dir = settle(s.shown, velocity, c.width, Boolean(c.prevId), Boolean(c.nextId));
      if (dir === 0) springBack(velocity);
      else commit(dir, velocity);
    };

    /** A mouse notch: one chord over, with the usual slide. */
    const step = (dir: -1 | 1, now: number) => {
      const o = latest.current;
      const index = o.currentId ? o.chordIds.indexOf(o.currentId) : -1;
      const id = o.chordIds[index + dir];
      end.stop();
      s.ignoreUntil = now + NOTCH_COOLDOWN_MS;
      if (id) void api.state.dispatch({ t: 'chord.activate', windowId: o.windowId, chordId: id });
    };

    /** The page's own handling of a wheel event the swipe takes, stopped (where it can be: a latched one can't). */
    const cancel = (event: WheelEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    const onWheel = (event: WheelEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('[data-swipe-area]') || target.closest('input, textarea, [contenteditable="true"]')) return;
      // A switcher with more chords than fit scrolls sideways itself.
      const strip = target.closest('[role="tablist"]');
      if (strip && strip.scrollWidth > strip.clientWidth + 1) return;
      const now = performance.now();
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      // Momentum from the last release (or a notch's cooldown) is ignored until it pauses, unless the OS says a new
      // gesture began; after a fling, until it does (a stalled frame can leave a pause in the momentum). While a commit
      // plays out, everything waits. Nothing ignored is cancelled: a quick new touch's first event must start its scroll
      // for macOS to send its begin (a catch of a pane springing back), and nothing here scrolls sideways anyway.
      const resting = s.phase === 'idle' || s.phase === 'settling';
      if (s.phase === 'committing' || (resting && (now < s.ignoreUntil || now < s.flungUntil))) {
        if (sideways) s.ignoreUntil = Math.max(s.ignoreUntil, now + MOMENTUM_GAP_MS);
        return;
      }
      if (s.phase === 'idle') {
        if (sideways && isWheelNotch(event.deltaMode, event.deltaX, true)) {
          cancel(event);
          step(event.deltaX > 0 ? 1 : -1, now);
          return;
        }
        s.phase = 'deciding';
        s.dx = 0;
        s.dy = 0;
        s.first = true;
      } else if (s.phase === 'settling') {
        s.phase = 'catching';
        s.dx = 0;
        s.dy = 0;
        s.first = true;
      }
      const first = s.first;
      s.first = false;
      s.lastAt = now;
      if (s.phase === 'deciding' || s.phase === 'catching') {
        s.dx += event.deltaX;
        s.dy += event.deltaY;
        const axis = lockAxis(s.dx, s.dy);
        if (axis === 'horizontal') {
          // Not the first: macOS begins a scroll (and its phases) only on a first event that wasn't cancelled. The
          // sidebar's lists don't scroll sideways (overflow-x hidden), so it moves nothing.
          if (!first) cancel(event);
          engage(now, s.phase === 'catching');
        } else if (axis === 'vertical') {
          // Up and down is the list's; a pane that was settling just finishes.
          s.phase = s.phase === 'catching' ? 'settling' : 'vertical';
        }
        end.event(now);
        return;
      }
      if (s.phase === 'vertical') {
        end.event(now);
        return;
      }
      if (s.phase === 'tracking') {
        cancel(event);
        s.raw -= event.deltaX;
        place();
        s.tracker.add(now, s.shown);
        end.event(now);
      }
    };

    const root = latest.current.root.current;
    root?.addEventListener('wheel', onWheel, { passive: false });
    const unsubscribe = api.gestures.onPhase((phase) => {
      const now = performance.now();
      if (phase === 'begin') {
        // A new gesture, not momentum from the last one; it ends when the OS says (GestureEnd.begin).
        s.flungUntil = 0;
        if (s.phase === 'idle' || s.phase === 'settling') s.ignoreUntil = 0;
        if (s.phase !== 'committing') end.begin();
        return;
      }
      // A fling: the fingers left moving, at their speed as of the last event, however late a busy renderer reads it;
      // its momentum waits for the next begin. An end: they stopped, or lifted slowly; the speed is as of now, so a rest
      // before the lift reads as one.
      // Only a swipe's fling: one that ends a vertical scroll, or one outside the swipe area, leaves the next gesture alone.
      if (phase === 'fling') {
        const swiping = s.phase === 'tracking' && s.context !== null;
        release(now, s.tracker.velocity(s.lastAt));
        if (swiping) s.flungUntil = now + FLING_MOMENTUM_MAX_MS;
      } else release(now);
    });
    // Ended at once, at rest, where the fingers can't be followed any more: the window hidden, the command bar over it
    // (and main sends an end as the window loses focus).
    const endNow = () => release(performance.now(), 0);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') endNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const unsubscribeOverlay = api.layout.onOverlay((shown) => {
      if (shown) endNow();
    });

    // The switch arrived: the committed chord's pane is the current one now, and settles to 0.
    s.onSwitched = (currentId: string | undefined) => {
      if (s.phase !== 'committing' || !s.target || currentId !== s.target.id) return;
      clearTimeout(s.commitTimer);
      const { id, transition } = s.target;
      const value = xFor(id);
      if (latest.current.reduced) value.jump(0);
      const settling = animate(value, 0, latest.current.reduced ? { duration: 0 } : transition);
      s.running.push(settling);
      void settling.finished.then(() => {
        if (s.phase === 'committing' && s.target?.id === id) {
          stopAll();
          reset();
        }
      });
      // The pane is real now; its ghost can go.
      setGhosts([]);
    };

    return () => {
      root?.removeEventListener('wheel', onWheel);
      unsubscribe();
      unsubscribeOverlay();
      document.removeEventListener('visibilitychange', onVisibility);
      stopAll();
      end.stop();
      clearTimeout(s.commitTimer);
    };
    // The listeners read `latest`; they're attached once per window.
  }, [blend]);

  // Hand the chord change to the commit, in the render that shows the new chord.
  useEffect(() => {
    g.current.onSwitched?.(options.currentId);
  }, [options.currentId]);

  return { ghosts, xFor, blend, blendId, paneMotion, tintInstant };
}
