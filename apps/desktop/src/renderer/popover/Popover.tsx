/**
 * The popover (ARCHITECTURE.md §5): cards that sit over the page at the
 * frame's top-right without blocking it. Main sizes the view to exactly
 * these cards, so the rest of the page stays clickable.
 */
import type { SitePermission } from '@chord/core';
import type { FindState, PermissionPrompt, PopoverState, SystemInfo } from '@chord/ipc';
import { Bell, Camera, ChevronDown, ChevronUp, Clipboard, MapPin, Mic, Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useLive, type Live } from '../shared/live';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './Popover.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

function FindBar({ find }: { find: FindState }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(find.text);
  // ⌘F again (or opening) focuses the field with its text selected, ready to type over.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [find.focus]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void api.find.query(text, !event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void api.find.close();
    }
  };
  const count = !text ? '' : find.matches === 0 ? 'No matches' : `${find.active} of ${find.matches}`;
  return (
    <div className={styles.card} role="search" aria-label="Find in page">
      <div className={styles.findRow}>
        <Search className={styles.muted} size={14} strokeWidth={2} aria-hidden />
        <input
          ref={input}
          className={styles.findInput}
          value={text}
          placeholder="Find in page"
          aria-label="Find in page"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            void api.find.query(e.target.value, true);
          }}
          onKeyDown={onKeyDown}
        />
        <span className={styles.count} aria-live="polite">
          {count}
        </span>
        <button type="button" className={styles.iconButton} aria-label="Previous match" disabled={find.matches === 0} onClick={() => void api.find.query(text, false)}>
          <ChevronUp {...ICON} />
        </button>
        <button type="button" className={styles.iconButton} aria-label="Next match" disabled={find.matches === 0} onClick={() => void api.find.query(text, true)}>
          <ChevronDown {...ICON} />
        </button>
        <button type="button" className={styles.iconButton} aria-label="Close find" onClick={() => void api.find.close()}>
          <X {...ICON} />
        </button>
      </div>
    </div>
  );
}

const PERMISSION_COPY: Record<SitePermission, { icon: typeof Camera; label: string }> = {
  camera: { icon: Camera, label: 'Use your camera' },
  microphone: { icon: Mic, label: 'Use your microphone' },
  location: { icon: MapPin, label: 'Know your location' },
  notifications: { icon: Bell, label: 'Show notifications' },
  'clipboard-read': { icon: Clipboard, label: 'See what you’ve copied' },
};

function PermissionCard({ prompt }: { prompt: PermissionPrompt }) {
  const respond = (decision: 'allow' | 'block' | 'dismiss') => void api.permission.respond(prompt.id, decision);
  return (
    <div className={styles.card} role="alertdialog" aria-label={`${prompt.host} is asking for permission`}>
      <div className={styles.permissionHead}>
        <p className={styles.permissionTitle}>
          <span className={styles.host}>{prompt.host}</span> wants to
        </p>
        <button type="button" className={styles.iconButton} aria-label="Not now" title="Not now (ask again next time)" onClick={() => respond('dismiss')}>
          <X {...ICON} />
        </button>
      </div>
      <ul className={styles.permissionList}>
        {prompt.permissions.map((p) => {
          const { icon: Icon, label } = PERMISSION_COPY[p];
          return (
            <li key={p}>
              <Icon {...ICON} aria-hidden />
              {label}
            </li>
          );
        })}
      </ul>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={() => respond('block')}>
          Block
        </button>
        <button type="button" className={styles.primary} onClick={() => respond('allow')}>
          Allow
        </button>
      </div>
    </div>
  );
}

export function Popover({ info: infoSource, state: stateSource }: { info: Live<SystemInfo>; state: Live<PopoverState> }) {
  const info = useLive(infoSource);
  const state = useLive(stateSource);
  const root = useRef<HTMLDivElement>(null);
  const hasCards = Boolean(state.find || state.permission);

  // Main fits the view to the cards; with none, the view hides.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void api.popover.size(hasCards ? r.width : 0, hasCards ? r.height : 0);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasCards]);

  const { style } = chordStyle(state.theme ? { theme: state.theme } : null, info, state.interface);
  return (
    <div ref={root} className={styles.root} style={style}>
      {state.find && <FindBar find={state.find} />}
      {state.permission && <PermissionCard key={state.permission.id} prompt={state.permission} />}
    </div>
  );
}
