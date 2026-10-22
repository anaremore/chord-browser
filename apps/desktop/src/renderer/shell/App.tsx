import type { SystemInfo } from '@chord/ipc';
import { createSpaceTheme, defaultSpaceStops, hexToRgb, rgbToOklch, siteColors, type SpaceTheme } from '@chord/tokens';
import { ArrowLeft, ArrowRight, Lock, RotateCw, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import styles from './App.module.css';
import { useSystemInfo, useTabState } from './hooks';
import { displayHost, monogram, siteHue } from './site';

function spaceTheme(info: SystemInfo): SpaceTheme {
  const accent = info.accentColor ? hexToRgb(info.accentColor) : null;
  return createSpaceTheme(
    { stops: defaultSpaceStops(accent ? rgbToOklch(accent) : null), grain: 0.35, appearance: 'auto' },
    { systemAppearance: info.appearance, material: info.material },
  );
}

function monogramStyle(host: string, info: SystemInfo): CSSProperties {
  const colors = siteColors(siteHue(host), info.appearance);
  return { '--monogram-bg': colors.background, '--monogram-fg': colors.foreground } as CSSProperties;
}

export function App({ initialInfo }: { initialInfo: SystemInfo }) {
  const info = useSystemInfo(initialInfo);
  const tab = useTabState();
  const theme = spaceTheme(info);
  const host = displayHost(tab.url);
  const title = tab.title || host;
  const overlayChrome = info.windowChrome.kind === 'overlay';

  return (
    <div className={styles.window} style={theme.vars as CSSProperties}>
      <div className={styles.backdrop} aria-hidden>
        <div className={styles.tint} />
        <div className={styles.grain} />
      </div>

      <nav className={styles.sidebar} aria-label="Sidebar">
        <header className={styles.header}>
          {/* macOS: buttons sit right, clear of the traffic lights. Windows/Linux: left (DESIGN.md §3.1). */}
          {!overlayChrome && <span className={styles.flex} />}
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Back"
            disabled={!tab.canGoBack}
            onClick={() => void window.chord.nav.command('back')}
          >
            <ArrowLeft size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Forward"
            disabled={!tab.canGoForward}
            onClick={() => void window.chord.nav.command('forward')}
          >
            <ArrowRight size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={tab.loading ? 'Stop' : 'Reload'}
            onClick={() => void window.chord.nav.command(tab.loading ? 'stop' : 'reload')}
          >
            {tab.loading ? <X size={16} strokeWidth={1.75} /> : <RotateCw size={16} strokeWidth={1.75} />}
          </button>
        </header>

        <div className={styles.urlPill} title={tab.url}>
          <Lock size={12} strokeWidth={2} aria-hidden />
          <span className={styles.ellipsis}>{host}</span>
        </div>

        <div className={styles.spaceHeader}>
          <span className={styles.spaceIcon} aria-hidden>
            ✦
          </span>
          <span>Personal</span>
        </div>

        <div className={styles.divider} role="separator" />

        <ul className={styles.list} aria-label="Today">
          <li className={`${styles.row} ${styles.active}`} aria-current="page">
            <span
              className={styles.monogram}
              style={monogramStyle(host, info)}
              aria-hidden
            >
              {monogram(host, title)}
            </span>
            <span className={styles.ellipsis}>{title}</span>
          </li>
        </ul>

        <span className={styles.flex} />

        <footer className={styles.footer}>
          <span className={styles.switcherPill} aria-label="Space: Personal">
            ✦
          </span>
        </footer>
      </nav>

      {overlayChrome && (
        <div className={styles.strip}>
          <span className={styles.address}>
            <span className={styles.addressHost}>{host}</span>
            {tab.title && (
              <>
                <span className={styles.addressSeparator} aria-hidden>
                  /
                </span>
                <span className={styles.addressTitle}>{tab.title}</span>
              </>
            )}
          </span>
        </div>
      )}

      {!overlayChrome && <div className={styles.topDrag} />}
      <div className={styles.frame} aria-hidden />
    </div>
  );
}
