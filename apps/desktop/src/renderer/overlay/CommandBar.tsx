/**
 * The command bar (DESIGN.md §7.3). Always mounted in the overlay view, so
 * opening is a state change, not a page load. Two placements: centered for a
 * new tab (⌘T), anchored on the address for editing in place (⌘L).
 */
import { formatKeys, shortcutById, type ActionId } from '@chord/core';
import type { HistorySearch, OverlayOpenEvent, SystemInfo } from '@chord/ipc';
import {
  ArrowDown,
  ArrowUp,
  Code,
  CornerDownLeft,
  Globe,
  History,
  Keyboard,
  Link,
  Maximize,
  PanelLeft,
  Pin,
  Printer,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  SquareTerminal,
  TextSearch,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { motion, MotionConfig } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Favicon } from '../shared/Favicon';
import { useMirror, type Mirror } from '../shared/mirror';
import { applyMotion, reducedMotionMode, springsFor } from '../shared/motion';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './CommandBar.module.css';
import { DownloadsPanel } from './DownloadsPanel';
import { buildResults, destinationOf, type Result } from './results';

interface Session {
  mode: OverlayOpenEvent['mode'];
  anchor: OverlayOpenEvent['anchor'];
  /** Changes on every open, replaying the entrance animation. */
  openedAt: number;
  /** What the field opened with (the address, for ⌘L): a pick is only learned once the person typed. */
  initial: string;
  /** Main's number for this opening; closing names it. */
  seq: number;
}

const ACTION_ICONS: Partial<Record<ActionId, typeof X>> = {
  'tab.reopen': RotateCcw,
  'tab.close': X,
  'tab.pin': Pin,
  'address.copy': Link,
  'address.copyMarkdown': Link,
  'tab.next': ArrowDown,
  'tab.previous': ArrowUp,
  'nav.hardReload': RotateCw,
  'view.toggleSidebar': PanelLeft,
  'view.find': TextSearch,
  'view.zoomIn': ZoomIn,
  'view.zoomOut': ZoomOut,
  'view.zoomReset': Search,
  'view.fullscreen': Maximize,
  'page.print': Printer,
  'page.viewSource': Code,
  'app.devtools': SquareTerminal,
  'app.settings': Settings,
  'chord.delete': Trash2,
  'app.shortcuts': Keyboard,
};

/** Anchored panels are at least this wide, so results have room beside a narrow sidebar. */
const ANCHORED_MIN_WIDTH = 560;
const EDGE = 8;

function keycapFor(action: ActionId, platform: SystemInfo['platform']): string {
  const sc = shortcutById(action);
  const first = sc ? (platform === 'darwin' ? sc.mac : sc.other)[0] : undefined;
  return first ? formatKeys(first, platform) : '';
}

function hintFor(result: Result, mode: Session['mode']): string {
  if (result.kind === 'tab') return 'Switch to tab';
  if (result.kind === 'action') return 'Run';
  if (result.kind === 'chord') return 'Switch to chord';
  if (result.kind === 'history') return mode === 'edit' ? 'Go' : 'Open';
  if (result.search) return 'Search';
  return mode === 'edit' ? 'Go' : 'Open';
}

export function CommandBar({ initialInfo, mirror }: { initialInfo: SystemInfo; mirror: Mirror }) {
  const [info, setInfo] = useState(initialInfo);
  useEffect(() => api.system.onChange(setInfo), []);
  const state = useMirror(mirror);
  const windowId = mirror.windowId;
  const win = state.windows[windowId];
  const { style, appearance } = chordStyle(win ? state.chords[win.activeChordId] : undefined, info, state.settings.interface);
  const spring = springsFor(state.settings, info.prefersReducedMotion);
  useEffect(() => applyMotion(state.settings, info.prefersReducedMotion), [state.settings, info.prefersReducedMotion]);

  const [session, setSession] = useState<Session | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      api.overlay.onOpen((event) => {
        setSession({ mode: event.mode, anchor: event.anchor, openedAt: performance.now(), initial: event.mode === 'edit' ? event.url : '', seq: event.seq });
        setQuery(event.mode === 'edit' ? event.url : '');
        setSelected(0);
      }),
    [],
  );

  // Typeable on the first frame (DESIGN.md §6.7): focus before the entrance animation runs.
  useLayoutEffect(() => {
    if (!session) return;
    const input = inputRef.current;
    input?.focus();
    if (session.mode === 'edit' && input) {
      input.select();
      // Show where the address starts, not where it ends.
      input.scrollLeft = 0;
    }
  }, [session]);

  // History and learned picks come from chord-data as the person types. A reply for older text is
  // dropped; until the new one lands, the last reply keeps rows from flickering away.
  const [history, setHistory] = useState<HistorySearch | null>(null);
  const searchSeq = useRef(0);
  useEffect(() => {
    if (!session || session.mode === 'downloads' || !query.trim()) return;
    const seq = ++searchSeq.current;
    void api.history.search(query.trim()).then((found) => {
      if (seq === searchSeq.current) setHistory(found);
    });
  }, [session, query]);

  const results = useMemo(
    () => (session && session.mode !== 'downloads' ? buildResults(query, state, windowId, session.mode, history) : []),
    [session, query, state, windowId, history],
  );
  const current = Math.min(selected, Math.max(0, results.length - 1));

  const close = () => {
    if (session) void api.overlay.close(session.seq);
    setSession(null);
  };

  const run = (result: Result, background: boolean) => {
    const dispatch = api.state.dispatch;
    const activeId = win ? win.activeTab[win.activeChordId] : null;
    // Learn the pick for what was typed (Crest's learned picks), and count a typed visit.
    const typed = query.trim();
    const destination = destinationOf(result);
    if (typed && typed !== session?.initial && destination) {
      const address = result.kind === 'open' || result.kind === 'history' ? result.url : result.kind === 'tab' ? result.tab.url : undefined;
      void api.history.choose(typed, destination, address && /^https?:/i.test(address) ? address : undefined);
    }
    if (result.kind === 'open' || result.kind === 'history') {
      if (session?.mode === 'edit' && activeId && !background) void dispatch({ t: 'tab.navigate', nodeId: activeId, url: result.url });
      else void dispatch({ t: 'tab.open', windowId, url: result.url, background });
    } else if (result.kind === 'tab') {
      void dispatch({ t: 'tab.activate', windowId, nodeId: result.tab.id });
    } else if (result.kind === 'chord') {
      void dispatch({ t: 'chord.activate', windowId, chordId: result.chord.id });
    }
    close();
    // Actions run after the bar closes, so focus is back on the page (print, devtools, zoom act on it).
    if (result.kind === 'action') void api.action.run(result.action);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSelected((current + step + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = results[current];
      // ⌘↵ / Ctrl+↵: open in a new background tab (DESIGN.md §14.3).
      if (result) run(result, info.platform === 'darwin' ? event.metaKey : event.ctrlKey);
    }
  };

  if (!session) return null;

  // The downloads panel shares the overlay: modal like the command bar, but without dimming the page.
  if (session.mode === 'downloads') {
    return (
      <MotionConfig reducedMotion={reducedMotionMode(state.settings)}>
        <div className={styles.root} style={style}>
          <div className={styles.clearScrim} onMouseDown={close} />
          <DownloadsPanel state={state} anchor={session.anchor} transition={spring('overlay', 'commandBar')} onClose={close} />
        </div>
      </MotionConfig>
    );
  }

  const anchored = session.mode === 'edit' && session.anchor !== null;
  const anchor = session.anchor;
  const panelStyle: CSSProperties | undefined =
    anchored && anchor
      ? {
          left: anchor.x,
          top: anchor.y,
          inlineSize: Math.min(Math.max(anchor.width, ANCHORED_MIN_WIDTH), window.innerWidth - anchor.x - EDGE),
        }
      : undefined;
  const entrance = anchored ? { opacity: 0, y: -4 } : { opacity: 0, scale: 0.97, y: -8 };
  const InputIcon = query && results[0]?.kind === 'open' && !results[0].search ? Globe : Search;

  return (
    <MotionConfig reducedMotion={reducedMotionMode(state.settings)}>
      <div className={styles.root} style={style}>
        <motion.div
          className={styles.scrim}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={spring('gentle', 'commandBar')}
          onMouseDown={close}
        />
        <div className={anchored ? undefined : styles.frameArea}>
          <motion.div
            key={session.openedAt}
            className={`${styles.panel} ${anchored ? styles.anchored : styles.centered}`}
            style={panelStyle}
            initial={entrance}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={spring('overlay', 'commandBar')}
            role="dialog"
            aria-label={anchored ? 'Edit address' : 'New tab'}
          >
            <div className={styles.inputRow}>
              <InputIcon className={styles.inputIcon} size={anchored ? 14 : 18} strokeWidth={1.75} aria-hidden />
              <input
                ref={inputRef}
                className={styles.input}
                value={query}
                placeholder="Search or enter address"
                spellCheck={false}
                autoComplete="off"
                aria-autocomplete="list"
                aria-controls="command-results"
                aria-activedescendant={results[current] ? `result-${current}` : undefined}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(0);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
            {results.length > 0 && (
              <ul id="command-results" className={styles.results} role="listbox">
                {results.map((result, i) => {
                  const Icon =
                  result.kind === 'action'
                    ? (ACTION_ICONS[result.action] ?? CornerDownLeft)
                    : result.kind === 'history'
                      ? History
                      : result.kind === 'open'
                        ? result.search
                          ? Search
                          : Globe
                        : null;
                  const isSelected = i === current;
                  return (
                    <li
                      key={result.key}
                      id={`result-${i}`}
                      role="option"
                      aria-selected={isSelected}
                      className={`${styles.result} ${isSelected ? styles.selected : ''}`}
                      onMouseMove={() => i !== current && setSelected(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => run(result, info.platform === 'darwin' ? e.metaKey : e.ctrlKey)}
                    >
                      {result.kind === 'tab' ? (
                        <Favicon url={result.tab.url} title={result.tab.title} favicon={result.tab.favicon} appearance={appearance} />
                      ) : result.kind === 'chord' ? (
                        <span className={styles.chordGlyph} aria-hidden>
                          {result.chord.icon}
                        </span>
                      ) : (
                        Icon && <Icon className={styles.resultIcon} size={16} strokeWidth={1.75} aria-hidden />
                      )}
                      <span className={styles.resultTitle}>{result.title}</span>
                      {(result.kind === 'open' || result.kind === 'tab' || result.kind === 'history') && result.detail && (
                        <span className={styles.resultDetail}>{result.detail}</span>
                      )}
                      {result.kind === 'chord' && <span className={styles.resultDetail}>Chord</span>}
                      {result.kind === 'tab' && result.chordName && <span className={styles.chip}>{result.chordName}</span>}
                      {result.kind === 'action' && <kbd className={styles.keycap}>{keycapFor(result.action, info.platform)}</kbd>}
                      {isSelected && (
                        <span className={styles.hint}>
                          {hintFor(result, session.mode)} <kbd className={styles.keycap}>↵</kbd>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </motion.div>
        </div>
      </div>
    </MotionConfig>
  );
}
