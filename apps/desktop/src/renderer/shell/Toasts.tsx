/**
 * Toasts (DESIGN.md §6.5, §7.5): short notes, usually with Undo, stacked
 * above the sidebar footer (or one at a time in the minimal bar). Each stays
 * six seconds, and the clock pauses while you hover it.
 */
import type { Toast } from '@chord/ipc';
import { durations } from '@chord/tokens';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import styles from './App.module.css';
import { useToasts, type ToastStore } from './toast-store';

function ToastCard({ toast, transition, compact, onDone }: { toast: Toast; transition: Transition; compact: boolean; onDone(): void }) {
  const left = useRef<number>(durations.toast);
  const [paused, setPaused] = useState(false);
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
      <span className={styles.toastMessage}>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className={styles.toastAction}
          onClick={() => {
            const action = toast.action!;
            if ('update' in action) void api.updates.restart();
            else void api.state.dispatch(action.command);
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
      layout
      className={`${styles.toast} ${also && !compact ? styles.toastTwoLines : ''}`}
      role="status"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6, transition: { duration: durations.fadeFast / 1000 } }}
      transition={transition}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      {also && !compact ? (
        <>
          <div className={styles.toastLine}>{first}</div>
          <div className={styles.toastLine}>
            <span className={styles.toastMessage}>{also.message}</span>
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

export function Toasts({ store, transition, compact }: { store: ToastStore; transition: Transition; compact: boolean }) {
  const toasts = useToasts(store);
  const dismiss = (id: string) => store.dismiss(id);
  const shown = compact ? toasts.slice(0, 1) : toasts;
  return (
    <div className={compact ? styles.toastsInline : styles.toasts} aria-live="polite">
      <AnimatePresence initial={false}>
        {shown.map((toast) => (
          <ToastCard key={toast.id} toast={toast} transition={transition} compact={compact} onDone={() => dismiss(toast.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}
