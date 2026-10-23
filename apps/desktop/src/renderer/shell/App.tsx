import { activeTabId, describeLoadError, isInternalUrl, sortedChords, type LiveTab, type LoadError, type TabNode } from '@chord/core';
import type { ChordEdit, SystemInfo } from '@chord/ipc';
import { Archive, ArrowLeft, ArrowRight, Ellipsis, Globe, Lock, PanelLeft, RotateCw, X } from 'lucide-react';
import { AnimatePresence, MotionConfig } from 'motion/react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useMirror, type Mirror } from '../shared/mirror';
import { applyMotion, reducedMotionMode, springsFor } from '../shared/motion';
import { displayHost, pageTitle } from '../shared/site';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './App.module.css';
import { ChordHeader, ChordPane, ChordSwitcher, newChordLook, Tint } from './Chords';
import { useSystemInfo } from './hooks';
import { keycap, withKeys } from './keys';
import { DownloadsButton, summarizeDownloads } from './Downloads';
import { ExtensionButtons, ExtensionsShelf, useExtensionsBar } from './Extensions';
import { Onboarding } from './Onboarding';
import { SidebarTabs } from './Tabs';
import { Toasts } from './Toasts';

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

function SidebarToggle({ collapsed, info, onToggle }: { collapsed: boolean; info: SystemInfo; onToggle(): void }) {
  return (
    <button
      type="button"
      className={styles.iconButton}
      aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
      aria-expanded={!collapsed}
      title={withKeys(collapsed ? 'Show sidebar' : 'Hide sidebar', 'view.toggleSidebar', info)}
      onClick={onToggle}
    >
      <PanelLeft {...ICON} />
    </button>
  );
}

function NavButtons({ live, hasTab, info }: { live: LiveTab | undefined; hasTab: boolean; info: SystemInfo }) {
  return (
    <>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Back"
        title={withKeys('Back', 'nav.back', info)}
        disabled={!live?.canGoBack}
        onClick={() => void api.nav.command('back')}
      >
        <ArrowLeft {...ICON} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Forward"
        title={withKeys('Forward', 'nav.forward', info)}
        disabled={!live?.canGoForward}
        onClick={() => void api.nav.command('forward')}
      >
        <ArrowRight {...ICON} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={live?.loading ? 'Stop' : 'Reload'}
        title={live?.loading ? 'Stop' : withKeys('Reload', 'nav.reload', info)}
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

  // Which way the sidebar slides when switching chords: toward the new chord's place in the switcher.
  const chordIndex = chord ? sortedChords(state).findIndex((c) => c.id === chord.id) : 0;
  const previousIndex = useRef(chordIndex);
  const slide = chordIndex >= previousIndex.current ? 1 : -1;
  useEffect(() => {
    previousIndex.current = chordIndex;
  }, [chordIndex]);

  // Downloads finished after this show a dot on the button until the panel is opened.
  const [downloadsSeenAt, setDownloadsSeenAt] = useState(() => Date.now());
  const downloads = summarizeDownloads(state.downloads, downloadsSeenAt);
  const downloadsButton = <DownloadsButton summary={downloads} onOpen={() => setDownloadsSeenAt(Date.now())} />;
  const archiveLabel = withKeys('Archive', 'app.history', info);
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

  const toggleSidebar = () => void api.action.run('view.toggleSidebar');
  const openOptions = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void api.menu.app({ x: r.x, y: r.y, width: r.width, height: r.height });
  };

  // Motion's default ignores the OS; "user" honors reduced motion (DESIGN.md §6.6) unless Settings says not to.
  return (
    <MotionConfig reducedMotion={reducedMotionMode(state.settings)}>
      <div className={styles.window} data-sidebar={collapsed ? 'collapsed' : 'docked'} style={style}>
        <div className={styles.backdrop} aria-hidden>
          <Tint value={String(style['--color-tint' as keyof typeof style] ?? '')} transition={spring('gentle', 'colorBlend')} />
          <div className={styles.grain} />
        </div>

        <nav className={styles.sidebar} aria-label="Sidebar" inert={collapsed} aria-hidden={collapsed}>
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
            <kbd className={styles.pillKeycap}>{keycap('address.edit', info)}</kbd>
          </button>

          <AnimatePresence initial={false} mode="popLayout" custom={slide}>
            <ChordPane key={chord?.id} slide={slide} transition={spring('smooth', 'chordSlide')}>
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

          {!collapsed && <Toasts transition={spring('overlay', 'sidebar')} compact={false} />}

          {!inTitleBar && <ExtensionsShelf bar={extensionsBar} />}

          <ChordSwitcher
            state={state}
            windowId={windowId}
            info={info}
            pill={spring('snappy', 'chordSlide')}
            leading={
              <>
                {archiveButton}
                {downloadsButton}
              </>
            }
            onCreate={() => void createChord()}
          />
        </nav>

        {/* The top bar: right of the sidebar on Windows/Linux; the whole minimal bar when collapsed (DESIGN.md §3.3). */}
        {(overlayChrome || collapsed) && (
          <div className={styles.bar}>
            {collapsed && (
              <div className={styles.barLead}>
                <SidebarToggle collapsed info={info} onToggle={toggleSidebar} />
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
          {!state.settings.onboarded && chord ? (
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
                  <p className={styles.emptyTitle}>Fresh chord, fresh start.</p>
                  <p className={styles.emptyBody}>Open a site, or search for anything.</p>
                  <button type="button" className={styles.emptyButton} onClick={() => void api.overlay.open('new')}>
                    New tab <kbd className={styles.inlineKeycap}>{keycap('tab.new', info)}</kbd>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </MotionConfig>
  );
}
