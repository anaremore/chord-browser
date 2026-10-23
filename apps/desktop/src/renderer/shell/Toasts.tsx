/**
 * Toasts (DESIGN.md §6.5, §7.5): short notes, usually with Undo, stacked
 * above the sidebar footer (or one at a time in the minimal bar). Each stays
 * six seconds, and the clock pauses while you hover it or it has focus.
 *
 * Screen readers hear each new toast once, through the stack's one polite
 * live region (DESIGN.md §10). ⌘Z / Ctrl+Z, while the shell has focus and no
 * text field does, presses the newest toast's Undo.
 */
import type { Toast } from '@chord/ipc';
import { durations } from '@chord/tokens';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from './api';
import styles from './App.module.css';

/** At most this many at once; older ones give way. */
const MAX_TOASTS = 3;

/** A toast leaving with the focus inside hands it to the sidebar's tabs, so the keyboard isn't left nowhere. */
function keepFocusFrom(card: HTMLElement | null): void {
  if (!card?.contains(document.activeElement)) return;
  document.querySelector<HTMLElement>('[role="tree"] [role="treeitem"][tabindex="0"]')?.focus();
}

function runAction(toast: Toast): void {
  const action = toast.action;
  if (!action) return;
  if ('update' in action) void api.updates.restart();
  else void api.state.dispatch(action.command);
}

function ToastCard({ toast, transition, compact, onDone }: { toast: Toast; transition: Transition; compact: boolean; onDone(): void }) {
  const left = useRef<number>(durations.toast);
  const card = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
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
      layout
      // Named by its message, so its Undo is found in context ("Moved to Work, group, Undo").
      role="group"
      aria-labelledby={messageId}
      className={`${styles.toast} ${also && !compact ? styles.toastTwoLines : ''}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6, transition: { duration: durations.fadeFast / 1000 } }}
      transition={transition}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
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
export function Toasts({ transition, compact, undoKeys, mac }: { transition: Transition; compact: boolean; undoKeys: boolean; mac: boolean }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(
    () =>
      api.toasts.onShow((toast) =>
        // The same toast again (deleting twice) replaces the old one rather than stacking.
        setToasts((all) => [toast, ...all.filter((t) => t.id !== toast.id)].slice(0, MAX_TOASTS)),
      ),
    [],
  );
  const dismiss = (id: string) => setToasts((all) => all.filter((t) => t.id !== id));
  const shown = compact ? toasts.slice(0, 1) : toasts;

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
    <div className={compact ? styles.toastsInline : styles.toasts} role="region" aria-label="Notifications" aria-live="polite" aria-atomic="false" aria-relevant="additions">
      <AnimatePresence initial={false}>
        {shown.map((toast) => (
          <ToastCard key={toast.id} toast={toast} transition={transition} compact={compact} onDone={() => dismiss(toast.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}
