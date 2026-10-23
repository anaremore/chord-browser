/**
 * The popover (ARCHITECTURE.md §5): cards that sit over the page at the
 * frame's top-right without blocking it. Main sizes the view to exactly
 * these cards, so the rest of the page stays clickable.
 */
import { SAFE_BROWSING_NOTICE, type SitePermission } from '@chord/core';
import type { FindState, PermissionPrompt, PopoverState, SharePrompt, SystemInfo } from '@chord/ipc';
import { Bell, Camera, ChevronDown, ChevronUp, Clipboard, MapPin, Mic, Search, ShieldCheck, X } from 'lucide-react';
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

/** Chord's screen-share picker (ARCHITECTURE.md §9): a screen or a window, and the computer's sound where the OS allows. */
function ShareCard({ prompt }: { prompt: SharePrompt }) {
  const screens = prompt.sources.filter((s) => s.kind === 'screen');
  const windows = prompt.sources.filter((s) => s.kind === 'window');
  const [kind, setKind] = useState<'screen' | 'window'>(screens.length > 0 ? 'screen' : 'window');
  const shown = kind === 'screen' ? screens : windows;
  // One screen is the usual answer: it's picked already.
  const [picked, setPicked] = useState<string | null>(screens.length === 1 ? screens[0]!.id : null);
  const [audio, setAudio] = useState(false);
  const respond = (sourceId: string | null) => void api.share.respond(prompt.id, sourceId, audio && prompt.audio);
  return (
    <div
      className={`${styles.card} ${styles.shareCard}`}
      role="alertdialog"
      aria-label={`${prompt.host} wants to share your screen`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') respond(null);
      }}
    >
      <div className={styles.permissionHead}>
        <p className={styles.permissionTitle}>
          <span className={styles.host}>{prompt.host}</span> wants to share your screen
        </p>
        <button type="button" className={styles.iconButton} aria-label="Don't share" title="Don't share" onClick={() => respond(null)}>
          <X {...ICON} />
        </button>
      </div>
      <div className={styles.shareTabs} role="tablist" aria-label="What to share">
        {(['screen', 'window'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={styles.shareTab}
            disabled={(k === 'screen' ? screens : windows).length === 0}
            onClick={() => setKind(k)}
          >
            {k === 'screen' ? 'Entire screen' : 'A window'}
          </button>
        ))}
      </div>
      <div className={styles.sources} role="listbox" aria-label={kind === 'screen' ? 'Screens' : 'Windows'}>
        {shown.map((source) => (
          <button
            key={source.id}
            type="button"
            role="option"
            aria-selected={picked === source.id}
            className={styles.source}
            onClick={() => setPicked(source.id)}
            onDoubleClick={() => respond(source.id)}
          >
            {source.thumbnail ? <img className={styles.thumbnail} src={source.thumbnail} alt="" draggable={false} /> : <span className={styles.thumbnail} />}
            <span className={styles.sourceName}>{source.name}</span>
          </button>
        ))}
      </div>
      {prompt.audio && (
        <label className={styles.shareAudio}>
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          Share your computer's sound too
        </label>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={() => respond(null)}>
          Cancel
        </button>
        <button type="button" className={styles.primary} disabled={!picked} onClick={() => respond(picked)}>
          Share
        </button>
      </div>
    </div>
  );
}

/**
 * Safe Browsing's one-time offer (ARCHITECTURE.md §14.5), for a profile from
 * before it existed: its notice in full, then on or not now. Either answer
 * is final; Settings → Privacy can change it later.
 */
function SafeBrowsingOffer() {
  const choose = (on: boolean) => void api.safeBrowsing.choose(on);
  return (
    <div className={styles.card} role="dialog" aria-labelledby="safe-browsing-offer" aria-describedby="safe-browsing-notice">
      <div className={styles.permissionHead}>
        <ShieldCheck className={styles.offerIcon} {...ICON} aria-hidden />
        <p id="safe-browsing-offer" className={styles.permissionTitle}>
          <span className={styles.host}>Warn you before risky sites?</span>
        </p>
      </div>
      <p id="safe-browsing-notice" className={styles.offerNotice}>
        {SAFE_BROWSING_NOTICE}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={() => choose(false)}>
          Not now
        </button>
        <button type="button" className={styles.primary} onClick={() => choose(true)}>
          Turn on
        </button>
      </div>
    </div>
  );
}

export function Popover({ info: infoSource, state: stateSource }: { info: Live<SystemInfo>; state: Live<PopoverState> }) {
  const info = useLive(infoSource);
  const state = useLive(stateSource);
  const root = useRef<HTMLDivElement>(null);
  const hasCards = Boolean(state.find || state.permission || state.share || state.safeBrowsingOffer);

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
      {state.share && <ShareCard key={state.share.id} prompt={state.share} />}
      {state.safeBrowsingOffer && <SafeBrowsingOffer />}
    </div>
  );
}
