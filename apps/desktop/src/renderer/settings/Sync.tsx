/**
 * Settings → Your data → Sync (docs/decisions/S15-your-data.md §8; DESIGN.md
 * §8.8): your setup the same on each of your computers, through a folder you
 * already sync, encrypted with a passphrase. Off, the card turns it on: pick
 * the folder (the system's picker), then a passphrase for a new one, or the
 * folder's to join it, and, if this computer has its own chords, what to do
 * with them. On, it says how it stands, lists the computers, and offers
 * Pause, Change passphrase and Turn off. A problem that needs you shows one
 * card at a time. Main and chord-data do the work; this page only asks.
 */
import { passphraseProblem, suggestPassphrase, type FolderInspection, type SyncComputer } from '@chord/core';
import type { SyncStepResult, SyncView } from '@chord/ipc';
import { Check } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { plural, ProblemCard } from '../shared/ImportPanel';
import { api } from './api';
import { RadioGroup, Row, Switch } from './controls';
import styles from './Settings.module.css';
import local from './YourData.module.css';

/** "2 minutes ago", "just now", "3 hours ago", "on Nov 30". */
export function agoText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${plural(m, 'minute')} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${plural(h, 'hour')} ago`;
  return `on ${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/** "2 hours", "10 minutes": how far ahead a clock runs. */
const aheadBy = (ms: number) => (ms >= 3_600_000 ? plural(Math.round(ms / 3_600_000), 'hour') : plural(Math.max(1, Math.round(ms / 60_000)), 'minute'));

/** The On row's line: *On · Dropbox › Chord sync · Up to date*, or the last change from another computer. */
export function onText(view: SyncView, now = Date.now()): string {
  const where = view.folderName ? `${view.folderName} › Chord sync` : 'Chord sync';
  const state = view.pending > 0 ? `${plural(view.pending, 'change')} to write` : view.lastChange ? `Last change from ${view.lastChange.name}, ${agoText(view.lastChange.at, now)}` : 'Up to date';
  return `${view.state === 'paused' ? 'Paused' : 'On'} · ${where} · ${state}`;
}

/** A computer's line in the list: its system, and when it last synced. */
export function computerText(c: SyncComputer, now = Date.now()): string {
  const parts = [c.os || 'Chord', c.app ? `Chord ${c.app}` : ''].filter(Boolean);
  if (c.self) return `${parts.join(' · ')} · This computer`;
  return `${parts.join(' · ')} · ${c.lastSync ? `Synced ${agoText(c.lastSync, now)}` : 'Not seen yet'}`;
}

const STEP_PROBLEMS: Record<Exclude<SyncStepResult, { ok: true }>['problem'], string> = {
  wrong: 'That passphrase doesn’t open this folder.',
  conflict: 'Sync was set up in this folder from two computers at once. Set it up on one computer first, then join from the others.',
  newer: 'This folder is from a newer Chord. Update Chord to sync through it.',
  damaged: 'Chord can’t use this folder. Choose another.',
  missing: 'Chord can’t find that folder any more. Choose it again.',
  io: 'Chord couldn’t write to that folder. Choose another.',
  busy: 'Sync is busy with another step. Try again in a moment.',
};

type Flow =
  | { at: 'idle' }
  | { at: 'choosing-folder' }
  | { at: 'new'; folderId: string; name: string }
  | { at: 'join'; folderId: string; name: string; computers: number }
  | { at: 'working'; text: string }
  | { at: 'problem'; text: string; retry: 'folder' | 'join' | 'updates'; join?: { folderId: string; name: string; computers: number } };

/** Two fields and Suggest one: a new passphrase, as the Export card asks for one. */
function NewPassphrase({ ids, value, onChange }: { ids: string; value: { passphrase: string; repeat: string; shown: boolean; touched: boolean }; onChange(next: { passphrase: string; repeat: string; shown: boolean; touched: boolean }): void }) {
  const lengthProblem = passphraseProblem(value.passphrase);
  const mismatch = value.repeat !== value.passphrase;
  const type = (key: 'passphrase' | 'repeat') => (text: string) => onChange({ ...value, [key]: text, shown: false });
  return (
    <div className={local.fields}>
      <label className={local.field}>
        <span className={styles.rowLabel}>Passphrase</span>
        <input
          className={`${styles.siteInput} ${local.input}`}
          type={value.shown ? 'text' : 'password'}
          value={value.passphrase}
          autoComplete="new-password"
          spellCheck={false}
          aria-invalid={(value.touched && Boolean(lengthProblem)) || undefined}
          aria-describedby={value.touched && lengthProblem ? `${ids}-length` : undefined}
          onChange={(e) => type('passphrase')(e.target.value)}
          onBlur={() => value.passphrase && onChange({ ...value, touched: true })}
        />
      </label>
      {value.touched && lengthProblem && (
        <span id={`${ids}-length`} className={local.problem}>
          {lengthProblem}
        </span>
      )}
      <label className={local.field}>
        <span className={styles.rowLabel}>Again</span>
        <input
          className={`${styles.siteInput} ${local.input}`}
          type={value.shown ? 'text' : 'password'}
          value={value.repeat}
          autoComplete="new-password"
          spellCheck={false}
          aria-invalid={(value.touched && mismatch) || undefined}
          aria-describedby={value.touched && mismatch ? `${ids}-match` : undefined}
          onChange={(e) => type('repeat')(e.target.value)}
          onBlur={() => value.repeat && onChange({ ...value, touched: true })}
        />
      </label>
      {value.touched && mismatch && !lengthProblem && (
        <span id={`${ids}-match`} className={local.problem}>
          The two don’t match.
        </span>
      )}
      <div className={local.suggest}>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            const words = suggestPassphrase();
            onChange({ passphrase: words, repeat: words, shown: true, touched: false });
          }}
        >
          Suggest one
        </button>
        {value.shown && <span className={styles.rowDescription}>Five words at random. Write them down, or keep them in your password manager.</span>}
      </div>
    </div>
  );
}

const EMPTY = { passphrase: '', repeat: '', shown: false, touched: false };
const ready = (v: typeof EMPTY) => passphraseProblem(v.passphrase) === null && v.repeat === v.passphrase;

/** One passphrase field and its button: joining, unlocking. */
function PassphraseField({ text, button, onSubmit, problem }: { text: string; button: string; onSubmit(passphrase: string): Promise<void>; problem: string | null }) {
  const [passphrase, setPassphrase] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <form
      className={local.fields}
      onSubmit={(e) => {
        e.preventDefault();
        if (!passphrase) return;
        const typed = passphrase;
        setPassphrase('');
        void onSubmit(typed);
      }}
    >
      <p className={`${styles.rowDescription} ${local.span}`}>{text}</p>
      <label className={local.field}>
        <span className={styles.rowLabel}>Passphrase</span>
        <input ref={field} className={`${styles.siteInput} ${local.input}`} type="password" value={passphrase} autoComplete="off" spellCheck={false} onChange={(e) => setPassphrase(e.target.value)} />
      </label>
      {problem && <span className={local.problem}>{problem}</span>}
      <div className={local.suggest}>
        <button type="submit" className={styles.linkButton} disabled={!passphrase}>
          {button}
        </button>
      </div>
    </form>
  );
}

/** Turning sync on: the folder, then a passphrase (new, or the folder's), then what to do with this computer's own setup. */
function TurnOn({ onUpdates, removed }: { onUpdates(): void; removed: boolean }) {
  const ids = useId();
  const [flow, setFlow] = useState<Flow>({ at: 'idle' });
  const [fresh, setFresh] = useState(EMPTY);
  const [wrong, setWrong] = useState<string | null>(null);

  const chooseFolder = async () => {
    setFlow({ at: 'choosing-folder' });
    setWrong(null);
    const result = await api.sync.chooseFolder().catch(() => ({ ok: false, problem: 'cancelled' }) as const);
    if (!result.ok) return setFlow({ at: 'idle' });
    const look: FolderInspection = result.inspection;
    if (look.state === 'new') setFlow({ at: 'new', folderId: result.folderId, name: result.name });
    else if (look.state === 'join') setFlow({ at: 'join', folderId: result.folderId, name: result.name, computers: look.computers });
    else setFlow({ at: 'problem', text: STEP_PROBLEMS[look.state], retry: look.state === 'newer' ? 'updates' : 'folder' });
  };
  const answered = (result: SyncStepResult, join?: { folderId: string; name: string; computers: number }) => {
    if (result.ok) return setFlow({ at: 'idle' });
    if (result.problem === 'wrong' && join) {
      setWrong(STEP_PROBLEMS.wrong);
      return setFlow({ at: 'join', ...join });
    }
    setFlow({ at: 'problem', text: STEP_PROBLEMS[result.problem], retry: result.problem === 'newer' ? 'updates' : 'folder' });
  };
  const start = async () => {
    if (flow.at !== 'new') return;
    if (!ready(fresh)) return setFresh({ ...fresh, touched: true });
    const { folderId } = flow;
    setFlow({ at: 'working', text: 'Locking the folder with your passphrase…' });
    const result = await api.sync.setup(folderId, fresh.passphrase).catch(() => ({ ok: false, problem: 'io' }) as const);
    setFresh(EMPTY);
    answered(result);
  };
  const join = async (passphrase: string) => {
    if (flow.at !== 'join') return;
    const where = { folderId: flow.folderId, name: flow.name, computers: flow.computers };
    setWrong(null);
    setFlow({ at: 'working', text: 'Opening the folder and reading your other computers…' });
    answered(await api.sync.join(where.folderId, passphrase).catch(() => ({ ok: false, problem: 'io' }) as const), where);
  };

  return (
    <div className={styles.group}>
      <Row
        label="Sync your setup"
        description="Chords, pinned tabs, Favorites, themes, settings, link routes and Effects, the same on each of your computers, through a folder you already sync: iCloud Drive, Dropbox, OneDrive or Syncthing. History and Today tabs stay on each computer."
        control={
          <button type="button" className={styles.linkButton} aria-expanded={flow.at !== 'idle'} disabled={flow.at === 'working' || flow.at === 'choosing-folder'} onClick={() => void chooseFolder()}>
            {removed ? 'Turn on again…' : 'Turn on sync…'}
          </button>
        }
      />
      {flow.at !== 'idle' && (
        <div className={local.card} role="group" aria-label="Turn on sync">
          {flow.at === 'choosing-folder' && <p className={local.note}>Pick a folder your sync app keeps on every computer. Chord adds a “Chord sync” folder inside.</p>}
          {flow.at === 'new' && (
            <>
              <p className={local.note}>
                {`In ${flow.name}. Choose a passphrase. Everything Chord puts in the folder is encrypted with it, and you’ll type it once on each computer. Lose it and the synced copy can’t be opened; what’s on each computer stays.`}
              </p>
              <NewPassphrase ids={ids} value={fresh} onChange={setFresh} />
              <div className={local.actions}>
                <div className={local.buttons}>
                  <button type="button" className={styles.linkButton} onClick={() => void start()}>
                    Start syncing
                  </button>
                </div>
              </div>
            </>
          )}
          {flow.at === 'join' && (
            <PassphraseField
              text={`${flow.name} syncs ${plural(flow.computers, 'computer')} already. Enter your passphrase.`}
              button="Join"
              problem={wrong}
              onSubmit={join}
            />
          )}
          {flow.at === 'working' && (
            <p className={local.note} role="status">
              {flow.text}
            </p>
          )}
          {flow.at === 'problem' && (
            <div className={local.actions}>
              <ProblemCard text={flow.text} action={flow.retry === 'updates' ? { label: 'Check for updates', run: onUpdates } : { label: 'Choose another folder…', run: () => void chooseFolder() }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Joined, with a setup of this computer's own: the synced setup replaces it (with Undo), or both stay. */
function Choose({ view }: { view: SyncView }) {
  const [mode, setMode] = useState<'synced' | 'both'>('synced');
  const [working, setWorking] = useState(false);
  const here = view.choosing?.here ?? 0;
  const options = [
    { key: 'synced' as const, name: 'Use the synced setup', hint: `${here === 1 ? 'This computer’s chord goes' : `This computer’s ${plural(here, 'chord')} go`}, and its Today tabs move to the synced setup. You can undo this.` },
    { key: 'both' as const, name: 'Keep both', hint: 'Everything stays, side by side, and goes to your other computers too.' },
  ];
  return (
    <div className={local.card} role="group" aria-label="This computer has its own chords">
      <p className={local.note}>This computer has its own chords.</p>
      {view.cluttered && (
        <p className={local.note}>The sync folder holds files Chord doesn’t recognise, so some of your other computers’ setup may not have been read yet. It goes on looking after you join.</p>
      )}
      <RadioGroup className={styles.group} label="What to do with this computer’s chords">
        {options.map((o) => (
          <button key={o.key} type="button" role="radio" aria-checked={mode === o.key} className={styles.choice} onClick={() => setMode(o.key)}>
            <span className={styles.rowText}>
              <span className={styles.rowLabel}>{o.name}</span>
              <span className={styles.rowDescription}>{o.hint}</span>
            </span>
            {mode === o.key && <Check className={styles.check} size={16} strokeWidth={2.25} aria-hidden />}
          </button>
        ))}
      </RadioGroup>
      <div className={local.actions}>
        <div className={local.buttons}>
          <button
            type="button"
            className={styles.linkButton}
            disabled={working}
            onClick={() => {
              setWorking(true);
              void api.sync.choose(mode).finally(() => setWorking(false));
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

/** Sync on: where it stands, the computers, and Pause, Change passphrase and Turn off. */
function On({ view, onUpdates }: { view: SyncView; onUpdates(): void }) {
  const ids = useId();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [next, setNext] = useState(EMPTY);
  const [startingOver, setStartingOver] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const unlock = async (passphrase: string) => {
    setProblem(null);
    const result = await api.sync.unlock(passphrase).catch(() => ({ ok: false, problem: 'io' }) as const);
    if (!result.ok) setProblem(STEP_PROBLEMS[result.problem]);
  };
  const change = async () => {
    if (!ready(next)) return setNext({ ...next, touched: true });
    const result = await (startingOver ? api.sync.startOver(next.passphrase) : api.sync.changePassphrase(next.passphrase)).catch(() => ({ ok: false, problem: 'io' }) as const);
    setNext(EMPTY);
    if (result.ok) {
      setChanging(false);
      setStartingOver(false);
    } else setProblem(STEP_PROBLEMS[result.problem]);
  };
  const relocate = async () => {
    setProblem(null);
    const result = await api.sync.relocate().catch(() => ({ ok: false, problem: 'io' }) as const);
    if (!result.ok) setProblem(result.problem === 'wrong' ? 'That isn’t this sync’s folder. Choose the folder your other computers sync through.' : STEP_PROBLEMS[result.problem]);
  };
  const pending = view.pendingUndo;
  const self = view.computers.find((c) => c.self);
  // Just after launch, the key kept here is still being read: nothing asks for the passphrase yet.
  const locked = view.state === 'locked' && !view.opening;
  const asking = locked || (view.state === 'problem' && view.problem === 'changed');
  return (
    <div className={styles.group}>
      <Row label="Sync" description={onText(view, now)} control={null} />
      {locked && !startingOver && <PassphraseField text="Sync is paused. Enter your passphrase." button="Unlock" problem={problem} onSubmit={unlock} />}
      {view.state === 'problem' && view.problem === 'changed' && !startingOver && (
        <PassphraseField
          text={
            // Named only when that computer said so under the old passphrase: anyone who can write to the folder could put a new file there.
            view.changedBy ? `The passphrase was changed on ${view.changedBy}. Enter the new one to keep syncing.` : 'Sync was started again in this folder with a new passphrase. Enter it to keep syncing.'
          }
          button="Unlock"
          problem={problem}
          onSubmit={unlock}
        />
      )}
      {asking && startingOver && (
        <>
          <p className={local.note}>
            Without the passphrase, the synced copy can’t be opened. Starting over puts this computer’s setup in the folder under a new one; your other computers pause until you type it there. What’s on each computer stays.
          </p>
          <NewPassphrase ids={`${ids}-over`} value={next} onChange={setNext} />
        </>
      )}
      {view.state === 'problem' && view.problem === 'missing' && (
        <div className={local.actions}>
          <ProblemCard text="Chord can’t find the sync folder. Is your sync app running?" action={{ label: 'Choose folder…', run: () => void relocate() }} />
        </div>
      )}
      {view.state === 'problem' && view.problem === 'unwritable' && (
        <div className={local.actions}>
          <ProblemCard text={`Chord couldn’t write to the sync folder. It tries again every few minutes; ${view.pending > 0 ? `${plural(view.pending, 'change')} wait here` : 'your changes wait here'}.`} />
        </div>
      )}
      {view.state === 'problem' && view.problem === 'stalled' && (
        <div className={local.actions}>
          <ProblemCard text={`The sync folder isn’t answering. Is your sync app or network drive working? Chord tries again in a few minutes; ${view.pending > 0 ? `${plural(view.pending, 'change')} wait here` : 'your changes wait here'}.`} />
        </div>
      )}
      {view.state === 'problem' && view.problem === 'unreadable' && (
        <div className={local.actions}>
          <ProblemCard text="Chord couldn’t take in changes from the sync folder. It tries again in a few minutes; nothing’s lost meanwhile." />
        </div>
      )}
      {view.state === 'problem' && view.problem === 'copies' && (
        <div className={local.actions}>
          <ProblemCard text="Another computer keeps writing to the sync folder as this one, so sync stopped writing here. Your changes wait. Turn sync off and on again on this computer." action={{ label: 'Turn off', run: () => void api.sync.off() }} />
        </div>
      )}
      {view.state === 'problem' && view.problem === 'newer' && (
        <div className={local.actions}>
          <ProblemCard text="Another computer has a newer Chord. Update this one to keep syncing." action={{ label: 'Check for updates', run: onUpdates }} />
        </div>
      )}
      {view.state === 'problem' && view.problem === 'conflict' && (
        <div className={local.actions}>
          <ProblemCard text="Sync was set up on two computers at once, and the folder kept the other’s. Turn sync off here, then join it." action={{ label: 'Turn off', run: () => void api.sync.off() }} />
        </div>
      )}
      {view.ahead.map((a) => (
        <p key={a.name} className={local.note}>{`${a.name}’s clock is ${aheadBy(a.ms)} ahead. Its changes may win over newer ones.`}</p>
      ))}
      {view.capped > 0 && <p className={local.note}>{`${plural(view.capped, 'thing')} from another computer went past what sync keeps, and stayed out.`}</p>}
      {view.refused > 0 && <p className={local.note}>{`${plural(view.refused, 'part')} of another computer’s changes went past what sync reads, and stayed out.`}</p>}
      {view.tooMany && <p className={local.note}>More than 64 computers sync through this folder. Chord reads 64 of them; remove the ones you don’t use.</p>}
      {view.cluttered && (
        <p className={local.note}>The sync folder holds files Chord doesn’t recognise, so it stops looking there for computers it doesn’t know yet. Remove them, or start sync again in a new folder.</p>
      )}
      {view.blocked.length > 0 && (
        <p className={local.note}>{`Changes from ${view.blocked.slice(0, 3).join(', ')} are slow to come: ${view.blocked.length === 1 ? 'its folder holds' : 'their folders hold'} files Chord doesn’t recognise.`}</p>
      )}
      {view.stuck.length > 0 && <p className={local.note}>{`Another computer’s clock is set far ahead, so some changes here can’t sync: ${view.stuck.slice(0, 3).join(', ')}${view.stuck.length > 3 ? ', and more' : ''}.`}</p>}
      <ul className={local.computers} aria-label="Computers that sync">
        {view.computers.map((c) => (
          <li key={c.id} className={styles.row}>
            {c.self && renaming !== null ? (
              <form
                className={local.rename}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (renaming.trim()) void api.sync.rename(renaming.trim());
                  setRenaming(null);
                }}
              >
                <label className={local.field}>
                  <span className={styles.rowLabel}>Name</span>
                  <input className={`${styles.siteInput} ${local.input}`} value={renaming} maxLength={100} autoFocus onChange={(e) => setRenaming(e.target.value)} />
                </label>
                <button type="submit" className={styles.linkButton}>
                  Done
                </button>
              </form>
            ) : (
              <>
                <div className={styles.rowText}>
                  <span className={styles.rowLabel}>{c.name}</span>
                  <span className={styles.rowDescription}>{computerText(c, now)}</span>
                </div>
                {c.self ? (
                  <button type="button" className={styles.linkButton} onClick={() => setRenaming(c.name)}>
                    Rename
                  </button>
                ) : (
                  <button type="button" className={styles.linkButton} aria-label={`Remove ${c.name}`} disabled={pending !== null} onClick={() => void api.sync.remove(c.id)}>
                    Remove
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {view.computers.length > 1 && <p className={local.note}>Removing a computer stops it syncing; it keeps what it has. To lock out a lost one, change the passphrase too.</p>}
      {self && view.state !== 'locked' && (!view.keyKept || view.keyWeak) && (
        // S15 question 6: asking after each launch, with remembering it anyway behind a plain warning.
        <Row
          label="Remember the key on this computer"
          description={
            view.keyWeak
              ? 'Kept without a keyring: any program you run could read it, and so could anyone who has this computer.'
              : 'This computer has no safe place for the key, so Chord asks for the passphrase after each launch. Remembered anyway, any program you run could read it.'
          }
          control={<Switch label="Remember the key on this computer" checked={view.keyWeak} onChange={(on) => void api.sync.rememberKey(on)} />}
        />
      )}
      {changing && (
        <>
          <p className={local.note}>Your other computers pause until you type the new passphrase on each of them.</p>
          <NewPassphrase ids={ids} value={next} onChange={setNext} />
        </>
      )}
      <div className={local.actions}>
        {pending && (
          <ProblemCard
            text={
              pending.what === 'off'
                ? `Sync turns off on this computer in a moment. What’s here stays.${view.pending > 0 ? ` ${plural(view.pending, 'change')} not yet in the folder wait here, and go when you turn sync on again.` : ''}`
                : `${view.computers.find((c) => c.id === pending.device)?.name ?? 'That computer'} will be removed from sync in a moment.`}
            action={{ label: 'Undo', run: () => void api.sync.undo(pending.token) }}
          />
        )}
        {problem && !changing && (startingOver || !asking) && <ProblemCard text={problem} />}
        <div className={local.buttons}>
          {changing || startingOver ? (
            <>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  setChanging(false);
                  setStartingOver(false);
                  setNext(EMPTY);
                }}
              >
                Cancel
              </button>
              <button type="button" className={styles.linkButton} onClick={() => void change()}>
                {startingOver ? 'Start over' : 'Change passphrase'}
              </button>
            </>
          ) : (
            <>
              {asking && (
                <button type="button" className={styles.linkButton} onClick={() => setStartingOver(true)}>
                  Lost it? Start over…
                </button>
              )}
              {(view.state === 'on' || view.state === 'paused') && (
                <button type="button" className={styles.linkButton} onClick={() => void api.sync.pause(view.state === 'on')}>
                  {view.state === 'on' ? 'Pause' : 'Resume'}
                </button>
              )}
              {view.state === 'on' && (
                <button type="button" className={styles.linkButton} onClick={() => setChanging(true)}>
                  Change passphrase…
                </button>
              )}
              <button type="button" className={styles.linkButton} disabled={pending !== null} onClick={() => void api.sync.off()}>
                Turn off
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Settings → Your data → Sync. */
export function SyncSection({ onUpdates }: { onUpdates(): void }) {
  const [view, setView] = useState<SyncView | null>(null);
  useEffect(() => {
    void api.sync.status().then(setView);
    return api.sync.onStatus(setView);
  }, []);
  if (!view) return null;
  if (view.state === 'off' || (view.state === 'problem' && view.problem === 'removed')) {
    return (
      <>
        {view.problem === 'removed' && view.removedAt !== null && (
          <p className={styles.groupNote}>{`This computer was removed from sync ${agoText(view.removedAt)}. What’s here stays.`}</p>
        )}
        {view.pending > 0 && <p className={styles.groupNote}>{`${plural(view.pending, 'change')} made while sync was on didn’t reach the folder. They go when you turn sync on again.`}</p>}
        <TurnOn onUpdates={onUpdates} removed={view.problem === 'removed'} />
      </>
    );
  }
  if (view.state === 'choosing') return <Choose view={view} />;
  return <On view={view} onUpdates={onUpdates} />;
}
