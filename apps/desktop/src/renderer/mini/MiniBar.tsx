/**
 * A mini window's 36 px bar (DESIGN.md §7.9): the site, copy link, and
 * **Open in ▾ [chord]**, which moves the page into that chord's Today (⌘↵).
 * The chevron picks another chord. The window's own caption controls close it.
 */
import type { MiniState, SystemInfo } from '@chord/ipc';
import { Check, ChevronDown, Globe, Link2, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './MiniBar.module.css';

/** Neutral tint: a mini window belongs to no chord until you move its page into one. */
const NEUTRAL = { theme: { stops: [{ l: 0.72, c: 0, h: 0 }], grain: 0.15, appearance: 'auto' as const } };
const COPIED_MS = 1200;

export function MiniBar({ initialInfo, initialState }: { initialInfo: SystemInfo; initialState: MiniState }) {
  const [info, setInfo] = useState(initialInfo);
  const [state, setState] = useState(initialState);
  const [copied, setCopied] = useState(false);
  const chevron = useRef<HTMLButtonElement>(null);
  useEffect(() => api.system.onChange(setInfo), []);
  useEffect(() => api.mini.onState(setState), []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const { style } = chordStyle(NEUTRAL, info);
  const keys = info.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter';
  const SiteIcon = state.secure ? Lock : Globe;
  const target = state.target;

  const choose = () => {
    const rect = chevron.current?.getBoundingClientRect();
    if (rect) void api.mini.chooseChord({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  };

  return (
    <div className={styles.bar} style={style} data-platform={info.platform}>
      <div className={styles.tint} aria-hidden />
      <div className={styles.site} title={state.title ? `${state.title}\n${state.url}` : state.url}>
        <SiteIcon className={styles.siteIcon} size={12} strokeWidth={2} aria-label={state.secure ? 'Secure' : undefined} aria-hidden={!state.secure} />
        <span className={styles.host} data-testid="mini-host">
          {state.host || state.url}
        </span>
      </div>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={copied ? 'Link copied' : 'Copy link'}
        title={copied ? 'Link copied' : 'Copy link'}
        onClick={() => {
          void api.mini.copyLink();
          setCopied(true);
        }}
      >
        {copied ? <Check size={14} strokeWidth={2} aria-hidden /> : <Link2 size={14} strokeWidth={1.75} aria-hidden />}
      </button>
      <div className={styles.split} role="group" aria-label="Open in a chord">
        <button
          type="button"
          className={styles.promote}
          disabled={!target}
          title={target ? `Open in ${target.name} (${keys})` : undefined}
          onClick={() => void api.mini.promote()}
        >
          Open in
          {target && (
            <span className={styles.chord}>
              <span aria-hidden>{target.icon}</span> {target.name}
            </span>
          )}
        </button>
        <button ref={chevron} type="button" className={styles.chevron} aria-label="Choose a chord" aria-haspopup="menu" onClick={choose}>
          <ChevronDown size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
      {state.loading && <div className={styles.loading} aria-hidden />}
    </div>
  );
}
