/**
 * Extension buttons (ARCHITECTURE.md §12, DESIGN.md §3). By default they
 * live in a slim shelf above the sidebar's footer, out of the header; Settings
 * can move them to the title bar. Only pinned extensions get a button; the
 * puzzle piece lists them all. A click opens an extension's popup under its
 * button; right-click for its menu (Unpin, Remove, Settings). On a Chrome Web
 * Store page, "Add to Chord" installs the extension shown.
 */
import type { ExtensionAction, ExtensionsBarState, Rect } from '@chord/ipc';
import { Plus, Puzzle } from 'lucide-react';
import { useEffect, useState, type MouseEvent } from 'react';
import { inNextFrame } from '../shared/frames';
import { api } from './api';
import styles from './Extensions.module.css';

const EMPTY: ExtensionsBarState = { actions: [], installed: 0, offer: null, installing: null };

/** The window's extension buttons, kept current by main. */
export function useExtensionsBar(): ExtensionsBarState {
  const [bar, setBar] = useState(EMPTY);
  useEffect(() => {
    let live = true;
    // A push can arrive before the answer and be the newer of the two (live.ts says why): it wins.
    let pushed = false;
    // In the frame with the state patches (a tab switch sends both), so they render once (shared/frames.ts).
    const show = inNextFrame(setBar);
    const off = api.extensions.onState((state) => {
      pushed = true;
      show(state);
    });
    void api.extensions.state().then((state) => live && !pushed && setBar(state));
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
export const actionName = (action: ExtensionAction) => action.title.split('\n')[0] || 'Extension';

function ActionButton({ action }: { action: ExtensionAction }) {
  const name = actionName(action);
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

/** Every extension, in a list under this button (the command bar's overlay hosts it, so it can float over the page). */
function PuzzleButton() {
  return (
    <button
      type="button"
      className={styles.action}
      aria-label="Extensions"
      aria-haspopup="dialog"
      title="Extensions"
      onClick={(e) => void api.overlay.open('extensions', rectOf(e.currentTarget))}
    >
      <Puzzle size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

function AddButton({ bar }: { bar: ExtensionsBarState }) {
  if (!bar.offer) return null;
  const busy = bar.installing === bar.offer.id;
  return (
    <button type="button" className={styles.add} disabled={busy} onClick={() => bar.offer && void api.extensions.install(bar.offer.id)}>
      <Plus size={14} strokeWidth={2.25} aria-hidden />
      {busy ? 'Adding…' : 'Add to Chord'}
    </button>
  );
}

/** Whether there's anything to show: extensions in this profile, or a Web Store page to add one from. */
export const hasExtensionsUi = (bar: ExtensionsBarState) => bar.installed > 0 || bar.offer !== null;

/** The sidebar's shelf: pinned buttons, then the puzzle piece at the end. */
export function ExtensionsShelf({ bar }: { bar: ExtensionsBarState }) {
  if (!hasExtensionsUi(bar)) return null;
  return (
    <div className={styles.shelf} role="toolbar" aria-label="Extensions" data-placement="sidebar">
      <AddButton bar={bar} />
      {bar.actions
        .filter((a) => a.pinned)
        .map((action) => (
          <ActionButton key={action.id} action={action} />
        ))}
      <span className={styles.flex} />
      {bar.installed > 0 && <PuzzleButton />}
    </div>
  );
}

/**
 * Extension buttons in a top bar. `puzzleOnly`: the minimal bar while
 * buttons belong to the sidebar, so popups stay one click away without
 * putting icons in the header.
 */
export function ExtensionButtons({ bar, puzzleOnly }: { bar: ExtensionsBarState; puzzleOnly: boolean }) {
  if (!hasExtensionsUi(bar)) return null;
  return (
    <div className={styles.group} role="toolbar" aria-label="Extensions" data-placement="bar">
      <AddButton bar={bar} />
      {!puzzleOnly &&
        bar.actions
          .filter((a) => a.pinned)
          .map((action) => (
            <ActionButton key={action.id} action={action} />
          ))}
      {bar.installed > 0 && <PuzzleButton />}
    </div>
  );
}
