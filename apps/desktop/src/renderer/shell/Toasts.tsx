/**
 * Toasts (DESIGN.md §6.5, §7.5): short notes, usually with Undo, above the
 * sidebar footer (or one at a time in the minimal bar). Up to three stack
 * like a deck: older ones tuck behind the newest, each 6 px higher and a
 * little smaller, and fan out while you hover the stack or it has focus.
 * Each stays six seconds; the clocks pause while the deck is open.
 *
 * Screen readers hear each new toast once, through the stack's one polite
 * live region (DESIGN.md §10). ⌘Z / Ctrl+Z, while the shell has focus and no
 * text field does, presses the newest toast's Undo.
 */
import type { Toast } from '@chord/ipc';
import { durations, space } from '@chord/tokens';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { api } from './api';
import styles from './App.module.css';
import { useToasts, type ToastStore } from './toast-store';

/** The deck (DESIGN.md §6.5): each older toast sits this much higher, and this much smaller, than the one in front. */
const DECK_OFFSET = 6;
const DECK_SCALE = 0.96;
/** Between toasts when the deck fans out. */
const GAP = space[2];

/** Where a toast sits in the deck, from its resting place at the bottom of the stack. */
interface Place {
  y: number;
  scale: number;
  /** How much of its bottom is cut off, so a taller toast behind never shows below the one in front. */
  clip: number;
  behind: boolean;
}

/** A toast leaving with the focus inside hands it to the sidebar's tabs, so the keyboard isn't left nowhere. */
export function keepFocusFrom(card: HTMLElement | null): void {
  if (!card?.contains(document.activeElement)) return;
  document.querySelector<HTMLElement>('[role="tree"] [role="treeitem"][tabindex="0"]')?.focus();
}

function runAction(toast: Toast): void {
  const action = toast.action;
  if (!action) return;
  if ('update' in action) void api.updates.restart();
  else void api.state.dispatch(action.command);
}

function ToastCard({
  toast,
  transition,
  compact,
  paused,
  place,
  depth,
  onHeight,
  onDone,
}: {
  toast: Toast;
  transition: Transition;
  compact: boolean;
  paused: boolean;
  /** In the deck (the sidebar); the minimal bar's one toast has none. */
  place?: Place;
  depth: number;
  onHeight(id: string, height: number): void;
  onDone(): void;
}) {
  const left = useRef<number>(durations.toast);
  const card = useRef<HTMLDivElement>(null);
  const messageId = useId();
  const alsoId = useId();
  // The second line goes once answered; the first (with its Undo) stays.
  const [alsoDone, setAlsoDone] = useState(false);
  const also = alsoDone ? undefined : toast.also;
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(onDone, left.current);
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - started;
    };
  }, [paused, onDone]);
  // Its height places the toasts above it (transforms and clipping don't change it).
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || compact) return;
    onHeight(toast.id, el.offsetHeight);
    const observer = new ResizeObserver(() => onHeight(toast.id, el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [toast.id, compact, onHeight]);
  const first = (
    <>
      <span id={messageId} className={styles.toastMessage}>
        {toast.message}
      </span>
      {toast.action && (
        <button
          type="button"
          className={styles.toastAction}
          // Several toasts can each have an Undo: each names what it undoes.
          aria-describedby={messageId}
          onClick={() => {
            runAction(toast);
            keepFocusFrom(card.current);
            onDone();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </>
  );
  const alsoButton = (line: NonNullable<Toast['also']>, label: string) => (
    <button
      type="button"
      className={styles.toastAction}
      aria-describedby={label === line.message ? undefined : alsoId}
      onClick={() => {
        void api.state.dispatch(line.action.command);
        setAlsoDone(true);
      }}
    >
      {label}
    </button>
  );
  return (
    <motion.div
      ref={card}
      // Named by its message, so its Undo is found in context ("Moved to Work, group, Undo").
      role="group"
      aria-labelledby={messageId}
      className={`${styles.toast} ${also && !compact ? styles.toastTwoLines : ''}`}
      data-behind={place?.behind || undefined}
      style={place && { zIndex: -depth, transformOrigin: 'top center', clipPath: place.clip > 0 ? `inset(0 0 ${place.clip}px 0)` : undefined }}
      initial={{ opacity: 0, y: (place?.y ?? 0) + 12 }}
      animate={{ opacity: 1, y: place?.y ?? 0, scale: place?.scale ?? 1 }}
      exit={{ opacity: 0, y: (place?.y ?? 0) + 6, transition: { duration: durations.fadeFast / 1000 } }}
      transition={transition}
      // A click on the toast itself, not one of its buttons, dismisses it, as a notification's does.
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        keepFocusFrom(card.current);
        onDone();
      }}
    >
      {also && !compact ? (
        <>
          <div className={styles.toastLine}>{first}</div>
          <div className={styles.toastLine}>
            <span id={alsoId} className={styles.toastMessage}>
              {also.message}
            </span>
            {alsoButton(also, also.action.label)}
          </div>
        </>
      ) : (
        <>
          {first}
          {/* One line in the minimal bar: the second line's question is its button. */}
          {also && alsoButton(also, also.message)}
        </>
      )}
    </motion.div>
  );
}

/** `undoKeys`: this stack answers ⌘Z (the one in view; both show while the collapsed sidebar peeks). */
export function Toasts({ store, transition, compact, undoKeys, mac }: { store: ToastStore; transition: Transition; compact: boolean; undoKeys: boolean; mac: boolean }) {
  const toasts = useToasts(store);
  const dismiss = (id: string) => store.dismiss(id);
  const shown = compact ? toasts.slice(0, 1) : toasts;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovered || focused;
  const [heights, setHeights] = useState<Record<string, number>>({});
  const onHeight = useCallback((id: string, height: number) => setHeights((was) => (was[id] === height ? was : { ...was, [id]: height })), []);

  // Newest in front, at the bottom. Fanned out, each toast sits a gap above the ones below it;
  // tucked in, each is 6 px higher than the one in front, cut to the front one's height.
  const front = (shown[0] && heights[shown[0].id]) ?? 0;
  let below = 0;
  const places = shown.map((toast, i): Place => {
    const height = heights[toast.id] ?? front;
    const place = open
      ? { y: -below, scale: 1, clip: 0, behind: false }
      : { y: height - front - i * DECK_OFFSET, scale: DECK_SCALE ** i, clip: Math.max(0, height - front), behind: i > 0 };
    below += height + GAP;
    return place;
  });
  // In the sidebar the stack takes the tucked-in deck's height; fanned out, it spreads up over the tabs.
  const height = shown.length ? front + (shown.length - 1) * DECK_OFFSET : 0;

  // ⌘Z / Ctrl+Z undoes what the newest toast offers to undo (DESIGN.md §7.5), unless a text field wants the key.
  const newest = toasts.find((t) => t.action && !('update' in t.action));
  useEffect(() => {
    if (!newest || !undoKeys) return;
    const onKey = (event: KeyboardEvent) => {
      const mod = mac ? event.metaKey : event.ctrlKey;
      if (!mod || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z' || event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      runAction(newest);
      dismiss(newest.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [newest, undoKeys, mac]);

  return (
    // The stack is one live region (and a landmark to find them by); each new toast is announced once, on its own.
    <motion.div
      className={compact ? styles.toastsInline : styles.toasts}
      data-open={(!compact && open) || undefined}
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions"
      initial={false}
      animate={compact ? undefined : { height }}
      transition={transition}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <AnimatePresence initial={false}>
        {shown.map((toast, i) => (
          <ToastCard
            key={toast.id}
            toast={toast}
            transition={transition}
            compact={compact}
            paused={open}
            place={compact ? undefined : places[i]}
            depth={i}
            onHeight={onHeight}
            onDone={() => dismiss(toast.id)}
          />
        ))}
      </AnimatePresence>
    </motion.div>
  );
}
