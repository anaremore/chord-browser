/**
 * The popover (ARCHITECTURE.md §5): cards that sit over the page at the
 * frame's top-right without blocking it. Main sizes the view to exactly
 * these cards, so the rest of the page stays clickable.
 */
import { SAFE_BROWSING_NOTICE, type SitePermission } from '@chord/core';
import { SYSTEM_SHARE_SOURCE, type AuthPrompt, type DrmNotice, type FindState, type PermissionPrompt, type PopoverState, type SharePrompt, type ShareSource, type SystemInfo } from '@chord/ipc';
import type { Appearance } from '@chord/tokens';
import { Bell, Camera, ChevronDown, ChevronUp, Clipboard, KeyRound, MapPin, Mic, MonitorPlay, MonitorUp, Search, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Favicon } from '../shared/Favicon';
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

type ShareKind = ShareSource['kind'];

const SHARE_KINDS: { kind: ShareKind; label: string; list: string }[] = [
  { kind: 'tab', label: 'A tab', list: 'Tabs' },
  { kind: 'window', label: 'A window', list: 'Windows' },
  { kind: 'screen', label: 'Entire screen', list: 'Screens' },
];

/**
 * Chord's share picker (ARCHITECTURE.md §9): one of Chord's tabs, a window or
 * a screen, and the sound that goes with it. Screens and windows are named at
 * once and pictured as the pictures arrive. Where the system picks those
 * itself (macOS 15 and later, Wayland), the card lists tabs and opens the
 * system's picker for the rest.
 */
function ShareCard({ prompt, appearance, platform }: { prompt: SharePrompt; appearance: Appearance; platform: SystemInfo['platform'] }) {
  const of = (k: ShareKind) => prompt.sources.filter((s) => s.kind === k);
  const [kind, setKind] = useState<ShareKind>('tab');
  const shown = of(kind);
  const [picked, setPicked] = useState<string | null>(null);
  // A tab's sound comes along unless you say not; the computer's only if you ask (it's everything you hear).
  const [tabSound, setTabSound] = useState(true);
  const [systemSound, setSystemSound] = useState(false);
  const sound = kind === 'tab' ? prompt.audio : prompt.audio && prompt.systemAudio;
  const respond = (sourceId: string | null) =>
    void api.share.respond(prompt.id, sourceId, sourceId !== SYSTEM_SHARE_SOURCE && sound && (kind === 'tab' ? tabSound : systemSound));
  const show = (k: ShareKind) => {
    setKind(k);
    // One screen is the usual answer: it's picked already.
    const screens = of('screen');
    setPicked(k === 'screen' && screens.length === 1 ? screens[0]!.id : null);
  };
  const lists = prompt.systemPicker ? SHARE_KINDS.filter((k) => k.kind === 'tab') : SHARE_KINDS;
  const list = SHARE_KINDS.find((k) => k.kind === kind)!.list;
  return (
    <div
      className={`${styles.card} ${styles.shareCard}`}
      role="alertdialog"
      aria-label={`Choose what to share with ${prompt.host}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') respond(null);
      }}
    >
      <div className={styles.permissionHead}>
        <p className={styles.permissionTitle}>
          Choose what to share with <span className={styles.host}>{prompt.host}</span>
        </p>
        <button type="button" className={styles.iconButton} aria-label="Don't share" title="Don't share" onClick={() => respond(null)}>
          <X {...ICON} />
        </button>
      </div>
      {lists.length > 1 && (
        <div className={styles.shareTabs} role="tablist" aria-label="What to share">
          {lists.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="tab"
              aria-selected={kind === k.kind}
              className={styles.shareTab}
              // Still being listed, screens and windows can be chosen as soon as they are.
              disabled={of(k.kind).length === 0 && !prompt.loading}
              onClick={() => show(k.kind)}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      {kind === 'tab' ? (
        <div className={styles.tabSources} role="listbox" aria-label={list}>
          {shown.map((source) => (
            <button
              key={source.id}
              type="button"
              role="option"
              aria-selected={picked === source.id}
              className={styles.tabSource}
              onClick={() => setPicked(source.id)}
              onDoubleClick={() => respond(source.id)}
            >
              <Favicon url={`https://${source.host ?? ''}/`} title={source.name} favicon={source.favicon ?? null} appearance={appearance} />
              <span className={styles.tabSourceName}>{source.name}</span>
              {source.self ? <span className={styles.selfTag}>This tab</span> : <span className={styles.tabSourceHost}>{source.host}</span>}
            </button>
          ))}
        </div>
      ) : (
      <div className={styles.sources} role="listbox" aria-label={list} aria-busy={prompt.loading || undefined}>
        {shown.length === 0 && <p className={styles.sourcesEmpty}>Finding {list.toLowerCase()}…</p>}
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
      )}
      {sound && (
        <label className={styles.shareAudio}>
          {kind === 'tab' ? (
            <input type="checkbox" checked={tabSound} onChange={(e) => setTabSound(e.target.checked)} />
          ) : (
            <input type="checkbox" checked={systemSound} onChange={(e) => setSystemSound(e.target.checked)} />
          )}
          {kind === 'tab' ? "Share the tab's sound too" : "Share your computer's sound too"}
        </label>
      )}
      <div className={styles.actions}>
        {prompt.systemPicker && (
          <button
            type="button"
            className={`${styles.secondary} ${styles.systemPicker}`}
            title={platform === 'darwin' ? "Opens macOS's own picker" : "Opens your desktop's own picker"}
            onClick={() => respond(SYSTEM_SHARE_SOURCE)}
          >
            <MonitorUp size={14} strokeWidth={2} aria-hidden />
            Screen or window…
          </button>
        )}
        <button type="button" className={styles.secondary} onClick={() => respond(null)}>
          Cancel
        </button>
        <button type="button" className={styles.primary} disabled={!picked || !shown.some((s) => s.id === picked)} onClick={() => respond(picked)}>
          Share
        </button>
      </div>
    </div>
  );
}

/**
 * A site or proxy asking for a username and password (HTTP Basic, Digest or
 * NTLM; ARCHITECTURE.md §9). What's typed goes to main once, on Sign in, and
 * Chord keeps none of it: Chromium remembers a sign-in that worked until you quit.
 */
function AuthCard({ prompt }: { prompt: AuthPrompt }) {
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const [sent, setSent] = useState(false);
  const ids = useId();
  // The username field has the keyboard when the box appears (main focuses the popover too).
  useEffect(() => username.current?.focus(), []);
  const respond = (credentials: { username: string; password: string } | null) => {
    setSent(true);
    void api.auth.respond(prompt.id, credentials);
  };
  const title = prompt.proxy ? 'The proxy' : 'Sign in to';
  return (
    <form
      className={styles.card}
      role="alertdialog"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-notes`}
      onSubmit={(e) => {
        e.preventDefault();
        respond({ username: username.current?.value ?? '', password: password.current?.value ?? '' });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          respond(null);
        }
      }}
    >
      <div className={styles.permissionHead}>
        <KeyRound className={styles.offerIcon} {...ICON} aria-hidden />
        <p id={`${ids}-title`} className={styles.permissionTitle}>
          {title} <span className={styles.host}>{prompt.origin}</span>
          {prompt.proxy && ' needs you to sign in'}
        </p>
        <button type="button" className={styles.iconButton} aria-label="Cancel" title="Cancel" onClick={() => respond(null)}>
          <X {...ICON} />
        </button>
      </div>
      <div id={`${ids}-notes`} className={styles.authNotes}>
        {prompt.retry && <p className={styles.authRetry}>That username and password didn't work.</p>}
        {prompt.realm && (
          <p className={styles.offerNotice}>
            The site says: <q className={styles.realm}>{prompt.realm}</q>
          </p>
        )}
        {prompt.insecure && (
          <p className={styles.authWarning}>
            <TriangleAlert size={14} strokeWidth={2} aria-hidden />
            This site isn't on HTTPS, so what you type here can be read on its way there.
          </p>
        )}
      </div>
      <div className={styles.authFields}>
        <label className={styles.authLabel} htmlFor={`${ids}-username`}>
          Username
        </label>
        <input ref={username} id={`${ids}-username`} className={styles.authInput} autoComplete="username" spellCheck={false} autoCapitalize="off" />
        <label className={styles.authLabel} htmlFor={`${ids}-password`}>
          Password
        </label>
        <input ref={password} id={`${ids}-password`} className={styles.authInput} type="password" autoComplete="current-password" />
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={() => respond(null)}>
          Cancel
        </button>
        <button type="submit" className={styles.primary} disabled={sent}>
          Sign in
        </button>
      </div>
    </form>
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

/**
 * On a service that needs Widevine (ARCHITECTURE.md §16, D4): it won't play
 * here yet, with up to two other browsers on this computer to open the page
 * in. Not now hides it for the service until Chord quits.
 */
function DrmNoticeCard({ notice }: { notice: DrmNotice }) {
  const id = useId();
  const [first, second] = notice.browsers;
  return (
    <div className={styles.card} role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-notice`}>
      <div className={styles.permissionHead}>
        <MonitorPlay className={styles.offerIcon} {...ICON} aria-hidden />
        <p id={`${id}-title`} className={styles.permissionTitle}>
          <span className={styles.host}>{notice.service} won’t play in Chord yet</span>
        </p>
        <button type="button" className={styles.iconButton} aria-label="Not now" title="Not now" onClick={() => void api.drm.dismiss()}>
          <X {...ICON} />
        </button>
      </div>
      <p id={`${id}-notice`} className={styles.offerNotice}>
        It needs Widevine, the copy protection streaming services use, which Chord doesn’t include yet.
        {first ? '' : ' Another browser can play it for now.'}
      </p>
      {first && (
        <div className={styles.actions}>
          {second && (
            <button type="button" className={styles.secondary} onClick={() => void api.drm.open(second.id)}>
              Open in {second.name}
            </button>
          )}
          <button type="button" className={styles.primary} onClick={() => void api.drm.open(first.id)}>
            Open in {first.name}
          </button>
        </div>
      )}
    </div>
  );
}

export function Popover({ info: infoSource, state: stateSource }: { info: Live<SystemInfo>; state: Live<PopoverState> }) {
  const info = useLive(infoSource);
  const state = useLive(stateSource);
  const root = useRef<HTMLDivElement>(null);
  const hasCards = Boolean(state.find || state.permission || state.share || state.auth || state.safeBrowsingOffer || state.drm);

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

  const { style, appearance } = chordStyle(state.theme ? { theme: state.theme } : null, info, state.interface);
  return (
    <div ref={root} className={styles.root} style={style}>
      {state.find && <FindBar find={state.find} />}
      {state.permission && <PermissionCard key={state.permission.id} prompt={state.permission} />}
      {state.share && <ShareCard key={state.share.id} prompt={state.share} appearance={appearance} platform={info.platform} />}
      {state.auth && <AuthCard key={state.auth.id} prompt={state.auth} />}
      {state.safeBrowsingOffer && <SafeBrowsingOffer />}
      {state.drm && <DrmNoticeCard key={state.drm.service} notice={state.drm} />}
    </div>
  );
}
