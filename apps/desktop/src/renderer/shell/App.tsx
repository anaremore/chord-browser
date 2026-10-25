import {
  activeTabId,
  chordsFor,
  describeLoadError,
  downloadsFor,
  isInternalUrl,
  keycapFor,
  SIDEBAR_WIDTH,
  sortedChords,
  splitOf,
  type ActionId,
  type LiveTab,
  type LoadError,
  type TabNode,
} from '@chord/core';
import type { ChordEdit, DuetView, SystemInfo } from '@chord/ipc';
import { durations } from '@chord/tokens';
import { Archive, ArrowLeft, ArrowRight, BookOpenText, Ellipsis, Globe, Lock, PanelLeft, RotateCw, Volume2, VolumeX, X } from 'lucide-react';
import { DuetIcon } from '../shared/icons';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { useLive, type Live } from '../shared/live';
import { useMirror, type Mirror } from '../shared/mirror';
import { applyMotion, INSTANT, motionMode, reducedMotionMode, springsFor } from '../shared/motion';
import { inNextFrame, noteRender } from '../shared/frames';
import { markRender } from '../shared/perf';
import { displayHost, pageTitle } from '../shared/site';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './App.module.css';
import { ArchiveButton, ArchiveFlights } from './ArchiveArc';
import { ChordHeader, ChordPane, ChordSwitcher, GhostPane, newChordLook, Tint } from './Chords';
import { ShortcutsProvider, useKeys } from './keys';
import { DownloadsButton, summarizeDownloads } from './Downloads';
import { DuetPanel } from './Duet';
import { DuetReadTabs } from './duet-context';
import { ExtensionButtons, ExtensionsShelf, useExtensionsBar } from './Extensions';
import { FrameSnapshots } from './FrameSnapshot';
import { NowPlayingCard } from './NowPlaying';
import { Onboarding } from './Onboarding';
import { SafeBrowsingWarning } from './SafeBrowsingWarning';
import { SplitPanes, useElementSize } from './Split';
import { FavoritesRow, SidebarDnd, SidebarTabs } from './Tabs';
import { Toasts } from './Toasts';
import { Announcer, announce } from './announce';
import { cycleRegion, trackRegions } from './regions';
import type { ToastStore } from './toast-store';
import { useChordSwipe, type PaneMotion } from './useChordSwipe';
import { usePreviewHover } from './usePreviewHover';

/** What the frame shows when a page didn't load (DESIGN.md §9), instead of a blank page. */
function LoadErrorState({ error, canGoBack, windowId, tabId }: { error: LoadError; canGoBack: boolean; windowId: string; tabId: string }) {
  const copy = describeLoadError(error.code, displayHost(error.url));
  const back = () =>
    void (canGoBack ? api.nav.command('back') : api.state.dispatch({ t: 'tab.close', windowId, nodeId: tabId }));
  return (
    <div className={styles.empty} role="alert" data-kind={copy.kind} data-page-state>
      <p className={styles.emptyTitle}>{copy.title}</p>
      <p className={styles.emptyBody}>{copy.body}</p>
      {copy.action === 'retry' ? (
        <button type="button" className={styles.emptyButton} onClick={() => void api.nav.command('reload')}>
          Try again
        </button>
      ) : (
        <button type="button" className={styles.emptyButton} onClick={back}>
          {canGoBack ? 'Go back' : 'Close tab'}
        </button>
      )}
      <p className={styles.errorCode}>{copy.name}</p>
    </div>
  );
}

/**
 * A tab whose service plays in Chord Player (DESIGN.md §7.13): the tab stays,
 * and its frame says where it plays, with the way back to the player and a
 * way to see the page here instead (to manage the account, say).
 */
function PlayerState({ tab }: { tab: TabNode }) {
  const host = displayHost(tab.url) || 'This page';
  return (
    <div className={styles.empty} role="status" data-page-state>
      <p className={styles.emptyTitle}>Playing in Chord Player</p>
      <p className={styles.emptyBody}>{host} plays in Chord Player, in a window of its own. This tab stays here.</p>
      <div className={styles.emptyActions}>
        <button type="button" className={styles.emptySecondary} onClick={() => void api.player.act(tab.id, 'release')}>
          Show the page here
        </button>
        <button type="button" className={styles.emptyButton} onClick={() => void api.player.act(tab.id, 'show')}>
          Back to the player
        </button>
      </div>
    </div>
  );
}

/** What the frame shows instead of a page that crashed, didn't load, may be unsafe, or plays in Chord Player (nothing while the page is fine). */
function PageState({ tab, live, windowId }: { tab: TabNode; live: LiveTab | undefined; windowId: string }) {
  if (live?.threat) return <SafeBrowsingWarning threat={live.threat} nodeId={tab.id} windowId={windowId} />;
  if (live?.player) return <PlayerState tab={tab} />;
  if (live?.crashed) {
    return (
      <div className={styles.empty} role="alert" data-page-state>
        <p className={styles.emptyTitle}>This page stopped working.</p>
        <p className={styles.emptyBody}>It’s not you. Reloading usually fixes it.</p>
        <button type="button" className={styles.emptyButton} onClick={() => void api.nav.command('reload')}>
          Reload
        </button>
      </div>
    );
  }
  return live?.error ? <LoadErrorState error={live.error} canGoBack={live.canGoBack} windowId={windowId} tabId={tab.id} /> : null;
}

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/**
 * Reports where the address sits so ⌘L can grow the command bar out of it.
 * Re-measures on resize and after the sidebar's slide settles.
 */
function anchorRef(el: HTMLElement | null) {
  if (!el) return;
  const report = () => {
    const r = el.getBoundingClientRect();
    void api.layout.anchor({ x: r.x, y: r.y, width: r.width, height: r.height });
  };
  report();
  const observer = new ResizeObserver(report);
  observer.observe(el);
  window.addEventListener('resize', report);
  window.addEventListener('transitionend', report);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', report);
    window.removeEventListener('transitionend', report);
  };
}

function SidebarToggle({ collapsed, info, onToggle, onHover }: { collapsed: boolean; info: SystemInfo; onToggle(): void; onHover?(over: boolean): void }) {
  const { withKeys } = useKeys(info);
  return (
    <button
      type="button"
      className={styles.iconButton}
      aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
      aria-expanded={!collapsed}
      title={withKeys(collapsed ? 'Show sidebar' : 'Hide sidebar', 'view.toggleSidebar')}
      onClick={onToggle}
      onPointerEnter={() => onHover?.(true)}
      onPointerLeave={() => onHover?.(false)}
    >
      <PanelLeft {...ICON} />
    </button>
  );
}

/**
 * Reader view (DESIGN.md §7.11): offered beside the address while the page
 * reads as an article, pressed while it shows in reader view.
 */
function ReaderButton({ live, info }: { live: LiveTab | undefined; info: SystemInfo }) {
  const { withKeys } = useKeys(info);
  if (!live?.readable && !live?.reader) return null;
  return (
    <button
      type="button"
      className={styles.iconButton}
      aria-label="Reader view"
      aria-pressed={Boolean(live.reader)}
      title={withKeys(live.reader ? 'Leave reader view' : 'Reader view', 'view.reader')}
      onClick={() => void api.action.run('view.reader')}
    >
      <BookOpenText {...ICON} />
    </button>
  );
}

/** The width a drag on the sidebar's edge asks for: clamped, and caught by the detent at the default. */
function snapWidth(width: number): number {
  const clamped = Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width));
  return Math.abs(clamped - SIDEBAR_WIDTH.default) <= SIDEBAR_WIDTH.detent ? SIDEBAR_WIDTH.default : Math.round(clamped);
}

/**
 * The sidebar's edge (DESIGN.md §3.1): drag to resize between 200 and 400 px,
 * with a gentle detent at 248; double-click goes back to 248; arrow keys
 * nudge it. The width shows at once and reaches main once a frame.
 */
function ResizeHandle({ width, windowId, onLive }: { width: number; windowId: string; onLive(width: number | null): void }) {
  const commit = (next: number) => api.state.dispatch({ t: 'window.sidebarWidth', windowId, width: next });
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      className={styles.resizeHandle}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        let next = width;
        let frame = 0;
        const move = (ev: PointerEvent) => {
          next = snapWidth(width + ev.clientX - startX);
          onLive(next);
          frame ||= requestAnimationFrame(() => {
            frame = 0;
            void commit(next);
          });
        };
        const end = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', end);
          el.removeEventListener('pointercancel', end);
          cancelAnimationFrame(frame);
          void commit(next).then(() => onLive(null));
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
      }}
      onDoubleClick={() => void commit(SIDEBAR_WIDTH.default)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 8;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          void commit(snapWidth(width + (e.key === 'ArrowLeft' ? -step : step)));
        }
      }}
    />
  );
}

/** How long the pointer rests on the toggle before the sidebar peeks, and how long it lingers after (DESIGN.md §3.3, §6.5). */
const PEEK_DELAY_MS = 300;
const EDGE_PEEK_DELAY_MS = 120;

function NavButtons({ live, hasTab, info }: { live: LiveTab | undefined; hasTab: boolean; info: SystemInfo }) {
  const { withKeys } = useKeys(info);
  return (
    <>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Back"
        title={withKeys('Back', 'nav.back')}
        disabled={!live?.canGoBack}
        onClick={() => void api.nav.command('back')}
      >
        <ArrowLeft {...ICON} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Forward"
        title={withKeys('Forward', 'nav.forward')}
        disabled={!live?.canGoForward}
        onClick={() => void api.nav.command('forward')}
      >
        <ArrowRight {...ICON} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={live?.loading ? 'Stop' : 'Reload'}
        title={live?.loading ? 'Stop' : withKeys('Reload', 'nav.reload')}
        disabled={!hasTab}
        onClick={() => void api.nav.command(live?.loading ? 'stop' : 'reload')}
      >
        {live?.loading ? <X {...ICON} /> : <RotateCw {...ICON} />}
      </button>
    </>
  );
}

export function App({ info: infoSource, mirror, toasts }: { info: Live<SystemInfo>; mirror: Mirror; toasts: ToastStore }) {
  // Every commit is marked (the perf spec checks a frame holds at most one), and main's updates that
  // arrive in a frame that has rendered already wait for the next (shared/frames.ts).
  useLayoutEffect(() => {
    markRender();
    noteRender();
  });
  const info = useLive(infoSource);
  const state = useMirror(mirror);
  const windowId = mirror.windowId;
  const win = state.windows[windowId];
  const chord = win ? state.chords[win.activeChordId] : undefined;
  // A private window: its own chord only, no pinning, no archive, and nothing kept.
  const isPrivate = Boolean(win?.private);
  const { style, appearance } = chordStyle(chord, info, state.settings.interface);
  const activeId = activeTabId(state, windowId);
  const active = activeId ? (state.nodes[activeId] as TabNode | undefined) : undefined;
  const live = activeId ? state.live[activeId] : undefined;
  // Split view: the frame divides between the split's panes; the active tab is the focused one.
  const split = activeId ? splitOf(state, activeId) : null;
  const frameRef = useRef<HTMLDivElement>(null);
  const frameSize = useElementSize(frameRef);
  // Where split view's drop zones go, and whether the shell is lifted over the page to show them.
  const [dropHost, setDropHost] = useState<HTMLDivElement | null>(null);
  const [lifted, setLifted] = useState(false);
  const lift = (on: boolean) => {
    setLifted(on);
    void api.layout.lift(on);
  };
  // Chord's own pages (the archive) go by their name, not an address.
  const internal = active ? isInternalUrl(active.url) : false;
  const host = active ? (internal ? active.title || 'Chord' : displayHost(active.url)) : '';
  const title = active && !internal ? pageTitle(active) : '';
  const overlayChrome = info.windowChrome.kind === 'overlay';
  const secure = active?.url.startsWith('https:') ?? false;
  const collapsed = win?.sidebar === 'collapsed';
  // Extension buttons: the sidebar's shelf by default, or the title bar (Settings → Extensions).
  // With the sidebar collapsed, the minimal bar keeps just the puzzle piece in sidebar mode.
  const extensionsBar = useExtensionsBar();
  const inTitleBar = state.settings.extensionButtons === 'titleBar';
  // The same function until the motion settings change: every sidebar row gets it, and redraws when it changes.
  const spring = useMemo(() => springsFor(state.settings, info.prefersReducedMotion), [state.settings, info.prefersReducedMotion]);
  const tabMotion = motionMode(state.settings, info.prefersReducedMotion, 'tabMoves');
  useEffect(() => applyMotion(state.settings, info.prefersReducedMotion), [state.settings, info.prefersReducedMotion]);
  // Keycaps follow your shortcut changes; App provides them to everything below.
  const keycap = (id: ActionId) => keycapFor(id, info.platform, state.settings.shortcuts);
  const muteKeys = keycap('tab.mute');
  const muteTitle = useMemo(() => ({ mute: `Mute tab  ${muteKeys}`.trim(), unmute: `Unmute tab  ${muteKeys}`.trim() }), [muteKeys]);

  // Which way the sidebar slides when switching chords: toward the new chord's place in the switcher.
  const chordIndex = chord ? chordsFor(state, windowId).findIndex((c) => c.id === chord.id) : 0;
  const previousIndex = useRef(chordIndex);
  const slide = chordIndex >= previousIndex.current ? 1 : -1;
  useEffect(() => {
    previousIndex.current = chordIndex;
  }, [chordIndex]);

  // Downloads finished after this show a dot on the button until the panel is opened. It starts when this window's
  // shell began loading, not when it first rendered: a download that finishes while the window starts is new.
  const [downloadsSeenAt, setDownloadsSeenAt] = useState(() => Math.floor(performance.timeOrigin));
  const downloads = summarizeDownloads(downloadsFor(state, windowId), downloadsSeenAt);
  const downloadsButton = <DownloadsButton summary={downloads} onOpen={() => setDownloadsSeenAt(Date.now())} />;
  const archiveKeys = keycap('app.history');
  const archiveLabel = archiveKeys ? `Archive  ${archiveKeys}` : 'Archive';
  // Archived rows' favicons fly here (DESIGN.md §6.5).
  const archiveButton = <ArchiveButton title={archiveLabel} onClick={() => void api.action.run('app.history')} />;
  // Duet's panel for this window (DESIGN.md §7.8): main pushes what it shows.
  const [duet, setDuet] = useState<DuetView | null>(null);
  useEffect(() => {
    // A push can arrive before the answer and be the newer of the two (live.ts says why): it wins.
    // It renders in the frame with the state patches (shared/frames.ts).
    let pushed = false;
    const show = inNextFrame(setDuet);
    const unsubscribe = api.duet.onState((view) => {
      pushed = true;
      show(view);
    });
    void api.duet.view().then((view) => {
      if (!pushed) setDuet(view);
    });
    return unsubscribe;
  }, []);
  const duetOpen = Boolean(duet?.enabled && duet.open);
  // The panel slides in on `overlay` and out a little quicker (DESIGN.md §6.1, §6.5), with the sidebar's motion switch.
  const duetEnter = spring('overlay', 'sidebar');
  const duetSlide = { enter: duetEnter, exit: duetEnter === INSTANT ? INSTANT : { duration: durations.fadeBase / 1000, ease: 'easeIn' as const } };
  const [chordEdit, setChordEdit] = useState<ChordEdit | null>(null);
  useEffect(() => api.chords.onEdit(setChordEdit), []);
  // F6 and ⇧F6 move between the window's regions (regions.ts).
  useEffect(() => {
    const untrack = trackRegions();
    const unsubscribe = api.focus.onRegion(cycleRegion);
    return () => {
      untrack();
      unsubscribe();
    };
  }, []);
  // A chord switch is announced: "Work chord, 3 pinned, 7 today" (DESIGN.md §8.2).
  const announcedChord = useRef(chord?.id);
  useEffect(() => {
    if (!chord || announcedChord.current === chord.id) return;
    announcedChord.current = chord.id;
    const tabs = Object.values(state.nodes).filter((n) => n.kind === 'tab' && n.chordId === chord.id);
    const pinned = tabs.filter((n) => n.section === 'pinned').length;
    announce(`${chord.name} chord, ${pinned} pinned, ${tabs.length - pinned} today`);
  }, [chord?.id]);
  // A new chord's name field opens on it as soon as it's here. Its patch can arrive after main's reply
  // (they come on different pipes), so it's found as the chord that wasn't there before, not the active one.
  const [naming, setNaming] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const created = naming && Object.keys(state.chords).find((id) => !naming.has(id));
    if (!created) return;
    setNaming(null);
    setChordEdit({ chordId: created, field: 'name' });
  }, [naming, state.chords]);
  const createChord = () => {
    setNaming(new Set(Object.keys(mirror.get().chords)));
    api.state.dispatch({ t: 'chord.create', windowId, name: 'New chord', ...newChordLook(sortedChords(state)) }).catch(() => setNaming(null));
  };

  // The sidebar's width, live while its edge is dragged (main lays the page out to match).
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const sidebarWidth = liveWidth ?? win?.sidebarWidth ?? SIDEBAR_WIDTH.default;

  // Minimal mode's peek: the sidebar slides in over the page and away once the pointer leaves.
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const schedulePeek = (open: boolean, delay: number) => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(open), delay);
  };
  const keepPeek = () => clearTimeout(peekTimer.current);
  // Right after you hide the sidebar the pointer is still on the toggle: it peeks only once the pointer has left it.
  const peekArmed = useRef(false);
  useEffect(() => {
    if (!collapsed) setPeek(false);
    peekArmed.current = false;
  }, [collapsed]);
  const hoverToggle = (over: boolean) => {
    if (!over) {
      peekArmed.current = true;
      if (peek) schedulePeek(false, PEEK_DELAY_MS);
      else keepPeek();
    } else if (peekArmed.current) {
      schedulePeek(true, PEEK_DELAY_MS);
    }
  };
  // Main lifts the shell above the page while it peeks, and lowers it once the slide-out is done.
  useEffect(() => {
    if (peek) {
      void api.layout.peek(true);
      return;
    }
    const timer = setTimeout(() => void api.layout.peek(false), PEEK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [peek]);
  const peeking = collapsed && peek;

  // The chord swipe (DESIGN.md §6.4): two fingers sideways on the sidebar or the minimal bar.
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const swipe = useChordSwipe({
    root: rootRef,
    track: trackRef,
    windowId,
    chordIds: chordsFor(state, windowId).map((c) => c.id),
    currentId: chord?.id,
    panes: !collapsed || peeking,
    release: spring('release', 'chordSlide'),
    reduced: info.prefersReducedMotion && state.settings.motion.followSystem,
    blend: state.settings.motion.colorBlend,
  });
  const paneMotion: PaneMotion = swipe.paneMotion ?? { kind: 'slide', dir: slide };
  // Hover previews of pinned tabs and folders (DESIGN.md §7.6): only with the sidebar docked and still.
  usePreviewHover(rootRef, !collapsed && liveWidth === null && swipe.paneMotion === null && state.settings.pagePreviews && state.settings.onboarded);
  const tintOf = (chordId: string) => String(chordStyle(state.chords[chordId], info, state.settings.interface).style['--color-tint' as keyof CSSProperties] ?? '');

  const toggleSidebar = () => void api.action.run('view.toggleSidebar');
  const openOptions = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void api.menu.app({ x: r.x, y: r.y, width: r.width, height: r.height });
  };

  // Motion's default ignores the OS; "user" honors reduced motion (DESIGN.md §6.6) unless Settings says not to.
  return (
    <ShortcutsProvider value={state.settings.shortcuts}>
      <MotionConfig reducedMotion={reducedMotionMode(state.settings)}>
        <div
          ref={rootRef}
          className={styles.window}
          data-sidebar={collapsed ? 'collapsed' : 'docked'}
          data-peek={peeking || undefined}
          data-lifted={lifted || undefined}
          data-resizing={liveWidth !== null || undefined}
          style={{ ...style, '--size-sidebar-width': `${sidebarWidth}px`, '--duet-space': duetOpen ? 'calc(var(--size-duet-width) + var(--space-2))' : 'var(--space-0)' } as CSSProperties}
        >
          <div className={styles.backdrop} aria-hidden>
            {/* A swipe blends the neighbor's tint in as the fingers move, so its switch needn't crossfade again. */}
            <Tint value={String(style['--color-tint' as keyof typeof style] ?? '')} transition={swipe.tintInstant ? INSTANT : spring('gentle', 'colorBlend')} />
            {swipe.blendId && <motion.div className={styles.tint} style={{ background: tintOf(swipe.blendId), opacity: swipe.blend }} />}
            <div className={styles.grain} />
          </div>

          {/*
            Over the page while the sidebar peeks: the pointer resting here (not in the sidebar) puts it
            away after a moment, and a click at once. Coming from the edge, the sidebar is a few px away.
          */}
          {peeking && (
            <div
              className={styles.peekScrim}
              aria-hidden
              onPointerMove={() => schedulePeek(false, PEEK_DELAY_MS)}
              onPointerDown={() => setPeek(false)}
            />
          )}
          {/* Pointing at the window's left edge peeks the sidebar (DESIGN.md §3.3). */}
          {collapsed && !peeking && (
            <div className={styles.edgeZone} aria-hidden onPointerEnter={() => schedulePeek(true, EDGE_PEEK_DELAY_MS)} onPointerLeave={keepPeek} />
          )}

          <nav
            data-region="sidebar"
            className={styles.sidebar}
            aria-label="Sidebar"
            data-swipe-area
            inert={collapsed && !peeking}
            aria-hidden={(collapsed && !peeking) || undefined}
            onPointerEnter={() => peeking && keepPeek()}
            onPointerMove={() => peeking && keepPeek()}
            onPointerLeave={() => peeking && schedulePeek(false, PEEK_DELAY_MS)}
            onKeyDown={(e) => {
              if (peeking && e.key === 'Escape') setPeek(false);
            }}
          >
            <header className={styles.header}>
              <SidebarToggle collapsed={collapsed} info={info} onToggle={toggleSidebar} />
              {!overlayChrome && <span className={styles.flex} />}
              <NavButtons live={live} hasTab={Boolean(active)} info={info} />
              {/* macOS has no title bar beside a docked sidebar: its header row is the title bar. */}
              {inTitleBar && !overlayChrome && <ExtensionButtons bar={extensionsBar} puzzleOnly={false} />}
            </header>

            <div className={styles.urlRow}>
              <button
                ref={collapsed ? undefined : anchorRef}
                type="button"
                className={styles.urlPill}
                title={active?.url ?? ''}
                // Its name is the address, not the keycap beside it; whether it's secure is said too.
                aria-label={host ? `Address: ${host}${secure ? ', secure' : ''}` : 'Search or enter address'}
                onClick={() => void api.overlay.open('edit')}
              >
                {internal ? (
                  <Archive size={12} strokeWidth={2} aria-hidden />
                ) : secure ? (
                  <Lock size={12} strokeWidth={2} aria-hidden />
                ) : (
                  <Globe size={12} strokeWidth={2} aria-hidden />
                )}
                <span className={styles.ellipsis}>{host || 'Search or enter address'}</span>
                <kbd className={styles.pillKeycap}>{keycap('address.edit')}</kbd>
              </button>
              {/* Beside the address when there's no bar to hold it (macOS, docked). */}
              {!overlayChrome && !collapsed && <ReaderButton live={live} info={info} />}
            </div>

            {/* One drag space: tabs move between lists, onto Favorites, and onto chords in the switcher. */}
            <SidebarDnd state={state} chordId={chord?.id ?? ''} windowId={windowId} frame={dropHost} onLift={lift}>
              {!isPrivate && <FavoritesRow state={state} windowId={windowId} activeId={activeId} appearance={appearance} />}

              <div ref={trackRef} className={styles.paneTrack} data-swiping={swipe.ghosts.length > 0 || swipe.paneMotion !== null || undefined}>
                <AnimatePresence initial={false} mode="popLayout" custom={paneMotion}>
                  <ChordPane key={chord?.id} motion={paneMotion} x={swipe.xFor(chord?.id ?? '')} transition={spring('smooth', 'chordSlide')}>
                    <ChordHeader
                      chord={chord}
                      info={info}
                      edit={chordEdit && chordEdit.chordId === chord?.id ? chordEdit.field : null}
                      onDone={() => setChordEdit(null)}
                    />
                    <DuetReadTabs.Provider value={new Set(duetOpen ? (duet?.readTabIds ?? []) : [])}>
                      <SidebarTabs
                        chordId={chord?.id ?? ''}
                        state={state}
                        windowId={windowId}
                        activeId={activeId}
                        info={info}
                        appearance={appearance}
                        spring={spring}
                        tabMotion={tabMotion}
                      />
                    </DuetReadTabs.Provider>
                  </ChordPane>
                </AnimatePresence>
                {/* The neighbors a swipe brings in beside the current chord. */}
                {swipe.ghosts.map(({ id }) => {
                  const neighbor = state.chords[id];
                  return (
                    neighbor && (
                      <GhostPane key={`ghost-${id}`} x={swipe.xFor(id)}>
                        <ChordHeader chord={neighbor} info={info} edit={null} onDone={() => {}} />
                        <SidebarTabs
                          chordId={id}
                          state={state}
                          windowId={windowId}
                          activeId={win?.activeTab[id] ?? null}
                          info={info}
                          appearance={appearance}
                          spring={spring}
                          tabMotion={tabMotion}
                        />
                      </GhostPane>
                    )
                  );
                })}
              </div>

              {(!collapsed || peeking) && <Toasts store={toasts} transition={spring('overlay', 'sidebar')} compact={false} undoKeys={!collapsed} mac={info.platform === 'darwin'} />}

              {/* Media playing in a tab you aren't looking at (DESIGN.md §7.10). */}
              <NowPlayingCard state={state} windowId={windowId} appearance={appearance} muteTitle={muteTitle} enter={spring('overlay', 'sidebar')} />

              {!inTitleBar && <ExtensionsShelf bar={extensionsBar} />}

              <ChordSwitcher
                state={state}
                windowId={windowId}
                info={info}
                pill={spring('snappy', 'chordSlide')}
                leading={
                  <>
                    {!isPrivate && archiveButton}
                    {downloadsButton}
                  </>
                }
                onCreate={isPrivate ? null : () => void createChord()}
              />
            </SidebarDnd>
            {!collapsed && <ResizeHandle width={sidebarWidth} windowId={windowId} onLive={setLiveWidth} />}
          </nav>

          {/* The top bar: right of the sidebar on Windows/Linux; the whole minimal bar when collapsed (DESIGN.md §3.3). */}
          {(overlayChrome || collapsed) && (
            <div className={styles.bar} data-swipe-area={collapsed || undefined} data-region="bar">
              {collapsed && (
                <div className={styles.barLead}>
                  <SidebarToggle collapsed info={info} onToggle={toggleSidebar} onHover={hoverToggle} />
                  <NavButtons live={live} hasTab={Boolean(active)} info={info} />
                </div>
              )}
              <button
                ref={collapsed ? anchorRef : undefined}
                type="button"
                className={styles.address}
                data-address
                aria-label={host ? `Address: ${host}${title ? `, ${title}` : ''}` : 'Search or enter address'}
                title={active?.url ?? ''}
                onClick={() => void api.overlay.open('edit')}
              >
                {host ? (
                  <>
                    <span className={styles.addressHost}>{host}</span>
                    {title && (
                      <>
                        <span className={styles.addressMuted} aria-hidden>
                          /
                        </span>
                        <span className={`${styles.addressMuted} ${styles.ellipsis}`}>{title}</span>
                      </>
                    )}
                  </>
                ) : (
                  <span className={styles.addressMuted}>Search or enter address</span>
                )}
              </button>
              <ReaderButton live={live} info={info} />
              {/* The tab on screen makes sound: its speaker, as on its row (hidden in the sidebar now). */}
              {collapsed && active && live?.audible && (
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={active.muted ? 'Unmute tab' : 'Mute tab'}
                  title={active.muted ? muteTitle.unmute : muteTitle.mute}
                  onClick={() => void api.state.dispatch({ t: 'tab.mute', nodeId: active.id, muted: !active.muted })}
                >
                  {active.muted ? <VolumeX {...ICON} /> : <Volume2 {...ICON} />}
                </button>
              )}
              <span className={styles.flex} />
              {(inTitleBar || collapsed) && <ExtensionButtons bar={extensionsBar} puzzleOnly={!inTitleBar} />}
              {/* In the minimal bar, Downloads shows only while something downloads or just finished (DESIGN.md §3.3). */}
              {collapsed && <Toasts store={toasts} transition={spring('overlay', 'sidebar')} compact undoKeys mac={info.platform === 'darwin'} />}
              {collapsed && (downloads.active > 0 || downloads.unseen) && downloadsButton}
              {duet?.enabled && (
                <button
                  type="button"
                  className={styles.duetButton}
                  aria-pressed={duetOpen}
                  title={`Duet  ${keycap('duet.toggle')}`.trim()}
                  onClick={() => void api.duet.act({ do: 'toggle' })}
                >
                  <DuetIcon {...ICON} aria-hidden />
                  Duet
                </button>
              )}
              {overlayChrome && (
                <button type="button" className={styles.iconButton} aria-label="Options" aria-haspopup="menu" title="Options" onClick={openOptions}>
                  <Ellipsis {...ICON} />
                </button>
              )}
            </div>
          )}
          {!overlayChrome && !collapsed && <div className={styles.topDrag} />}

          <div ref={frameRef} className={styles.frame} data-split={split ? split.direction : undefined} data-region="page">
            {!state.settings.onboarded && chord && !isPrivate ? (
              <Onboarding chord={chord} chords={sortedChords(state)} windowId={windowId} info={info} spring={spring} />
            ) : (
              <>
                {split ? (
                  <SplitPanes
                    state={state}
                    windowId={windowId}
                    split={split}
                    activeId={activeId}
                    size={frameSize}
                    pageState={(tab, paneLive) => <PageState tab={tab} live={paneLive} windowId={windowId} />}
                  />
                ) : (
                  active && <PageState tab={active} live={live} windowId={windowId} />
                )}
                {!active && (
                  <div className={styles.empty} data-page-state>
                    {isPrivate ? (
                      <>
                        <p className={styles.emptyTitle}>This window is private.</p>
                        <p className={styles.emptyBody}>Chord won’t remember the sites you visit in this window. Files you download are kept.</p>
                      </>
                    ) : (
                      <>
                        <p className={styles.emptyTitle}>Fresh chord, fresh start.</p>
                        <p className={styles.emptyBody}>Open a site, or search for anything.</p>
                      </>
                    )}
                    <button type="button" className={styles.emptyButton} onClick={() => void api.overlay.open('new')}>
                      New tab <kbd className={styles.inlineKeycap}>{keycap('tab.new')}</kbd>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          {/* The pages' pictures while the frame changes size (ARCHITECTURE.md §5). */}
          <FrameSnapshots />
          {/* A panel already open when the shell starts is just there; opening and closing slide it. */}
          {duet && (
            <AnimatePresence initial={false}>
              {duetOpen && <DuetPanel key="duet" view={duet} windowId={windowId} info={info} slide={duetSlide} />}
            </AnimatePresence>
          )}
          <ArchiveFlights />
          <Announcer />

          {/* Split view's drop zones, over the page while a tab is dragged (Tabs.tsx draws them here). */}
          <div ref={setDropHost} className={styles.dropLayer} aria-hidden={!lifted || undefined} />
        </div>
      </MotionConfig>
    </ShortcutsProvider>
  );
}
