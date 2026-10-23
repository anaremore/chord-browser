/**
 * The command bar (DESIGN.md §7.3). Always mounted in the overlay view, so
 * opening is a state change, not a page load. Two placements: centered for a
 * new tab (⌘T), anchored on the address for editing in place (⌘L).
 *
 * Typing completes the leading page's address inline (Tab accepts), a site
 * keyword or `@filter` followed by Tab narrows the bar to a chip, and the
 * engine's suggestions slot in under the local rows when they arrive.
 */
import { formatKeys, parseInput, shortcutById, type ActionId, type SearchEngineId } from '@chord/core';
import type { HistorySearch, OverlayOpenEvent, SystemInfo } from '@chord/ipc';
import {
  AppWindow,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Code,
  Command,
  CornerDownLeft,
  Globe,
  History,
  Keyboard,
  Layers,
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
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { Favicon } from '../shared/Favicon';
import { useMirror, type Mirror } from '../shared/mirror';
import { applyMotion, reducedMotionMode, springsFor } from '../shared/motion';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './CommandBar.module.css';
import { DownloadsPanel } from './DownloadsPanel';
import { buildResults, completionFor, destinationOf, scopeFor, scopeLabel, type Filter, type Result, type Scope } from './results';

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

/**
 * Where a result opens (DESIGN.md §7.3): ↵ here (this tab when editing its
 * address), ⌘↵ / Ctrl+↵ a new background tab, ⇧↵ a new tab in front. ⇧↵ is
 * a new window in the spec; it opens a tab until Chord has more than one window.
 */
type Where = 'here' | 'background' | 'front';

const ACTION_ICONS: Partial<Record<ActionId, typeof X>> = {
  'tab.reopen': RotateCcw,
  'app.history': Archive,
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

const FILTER_ICONS: Record<Filter, typeof X> = { tabs: AppWindow, pinned: Pin, history: History, archive: Archive, chords: Layers, actions: Command };
const scopeIcon = (scope: Scope) => (scope.kind === 'filter' ? FILTER_ICONS[scope.filter] : Search);

/** Anchored panels are at least this wide, so results have room beside a narrow sidebar. */
const ANCHORED_MIN_WIDTH = 560;
const EDGE = 8;
/** Suggestions wait for a pause this long in typing, so not every keystroke goes out. */
const SUGGEST_DELAY_MS = 120;

function keycapFor(action: ActionId, platform: SystemInfo['platform']): string {
  const sc = shortcutById(action);
  const first = sc ? (platform === 'darwin' ? sc.mac : sc.other)[0] : undefined;
  return first ? formatKeys(first, platform) : '';
}

function hintFor(result: Result, mode: Session['mode']): { text: string; key: string } {
  if (result.kind === 'scope') return { text: result.scope.kind === 'keyword' ? `Search ${scopeLabel(result.scope).name}` : 'Show only these', key: result.scope.kind === 'keyword' ? 'Tab' : '↵' };
  if (result.kind === 'tab') return { text: 'Switch to tab', key: '↵' };
  if (result.kind === 'action') return { text: 'Run', key: '↵' };
  if (result.kind === 'chord') return { text: 'Switch to chord', key: '↵' };
  if (result.kind === 'history') return { text: mode === 'edit' ? 'Go' : 'Open', key: '↵' };
  if (result.kind === 'archive') return { text: 'Bring back', key: '↵' };
  if (result.search) return { text: 'Search', key: '↵' };
  return { text: mode === 'edit' ? 'Go' : 'Open', key: '↵' };
}

/** Which engine to ask for suggestions: the setting's, a keyword's own engine, or none (sites, filters). */
function suggestionEngine(scope: Scope | null): SearchEngineId | undefined | null {
  if (!scope) return undefined;
  return scope.kind === 'keyword' ? (scope.keyword.engine ?? null) : null;
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
  /** What the person typed; the field shows it plus any inline completion. */
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [scope, setScope] = useState<Scope | null>(null);
  /** Whether the last edit may complete: typing at the end does; deleting never brings back what was deleted. */
  const [mayComplete, setMayComplete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      api.overlay.onOpen((event) => {
        setSession({ mode: event.mode, anchor: event.anchor, openedAt: performance.now(), initial: event.mode === 'edit' ? event.url : '', seq: event.seq });
        setQuery(event.mode === 'edit' ? event.url : '');
        setSelected(0);
        setScope(null);
        setMayComplete(false);
        setSuggested(null);
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
  // dropped; until the new one lands, the last reply keeps rows from flickering away. `@history`
  // asks even before anything is typed, as does `@archive`: recent pages, newest archived tabs.
  const [history, setHistory] = useState<HistorySearch | null>(null);
  const searchSeq = useRef(0);
  const historyFilter = scope?.kind === 'filter' && (scope.filter === 'history' || scope.filter === 'archive');
  useEffect(() => {
    if (!session || session.mode === 'downloads' || (!query.trim() && !historyFilter)) return;
    const seq = ++searchSeq.current;
    void api.history.search(query.trim()).then((found) => {
      if (seq === searchSeq.current) setHistory(found);
    });
  }, [session, query, historyFilter]);

  // The engine's suggestions (Settings → General), after a pause in typing. Typed addresses are never
  // sent. A reply for older text is dropped; while the next one is on its way, older suggestions that
  // still fit what's typed stay, so the rows don't flicker.
  const [suggested, setSuggested] = useState<{ text: string; items: string[] } | null>(null);
  const suggestSeq = useRef(0);
  const engineForSuggestions = suggestionEngine(scope);
  useEffect(() => {
    const text = query.trim();
    const wanted =
      session &&
      session.mode !== 'downloads' &&
      state.settings.searchSuggestions &&
      engineForSuggestions !== null &&
      text !== session.initial &&
      parseInput(text)?.kind === 'search' &&
      // A filter being typed (`@hi`) never goes out.
      !/^@\S*$/.test(text);
    if (!wanted) {
      suggestSeq.current++;
      return;
    }
    const seq = ++suggestSeq.current;
    const timer = setTimeout(() => {
      void api.search.suggest(text, engineForSuggestions).then((items) => {
        if (seq === suggestSeq.current) setSuggested({ text, items });
      });
    }, SUGGEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [session, query, engineForSuggestions, state.settings.searchSuggestions]);
  const typedNow = query.trim().toLocaleLowerCase();
  const suggestions = useMemo(
    () =>
      state.settings.searchSuggestions && suggested && engineForSuggestions !== null && typedNow
        ? suggested.items.filter((s) => s.toLocaleLowerCase().startsWith(typedNow) || suggested.text.toLocaleLowerCase() === typedNow)
        : [],
    [suggested, typedNow, engineForSuggestions, state.settings.searchSuggestions],
  );

  const results = useMemo(
    () => (session && session.mode !== 'downloads' ? buildResults(query, state, windowId, session.mode, history, Date.now(), { scope, suggestions }) : []),
    [session, query, state, windowId, history, scope, suggestions],
  );
  const current = Math.min(selected, Math.max(0, results.length - 1));
  // Inline autocomplete: only the leading row completes, and only while it's the one selected.
  const completion = mayComplete && !scope && current === 0 ? completionFor(query, results[0]) : '';

  // The completed part stays selected, so typing on replaces it and Backspace removes it.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && completion && document.activeElement === input) input.setSelectionRange(query.length, query.length + completion.length);
  }, [query, completion]);

  const close = () => {
    if (session) void api.overlay.close(session.seq);
    setSession(null);
  };

  const enterScope = (next: Scope) => {
    setScope(next);
    setQuery('');
    setSelected(0);
    setMayComplete(false);
    setSuggested(null);
  };

  const run = (result: Result, where: Where) => {
    if (result.kind === 'scope') {
      enterScope(result.scope);
      return;
    }
    const dispatch = api.state.dispatch;
    const activeId = win ? win.activeTab[win.activeChordId] : null;
    // Learn the pick for what was typed (Crest's learned picks), and count a typed visit.
    const typed = query.trim();
    const destination = destinationOf(result);
    if (typed && typed !== session?.initial && destination && !scope) {
      const address = result.kind === 'open' || result.kind === 'history' || result.kind === 'archive' ? result.url : result.kind === 'tab' ? result.tab.url : undefined;
      void api.history.choose(typed, destination, address && /^https?:/i.test(address) ? address : undefined);
    }
    if (result.kind === 'open' || result.kind === 'history') {
      if (session?.mode === 'edit' && activeId && where === 'here') void dispatch({ t: 'tab.navigate', nodeId: activeId, url: result.url });
      else void dispatch({ t: 'tab.open', windowId, url: result.url, background: where === 'background' });
    } else if (result.kind === 'tab') {
      void dispatch({ t: 'tab.activate', windowId, nodeId: result.tab.id });
    } else if (result.kind === 'chord') {
      void dispatch({ t: 'chord.activate', windowId, chordId: result.chord.id });
    } else if (result.kind === 'archive') {
      void api.archive.restore(result.archiveId);
    }
    close();
    // Actions run after the bar closes, so focus is back on the page (print, devtools, zoom act on it).
    if (result.kind === 'action') void api.action.run(result.action);
  };

  const whereFor = (event: KeyboardEvent | MouseEvent): Where => {
    if (info.platform === 'darwin' ? event.metaKey : event.ctrlKey) return 'background';
    return event.shiftKey ? 'front' : 'here';
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const caretAtEnd = input.selectionStart === input.value.length || (completion !== '' && input.selectionStart === query.length);
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
      if (result) run(result, whereFor(event));
    } else if (event.key === 'Tab') {
      // Tab never leaves the field: it narrows, completes, or steps through the rows.
      event.preventDefault();
      if (event.shiftKey) {
        if (results.length > 0) setSelected((current - 1 + results.length) % results.length);
        return;
      }
      const narrowed = scope ? null : (scopeFor(query, 'tab') ?? (results[current]?.kind === 'scope' ? results[current].scope : null));
      if (narrowed) enterScope(narrowed);
      else if (completion) {
        // The text stays the same, so only the selection shows the change: the caret goes to the end.
        setQuery(query + completion);
        setMayComplete(false);
        input.setSelectionRange(input.value.length, input.value.length);
      } else if (results.length > 0) setSelected((current + 1) % results.length);
    } else if (event.key === ' ' && !scope && caretAtEnd) {
      const narrowed = scopeFor(query, 'space');
      if (narrowed) {
        event.preventDefault();
        enterScope(narrowed);
      }
    } else if (event.key === 'Backspace' && scope && input.value === '') {
      // Backspace on an empty field leaves the keyword or filter.
      event.preventDefault();
      setScope(null);
      setSelected(0);
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
  const label = scope ? scopeLabel(scope) : null;
  const placeholder = label?.placeholder ?? 'Search or enter address';
  const ScopeIcon = scope ? scopeIcon(scope) : null;

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
              {scope && label && ScopeIcon ? (
                <motion.span
                  className={styles.scopeChip}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={spring('snappy', 'commandBar')}
                  data-testid="scope-chip"
                >
                  <ScopeIcon size={14} strokeWidth={2} aria-hidden />
                  {label.name}
                </motion.span>
              ) : (
                <InputIcon className={styles.inputIcon} size={anchored ? 14 : 18} strokeWidth={1.75} aria-hidden />
              )}
              <input
                ref={inputRef}
                className={styles.input}
                value={query + completion}
                placeholder={placeholder}
                aria-label={placeholder}
                spellCheck={false}
                autoComplete="off"
                aria-autocomplete="both"
                aria-controls="command-results"
                aria-activedescendant={results[current] ? `result-${current}` : undefined}
                onChange={(e) => {
                  const native = e.nativeEvent as InputEvent;
                  const input = e.target;
                  // Completion follows typing at the end of the text, never a deletion or an edit in the middle.
                  setMayComplete(Boolean(native.inputType?.startsWith('insert')) && !native.isComposing && input.selectionStart === input.value.length);
                  setQuery(input.value);
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
                        : result.kind === 'archive'
                          ? ArchiveRestore
                          : result.kind === 'scope'
                            ? scopeIcon(result.scope)
                            : result.kind === 'open'
                              ? result.search
                                ? Search
                                : Globe
                              : null;
                  const isSelected = i === current;
                  const hint = hintFor(result, session.mode);
                  return (
                    <li
                      key={result.key}
                      id={`result-${i}`}
                      role="option"
                      aria-selected={isSelected}
                      className={`${styles.result} ${isSelected ? styles.selected : ''}`}
                      onMouseMove={() => i !== current && setSelected(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => run(result, whereFor(e))}
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
                      {(result.kind === 'open' || result.kind === 'tab' || result.kind === 'history' || result.kind === 'archive') && result.detail && (
                        <span className={styles.resultDetail}>{result.detail}</span>
                      )}
                      {result.kind === 'scope' && <span className={styles.chip}>{result.detail}</span>}
                      {result.kind === 'chord' && <span className={styles.resultDetail}>Chord</span>}
                      {result.kind === 'archive' && <span className={styles.chip}>Archived</span>}
                      {result.kind === 'tab' && result.chordName && <span className={styles.chip}>{result.chordName}</span>}
                      {result.kind === 'action' && <kbd className={styles.keycap}>{keycapFor(result.action, info.platform)}</kbd>}
                      {isSelected && (
                        <span className={styles.hint}>
                          {hint.text} <kbd className={styles.keycap}>{hint.key}</kbd>
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
