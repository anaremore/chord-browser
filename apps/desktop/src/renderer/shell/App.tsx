import {
  activeTabId,
  chordsFor,
  describeLoadError,
  downloadsFor,
  isInternalUrl,
  keycapFor,
  SIDEBAR_WIDTH,
  sortedChords,
  type ActionId,
  type LiveTab,
  type LoadError,
  type TabNode,
} from '@chord/core';
import type { ChordEdit, SystemInfo } from '@chord/ipc';
import { Archive, ArrowLeft, ArrowRight, Ellipsis, Globe, Lock, PanelLeft, RotateCw, X } from 'lucide-react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { useMirror, type Mirror } from '../shared/mirror';
import { applyMotion, INSTANT, reducedMotionMode, springsFor } from '../shared/motion';
import { displayHost, pageTitle } from '../shared/site';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './App.module.css';
import { ChordHeader, ChordPane, ChordSwitcher, GhostPane, newChordLook, Tint } from './Chords';
import { useSystemInfo } from './hooks';
import { ShortcutsProvider, useKeys } from './keys';
import { DownloadsButton, summarizeDownloads } from './Downloads';
import { ExtensionButtons, ExtensionsShelf, useExtensionsBar } from './Extensions';
import { Onboarding } from './Onboarding';
import { FavoritesRow, SidebarDnd, SidebarTabs } from './Tabs';
import { Toasts } from './Toasts';
import { useChordSwipe, type PaneMotion } from './useChordSwipe';

/** What the frame shows when a page didn't load (DESIGN.md §9), instead of a blank page. */
function LoadErrorState({ error, canGoBack, windowId, tabId }: { error: LoadError; canGoBack: boolean; windowId: string; tabId: string }) {
  const copy = describeLoadError(error.code, displayHost(error.url));
  const back = () =>
    void (canGoBack ? api.nav.command('back') : api.state.dispatch({ t: 'tab.close', windowId, nodeId: tabId }));
  return (
    <div className={styles.empty} role="alert" data-kind={copy.kind}>
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

export function App({ initialInfo, mirror }: { initialInfo: SystemInfo; mirror: Mirror }) {
  const info = useSystemInfo(initialInfo);
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
  const spring = springsFor(state.settings, info.prefersReducedMotion);
  useEffect(() => applyMotion(state.settings, info.prefersReducedMotion), [state.settings, info.prefersReducedMotion]);
  // Keycaps follow your shortcut changes; App provides them to everything below.
  const keycap = (id: ActionId) => keycapFor(id, info.platform, state.settings.shortcuts);

  // Which way the sidebar slides when switching chords: toward the new chord's place in the switcher.
  const chordIndex = chord ? chordsFor(state, windowId).findIndex((c) => c.id === chord.id) : 0;
  const previousIndex = useRef(chordIndex);
  const slide = chordIndex >= previousIndex.current ? 1 : -1;
  useEffect(() => {
    previousIndex.current = chordIndex;
  }, [chordIndex]);

  // Downloads finished after this show a dot on the button until the panel is opened.
  const [downloadsSeenAt, setDownloadsSeenAt] = useState(() => Date.now());
  const downloads = summarizeDownloads(downloadsFor(state, windowId), downloadsSeenAt);
  const downloadsButton = <DownloadsButton summary={downloads} onOpen={() => setDownloadsSeenAt(Date.now())} />;
  const archiveKeys = keycap('app.history');
  const archiveLabel = archiveKeys ? `Archive  ${archiveKeys}` : 'Archive';
  const archiveButton = (
    <button type="button" className={styles.downloadsButton} aria-label="Archive" title={archiveLabel} onClick={() => void api.action.run('app.history')}>
      <Archive {...ICON} />
    </button>
  );
  const [chordEdit, setChordEdit] = useState<ChordEdit | null>(null);
  useEffect(() => api.chords.onEdit(setChordEdit), []);
  const createChord = async () => {
    await api.state.dispatch({ t: 'chord.create', windowId, name: 'New chord', ...newChordLook(sortedChords(state)) });
    // Main's patches arrive before its reply, so the mirror already shows the new chord: name it right away.
    const chordId = mirror.get().windows[windowId]?.activeChordId;
    if (chordId) setChordEdit({ chordId, field: 'name' });
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
          data-resizing={liveWidth !== null || undefined}
          style={{ ...style, '--size-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
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

            <button
              ref={collapsed ? undefined : anchorRef}
              type="button"
              className={styles.urlPill}
              title={active?.url ?? ''}
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

            {/* One drag space: tabs move between lists, onto Favorites, and onto chords in the switcher. */}
            <SidebarDnd state={state} chordId={chord?.id ?? ''}>
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
                    <SidebarTabs
                      chordId={chord?.id ?? ''}
                      state={state}
                      windowId={windowId}
                      activeId={activeId}
                      info={info}
                      appearance={appearance}
                      spring={spring}
                    />
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
                        />
                      </GhostPane>
                    )
                  );
                })}
              </div>

              {(!collapsed || peeking) && <Toasts transition={spring('overlay', 'sidebar')} compact={false} />}

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
            <div className={styles.bar} data-swipe-area={collapsed || undefined}>
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
              <span className={styles.flex} />
              {(inTitleBar || collapsed) && <ExtensionButtons bar={extensionsBar} puzzleOnly={!inTitleBar} />}
              {/* In the minimal bar, Downloads shows only while something downloads or just finished (DESIGN.md §3.3). */}
              {collapsed && <Toasts transition={spring('overlay', 'sidebar')} compact />}
              {collapsed && (downloads.active > 0 || downloads.unseen) && downloadsButton}
              {overlayChrome && (
                <button type="button" className={styles.iconButton} aria-label="Options" aria-haspopup="menu" title="Options" onClick={openOptions}>
                  <Ellipsis {...ICON} />
                </button>
              )}
            </div>
          )}
          {!overlayChrome && !collapsed && <div className={styles.topDrag} />}

          <div className={styles.frame}>
            {!state.settings.onboarded && chord && !isPrivate ? (
              <Onboarding chord={chord} windowId={windowId} info={info} spring={spring} />
            ) : (
              <>
                {active && live?.crashed && (
                  <div className={styles.empty} role="alert">
                    <p className={styles.emptyTitle}>This page stopped working.</p>
                    <p className={styles.emptyBody}>It’s not you. Reloading usually fixes it.</p>
                    <button type="button" className={styles.emptyButton} onClick={() => void api.nav.command('reload')}>
                      Reload
                    </button>
                  </div>
                )}
                {active && !live?.crashed && live?.error && <LoadErrorState error={live.error} canGoBack={live.canGoBack} windowId={windowId} tabId={active.id} />}
                {!active && (
                  <div className={styles.empty}>
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
        </div>
      </MotionConfig>
    </ShortcutsProvider>
  );
}
