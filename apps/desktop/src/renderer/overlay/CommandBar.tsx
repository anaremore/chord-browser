/**
 * The command bar (DESIGN.md §7.3). Always mounted in the overlay view, so
 * opening is a state change, not a page load. Two placements: centered for a
 * new tab (⌘T), anchored on the address for editing in place (⌘L).
 *
 * Typing completes the leading page's address inline (Tab accepts), a site
 * keyword or `@filter` followed by Tab narrows the bar to a chip, and the
 * engine's suggestions slot in under the local rows when they arrive.
 */
import { keycapFor, parseInput, type ActionId, type DuetHit, type SearchEngineId } from '@chord/core';
import type { HistorySearch, OverlayOpenEvent, PeekState, SystemInfo } from '@chord/ipc';
import { AppWindow, Archive, Columns2, ArchiveRestore, ArrowDown, ArrowUp, Code, Command, CornerDownLeft, Globe, History, Keyboard, Layers, Link, Maximize, PanelLeft, Pin, Presentation, Printer, RotateCcw, RotateCw, Search, Settings, SquareTerminal, TextSearch, Trash2, Volume2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { motion, MotionConfig } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { Favicon } from '../shared/Favicon';
import { DuetIcon } from '../shared/icons';
import { useLive, type Live } from '../shared/live';
import { useMirror, type Mirror } from '../shared/mirror';
import { applyMotion, reducedMotionMode, springsFor } from '../shared/motion';
import { afterNextPaint, fromEpoch, measureSince } from '../shared/perf';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './CommandBar.module.css';
import { DownloadsPanel } from './DownloadsPanel';
import { ExtensionsPanel } from './ExtensionsPanel';
import { PeekChrome } from './Peek';
import { buildResults, completionFor, destinationOf, scopeFor, scopeLabel, type Filter, type Result, type Scope } from './results';

interface Session {
  mode: OverlayOpenEvent['mode'];
  anchor: OverlayOpenEvent['anchor'];
  /** Changes on every open, replaying the entrance animation. */
  openedAt: number;
  /** When main was asked to open (epoch ms): the open budget counts from here to the first painted frame. */
  requestedAt: number;
  /** What the field opened with (the address, for ⌘L): a pick is only learned once the person typed. */
  initial: string;
  /** Main's number for this opening; closing names it. */
  seq: number;
  /** Peek's page and card, when the overlay is Peek's chrome. */
  peek?: PeekState;
  /** Not an opening: the unseen warm-up render while the overlay is still hidden (see below). */
  warm?: boolean;
}

/** What the warm-up "types": enough to fill the results with each kind of row. */
const WARM_QUERY = 'a';
/** How long the warm-up stays rendered: long enough for its history reply to arrive and render. */
const WARM_MS = 400;

/**
 * A keystroke being timed (ARCHITECTURE.md §1): results from memory should be
 * on screen in the very next frame, history and the archive within 16 ms.
 */
interface Keystroke {
  query: string;
  /** The input event's timestamp. */
  at: number;
  /** A frame has started since: results committed after this missed the keystroke's frame. */
  frameBegan: boolean;
  /** When results for it were committed to the DOM, once they were. */
  committed: number | null;
}

/** Whether the overlay is the command bar, in any of its modes (rather than a panel or Peek's chrome). */
const isCommandBar = (session: Session | null): session is Session & { mode: 'new' | 'edit' | 'split' } =>
  session?.mode === 'new' || session?.mode === 'edit' || session?.mode === 'split';

/**
 * Where a result opens (DESIGN.md §7.3): ↵ here (this tab when editing its
 * address), ⌘↵ / Ctrl+↵ a new background tab, ⇧↵ a new tab in front, ⌥↵
 * beside the current tab in a split (as ↵ does in "Split with…"). ⇧↵ is a
 * new window in the spec; it opens a tab until Chord has more than one window.
 */
type Where = 'here' | 'background' | 'front' | 'split';

const ACTION_ICONS: Partial<Record<ActionId, typeof X>> = {
  'tab.reopen': RotateCcw,
  'app.history': Archive,
  'tab.close': X,
  'tab.pin': Pin,
  'tab.mute': Volume2,
  'address.copy': Link,
  'address.copyMarkdown': Link,
  'tab.next': ArrowDown,
  'tab.previous': ArrowUp,
  'nav.hardReload': RotateCw,
  'view.toggleSidebar': PanelLeft,
  'view.presenting': Presentation,
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
  'split.with': Columns2,
  'split.separate': Columns2,
  'split.focusNext': Columns2,
  'split.focusPrevious': Columns2,
  'app.shortcuts': Keyboard,
  'duet.toggle': DuetIcon,
};

const FILTER_ICONS: Record<Filter, typeof X> = { tabs: AppWindow, pinned: Pin, history: History, archive: Archive, duet: DuetIcon, chords: Layers, actions: Command };
const scopeIcon = (scope: Scope) => (scope.kind === 'filter' ? FILTER_ICONS[scope.filter] : Search);

/** Anchored panels are at least this wide, so results have room beside a narrow sidebar. */
const ANCHORED_MIN_WIDTH = 560;
const EDGE = 8;
/** Suggestions wait for a pause this long in typing, so not every keystroke goes out. */
const SUGGEST_DELAY_MS = 120;

function hintFor(result: Result, mode: Session['mode']): { text: string; key: string } {
  if (result.kind === 'scope') return { text: result.scope.kind === 'keyword' ? `Search ${scopeLabel(result.scope).name}` : 'Show only these', key: result.scope.kind === 'keyword' ? 'Tab' : '↵' };
  if (mode === 'split') return { text: 'Open in split', key: '↵' };
  if (result.kind === 'tab') return { text: 'Switch to tab', key: '↵' };
  if (result.kind === 'action') return { text: 'Run', key: '↵' };
  if (result.kind === 'chord') return { text: 'Switch to chord', key: '↵' };
  if (result.kind === 'history') return { text: mode === 'edit' ? 'Go' : 'Open', key: '↵' };
  if (result.kind === 'archive') return { text: 'Bring back', key: '↵' };
  if (result.kind === 'duet') return { text: 'Open chat', key: '↵' };
  if (result.search) return { text: 'Search', key: '↵' };
  return { text: mode === 'edit' ? 'Go' : 'Open', key: '↵' };
}

/** Which engine to ask for suggestions: the setting's, a keyword's own engine, or none (sites, filters). */
function suggestionEngine(scope: Scope | null): SearchEngineId | undefined | null {
  if (!scope) return undefined;
  return scope.kind === 'keyword' ? (scope.keyword.engine ?? null) : null;
}

export function CommandBar({ info: infoSource, mirror }: { info: Live<SystemInfo>; mirror: Mirror }) {
  const info = useLive(infoSource);
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
  /** Whether a real opening has come (the warm-up only runs before one), and whether the warm-up is showing. */
  const opened = useRef(false);
  const warming = useRef(false);

  useEffect(() => {
    const stop = api.overlay.onOpen((event) => {
      opened.current = true;
      warming.current = false;
      searched.current = null;
      setSession({
        mode: event.mode,
        anchor: event.anchor,
        openedAt: performance.now(),
        requestedAt: event.requestedAt,
        initial: event.mode === 'edit' ? event.url : '',
        seq: event.seq,
        ...(event.peek ? { peek: event.peek } : {}),
      });
      setQuery(event.mode === 'edit' ? event.url : '');
      setSelected(0);
      setScope(null);
      setMayComplete(false);
      setSuggested(null);
    });
    const stopDismiss = api.overlay.onDismiss((seq) => setSession((current) => (current?.seq === seq ? null : current)));
    // Listening: an opening that waited for this (a brand-new window's) comes now.
    void api.overlay.ready();
    return () => {
      stop();
      stopDismiss();
    };
  }, []);

  // The first opening shouldn't pay for this process's first fonts, styles and code paths (about
  // 40 ms on the reference PC; the open budget is 50, ARCHITECTURE.md §1). So once main says the
  // window is up, while the overlay is still hidden, the bar renders once, unseen, with a query
  // (which also warms the history search), then goes again. A real opening simply replaces it.
  // Not sooner: alongside the shell's start it slows the launch. Not at idle: a hidden page gets
  // no idle time, so that would wait for the first opening itself.
  useEffect(() => {
    let done: ReturnType<typeof setTimeout> | undefined;
    const stop = api.overlay.onWarm(() => {
      if (opened.current || warming.current) return;
      performance.mark('chord:command-bar-warm');
      warming.current = true;
      setSession({ mode: 'new', anchor: null, openedAt: performance.now(), requestedAt: 0, initial: WARM_QUERY, seq: -1, warm: true });
      setQuery(WARM_QUERY);
      done = setTimeout(() => {
        if (!warming.current) return;
        warming.current = false;
        searchSeq.current++; // a reply still on its way is dropped
        setSession(null);
        setQuery('');
        setHistory(null);
      }, WARM_MS);
    });
    return () => {
      stop();
      clearTimeout(done);
    };
  }, []);

  // Typeable on the first frame (DESIGN.md §6.7): focus before the entrance animation runs.
  useLayoutEffect(() => {
    if (!session) return;
    // The warm-up only needs laying out (that loads the fonts); nothing is focused or timed.
    if (session.warm) {
      inputRef.current?.getBoundingClientRect();
      return;
    }
    const input = inputRef.current;
    input?.focus();
    if (session.mode === 'edit' && input) {
      input.select();
      // Show where the address starts, not where it ends.
      input.scrollLeft = 0;
    }
    // The open budget: from the request in main to this opening's first frame (and on to its paint).
    if (!isCommandBar(session)) return;
    const { requestedAt, openedAt, mode } = session;
    const start = fromEpoch(requestedAt);
    const committed = performance.now();
    afterNextPaint((frameAt) => measureSince('chord:command-bar-open', start, { mode, received: openedAt - start, committed: committed - start, frame: frameAt - start }));
  }, [session]);

  // History and learned picks come from chord-data as the person types. A reply for older text is
  // dropped; until the new one lands, the last reply keeps rows from flickering away. `@history`
  // asks even before anything is typed, as does `@archive`: recent pages, newest archived tabs.
  const [history, setHistory] = useState<HistorySearch | null>(null);
  // @duet: Duet chats by their words, from chord-data.
  const [duetHits, setDuetHits] = useState<DuetHit[]>([]);
  const duetFilter = scope?.kind === 'filter' && scope.filter === 'duet';
  useEffect(() => {
    if (!duetFilter || !query.trim()) return setDuetHits([]);
    let current = true;
    void api.duet.search(query.trim()).then((hits) => {
      if (current) setDuetHits(hits);
    });
    return () => {
      current = false;
    };
  }, [duetFilter, query]);
  const searchSeq = useRef(0);
  const keystroke = useRef<Keystroke | null>(null);
  /** The reply that answers the timed keystroke: when its search went out, and how long chord-data took. */
  const historyReply = useRef<{ keystroke: Keystroke; sent: number; roundTrip: number } | null>(null);
  /** The text the latest search asked about, so a keystroke's own search isn't asked again after it renders. */
  const searched = useRef<string | null>(null);
  const historyFilter = scope?.kind === 'filter' && (scope.filter === 'history' || scope.filter === 'archive');
  const wantsHistory = (text: string) => isCommandBar(session) && (text.trim() !== '' || historyFilter);
  const searchHistory = (text: string, typed: Keystroke | null) => {
    const seq = ++searchSeq.current;
    searched.current = text;
    const sent = performance.now();
    void api.history.search(text.trim()).then((found) => {
      if (seq !== searchSeq.current) return;
      if (typed) historyReply.current = { keystroke: typed, sent: sent - typed.at, roundTrip: performance.now() - sent };
      // Rendered now, in the reply's own task: left to the scheduler, it can miss the next frame
      // and arrive one frame late (the history budget is 16 ms, ARCHITECTURE.md §1).
      flushSync(() => setHistory(found));
    });
  };
  // Opening, a filter, an address to edit: what's in the field is asked about. (Typing asks in its
  // own handler, before the rows from memory render, so the reply's trip overlaps that work.)
  useEffect(() => {
    if (wantsHistory(query) && searched.current !== query) searchHistory(query, null);
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
      isCommandBar(session) &&
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

  // Presenting mode (ARCHITECTURE.md §9): main answers nothing from history, the archive or Duet while it's on;
  // a reply that left before it started isn't shown either.
  const presenting = state.presenting !== null;
  const results = useMemo(
    () =>
      isCommandBar(session)
        ? buildResults(query, state, windowId, session.mode, presenting ? null : history, Date.now(), { scope, suggestions, duetHits: presenting ? [] : duetHits })
        : [],
    [session, query, state, windowId, history, scope, suggestions, duetHits, presenting],
  );
  const current = Math.min(selected, Math.max(0, results.length - 1));
  // Inline autocomplete: only the leading row completes, and only while it's the one selected.
  const completion = mayComplete && !scope && current === 0 ? completionFor(query, results[0]) : '';

  // The completed part stays selected, so typing on replaces it and Backspace removes it.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && completion && document.activeElement === input) input.setSelectionRange(query.length, query.length + completion.length);
  }, [query, completion]);

  // Keystroke budgets: rows from memory are in the DOM before the keystroke's frame begins; the
  // history and archive reply follows within 16 ms. Each is measured to its first painted frame.
  useLayoutEffect(() => {
    const typed = keystroke.current;
    if (typed && typed.query === query && typed.committed === null) {
      const committed = performance.now();
      typed.committed = committed;
      const detail = { query, rows: results.length, sameFrame: !typed.frameBegan, committed: committed - typed.at };
      afterNextPaint((frameAt) => measureSince('chord:keystroke', typed.at, { ...detail, frame: frameAt - typed.at }));
    }
    const reply = historyReply.current;
    if (reply && reply.keystroke.query === query) {
      historyReply.current = null;
      const committed = performance.now();
      const detail = {
        query,
        rows: results.filter((r) => r.kind === 'history' || r.kind === 'archive').length,
        sent: reply.sent,
        roundTrip: reply.roundTrip,
        committed: committed - reply.keystroke.at,
      };
      afterNextPaint((frameAt) => measureSince('chord:keystroke-history', reply.keystroke.at, { ...detail, frame: frameAt - reply.keystroke.at }));
    }
  }, [results, query]);

  /** `dismissed`: Esc or a click outside, so the keyboard goes back where it came from (main). */
  const close = (dismissed?: boolean) => {
    if (session) void api.overlay.close(session.seq, dismissed === true);
    setSession(null);
  };
  const dismiss = () => close(true);

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
    // Beside the current tab, in a split (DESIGN.md §8.4): a page opens as a new pane; a tab of this chord moves in.
    const splitTab = result.kind === 'tab' && result.tab.chordId === win?.activeChordId && result.tab.id !== activeId ? result.tab : null;
    if (where === 'split' && activeId && (splitTab || result.kind === 'open' || result.kind === 'history')) {
      if (splitTab) void dispatch({ t: 'split.add', windowId, withId: activeId, nodeId: splitTab.id });
      else if (result.kind === 'open' || result.kind === 'history') void dispatch({ t: 'split.add', windowId, withId: activeId, url: result.url });
      close();
      return;
    }
    if (result.kind === 'open' || result.kind === 'history') {
      if (session?.mode === 'edit' && activeId && where === 'here') void dispatch({ t: 'tab.navigate', nodeId: activeId, url: result.url });
      else void dispatch({ t: 'tab.open', windowId, url: result.url, background: where === 'background', route: true });
    } else if (result.kind === 'tab') {
      void dispatch({ t: 'tab.activate', windowId, nodeId: result.tab.id });
    } else if (result.kind === 'chord') {
      void dispatch({ t: 'chord.activate', windowId, chordId: result.chord.id });
    } else if (result.kind === 'archive') {
      void api.archive.restore(result.archiveId);
    } else if (result.kind === 'duet') {
      void api.duet.open(result.chordId, result.threadId);
    }
    close();
    // Actions run after the bar closes, so focus is back on the page (print, devtools, zoom act on it).
    if (result.kind === 'action') void api.action.run(result.action);
  };

  const whereFor = (event: KeyboardEvent | MouseEvent): Where => {
    if (session?.mode === 'split' || event.altKey) return 'split';
    if (info.platform === 'darwin' ? event.metaKey : event.ctrlKey) return 'background';
    return event.shiftKey ? 'front' : 'here';
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const caretAtEnd = input.selectionStart === input.value.length || (completion !== '' && input.selectionStart === query.length);
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
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

  if (session.mode === 'peek' && session.peek) {
    return (
      <MotionConfig reducedMotion={reducedMotionMode(state.settings)}>
        <div className={styles.root} style={style}>
          <PeekChrome
            key={session.openedAt}
            initial={session.peek}
            info={info}
            transition={spring('gentle', 'commandBar')}
            enter={spring('overlay', 'commandBar')}
            onClose={dismiss}
          />
        </div>
      </MotionConfig>
    );
  }

  // The downloads and extensions panels share the overlay: modal like the command bar, but without dimming the page.
  if (session.mode === 'downloads' || session.mode === 'extensions') {
    return (
      <MotionConfig reducedMotion={reducedMotionMode(state.settings)}>
        <div className={styles.root} style={style}>
          <div className={styles.clearScrim} onMouseDown={dismiss} />
          {session.mode === 'downloads' ? (
            <DownloadsPanel state={state} windowId={windowId} anchor={session.anchor} transition={spring('overlay', 'commandBar')} onClose={close} />
          ) : (
            <ExtensionsPanel key={session.openedAt} anchor={session.anchor} transition={spring('overlay', 'commandBar')} onClose={close} />
          )}
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
  const placeholder = label?.placeholder ?? (session.mode === 'split' ? 'Split with a tab or a page' : 'Search or enter address');
  const ScopeIcon = scope ? scopeIcon(scope) : null;

  return (
    <MotionConfig reducedMotion={reducedMotionMode(state.settings)}>
      {/* The warm-up is laid out but never seen, focused or announced. */}
      <div className={`${styles.root} ${session.warm ? styles.warming : ''}`} style={style} aria-hidden={session.warm || undefined} inert={session.warm}>
        <motion.div
          className={styles.scrim}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={spring('gentle', 'commandBar')}
          onMouseDown={dismiss}
        />
        <div className={anchored ? undefined : styles.frameArea}>
          <motion.div
            key={session.openedAt}
            className={`${styles.panel} ${anchored ? styles.anchored : styles.centered}`}
            style={panelStyle}
            initial={entrance}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={spring('overlay', 'commandBar')}
            role={session.warm ? undefined : 'dialog'}
            aria-modal={session.warm ? undefined : true}
            aria-label={anchored ? 'Edit address' : session.mode === 'split' ? 'Split with' : 'New tab'}
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
                // A combobox controlling the results (DESIGN.md §10): ↑ ↓ move the active option, which
                // screen readers follow through aria-activedescendant while typing stays in the field.
                role="combobox"
                aria-expanded={results.length > 0}
                aria-haspopup="listbox"
                aria-autocomplete="both"
                aria-controls="command-results"
                aria-activedescendant={results[current] ? `result-${current}` : undefined}
                onChange={(e) => {
                  const native = e.nativeEvent as InputEvent;
                  const input = e.target;
                  const typed: Keystroke = { query: input.value, at: e.timeStamp, frameBegan: false, committed: null };
                  keystroke.current = typed;
                  requestAnimationFrame(() => {
                    typed.frameBegan = true;
                  });
                  // History is asked first, so its reply travels while the rows from memory render.
                  if (wantsHistory(input.value)) searchHistory(input.value, typed);
                  // Completion follows typing at the end of the text, never a deletion or an edit in the middle.
                  setMayComplete(Boolean(native.inputType?.startsWith('insert')) && !native.isComposing && input.selectionStart === input.value.length);
                  setQuery(input.value);
                  setSelected(0);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
            {results.length > 0 && (
              <ul id="command-results" className={styles.results} role="listbox" aria-label="Results">
                {results.map((result, i) => {
                  const Icon =
                    result.kind === 'action'
                      ? (ACTION_ICONS[result.action] ?? CornerDownLeft)
                      : result.kind === 'history'
                        ? History
                        : result.kind === 'archive'
                          ? ArchiveRestore
                          : result.kind === 'duet'
                            ? DuetIcon
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
                      {result.kind === 'duet' && <span className={styles.resultDetail}>{result.detail}</span>}
                      {result.kind === 'tab' && result.chordName && <span className={styles.chip}>{result.chordName}</span>}
                      {result.kind === 'action' && <kbd className={styles.keycap}>{keycapFor(result.action, info.platform, state.settings.shortcuts)}</kbd>}
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
