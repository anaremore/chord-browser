/**
 * The 36 px bar of a tab's developer tools in a window of their own
 * (DESIGN.md §7.16): the site they inspect, and **Dock in the window**
 * (⌘⇧D / Ctrl+Shift+D, Chrome's key for it), which puts them back beside the
 * page, on the side docked ones take. The window's own caption controls close them.
 */
import type { DevtoolsBar as BarState, SystemInfo } from '@chord/ipc';
import { PanelBottom, PanelRight, SquareTerminal } from 'lucide-react';
import { useLive, type Live } from '../shared/live';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './DevtoolsBar.module.css';

/** Neutral tint, as a mini window's: DevTools belong to no chord's look. */
const NEUTRAL = { theme: { stops: [{ l: 0.72, c: 0, h: 0 }], grain: 0.15, appearance: 'auto' as const } };

export function DevtoolsBar({ info: infoSource, bar: barSource }: { info: Live<SystemInfo>; bar: Live<BarState> }) {
  const info = useLive(infoSource);
  const bar = useLive(barSource);
  const { style } = chordStyle(NEUTRAL, info);
  const keys = info.platform === 'darwin' ? '⌘⇧D' : 'Ctrl+Shift+D';
  const Side = bar.side === 'right' ? PanelRight : PanelBottom;
  return (
    <div className={styles.bar} style={style} data-platform={info.platform}>
      <div className={styles.tint} aria-hidden />
      <div className={styles.title} title={bar.title ? `${bar.title}\n${bar.host}` : bar.host}>
        <SquareTerminal className={styles.icon} size={14} strokeWidth={1.75} aria-hidden />
        <span className={styles.name}>Developer tools</span>
        {bar.host && (
          <span className={styles.host} data-testid="devtools-host">
            {bar.host}
          </span>
        )}
      </div>
      <button type="button" className={styles.dock} title={`Dock in the window (${keys})`} onClick={() => void api.devtools.dock()}>
        <Side size={14} strokeWidth={1.75} aria-hidden />
        Dock in the window
      </button>
    </div>
  );
}
