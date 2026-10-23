/**
 * Extension buttons (ARCHITECTURE.md §12): one per extension with an action,
 * for the current tab, with its badge. A click opens its popup under the
 * button; right-click for its menu. On a Chrome Web Store page, "Add to
 * Chord" installs the extension shown.
 */
import type { ExtensionAction, ExtensionsBarState, Rect } from '@chord/ipc';
import { Plus, Puzzle } from 'lucide-react';
import { useEffect, useState, type MouseEvent } from 'react';
import { api } from './api';
import styles from './Extensions.module.css';

const EMPTY: ExtensionsBarState = { actions: [], offer: null, installing: null };

/** The window's extension buttons, kept current by main. */
export function useExtensionsBar(): ExtensionsBarState {
  const [bar, setBar] = useState(EMPTY);
  useEffect(() => {
    let live = true;
    const off = api.extensions.onState(setBar);
    void api.extensions.state().then((state) => live && setBar(state));
    return () => {
      live = false;
      off();
    };
  }, []);
  return bar;
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

/** The first line of an action's title: some put instructions on later lines. */
const label = (action: ExtensionAction) => action.title.split('\n')[0] || 'Extension';

function ActionButton({ action }: { action: ExtensionAction }) {
  const name = label(action);
  return (
    <button
      type="button"
      className={styles.action}
      aria-label={action.badgeText ? `${name}, ${action.badgeText}` : name}
      title={action.title}
      onClick={(e) => void api.extensions.activate(action.id, rectOf(e.currentTarget))}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        void api.extensions.menu(action.id, { x: e.clientX, y: e.clientY });
      }}
    >
      {action.icon ? <img className={styles.icon} src={action.icon} alt="" draggable={false} /> : <Puzzle size={16} strokeWidth={1.75} aria-hidden />}
      {action.badgeText && (
        <span className={styles.badge} style={action.badgeColor ? { backgroundColor: action.badgeColor } : undefined} aria-hidden>
          {action.badgeText.slice(0, 4)}
        </span>
      )}
    </button>
  );
}

/**
 * The buttons, at most `max` of them; the rest are a menu behind the puzzle
 * piece. Renders nothing when there are no extensions and nothing to offer.
 */
export function ExtensionButtons({ bar, max }: { bar: ExtensionsBarState; max: number }) {
  const sorted = [...bar.actions].sort((a, b) => label(a).localeCompare(label(b)));
  const fits = sorted.length <= max;
  const shown = fits ? sorted : sorted.slice(0, Math.max(0, max - 1));
  const hidden = fits ? [] : sorted.slice(shown.length);
  if (sorted.length === 0 && !bar.offer) return null;
  return (
    <div className={styles.group} role="toolbar" aria-label="Extensions">
      {bar.offer && (
        <button
          type="button"
          className={styles.add}
          disabled={bar.installing === bar.offer.id}
          onClick={() => bar.offer && void api.extensions.install(bar.offer.id)}
        >
          <Plus size={14} strokeWidth={2.25} aria-hidden />
          {bar.installing === bar.offer.id ? 'Adding…' : 'Add to Chord'}
        </button>
      )}
      {shown.map((action) => (
        <ActionButton key={action.id} action={action} />
      ))}
      {hidden.length > 0 && (
        <button
          type="button"
          className={styles.action}
          aria-label={`${hidden.length} more extensions`}
          aria-haspopup="menu"
          title="More extensions"
          onClick={(e) =>
            void api.extensions.overflow(
              hidden.map((a) => a.id),
              rectOf(e.currentTarget),
            )
          }
        >
          <Puzzle size={16} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </div>
  );
}
