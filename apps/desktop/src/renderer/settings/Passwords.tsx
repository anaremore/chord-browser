/**
 * Settings → Passwords (docs/decisions/S17-passwords.md §9; DESIGN.md §8.9):
 * the switch, the lock, and your list. Main owns the vault and its clock;
 * this page shows what main says (`passwords:view`, usernames only) and asks.
 * A password reaches this page only through *Show*, after the passphrase
 * when it was typed more than 5 minutes ago; *Copy* never brings it here.
 * Delete has Undo for the session. Import… and Export… are PasswordTransfer.tsx.
 */
import { DEFAULT_PASSWORD_SETTINGS, lockAfterText, PASSWORD_LOCK_AFTER, PASSWORD_REAUTH_MS, passwordChordPatch, passwordChordRows, type LoginSummary, type PasswordLockAfter } from '@chord/core';
import type { PasswordRevealResult, PasswordStepResult, PasswordsView, SettingsSnapshot } from '@chord/ipc';
import { createChordTheme, type Appearance } from '@chord/tokens';
import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Favicon } from '../shared/Favicon';
import { EMPTY_PASSPHRASE, PassphraseStep, passphraseReady, type PassphraseValue } from '../shared/PassphraseStep';
import { api } from './api';
import { ExportCard, ImportCard } from './PasswordTransfer';
import { ResetButton, SectionHeader, Switch } from './controls';
import local from './Passwords.module.css';
import styles from './Settings.module.css';
import sites from './Sites.module.css';

const PROBLEMS: Record<Exclude<PasswordStepResult, { ok: true }>['problem'] | Exclude<PasswordRevealResult, { ok: true }>['problem'], string> = {
  wrong: 'That isn’t the passphrase.',
  invalid: 'Chord can’t save that. Check the address: it starts with https:// or http://.',
  locked: 'Your passwords are locked. Unlock them first.',
  none: 'Choose a passphrase first.',
  exists: 'You have a passphrase already.',
  missing: 'That password is gone.',
  keyring: 'This computer has no keyring for Chord to keep it in.',
  io: 'Chord couldn’t do that. Try again.',
  passphrase: 'Enter your passphrase first.',
};

const KEEP_WHY = 'Then other programs you run could read your passwords, on Windows and Linux.';

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const day = (at: number) => new Date(at).toDateString();

/** A *Not confirmed* sign-in's line in its detail (the owner's design 4A, S17 §6). */
function notConfirmedText(createdAt: number, now = Date.now()): string {
  const when = whenText(createdAt, now);
  const made = when === 'Today' || when === 'Yesterday' ? when.toLowerCase() : `on ${when}`;
  return `Not confirmed: Chord made this password ${made} and kept it, but hasn’t seen the site take it. If the sign-up didn’t go through, delete it.`;
}

/** *Today*, *Yesterday*, *Nov 2*, *Nov 2, 2025*: when a sign-in was last used, or saved. */
function whenText(at: number, now = Date.now()): string {
  if (day(at) === day(now)) return 'Today';
  if (day(at) === day(now - 86_400_000)) return 'Yesterday';
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One passphrase field and its button, inline: unlocking, and Show or Copy asking again (and Import and Export, PasswordTransfer.tsx). */
export function PassphraseAsk({
  text,
  button,
  problem,
  onSubmit,
  onCancel,
  labelled = true,
}: {
  /** The line above the field; null where the row already says it. */
  text: string | null;
  button: string;
  problem: string | null;
  onSubmit(passphrase: string): void;
  onCancel?(): void;
  /** Its own *Passphrase* label; false inside the Passphrase row, which names it already. */
  labelled?: boolean;
}) {
  const ids = useId();
  const [passphrase, setPassphrase] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), [problem]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase) return;
    const typed = passphrase;
    setPassphrase('');
    onSubmit(typed);
  };
  return (
    <form className={local.ask} onSubmit={submit}>
      {text && <p className={local.askText}>{text}</p>}
      <div className={local.askField}>
        {labelled && (
          <label className={styles.rowLabel} htmlFor={`${ids}-passphrase`}>
            Passphrase
          </label>
        )}
        <input
          ref={field}
          id={`${ids}-passphrase`}
          className={`${styles.siteInput} ${local.grow}`}
          type="password"
          value={passphrase}
          autoComplete="off"
          spellCheck={false}
          aria-label={labelled ? undefined : 'Passphrase'}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${ids}-problem` : undefined}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && onCancel) {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <button type="submit" className={styles.linkButton} disabled={!passphrase}>
          {button}
        </button>
      </div>
      {problem && (
        <p id={`${ids}-problem`} className={local.problem} role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

/** A row opened: the address, username, password (dots, Show, Copy), the note, the site's change-password page, Delete. */
function LoginDetail({ login, hideSeq, onView, onDeleted }: { login: LoginSummary; hideSeq: number; onView(view: PasswordsView): void; onDeleted(): void }) {
  const ids = useId();
  const [password, setPassword] = useState<string | null>(null);
  /** The password as Show brought it: editing it saves only what changed. */
  const revealed = useRef<string | null>(null);
  const [asking, setAsking] = useState<'show' | 'copy' | 'address' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState<'username' | 'password' | null>(null);
  /** *Change password on the site* was pressed: what happened (the owner's design 6A). */
  const [changing, setChanging] = useState<'opened' | 'failed' | null>(null);
  const [origin, setOrigin] = useState(login.origin);
  const [username, setUsername] = useState(login.username);
  const [note, setNote] = useState(login.note);
  // Main's view moved on (an edit elsewhere): the fields follow it.
  useEffect(() => setOrigin(login.origin), [login.origin]);
  useEffect(() => setUsername(login.username), [login.username]);
  useEffect(() => setNote(login.note), [login.note]);
  // The vault locked (main says so), or the shown password has been on screen as long as the passphrase lasts: it goes.
  useEffect(() => {
    revealed.current = null;
    setPassword(null);
  }, [hideSeq]);
  // The 5 minutes count from the last change, so typing a new password never loses it; one not saved yet is saved first.
  useEffect(() => {
    if (password === null) return;
    const timer = setTimeout(() => {
      if (password && password !== revealed.current) void api.passwords.edit(login.id, { password });
      revealed.current = null;
      setPassword(null);
    }, PASSWORD_REAUTH_MS);
    return () => clearTimeout(timer);
  }, [password, login.id]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const answered = (result: PasswordStepResult) => {
    if (result.ok) {
      setProblem(null);
      onView(result.view);
    } else setProblem(PROBLEMS[result.problem]);
  };
  const save = (patch: Partial<{ origin: string; username: string; password: string; note: string }>) => void api.passwords.edit(login.id, patch).then(answered);
  /** A new address asks for the passphrase as Show does, inline. */
  const moveTo = async (next: string, passphrase?: string) => {
    const result = await api.passwords.edit(login.id, { origin: next }, passphrase);
    if (!result.ok && (result.problem === 'passphrase' || result.problem === 'wrong')) {
      setAsking('address');
      setProblem(result.problem === 'wrong' ? PROBLEMS.wrong : null);
      return;
    }
    setAsking(null);
    answered(result);
  };

  const act = async (what: 'show' | 'copy', passphrase?: string) => {
    const result = what === 'show' ? await api.passwords.reveal(login.id, passphrase) : await api.passwords.copy(login.id, passphrase);
    if (result.ok) {
      setAsking(null);
      setProblem(null);
      if (what === 'show') {
        revealed.current = result.password ?? null;
        setPassword(result.password ?? null);
      }
      else setCopied('password');
      return;
    }
    if (result.problem === 'passphrase' || result.problem === 'wrong') {
      setAsking(what);
      setProblem(result.problem === 'wrong' ? PROBLEMS.wrong : null);
    } else {
      setAsking(null);
      setProblem(PROBLEMS[result.problem]);
    }
  };

  const secure = origin.startsWith('https://');
  return (
    <div
      id={`${ids}-detail`}
      className={local.detail}
      role="group"
      aria-label={`${hostOf(login.origin)}${login.realm ? `, realm ${login.realm}` : ''}, ${login.username || 'no username'}`}
    >
      {login.unconfirmed && <p className={local.quiet}>{notConfirmedText(login.createdAt)}</p>}
      <div className={local.field}>
        <label className={local.fieldLabel} htmlFor={`${ids}-origin`}>
          Address
        </label>
        <input
          id={`${ids}-origin`}
          className={local.value}
          value={origin}
          spellCheck={false}
          onChange={(e) => setOrigin(e.target.value)}
          onBlur={() => origin.trim() !== login.origin && void moveTo(origin.trim())}
        />
        <span />
      </div>
      <div className={local.field}>
        <label className={local.fieldLabel} htmlFor={`${ids}-username`}>
          Username
        </label>
        <input
          id={`${ids}-username`}
          className={local.value}
          value={username}
          placeholder="Add a username"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setUsername(e.target.value)}
          onBlur={() => username !== login.username && save({ username })}
        />
        <button type="button" className={local.tiny} aria-label="Copy username" onClick={() => void api.settings.copyText(login.username).then(() => setCopied('username'))}>
          {copied === 'username' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className={local.field}>
        {password === null ? (
          <span id={`${ids}-password-label`} className={local.fieldLabel}>
            Password
          </span>
        ) : (
          <label className={local.fieldLabel} htmlFor={`${ids}-password`} id={`${ids}-password-label`}>
            Password
          </label>
        )}
        {password === null ? (
          <span id={`${ids}-password`} className={`${local.value} ${local.dots}`} role="img" aria-labelledby={`${ids}-password-label ${ids}-password-hidden`}>
            <span id={`${ids}-password-hidden`} hidden>
              hidden
            </span>
            ••••••••••
          </span>
        ) : (
          <input
            id={`${ids}-password`}
            className={`${local.value} ${local.mono}`}
            value={password}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => {
              if (!password || password === revealed.current) return;
              revealed.current = password;
              save({ password });
            }}
          />
        )}
        <span className={local.tinies}>
          {password === null ? (
            <button type="button" className={local.tiny} aria-label="Show password" onClick={() => void act('show')}>
              Show
            </button>
          ) : (
            <button type="button" className={local.tiny} aria-label="Hide password" onClick={() => setPassword(null)}>
              Hide
            </button>
          )}
          <span aria-hidden>·</span>
          <button type="button" className={local.tiny} aria-label="Copy password" onClick={() => void act('copy')}>
            {copied === 'password' ? 'Copied' : 'Copy'}
          </button>
        </span>
      </div>
      {asking && (
        <PassphraseAsk
          text={asking === 'show' ? 'Enter your passphrase to show it.' : asking === 'copy' ? 'Enter your passphrase to copy it.' : 'Enter your passphrase to change the address.'}
          button={asking === 'show' ? 'Show' : asking === 'copy' ? 'Copy' : 'Change'}
          problem={problem}
          onSubmit={(passphrase) => void (asking === 'address' ? moveTo(origin.trim(), passphrase) : act(asking, passphrase))}
          onCancel={() => {
            if (asking === 'address') setOrigin(login.origin);
            setAsking(null);
            setProblem(null);
          }}
        />
      )}
      <div className={local.field}>
        <label className={local.fieldLabel} htmlFor={`${ids}-note`}>
          Note
        </label>
        <input id={`${ids}-note`} className={local.value} value={note} placeholder="Add a note" onChange={(e) => setNote(e.target.value)} onBlur={() => note !== login.note && save({ note })} />
        <span />
      </div>
      {copied === 'password' && <p className={local.quiet}>It leaves the clipboard in a minute.</p>}
      {problem && !asking && (
        <p className={local.problem} role="alert">
          {problem}
        </p>
      )}
      {changing && (
        <p className={local.quiet} role="status">
          {changing === 'opened' ? 'Opened in a new tab. Use a strong password there, and Chord updates this one when the site takes it.' : 'Chord couldn’t find where this site changes a password.'}
        </p>
      )}
      <div className={local.detailActions}>
        {secure ? (
          // The site's own page for it (Apple's list), else its /.well-known/change-password: main decides, https only (S17 §9).
          <button type="button" className={local.tiny} onClick={() => void api.passwords.changeOnSite(login.id).then((opened) => setChanging(opened ? 'opened' : 'failed'))}>
            Change password on the site ↗
          </button>
        ) : (
          <span className={local.quiet}>This site isn’t on HTTPS, so Chord doesn’t open its pages for you.</span>
        )}
        <button
          type="button"
          className={`${styles.linkButton} ${local.delete}`}
          onClick={() =>
            void api.passwords.remove(login.id).then((result) => {
              answered(result);
              if (result.ok) onDeleted();
            })
          }
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/** *Add a password…*: an address, a username and a password; with no passphrase yet, the passphrase too (the first one saved sets it). */
function AddLogin({ needsPassphrase, onView, onDone }: { needsPassphrase: boolean; onView(view: PasswordsView): void; onDone(): void }) {
  const [origin, setOrigin] = useState('https://');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [passphrase, setPassphrase] = useState<PassphraseValue>(EMPTY_PASSPHRASE);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const ready = origin.length > 'https://'.length && password.length > 0 && (!needsPassphrase || passphraseReady(passphrase));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return setPassphrase({ ...passphrase, touched: true });
    setBusy(true);
    if (needsPassphrase) {
      const setup = await api.passwords.setup(passphrase.passphrase);
      setPassphrase(EMPTY_PASSPHRASE);
      if (!setup.ok) {
        setBusy(false);
        return setProblem(PROBLEMS[setup.problem]);
      }
    }
    const result = await api.passwords.add({ origin: origin.trim(), username, password, note });
    setBusy(false);
    if (!result.ok) return setProblem(PROBLEMS[result.problem]);
    onView(result.view);
    onDone();
  };
  return (
    <form className={`${styles.group} ${local.add}`} aria-label="Add a password" onSubmit={(e) => void submit(e)}>
      <div className={local.detail}>
        <label className={local.field}>
          <span className={local.fieldLabel}>Address</span>
          <input ref={first} className={local.value} value={origin} spellCheck={false} autoComplete="off" onChange={(e) => setOrigin(e.target.value)} />
          <span />
        </label>
        <label className={local.field}>
          <span className={local.fieldLabel}>Username</span>
          <input className={local.value} value={username} spellCheck={false} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
          <span />
        </label>
        <label className={local.field}>
          <span className={local.fieldLabel}>Password</span>
          <input className={local.value} type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
          <span />
        </label>
        <label className={local.field}>
          <span className={local.fieldLabel}>Note</span>
          <input className={local.value} value={note} placeholder="Add a note" onChange={(e) => setNote(e.target.value)} />
          <span />
        </label>
        {needsPassphrase && (
          <div className={local.stepRow}>
            <PassphraseStep value={passphrase} onChange={setPassphrase} />
          </div>
        )}
        {problem && (
          <p className={local.problem} role="alert">
            {problem}
          </p>
        )}
        <div className={local.detailActions}>
          <button type="button" className={styles.linkButton} onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className={`${styles.linkButton} ${local.primary}`} disabled={busy || (passphrase.touched && !ready)}>
            Save
          </button>
        </div>
      </div>
    </form>
  );
}
/**
 * One row per chord under the switch, in the switcher's order (DESIGN.md
 * §8.9): its color, its name and its own switch. A chord with a password
 * manager's extension shows off, and says which; turning it on there is
 * `onChords`, off by hand elsewhere `offChords`. With the switch off they dim
 * and can't be used. Private windows follow the switch alone.
 */
function ChordSwitches({ snapshot, appearance, labelledBy }: { snapshot: SettingsSnapshot; appearance: Appearance; labelledBy: string }) {
  const ids = useId();
  const settings = snapshot.settings.passwords;
  const rows = passwordChordRows(settings, snapshot.chords, snapshot.extensions);
  const colors = useMemo(
    () => snapshot.chords.map((chord) => createChordTheme(chord.theme, { systemAppearance: appearance, material: 'solid' }).vars['--color-accent']),
    [snapshot.chords, appearance],
  );
  const off = !settings.enabled;
  return (
    <div role="group" aria-labelledby={labelledBy} className={`${local.chords} ${off ? local.chordsOff : ''}`}>
      {snapshot.chords.map((chord, i) => {
        const row = rows[i]!;
        const why = row.offBecause ? `${ids}-${i}` : undefined;
        return (
          <div key={chord.id} className={`${styles.row} ${local.chordRow}`} data-chord={chord.id}>
            <span className={local.chordDot} style={{ '--chord-dot': colors[i] } as CSSProperties} aria-hidden />
            <div className={styles.rowText}>
              <span className={styles.rowLabel}>{chord.name}</span>
              {row.offBecause && (
                <span id={why} className={styles.rowDescription}>
                  {`Off: ${row.offBecause} is installed here.`}
                </span>
              )}
            </div>
            <Switch
              label={chord.name}
              checked={row.on}
              disabled={off}
              onChange={(on) => void api.settings.set({ passwords: passwordChordPatch(settings, chord, on, snapshot.extensions) })}
              {...(why ? { describedBy: why } : {})}
            />
          </div>
        );
      })}
    </div>
  );
}


/** The switch, Lock after, Keep unlocked and the passphrase's own row. */
function Locking({ snapshot, appearance, view, onView }: { snapshot: SettingsSnapshot; appearance: Appearance; view: PasswordsView; onView(view: PasswordsView): void }) {
  const ids = useId();
  const settings = snapshot.settings.passwords;
  const [problem, setProblem] = useState<string | null>(null);
  const [step, setStep] = useState<'choose' | 'change' | 'startOver' | 'keep' | null>(null);
  const [fresh, setFresh] = useState<PassphraseValue>(EMPTY_PASSPHRASE);
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const answered = (result: PasswordStepResult) => {
    setBusy(false);
    if (!result.ok) return setProblem(PROBLEMS[result.problem]);
    setProblem(null);
    setStep(null);
    setFresh(EMPTY_PASSPHRASE);
    setCurrent('');
    onView(result.view);
  };
  const choose = async () => {
    if (!passphraseReady(fresh)) return setFresh({ ...fresh, touched: true });
    setBusy(true);
    answered(await api.passwords.setup(fresh.passphrase));
  };
  const change = async () => {
    if (!passphraseReady(fresh) || !current) return setFresh({ ...fresh, touched: true });
    setBusy(true);
    answered(await api.passwords.changePassphrase(current, fresh.passphrase));
  };
  const setLockAfter = (lockAfter: PasswordLockAfter) => void api.settings.set({ passwords: { lockAfter } });

  return (
    <div className={styles.group}>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span id={`${ids}-on`} className={styles.rowLabel}>
            Offer to save and fill passwords
          </span>
          {snapshot.chords.length > 0 && (
            <span id={`${ids}-each`} className={styles.rowDescription}>
              In each chord below.
            </span>
          )}
        </div>
        <ResetButton
          label="Reset Offer to save and fill passwords to default"
          visible={settings.enabled !== DEFAULT_PASSWORD_SETTINGS.enabled}
          onReset={() => void api.settings.set({ passwords: { enabled: DEFAULT_PASSWORD_SETTINGS.enabled } })}
        />
        <Switch
          label="Offer to save and fill passwords"
          checked={settings.enabled}
          onChange={(enabled) => void api.settings.set({ passwords: { enabled } })}
          {...(snapshot.chords.length > 0 ? { describedBy: `${ids}-each` } : {})}
        />
      </div>
      {snapshot.chords.length > 0 && <ChordSwitches snapshot={snapshot} appearance={appearance} labelledBy={`${ids}-on`} />}
      <div className={styles.row}>
        <div className={styles.rowText}>
          <label htmlFor={`${ids}-lock`} className={styles.rowLabel}>
            Lock after
          </label>
        </div>
        <ResetButton
          label="Reset Lock after to default"
          visible={settings.lockAfter !== DEFAULT_PASSWORD_SETTINGS.lockAfter}
          onReset={() => setLockAfter(DEFAULT_PASSWORD_SETTINGS.lockAfter)}
        />
        <select
          id={`${ids}-lock`}
          className={sites.select}
          value={String(settings.lockAfter)}
          onChange={(e) => setLockAfter(e.target.value === 'never' ? 'never' : (Number(e.target.value) as PasswordLockAfter))}
        >
          {PASSWORD_LOCK_AFTER.map((choice) => (
            <option key={choice} value={String(choice)}>
              {lockAfterText(choice)}
            </option>
          ))}
        </select>
      </div>
      {view.state !== 'none' && (
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>Keep unlocked on this computer</span>
            <span id={`${ids}-keep`} className={styles.rowDescription}>
              {view.canKeep ? KEEP_WHY : 'This computer has no keyring, so your passwords lock each time Chord starts.'}
            </span>
          </div>
          {view.canKeep && (
            <Switch
              label="Keep unlocked on this computer"
              describedBy={`${ids}-keep`}
              checked={view.kept}
              // Turning it on needs the key, so the vault open; turning it off doesn't.
              onChange={(on) =>
                on && view.state !== 'open'
                  ? setProblem(PROBLEMS.locked)
                  : void api.passwords.keep(on).then((result) => (!result.ok && result.problem === 'passphrase' ? setStep('keep') : answered(result)))
              }
            />
          )}
        </div>
      )}
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowLabel}>Passphrase</span>
          {view.state !== 'open' && (
            <span className={styles.rowDescription}>{view.state === 'none' ? 'None yet. You choose one with the first password Chord keeps.' : 'Your passwords are locked.'}</span>
          )}
          {view.state === 'locked' && step !== 'startOver' && (
            <div className={local.inRow}>
              <PassphraseAsk text={null} labelled={false} button="Unlock" problem={problem} onSubmit={(passphrase) => void api.passwords.unlock(passphrase).then(answered)} />
              <button type="button" className={local.inlineLink} onClick={() => setStep('startOver')}>
                Forgot it?
              </button>
            </div>
          )}
        </div>
        <div className={styles.inlineControls}>
          {view.state === 'none' && step !== 'choose' && (
            <button type="button" className={styles.linkButton} onClick={() => setStep('choose')}>
              Choose…
            </button>
          )}
          {view.state === 'open' && (
            <>
              <button type="button" className={styles.linkButton} onClick={() => void api.passwords.lock().then(onView)}>
                Lock now
              </button>
              <button type="button" className={styles.linkButton} aria-expanded={step === 'change'} onClick={() => setStep(step === 'change' ? null : 'change')}>
                Change…
              </button>
            </>
          )}
        </div>
      </div>
      {step === 'keep' && (
        <div className={local.block}>
          <PassphraseAsk
            text="Enter your passphrase to keep your passwords unlocked on this computer."
            button="Keep unlocked"
            problem={problem}
            onSubmit={(passphrase) =>
              void api.passwords.keep(true, passphrase).then((result) => (!result.ok && result.problem === 'wrong' ? setProblem(PROBLEMS.wrong) : answered(result)))
            }
            onCancel={() => {
              setStep(null);
              setProblem(null);
            }}
          />
        </div>
      )}
      {view.state === 'locked' && step === 'startOver' && (
        <div className={local.block} role="group" aria-label="Start over">
          <p className={local.askText}>
            {`Without the passphrase, Chord can’t open your ${view.count === 1 ? 'password' : `${view.count} passwords`}. Starting over deletes ${view.count === 1 ? 'it' : 'them'}, and you choose a new passphrase with the next one.`}
          </p>
          <div className={local.detailActions}>
            <button type="button" className={styles.linkButton} onClick={() => setStep(null)}>
              Keep them
            </button>
            <button type="button" className={`${styles.linkButton} ${local.delete}`} onClick={() => void api.passwords.startOver().then((v) => (setStep(null), onView(v)))}>
              Delete them and start over
            </button>
          </div>
        </div>
      )}
      {(step === 'choose' || step === 'change') && (
        <form
          className={local.block}
          onSubmit={(e) => {
            e.preventDefault();
            void (step === 'choose' ? choose() : change());
          }}
        >
          {step === 'change' && (
            <label className={local.askField}>
              <span className={styles.rowLabel}>Current</span>
              <input className={`${styles.siteInput} ${local.grow}`} type="password" value={current} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
            </label>
          )}
          <PassphraseStep value={fresh} onChange={setFresh} label={step === 'change' ? 'New' : 'Passphrase'} autoFocus={step === 'choose'} note={step === 'change' ? null : undefined} />
          {problem && (
            <p className={local.problem} role="alert">
              {problem}
            </p>
          )}
          <div className={local.detailActions}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setStep(null);
                setFresh(EMPTY_PASSPHRASE);
                setCurrent('');
                setProblem(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className={`${styles.linkButton} ${local.primary}`} disabled={busy}>
              {busy ? 'Locking…' : step === 'change' ? 'Change' : 'Use it'}
            </button>
          </div>
        </form>
      )}
      {problem && view.state !== 'locked' && !step && (
        <p className={`${local.problem} ${local.block}`} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

export function PasswordsSection({ snapshot, appearance }: { snapshot: SettingsSnapshot; appearance: Appearance }) {
  const [view, setView] = useState<PasswordsView | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [nevers, setNevers] = useState(false);
  const [transfer, setTransfer] = useState<'import' | 'export' | null>(null);
  /** Counts the vault's locks main told of: a shown password goes at each. */
  const [hideSeq, setHideSeq] = useState(0);
  useEffect(() => {
    let live = true;
    const refresh = () => void api.passwords.view().then((v) => live && setView(v));
    refresh();
    const off = api.passwords.onChange((change) => (change?.hide ? setHideSeq((n) => n + 1) : refresh()));
    window.addEventListener('focus', refresh);
    return () => {
      live = false;
      off();
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    const logins = view?.logins ?? [];
    return words ? logins.filter((l) => `${hostOf(l.origin)} ${l.realm ?? ''} ${l.username} ${l.note}`.toLowerCase().includes(words)) : logins;
  }, [view, query]);

  return (
    <>
      <SectionHeader title="Passwords" description="Chord keeps the passwords you sign in with, locked with a passphrase only you know, and fills them when you choose." />
      {view && <Locking snapshot={snapshot} appearance={appearance} view={view} onView={setView} />}
      {view?.state === 'none' && !adding && <p className={local.empty}>No passwords yet. Sign in somewhere and Chord offers to keep it.</p>}
      {view?.state === 'open' && (
        <>
          {view.logins.length > 0 && (
            <label className={local.search}>
              <Search size={14} strokeWidth={2} aria-hidden />
              <input className={local.searchInput} type="search" value={query} placeholder="Search passwords" aria-label="Search passwords" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
          {view.deleted.map((d) => (
            <div key={d.id} className={local.deleted} role="status">
              <span>{`Deleted ${hostOf(d.origin)}${d.username ? ` · ${d.username}` : ''}.`}</span>
              <button type="button" className={local.tiny} onClick={() => void api.passwords.undo(d.id).then((r) => r.ok && setView(r.view))}>
                Undo
              </button>
            </div>
          ))}
          {view.logins.length === 0 && view.deleted.length === 0 && <p className={local.empty}>No passwords yet. Sign in somewhere and Chord offers to keep it.</p>}
          {view.logins.length > 0 && shown.length === 0 && <p className={local.empty}>{`No passwords match “${query.trim()}”.`}</p>}
          {shown.length > 0 && (
            <ul className={local.list} aria-label="Saved passwords">
              {shown.map((login) => {
                const expanded = open === login.id;
                return (
                  <li key={login.id}>
                    <button type="button" className={local.login} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : login.id)}>
                      <Favicon url={login.origin} title={hostOf(login.origin)} favicon={null} appearance={appearance} />
                      <span className={local.loginText}>
                        <span className={local.loginHost}>{hostOf(login.origin)}</span>
                        {login.realm !== null && <span className={local.loginUser}>{login.realm ? `Realm: ${login.realm}` : 'The site’s sign-in box'}</span>}
                        <span className={local.loginUser}>{login.username || (login.unconfirmed ? 'No username yet' : 'No username')}</span>
                      </span>
                      {/* Never used, so the date has nothing to say: the words take its place (the owner's design 4A). */}
                      <span className={local.when}>{login.unconfirmed ? 'Not confirmed' : whenText(login.lastUsed ?? login.updatedAt)}</span>
                    </button>
                    {expanded && <LoginDetail login={login} hideSeq={hideSeq} onView={setView} onDeleted={() => setOpen(null)} />}
                  </li>
                );
              })}
            </ul>
          )}
          {view.unreadable > 0 && <p className={local.quiet}>{`${view.unreadable === 1 ? 'One password' : `${view.unreadable} passwords`} couldn’t be read, and ${view.unreadable === 1 ? 'is' : 'are'} kept as ${view.unreadable === 1 ? 'it is' : 'they are'}.`}</p>}
        </>
      )}
      {adding && view && <AddLogin needsPassphrase={view.state === 'none'} onView={setView} onDone={() => setAdding(false)} />}
      {view && (
        <div className={local.foot}>
          {!adding && view.state !== 'locked' && (
            <button type="button" className={local.footLink} onClick={() => setAdding(true)}>
              Add a password…
            </button>
          )}
          <button type="button" className={local.footLink} aria-expanded={transfer === 'import'} onClick={() => setTransfer(transfer === 'import' ? null : 'import')}>
            Import…
          </button>
          {view.state === 'open' && view.count > 0 && (
            <button type="button" className={local.footLink} aria-expanded={transfer === 'export'} onClick={() => setTransfer(transfer === 'export' ? null : 'export')}>
              Export…
            </button>
          )}
          {view.state === 'open' && (
            <button type="button" className={local.footLink} aria-expanded={nevers} onClick={() => setNevers(!nevers)}>
              Sites Chord never saves for
            </button>
          )}
        </div>
      )}
      {transfer === 'import' && view && <ImportCard view={view} onClose={() => setTransfer(null)} />}
      {transfer === 'export' && view?.state === 'open' && <ExportCard view={view} />}
      {nevers && view?.state === 'open' && (
        <div className={styles.group} role="group" aria-label="Sites Chord never saves for">
          {view.nevers.length === 0 && <p className={local.block}>
              None. When Chord offers to save a password, <em>Never for this site</em> puts the site here.
            </p>}
          {view.nevers.map((site) => (
            <div key={site} className={styles.row}>
              <span className={`${styles.rowLabel} ${local.grow}`}>{site}</span>
              <button type="button" className={styles.linkButton} onClick={() => void api.passwords.forgetNever(site).then((r) => r.ok && setView(r.view))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
