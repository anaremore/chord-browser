/**
 * What the shell says to screen readers that isn't on screen as text
 * (DESIGN.md §10): chord switches, Duet finishing an answer, a row picked up
 * or moved with the keyboard. One polite live region for the window, so
 * announcements queue instead of talking over each other.
 */
import { useEffect, useState } from 'react';

type Listener = (text: string) => void;
const listeners = new Set<Listener>();

/** Say `text` politely, once (the same words again are said again). */
export function announce(text: string): void {
  for (const listener of listeners) listener(text);
}

export function Announcer() {
  const [text, setText] = useState('');
  useEffect(() => {
    let frame = 0;
    const listener: Listener = (next) => {
      // Clearing first makes a repeat of the same words a change a screen reader hears.
      setText('');
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setText(next));
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="announcer">
      {text}
    </div>
  );
}
