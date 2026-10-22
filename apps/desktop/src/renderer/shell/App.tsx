import { activeTabId, formatKeys, shortcutById, tabsInOrder, type ActionId, type LiveTab, type TabNode } from '@chord/core';
import type { SystemInfo } from '@chord/ipc';
import { ArrowLeft, ArrowRight, Ellipsis, Globe, Lock, PanelLeft, Plus, RotateCw, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { MouseEvent } from 'react';
import { Favicon } from '../shared/Favicon';
import { useMirror, type Mirror } from '../shared/mirror';
import { spring } from '../shared/motion';
import { displayHost, pageTitle } from '../shared/site';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './App.module.css';
import { useSystemInfo } from './hooks';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

function keycap(id: ActionId, info: SystemInfo): string {
  const keys = shortcutById(id);
  const first = keys ? (info.platform === 'darwin' ? keys.mac : keys.other)[0] : undefined;
  return first ? formatKeys(first, info.platform) : '';
}

/** A label with its shortcut, for tooltips: "Reload  Ctrl+R". */
function withKeys(label: string, id: ActionId, info: SystemInfo): string {
  const keys = keycap(id, info);
  return keys ? `${label}  ${keys}` : label;
}

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
  const { style, appearance } = chordStyle(chord, info);
  const tabs = chord ? tabsInOrder(state, chord.id) : [];
  const activeId = activeTabId(state, windowId);
  const active = activeId ? (state.nodes[activeId] as TabNode | undefined) : undefined;
  const live = activeId ? state.live[activeId] : undefined;
  const host = active ? displayHost(active.url) : '';
  const title = active ? pageTitle(active) : '';
  const overlayChrome = info.windowChrome.kind === 'overlay';
  const secure = active?.url.startsWith('https:') ?? false;
  const collapsed = win?.sidebar === 'collapsed';

  const dispatch = api.state.dispatch;
  const closeTab = (id: string) => void dispatch({ t: 'tab.close', windowId, nodeId: id });
  const toggleSidebar = () => void api.action.run('view.toggleSidebar');
  const openOptions = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void api.menu.app({ x: r.x, y: r.y, width: r.width, height: r.height });
  };

  return (
    <div className={styles.window} data-sidebar={collapsed ? 'collapsed' : 'docked'} style={style}>
      <div className={styles.backdrop} aria-hidden>
        <div className={styles.tint} />
        <div className={styles.grain} />
      </div>

      <nav className={styles.sidebar} aria-label="Sidebar" inert={collapsed} aria-hidden={collapsed}>
        <header className={styles.header}>
          <SidebarToggle collapsed={collapsed} info={info} onToggle={toggleSidebar} />
          {!overlayChrome && <span className={styles.flex} />}
          <NavButtons live={live} hasTab={Boolean(active)} info={info} />
        </header>

        <button
          ref={collapsed ? undefined : anchorRef}
          type="button"
          className={styles.urlPill}
          title={active?.url ?? ''}
          onClick={() => void api.overlay.open('edit')}
        >
          {secure ? <Lock size={12} strokeWidth={2} aria-hidden /> : <Globe size={12} strokeWidth={2} aria-hidden />}
          <span className={styles.ellipsis}>{host || 'Search or enter address'}</span>
          <kbd className={styles.pillKeycap}>{keycap('address.edit', info)}</kbd>
        </button>

        <div className={styles.chordHeader}>
          <span className={styles.chordIcon} aria-hidden>
            {chord?.icon ?? '✦'}
          </span>
          <span className={styles.ellipsis}>{chord?.name ?? ''}</span>
        </div>

        <div className={styles.divider} role="separator" />

        <button type="button" className={`${styles.row} ${styles.newTab}`} onClick={() => void api.overlay.open('new')}>
          <Plus {...ICON} aria-hidden />
          <span className={styles.ellipsis}>New tab</span>
          <kbd className={styles.rowKeycap}>{keycap('tab.new', info)}</kbd>
        </button>

        <ul className={styles.list} aria-label="Today">
          <AnimatePresence initial={false} mode="popLayout">
            {tabs.map((tab) => {
              const isActive = tab.id === activeId;
              const tabLive = state.live[tab.id];
              return (
                <motion.li
                  key={tab.id}
                  layout="position"
                  className={styles.item}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={spring('smooth', 'tabMoves')}
                  onMouseDown={(e: MouseEvent) => {
                    if (e.button === 1) e.preventDefault(); // no autoscroll
                  }}
                  onAuxClick={(e: MouseEvent) => {
                    if (e.button === 1) closeTab(tab.id);
                  }}
                  onContextMenu={(e: MouseEvent) => {
                    e.preventDefault();
                    void api.menu.tab(tab.id, { x: e.clientX, y: e.clientY });
                  }}
                >
                  {isActive && (
                    <motion.span layoutId="active-pill" className={styles.activePill} transition={spring('snappy', 'tabMoves')} />
                  )}
                  <button
                    type="button"
                    className={`${styles.row} ${isActive ? styles.active : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    title={pageTitle(tab) || tab.url}
                    onClick={() => void dispatch({ t: 'tab.activate', windowId, nodeId: tab.id })}
                  >
                    <Favicon
                      url={tab.url}
                      title={tab.title}
                      favicon={tab.favicon}
                      loading={Boolean(tabLive?.loading) && !tab.favicon}
                      appearance={appearance}
                    />
                    <span className={styles.ellipsis}>{pageTitle(tab) || displayHost(tab.url) || 'New tab'}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.close}
                    aria-label={`Close ${tab.title || 'tab'}`}
                    title={withKeys('Close tab', 'tab.close', info)}
                    onClick={() => closeTab(tab.id)}
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>

        <span className={styles.flex} />

        <footer className={styles.footer}>
          <span className={styles.switcherPill} title={chord?.name} aria-label={`Chord: ${chord?.name ?? ''}`}>
            {chord?.icon ?? '✦'}
          </span>
        </footer>
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
          {overlayChrome && (
            <button type="button" className={styles.iconButton} aria-label="Options" aria-haspopup="menu" title="Options" onClick={openOptions}>
              <Ellipsis {...ICON} />
            </button>
          )}
        </div>
      )}
      {!overlayChrome && !collapsed && <div className={styles.topDrag} />}

      <div className={styles.frame}>
        {!active && (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Fresh chord, fresh start.</p>
            <p className={styles.emptyBody}>Open a site, or search for anything.</p>
            <button type="button" className={styles.emptyButton} onClick={() => void api.overlay.open('new')}>
              New tab <kbd className={styles.inlineKeycap}>{keycap('tab.new', info)}</kbd>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
