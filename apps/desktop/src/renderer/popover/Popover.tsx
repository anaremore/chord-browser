/**
 * The popover (ARCHITECTURE.md §5): cards that sit over the page at the
 * frame's top-right without blocking it. Main sizes the view to exactly
 * these cards, so the rest of the page stays clickable.
 */
import { formatKeys, PASSWORD_REGENERATE_KEYS, SAFE_BROWSING_NOTICE, type Platform, type SitePermission } from '@chord/core';
import {
  SYSTEM_SHARE_SOURCE,
  type AgentConnectCard,
  type AuthPrompt,
  type DrmNotice,
  type FindState,
  type PasskeyPrompt,
  type PasswordMenu,
  type PasswordSaveCard,
  type PasswordUnlockPrompt,
  type PermissionPrompt,
  type PlayerOffer,
  type PopoverState,
  type SharePrompt,
  type ShareSource,
  type SystemInfo,
} from '@chord/ipc';
import { durations, type Appearance } from '@chord/tokens';
import {
  Bell,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  MapPin,
  Mic,
  MonitorPlay,
  MonitorUp,
  RotateCw,
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { AgentCardBody } from '../shared/AgentCard';
import { Favicon } from '../shared/Favicon';
import { EMPTY_PASSPHRASE, PassphraseStep, passphraseReady, type PassphraseValue } from '../shared/PassphraseStep';
import { useLive, type Live } from '../shared/live';
import { installingLabel, megabytes, PLAYER_FAILURES } from '../shared/player';
import { chordStyle, useRootColorScheme } from '../shared/theme';
import { api } from './api';
import { EffectsCard } from './EffectsCard';
import styles from './Popover.module.css';
import { PromptKeys } from './prompt-keys';

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

/** A field you type into (the box's username and password), where Space types rather than presses. */
const isTextField = (target: EventTarget) => target instanceof HTMLInputElement && target.type !== 'checkbox';
/** The box's Cancel buttons (`data-cancel`): they always work, as Escape does. */
const isCancel = (target: EventTarget) => target instanceof HTMLElement && target.hasAttribute('data-cancel');

/** What a filled password field holds: a mask, never the password, which stays in main. */
const FILLED_MASK = '•'.repeat(10);

/**
 * A site or proxy asking for a username and password (HTTP Basic, Digest or
 * NTLM; ARCHITECTURE.md §9). What's typed goes to main once, on Sign in.
 * With Chord's passwords on here (S17 §10): a sign-in saved from this box for
 * this origin and realm fills it, its password masked (this page never has
 * it: Sign in sends which account, and main answers from the vault); several
 * get a chooser of usernames; a locked vault gets *Unlock passwords*. A
 * frame of another site's page says whose page it's in, and isn't filled:
 * its usernames are the chooser, so signing in takes a click on one. And
 * *Remember* saves what you typed once the site takes it. Never for a proxy,
 * and a private window fills without *Remember*.
 */
export function AuthCard({ prompt }: { prompt: AuthPrompt }) {
  const form = useRef<HTMLFormElement>(null);
  const usernameField = useRef<HTMLInputElement>(null);
  const signIn = useRef<HTMLButtonElement>(null);
  const [sent, setSent] = useState(false);
  /** The saved sign-in the box is filled with, by its place in `prompt.accounts`; null once you type over it. */
  const [filled, setFilled] = useState<number | null>(prompt.fill && prompt.accounts.length > 0 ? 0 : null);
  const [username, setUsername] = useState(prompt.fill ? (prompt.accounts[0] ?? '') : '');
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState(false);
  const [remember, setRemember] = useState(prompt.remember ?? false);
  const ids = useId();
  // Sign in, the chooser and Unlock wait a moment after the box appears (disabled, so Enter doesn't submit either): a
  // page can't time the box to appear under a click, or a held Enter, meant for itself. Then Enter and Space must be
  // pressed afresh: a key held through the wait only repeats, or is let go (prompt-keys.ts). Cancel and Escape always work.
  const [keys] = useState(() => new PromptKeys());
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      keys.arm();
      setArmed(true);
    }, durations.promptInputDelay);
    return () => clearTimeout(timer);
  }, []);
  // The username field has the keyboard when the box appears (main focuses the popover too); Sign in when it's filled.
  // Filled, the box itself holds it (Escape cancels) until Sign in can take it.
  useEffect(() => (prompt.fill && prompt.accounts.length > 0 ? form.current : usernameField.current)?.focus(), []);
  useEffect(() => {
    if (armed && filled !== null && !typed && form.current?.contains(document.activeElement)) signIn.current?.focus();
  }, [armed]);
  // Filled after the box appeared (the vault answered late, or was just unlocked): unless you've typed already.
  const accounts = prompt.accounts.join('\n');
  useEffect(() => {
    if (typed || !prompt.fill || prompt.accounts.length === 0 || filled !== null) return;
    setFilled(0);
    setUsername(prompt.accounts[0]!);
    setPassword('');
    if (prompt.remember !== null) setRemember(true);
    // An Enter held on *Unlock passwords* doesn't repeat into Sign in.
    keys.refocused();
    signIn.current?.focus();
  }, [accounts]);
  // Main didn't answer with a saved sign-in (the vault locked meanwhile): the box is yours again.
  useEffect(() => setSent(false), [prompt.locked, accounts]);
  const respond = (credentials: { username: string; password: string } | { account: number; username: string } | null) => {
    setSent(true);
    void api.auth.respond(prompt.id, credentials, prompt.remember !== null && remember);
  };
  const choose = (index: number) => {
    setFilled(index);
    setUsername(prompt.accounts[index]!);
    setPassword('');
    setTyped(false);
    // Filled from the vault: Remember keeps it so, as when the box opened filled.
    if (prompt.remember !== null) setRemember(true);
  };
  const title = prompt.proxy ? 'The proxy' : 'Sign in to';
  return (
    <form
      ref={form}
      tabIndex={-1}
      className={`${styles.card} ${styles.authBox}`}
      role="alertdialog"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-notes`}
      onKeyDownCapture={(e) => {
        if (!keys.keydown({ key: e.key, repeat: e.repeat, field: isTextField(e.target), cancel: isCancel(e.target) })) e.preventDefault();
      }}
      onKeyUpCapture={(e) => {
        if (!keys.keyup({ key: e.key, field: isTextField(e.target), cancel: isCancel(e.target) })) e.preventDefault();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!keys.ready) return;
        respond(filled !== null ? { account: filled, username: prompt.accounts[filled]! } : { username, password });
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
        <button type="button" className={styles.iconButton} aria-label="Cancel" title="Cancel" data-cancel onClick={() => respond(null)}>
          <X {...ICON} />
        </button>
      </div>
      <div id={`${ids}-notes`} className={styles.authNotes}>
        {prompt.embedded && (
          <p className={styles.offerNotice}>
            Asked by <span className={styles.host}>{new URL(prompt.origin).host}</span>, inside{' '}
            {prompt.embedded.host ? <span className={styles.host}>{prompt.embedded.host}</span> : 'another page'}.
          </p>
        )}
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
      {prompt.locked && (
        <button type="button" className={styles.authUnlock} disabled={!armed} onClick={() => void api.auth.unlock(prompt.id)}>
          <span className={styles.menuIcon} aria-hidden>
            <LockKeyhole size={12} strokeWidth={2} />
          </span>
          Unlock passwords
        </button>
      )}
      {(prompt.accounts.length > 1 || (!prompt.fill && prompt.accounts.length > 0)) && (
        <div className={styles.authChooser} role="listbox" aria-label="Saved sign-ins">
          {prompt.accounts.map((name, i) => (
            <button key={i} type="button" role="option" aria-selected={filled === i} className={styles.authAccount} disabled={!armed} onClick={() => choose(i)}>
              <span className={styles.menuIcon} aria-hidden>
                {[...name.trim()][0]?.toUpperCase() || '·'}
              </span>
              <span className={styles.menuUser}>{name || 'No username'}</span>
            </button>
          ))}
        </div>
      )}
      <div className={styles.authFields}>
        <label className={styles.authLabel} htmlFor={`${ids}-username`}>
          Username
        </label>
        <input
          ref={usernameField}
          id={`${ids}-username`}
          className={styles.authInput}
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="off"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setTyped(true);
            // Another username: the saved password isn't its own.
            if (filled !== null) {
              setFilled(null);
              setPassword('');
            }
          }}
        />
        <label className={styles.authLabel} htmlFor={`${ids}-password`}>
          Password
        </label>
        <input
          id={`${ids}-password`}
          className={styles.authInput}
          type="password"
          autoComplete="current-password"
          value={filled !== null ? FILLED_MASK : password}
          onFocus={(e) => {
            if (filled !== null) e.target.select();
          }}
          onChange={(e) => {
            setTyped(true);
            const value = e.target.value;
            if (filled === null) return setPassword(value);
            // Typed over the saved one: what's typed, without the mask.
            setFilled(null);
            setPassword(value.startsWith(FILLED_MASK) ? value.slice(FILLED_MASK.length) : FILLED_MASK.startsWith(value) ? '' : value);
          }}
        />
      </div>
      {prompt.remember !== null && (
        <label className={styles.shareAudio}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember
        </label>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} data-cancel onClick={() => respond(null)}>
          Cancel
        </button>
        <button ref={signIn} type="submit" className={styles.primary} disabled={sent || !armed}>
          Sign in
        </button>
      </div>
    </form>
  );
}

/** How long after the popover shows its connect card the card is announced (the view must be on screen first). */
const ANNOUNCE_DELAY_MS = 150;

/** What an outside agent may do, as the connect card lists it (mocks/agents-s18-m1.html §1). */
const AGENT_MAY = ['Open and read pages in its own Agent chord', 'Read a tab of yours only when you share it', 'Never see your passwords'];

/**
 * An outside agent asks to use Chord (S18 M1d): centered at the top of the page, never taking the keyboard.
 * Who started it is a hint: the name is the agent's own, the program and folder are what the OS says.
 */
function AgentConnectCardView({ card }: { card: AgentConnectCard }) {
  const respond = (answer: 'deny' | 'once' | 'always') => void api.agents.respond(card.id, answer);
  return (
    <div className={styles.card} role="alertdialog" aria-label={`${card.name} wants to use Chord`}>
      <AgentCardBody
        title={`${card.name} wants to use Chord`}
        note={`Started${card.startedBy ? ` by ${card.startedBy}` : ''} in ${card.folder ?? 'an unknown folder'}.`}
        list={AGENT_MAY}
        closeLabel="Close"
        onClose={() => respond('deny')}
        actions={[
          { label: 'Deny', look: 'link', onClick: () => respond('deny') },
          { label: 'Allow once', look: 'quiet', onClick: () => respond('once') },
          { label: 'Always allow', look: 'primary', onClick: () => respond('always') },
        ]}
      />
    </div>
  );
}

/**
 * Choosing a passkey (ARCHITECTURE.md §9, Passkeys): the authenticator holds
 * more than one for the site. Each account is a button, named as the site
 * named it; Cancel or Escape declines, and the site hears it was cancelled.
 */
function PasskeyCard({ prompt }: { prompt: PasskeyPrompt }) {
  const ids = useId();
  const first = useRef<HTMLButtonElement>(null);
  const [sent, setSent] = useState(false);
  // The first account has the keyboard when the card appears (main focuses the popover too).
  useEffect(() => first.current?.focus(), []);
  const respond = (credentialId: string | null) => {
    if (sent) return;
    setSent(true);
    void api.passkey.respond(prompt.id, credentialId);
  };
  return (
    <div
      className={styles.card}
      role="alertdialog"
      aria-labelledby={`${ids}-title`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          respond(null);
        }
      }}
    >
      <div className={styles.permissionHead}>
        <Fingerprint className={styles.offerIcon} {...ICON} aria-hidden />
        <p id={`${ids}-title`} className={styles.permissionTitle}>
          Sign in to <span className={styles.host}>{prompt.site}</span> with a passkey
        </p>
        <button type="button" className={styles.iconButton} aria-label="Cancel" title="Cancel" onClick={() => respond(null)}>
          <X {...ICON} />
        </button>
      </div>
      <ul className={styles.passkeyList}>
        {prompt.accounts.map((account, i) => (
          <li key={account.credentialId}>
            <button ref={i === 0 ? first : undefined} type="button" className={styles.passkeyAccount} disabled={sent} onClick={() => respond(account.credentialId)}>
              <span className={styles.passkeyName}>{account.displayName || account.name || 'Unnamed account'}</span>
              {account.name && account.name !== account.displayName && <span className={styles.passkeyDetail}>{account.name}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={() => respond(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Unlock passwords (docs/decisions/S17-passwords.md §7): the vault's
 * passphrase, at the top of the tab like the sign-in box, when something needs
 * the vault open. *Keep unlocked on this computer* (off unless you turn it on)
 * keeps a copy of the key with the OS, and says what that gives up. The
 * passphrase goes to main once, on Unlock, and the field is emptied.
 */
function UnlockPasswordsCard({ prompt }: { prompt: PasswordUnlockPrompt }) {
  const ids = useId();
  const field = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState('');
  const [keep, setKeep] = useState(prompt.keep);
  // The field has the keyboard when the card appears, and again after each wrong passphrase (the button had it).
  useEffect(() => {
    if (!prompt.busy) field.current?.focus();
  }, [prompt.problem, prompt.busy]);
  const cancel = () => void api.passwords.unlock(prompt.id, null, false);
  return (
    <form
      className={styles.card}
      role="alertdialog"
      aria-labelledby={`${ids}-title`}
      aria-describedby={prompt.problem ? `${ids}-problem` : undefined}
      aria-busy={prompt.busy || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (!passphrase || prompt.busy) return;
        const typed = passphrase;
        setPassphrase('');
        void api.passwords.unlock(prompt.id, typed, keep && prompt.canKeep);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <div className={styles.permissionHead}>
        <KeyRound className={styles.offerIcon} {...ICON} aria-hidden />
        <p id={`${ids}-title`} className={styles.permissionTitle}>
          <span className={styles.host}>Unlock passwords</span>
        </p>
      </div>
      <div className={styles.authFields}>
        <label className={styles.authLabel} htmlFor={`${ids}-passphrase`}>
          Passphrase
        </label>
        <input
          ref={field}
          id={`${ids}-passphrase`}
          className={styles.authInput}
          type="password"
          value={passphrase}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={prompt.problem ? true : undefined}
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </div>
      {prompt.problem && (
        <p id={`${ids}-problem`} className={styles.authRetry} role="alert">
          That isn’t the passphrase. Try again.
        </p>
      )}
      {prompt.canKeep && (
        <div className={styles.keepRow}>
          <button
            type="button"
            role="switch"
            aria-checked={keep}
            aria-labelledby={`${ids}-keep`}
            aria-describedby={`${ids}-keep-why`}
            className={styles.switch}
            onClick={() => setKeep(!keep)}
          >
            <span className={styles.knob} />
          </button>
          <span className={styles.keepText}>
            <span id={`${ids}-keep`}>Keep unlocked on this computer</span>
            <span id={`${ids}-keep-why`} className={styles.keepWhy}>
              Then other programs you run could read your passwords, on Windows and Linux.
            </span>
          </span>
        </div>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={cancel}>
          Cancel
        </button>
        <button type="submit" className={styles.primary} disabled={!passphrase || prompt.busy}>
          {prompt.busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>
    </form>
  );
}

/**
 * The menu under a sign-in field (docs/decisions/S17-passwords.md §9): the site's saved
 * accounts by username, with the host under it where it isn't the page's, then *Other
 * passwords…*; or *Unlock passwords* alone while they're locked. The page keeps the keyboard:
 * ↓ ↑ Enter go through main, which moves the highlight here. A click chooses a row (main gives
 * the page its focus back). Nothing here ever holds a password.
 */
/** When a *Not confirmed* sign-in was made, as the menu says it (the owner's design 4A): `made today`. */
export function madeWhen(madeAt: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(madeAt) === day(now)) return 'made today';
  if (day(madeAt) === day(now - 86_400_000)) return 'made yesterday';
  return `made ${new Date(madeAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/**
 * The menu under a field (S17 §9). On a new password's field (the owner's design 3A, 2026-11-17): *Use a strong
 * password* first, built like an account row, the password in mono on its second line, the site's rules in words
 * under it where they shaped it, and ↻ at the row's end (and by key, its tooltip says which); then the accounts, past
 * a hairline, and *Other passwords…*. ↓ ↑ Enter as ever. A *Not confirmed* account says so, and when it was made.
 */
function PasswordMenuCard({ menu, platform }: { menu: PasswordMenu; platform: Platform }) {
  const ids = useId();
  const choose = (index: number) => void api.passwords.choose(menu.id, index);
  const generated = menu.state === 'generate' ? menu.generated : undefined;
  const offset = generated ? 1 : 0;
  const another = `Another password (${formatKeys(PASSWORD_REGENERATE_KEYS, platform)})`;
  // ↻ sits at the generator row's end (the owner's design 3A) but outside its option: a button can't be inside one.
  const generatorRow = useRef<HTMLDivElement>(null);
  const regenerate = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const r = generatorRow.current;
    const b = regenerate.current;
    if (r && b) b.style.insetBlockStart = `${r.offsetTop + (r.offsetHeight - b.offsetHeight) / 2}px`;
  });
  const rowId = (i: number) => `${ids}-row-${i}`;
  const row = (i: number, content: ReactNode, className = styles.menuRow, ref?: Ref<HTMLDivElement>) => (
    <div key={i} ref={ref} id={rowId(i)} role="option" aria-selected={menu.index === i} className={className} onClick={() => choose(i)}>
      {content}
    </div>
  );
  return (
    <div className={`${styles.card} ${styles.passwordMenu}`}>
      <div role="listbox" aria-label={`Passwords for ${menu.host}`} aria-activedescendant={rowId(menu.index)} className={styles.menuList}>
        {generated &&
          row(
            0,
            <>
              <span className={styles.menuIcon} aria-hidden>
                <Sparkles size={12} strokeWidth={2} />
              </span>
              <span className={`${styles.menuText} ${styles.menuGrow}`}>
                <span className={styles.menuUser}>{generated.strong ? 'Use a strong password' : 'Use a password this site allows'}</span>
                <span className={styles.menuMono} translate="no">
                  {generated.password}
                </span>
                {generated.rule && <span className={styles.menuHost}>{generated.rule}</span>}
              </span>
            </>,
            `${styles.menuRow} ${styles.menuGenerator}`,
            generatorRow,
          )}
        {menu.state === 'locked'
          ? row(
              0,
              <>
                <span className={styles.menuIcon} aria-hidden>
                  <LockKeyhole size={12} strokeWidth={2} />
                </span>
                <span className={styles.menuText}>Unlock passwords</span>
              </>,
            )
          : menu.accounts.map((account, i) =>
              row(
                i + offset,
                <>
                  <span className={styles.menuIcon} aria-hidden>
                    {[...account.username.trim()][0]?.toUpperCase() || (account.madeAt !== undefined ? 'N' : '·')}
                  </span>
                  <span className={styles.menuText}>
                    <span className={styles.menuUser}>{account.username || (account.madeAt !== undefined ? 'No username yet' : 'No username')}</span>
                    {(account.host || account.madeAt !== undefined) && (
                      <span className={styles.menuHost}>
                        {[account.host, account.madeAt !== undefined ? `Not confirmed · ${madeWhen(account.madeAt)}` : null].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                </>,
                // Past a hairline under the generator's row.
                generated && i === 0 ? `${styles.menuRow} ${styles.menuDivided}` : styles.menuRow,
              ),
            )}
        {menu.state !== 'locked' && row(menu.accounts.length + offset, <span className={styles.menuText}>Other passwords…</span>, `${styles.menuRow} ${styles.menuMore}`)}
      </div>
      {generated && (
        <button ref={regenerate} type="button" className={`${styles.iconButton} ${styles.menuRegenerate}`} aria-label={another} title={another} onClick={() => void api.passwords.regenerate(menu.id)}>
          <RotateCw size={14} strokeWidth={2} />
        </button>
      )}
      {menu.insecure && (
        <p className={styles.menuWarning}>
          <TriangleAlert size={12} strokeWidth={2} aria-hidden />
          This page isn’t secure
        </p>
      )}
    </div>
  );
}

const DOTS = '••••••••••';

/**
 * The save and update cards (docs/decisions/S17-passwords.md §9), after a sign-in that
 * worked: at the tab's top right, never taking focus. *Save this password for [site]?* with
 * the username (yours to correct) and the password as dots, the eye to see it; **Save** ·
 * *Never for this site* · ×. Updating: *Update the password for [username]?* · **Update**.
 * The very first also chooses the passphrase (the passphrase step Settings uses). The
 * password reaches this page only for the eye, and goes again when the card does.
 *
 * Phase 2 (the owner's design 5A, 2026-11-17), the same anatomy with new titles: a sign-up's *Save the password for
 * your new account on …?*; a sign-up with Chord's own password, saved already, *Your new password for … is saved.*
 * (**Done** · *Delete it*); and a change Chord can't place, *Which account on … did you change?*, with the sign-in
 * box's chooser: **Update** waits for a pick, or *Save as new*. A generated password with no vault yet chooses the
 * passphrase here, with no username (its form's submit gives it one). Never taking focus.
 */
function SavePasswordCardView({ card }: { card: PasswordSaveCard }) {
  const ids = useId();
  const [username, setUsername] = useState(card.username);
  const [passphrase, setPassphrase] = useState<PassphraseValue>(EMPTY_PASSPHRASE);
  const [shown, setShown] = useState<string | null>(null);
  const [account, setAccount] = useState<number | null>(null);
  const act = (action: 'save' | 'never' | 'close' | 'hold' | 'release' | 'new' | 'delete' | 'code', details?: { username?: string; passphrase?: string; account?: number }) =>
    void api.passwords.card(card.id, action, details);
  const update = card.kind === 'update';
  const change = card.kind === 'change';
  const refused = card.kind === 'refused';
  // A refused card is a saved card that turned (S17 §6, phase 3A-2): *Delete it* and **Done**, as the saved card's.
  const saved = card.kind === 'saved' || refused;
  // Save or Update pressed while the site could still say no (the owner's design 1A): it waits, read-only.
  const waiting = !!card.waiting;
  const ready = !card.busy && !waiting && (!card.setup || passphraseReady(passphrase)) && (!change || account !== null);
  const save = () => {
    if (card.setup && !passphraseReady(passphrase)) return setPassphrase({ ...passphrase, touched: true });
    if (!ready) return;
    if (change) return act('save', { account: account! });
    act('save', { username, ...(card.setup ? { passphrase: passphrase.passphrase } : {}) });
  };
  const toggle = async () => {
    if (shown !== null) return setShown(null);
    const revealed = await api.passwords.reveal(card.id);
    setShown(revealed?.password ?? null);
  };
  // *Keep them* or *Leave off the code* changed what Save saves: a revealed password shows the new one (S17 §6, 3D).
  const code = card.code;
  const revealedRef = useRef(shown);
  revealedRef.current = shown;
  useEffect(() => {
    if (!code || revealedRef.current === null) return;
    let live = true;
    void api.passwords.reveal(card.id).then((r) => live && setShown(r?.password ?? null));
    return () => {
      live = false;
    };
  }, [code, card.id]);
  return (
    <form
      className={styles.card}
      role="dialog"
      aria-labelledby={`${ids}-title`}
      aria-busy={card.busy || waiting || undefined}
      onFocus={() => act('hold')}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) act('release');
      }}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          act('close');
        }
      }}
    >
      <div className={styles.permissionHead}>
        {refused ? <TriangleAlert className={`${styles.offerIcon} ${styles.offerIconWarn}`} {...ICON} aria-hidden /> : <KeyRound className={styles.offerIcon} {...ICON} aria-hidden />}
        <p id={`${ids}-title`} className={styles.permissionTitle}>
          {refused ? (
            <>
              <span className={styles.host}>{card.host}</span> didn’t take your new password.
            </>
          ) : update ? (
            <>
              {card.username ? (
                <>
                  Update the password for <span className={styles.host}>{card.username}</span>?
                </>
              ) : (
                <>
                  Update a password for <span className={styles.host}>{card.host}</span>?
                </>
              )}
            </>
          ) : saved ? (
            <>
              Your new password for <span className={styles.host}>{card.host}</span> is saved.
            </>
          ) : change ? (
            <>
              Which account on <span className={styles.host}>{card.host}</span> did you change?
            </>
          ) : card.signUp ? (
            <>
              Save the password for your new account on <span className={styles.host}>{card.host}</span>?
            </>
          ) : (
            <>
              Save this password for <span className={styles.host}>{card.host}</span>?
            </>
          )}
        </p>
        <button type="button" className={styles.iconButton} aria-label="Close" title="Close" onClick={() => act('close')}>
          <X {...ICON} />
        </button>
      </div>
      {change && (
        <>
          <div className={styles.authChooser} role="listbox" aria-label={`Accounts on ${card.host}`}>
            {(card.accounts ?? []).map((name, i) => (
              <button key={i} type="button" role="option" aria-selected={account === i} className={styles.authAccount} disabled={card.busy || waiting} onClick={() => setAccount(i)}>
                <span className={styles.menuIcon} aria-hidden>
                  {[...name.trim()][0]?.toUpperCase() || '·'}
                </span>
                <span className={styles.menuUser}>{name || 'No username'}</span>
                {account === i && <Check className={styles.authTick} size={14} strokeWidth={2} aria-hidden />}
              </button>
            ))}
          </div>
          <p className={styles.offerNotice}>Or save it as another account.</p>
        </>
      )}
      {refused && <p className={styles.offerNotice}>Chord kept it in Settings → Passwords, Not confirmed, in case the sign-up went through after all.</p>}
      {saved && !refused && (
        <div className={styles.authFields}>
          <span className={styles.authLabel}>Username</span>
          <span className={styles.savedPassword}>{card.username || 'No username yet'}</span>
        </div>
      )}
      <div className={styles.authFields} hidden={change || saved}>
        {!update && !card.generated && !change && !saved && (
          <>
            <label className={styles.authLabel} htmlFor={`${ids}-username`}>
              Username
            </label>
            <input
              id={`${ids}-username`}
              className={styles.authInput}
              value={username}
              readOnly={waiting}
              maxLength={500}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setUsername(e.target.value)}
            />
          </>
        )}
        {!card.setup && !change && !saved && (
          <>
            <span className={styles.authLabel} id={`${ids}-password`}>
              Password
            </span>
            <span className={styles.savedPassword}>
              <span className={shown === null ? styles.dots : styles.revealed}>{shown ?? DOTS}</span>
              <button type="button" className={styles.iconButton} aria-label={shown === null ? 'Show password' : 'Hide password'} onClick={() => void toggle()}>
                {shown === null ? <Eye size={14} strokeWidth={2} /> : <EyeOff size={14} strokeWidth={2} />}
              </button>
            </span>
          </>
        )}
      </div>
      {code && !update && !change && !saved && (
        <p className={styles.offerNotice}>
          {code === 'trimmed' ? 'This site takes a sign-in code after the password, so Chord left off the last 6 digits. ' : 'Chord will save the password as you typed it. '}
          <button type="button" className={styles.inlineLink} disabled={card.busy || waiting} onClick={() => act('code')}>
            {code === 'trimmed' ? 'Keep them' : 'Leave off the code'}
          </button>
        </p>
      )}
      {card.setup && (
        <div className={styles.saveStep}>
          <PassphraseStep value={passphrase} onChange={setPassphrase} readOnly={waiting} />
        </div>
      )}
      {card.problem && (
        <p className={styles.authRetry} role="alert">
          Chord couldn’t save it. Try again.
        </p>
      )}
      {waiting && (
        <p className={styles.offerNotice} role="status">
          Waiting a moment for {card.host} to confirm the sign-in.
        </p>
      )}
      <div className={styles.actions}>
        {!update && !card.setup && !change && !saved && (
          <button type="button" className={styles.link} disabled={card.busy || waiting} onClick={() => act('never')}>
            Never for this site
          </button>
        )}
        {change && (
          <button type="button" className={styles.link} disabled={card.busy || waiting} onClick={() => act('new')}>
            Save as new
          </button>
        )}
        {saved && (
          <button type="button" className={styles.link} disabled={card.busy} onClick={() => act('delete')}>
            Delete it
          </button>
        )}
        <button type="submit" className={`${styles.primary}${waiting ? ` ${styles.primaryBusy}` : ''}`} disabled={card.busy || waiting || (change && account === null)}>
          {waiting ? (
            <>
              <span className={styles.spin} aria-hidden />
              {update || change ? 'Updating…' : 'Saving…'}
            </>
          ) : update || change ? (
            'Update'
          ) : saved ? (
            'Done'
          ) : (
            'Save'
          )}
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
 * Chord Player's part of the notice, first and full width (DESIGN.md §7.1):
 * install it (its download's size), its progress, open the page in it, or
 * why it failed with Try again.
 */
function PlayerAction({ offer }: { offer: PlayerOffer }) {
  switch (offer.state) {
    case 'install':
      return (
        <div className={styles.playerRow}>
          <button type="button" className={`${styles.primary} ${styles.wide}`} onClick={() => void api.drm.player('install')}>
            {offer.update ? 'Update' : 'Install'} Chord Player (about {megabytes(offer.size)} MB)
          </button>
        </div>
      );
    case 'installing': {
      const label = installingLabel(offer);
      return (
        <div className={styles.playerRow}>
          <div className={styles.progressLabel} aria-hidden>
            {label}
          </div>
          <div className={styles.progress} role="progressbar" aria-label="Installing Chord Player" aria-valuemin={0} aria-valuemax={100} aria-valuenow={offer.percent} aria-valuetext={label}>
            <div className={styles.progressFill} style={{ inlineSize: `${offer.percent}%` }} />
          </div>
        </div>
      );
    }
    case 'ready':
      return (
        <div className={styles.playerRow}>
          <button type="button" className={`${styles.primary} ${styles.wide}`} onClick={() => void api.drm.player('open')}>
            Open in Chord Player
          </button>
        </div>
      );
    case 'opening':
      return (
        <div className={styles.playerRow}>
          <button type="button" className={`${styles.primary} ${styles.wide}`} disabled>
            Opening in Chord Player…
          </button>
        </div>
      );
    case 'failed':
      return (
        <div className={styles.playerRow}>
          <p className={styles.playerProblem} role="alert">
            {PLAYER_FAILURES[offer.why]}
          </p>
          <button type="button" className={`${styles.primary} ${styles.wide}`} onClick={() => void api.drm.player('retry')}>
            Try again
          </button>
        </div>
      );
  }
}

/**
 * On a service that needs Widevine (ARCHITECTURE.md §16, D4): it won't play
 * here yet. Chord Player comes first when it's offered (never in Google-free
 * mode or a private window), then up to two other browsers on this computer
 * to open the page in. Not now hides it for the service until Chord quits.
 */
function DrmNoticeCard({ notice }: { notice: DrmNotice }) {
  const id = useId();
  const [first, second] = notice.browsers;
  const player = notice.player;
  const others = player ? notice.browsers : second ? [second] : [];
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
        {player
          ? `It needs Widevine, the copy protection streaming services use. Chord Player, a companion app with Widevine, plays it ${notice.inTab ? 'right here, in this tab' : 'in a window of its own'}.`
          : 'It needs Widevine, the copy protection streaming services use, which Chord doesn’t include yet.'}
        {player && notice.linux ? ' On Linux, some services play only in lower quality, or not at all.' : ''}
        {!player && !first ? ' Another browser can play it for now.' : ''}
      </p>
      {player && <PlayerAction offer={player} />}
      {(others.length > 0 || (!player && first)) && (
        <div className={styles.actions}>
          {others.map((b) => (
            <button key={b.id} type="button" className={styles.secondary} onClick={() => void api.drm.open(b.id)}>
              Open in {b.name}
            </button>
          ))}
          {!player && first && (
            <button type="button" className={styles.primary} onClick={() => void api.drm.open(first.id)}>
              Open in {first.name}
            </button>
          )}
        </div>
      )}
      {player && others.length === 0 && <div className={styles.actionsEnd} />}
    </div>
  );
}

/**
 * `menuOnly`: the page in the menu's own view (loaded with `#menu`), which shows the menu under a sign-in field and
 * nothing else; main places it under the field. The popover's own page never shows the menu, so its cards stay put
 * and keep what's typed in them while a menu opens and closes.
 */
export function Popover({ info: infoSource, state: stateSource, menuOnly = false }: { info: Live<SystemInfo>; state: Live<PopoverState>; menuOnly?: boolean }) {
  const info = useLive(infoSource);
  const state = useLive(stateSource);
  const root = useRef<HTMLDivElement>(null);
  const menu = menuOnly ? state.passwordMenu : null;
  const hasCards = menuOnly
    ? Boolean(menu)
    : Boolean(state.find || state.agentCard || state.permission || state.share || state.auth || state.passkey || state.passwordsUnlock || state.passwordSave || state.safeBrowsingOffer || state.drm || state.effects);

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

  // The connect card never takes the keyboard, so it's announced. A live region only speaks a change it saw: the text
  // comes a moment after the view (hidden with no cards) shows, never with it.
  const card = menuOnly ? null : state.agentCard;
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    setAnnounced('');
    if (!card) return;
    const timer = setTimeout(() => setAnnounced(`${card.name} wants to use Chord`), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [card?.id, card?.name]);

  useRootColorScheme(appearance);
  if (menuOnly)
    return (
      <div ref={root} className={`${styles.root} ${styles.menuRoot}`} style={style}>
        {menu && <PasswordMenuCard key={menu.id} menu={menu} platform={info.platform} />}
      </div>
    );
  return (
    <div ref={root} className={styles.root} style={style}>
      {/* Politely: the card waits for you. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announced}
      </p>
      {state.find && <FindBar find={state.find} />}
      {state.agentCard && <AgentConnectCardView key={state.agentCard.id} card={state.agentCard} />}
      {state.permission && <PermissionCard key={state.permission.id} prompt={state.permission} />}
      {state.share && <ShareCard key={state.share.id} prompt={state.share} appearance={appearance} platform={info.platform} />}
      {state.auth && <AuthCard key={state.auth.id} prompt={state.auth} />}
      {state.passkey && <PasskeyCard key={state.passkey.id} prompt={state.passkey} />}
      {state.passwordsUnlock && <UnlockPasswordsCard key={state.passwordsUnlock.id} prompt={state.passwordsUnlock} />}
      {state.passwordSave && <SavePasswordCardView key={state.passwordSave.id} card={state.passwordSave} />}
      {state.safeBrowsingOffer && <SafeBrowsingOffer />}
      {state.drm && <DrmNoticeCard key={state.drm.service} notice={state.drm} />}
      {state.effects && <EffectsCard key={state.effects.host} opened={state.effects.opened} />}
    </div>
  );
}
