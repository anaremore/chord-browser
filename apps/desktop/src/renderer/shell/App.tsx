import { activeTabId, formatKeys, shortcutById, tabsInOrder, type ActionId, type TabNode } from '@chord/core';
import type { SystemInfo } from '@chord/ipc';
import { ArrowLeft, ArrowRight, Globe, Lock, Plus, RotateCw, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useLayoutEffect, useRef, type MouseEvent } from 'react';
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
  const overlayChrome = info.windowChrome.kind === 'overlay';
  const secure = active?.url.startsWith('https:') ?? false;

  const pillRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = pillRef.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void api.layout.anchor({ x: r.x, y: r.y, width: r.width, height: r.height });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, []);

  const dispatch = api.state.dispatch;
  const closeTab = (id: string) => void dispatch({ t: 'tab.close', windowId, nodeId: id });

  return (
    <div className={styles.window} style={style}>
      <div className={styles.backdrop} aria-hidden>
        <div className={styles.tint} />
        <div className={styles.grain} />
      </div>

      <nav className={styles.sidebar} aria-label="Sidebar">
        <header className={styles.header}>
          {!overlayChrome && <span className={styles.flex} />}
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Back"
            disabled={!live?.canGoBack}
            onClick={() => void api.nav.command('back')}
          >
            <ArrowLeft {...ICON} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Forward"
            disabled={!live?.canGoForward}
            onClick={() => void api.nav.command('forward')}
          >
            <ArrowRight {...ICON} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={live?.loading ? 'Stop' : 'Reload'}
            title={live?.loading ? 'Stop' : `Reload  ${keycap('nav.reload', info)}`}
            disabled={!active}
            onClick={() => void api.nav.command(live?.loading ? 'stop' : 'reload')}
          >
            {live?.loading ? <X {...ICON} /> : <RotateCw {...ICON} />}
          </button>
        </header>

        <button
          ref={pillRef}
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
                    title={`Close tab  ${keycap('tab.close', info)}`}
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

      {overlayChrome && (
        <div className={styles.strip}>
          {active && (
            <button type="button" className={styles.address} onClick={() => void api.overlay.open('edit')}>
              <span className={styles.addressHost}>{host}</span>
              {pageTitle(active) && (
                <>
                  <span className={styles.addressMuted} aria-hidden>
                    /
                  </span>
                  <span className={`${styles.addressMuted} ${styles.ellipsis}`}>{pageTitle(active)}</span>
                </>
              )}
            </button>
          )}
        </div>
      )}
      {!overlayChrome && <div className={styles.topDrag} />}

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
