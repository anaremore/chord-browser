/**
 * Settings → Passwords → Import… and Export… (docs/decisions/S17-passwords.md
 * §10, phase 2), as the owner's mock draws them (`passwords-phase2.html`,
 * options 1C and 2A). Main and chord-data do the reading, comparing and
 * writing; these cards show what they say and ask. No password reaches this
 * page: the preview has addresses and usernames only.
 *
 * - **Import** reads like Your data's import: *From*, *What comes in*, a
 *   switch (*Take the file's where they differ*, off: yours are kept) with a
 *   checkbox for each that differs, and *Left out*. A long list folds behind
 *   *Review all*, a search box over a virtual list. No confirm dialog: the
 *   result has Undo, here and in the window's toast (DESIGN.md principle 6).
 * - **Export** offers two kinds: Chord's encrypted file, with a passphrase
 *   of its own (never the vault's, the owner's decision), or a CSV, with its
 *   warning. The vault's passphrase is asked for at the save, as *Show* asks.
 */
import { PASSWORD_SOURCE_NAMES, type ImportIssue, type PasswordImportResult, type PasswordImportSummary, type PasswordImportUndone } from '@chord/core';
import type { ExportProgress, PasswordImportProgress, PasswordsView } from '@chord/ipc';
import { size } from '@chord/tokens';
import { Search, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { plural, ProblemCard, ProgressLine } from '../shared/ImportPanel';
import { EMPTY_PASSPHRASE, PassphraseStep, passphraseReady, type PassphraseValue } from '../shared/PassphraseStep';
import { api } from './api';
import { RadioGroup, Row, Switch } from './controls';
import local from './PasswordTransfer.module.css';
import { PassphraseAsk } from './Passwords';
import styles from './Settings.module.css';
import data from './YourData.module.css';

const numbers = new Intl.NumberFormat('en-US');
const hostOf = (origin: string) => origin.replace(/^[a-z]+:\/\//, '');
const passwords = (n: number) => plural(n, 'password');

/** Lines shown before *Review all* or *Show*. */
const FOLDED = 5;
/** A virtual list's line, in CSS pixels (its CSS sets the same token, `--size-icon-button`), and how many show. */
const LINE_PX = size.iconButton;
const LINES = 7;

/* ---------- The words ---------- */

/** "A Chrome, Edge or Brave export, 412 rows, from Chrome Passwords.csv." */
export function fromText(preview: PasswordImportSummary, name: string): string {
  const kind = preview.source ? `A ${PASSWORD_SOURCE_NAMES[preview.source]} export` : 'A CSV file';
  return `${kind}, ${plural(preview.rows, 'row')}, from ${name}.`;
}

/** "New: 380 passwords. Same as yours: 20, left as they are. Different from yours: 9." */
export function comesInText(preview: PasswordImportSummary): string {
  if (preview.state === 'locked') return `${passwords(preview.logins)} in the file. Unlock your passwords to compare them with yours.`;
  if (preview.logins === 0) return 'No passwords Chord can bring in.';
  const parts = [`New: ${passwords(preview.added)}.`];
  if (preview.same) parts.push(`Same as yours: ${numbers.format(preview.same)}, left as they are.`);
  if (preview.different) parts.push(`Different from yours: ${numbers.format(preview.different)}.`);
  return parts.join(' ');
}

const WHY: Record<ImportIssue['kind'], string> = {
  address: 'no address',
  app: 'an app, not a site',
  password: 'no password',
  long: 'too long',
  kind: 'not a sign-in',
};

/** "3 rows without a usable address", or, mixed, "4 rows left out". */
export function leftOutTitle(issues: readonly ImportIssue[], more: number): string {
  const n = issues.length + more;
  const address = issues.every((i) => i.kind === 'address' || i.kind === 'app');
  return address ? `${plural(n, 'row')} without a usable address` : `${plural(n, 'row')} left out`;
}

/** "Row 57: “Home router”, admin (no address)": what the row says, never its password. */
export function issueText(issue: ImportIssue, why = true): string {
  const what = [issue.address || (issue.name ? `“${issue.name}”` : ''), issue.username].filter(Boolean).join(', ');
  return `Row ${numbers.format(issue.row)}${what ? `: ${what}` : ''}${why ? ` (${WHY[issue.kind]})` : ''}`;
}

/** "Imported 380 passwords, and took the file’s for 4." */
export function resultText(r: PasswordImportResult): { title: string; more: string } {
  const title =
    r.added === 0 && r.updated === 0
      ? 'Nothing to import: every password in the file is here already.'
      : `Imported ${passwords(r.added)}${r.updated ? `, and took the file’s for ${numbers.format(r.updated)}` : ''}.`;
  const more = [r.kept ? `Yours stayed for ${numbers.format(r.kept)}.` : '', r.stopped ? 'Your passwords locked part way, so the rest stayed out.' : ''].filter(Boolean).join(' ');
  return { title, more };
}

export function undoneText(u: PasswordImportUndone): string {
  return `Import undone.${u.restored ? ` ${plural(u.restored, 'replaced password')} came back as ${u.restored === 1 ? 'it was' : 'they were'}.` : ''}${u.changed ? ` ${plural(u.changed, 'password')} you changed since stayed as you left ${u.changed === 1 ? 'it' : 'them'}.` : ''}`;
}

/* ---------- Import ---------- */

type ImportStep =
  | { at: 'reading' }
  | { at: 'problem'; text: string }
  | { at: 'preview'; stageId: string; name: string; preview: PasswordImportSummary }
  | { at: 'writing'; stageId: string; name: string; preview: PasswordImportSummary; done: number; total: number }
  | { at: 'done'; name: string; preview: PasswordImportSummary; importId: string | null; result: PasswordImportResult }
  | { at: 'undone'; text: string };

/** The import card, under the foot's links. It opens on the file dialog; closing it lets the file go. */
export function ImportCard({ view, onClose }: { view: PasswordsView; onClose(): void }) {
  const [step, setStep] = useState<ImportStep>({ at: 'reading' });
  const [take, setTake] = useState<Set<number>>(new Set());
  const [first, setFirst] = useState<PassphraseValue>(EMPTY_PASSPHRASE);
  const [problem, setProblem] = useState<string | null>(null);
  const stage = useRef<string | null>(null);

  const choose = async () => {
    if (stage.current) void api.passwords.importDrop(stage.current);
    stage.current = null;
    setStep({ at: 'reading' });
    setTake(new Set());
    setProblem(null);
    const opened = await api.passwords.importChoose().catch(() => ({ ok: false, problem: 'unreadable' }) as const);
    if (!opened.ok) {
      if (opened.problem === 'cancelled') return onClose();
      return setStep({ at: 'problem', text: opened.problem === 'busy' ? 'Another import is still running. Try again when it’s done.' : 'Chord couldn’t read that file.' });
    }
    stage.current = opened.stageId;
    setStep({ at: 'preview', stageId: opened.stageId, name: opened.name, preview: opened.preview });
  };
  // Opened: the dialog at once. Closed: the file's passwords leave memory.
  useEffect(() => {
    void choose();
    return () => {
      if (stage.current) void api.passwords.importDrop(stage.current);
    };
  }, []);
  // Unlocked elsewhere (the card's own row, or Settings' Passphrase row): the preview compares now.
  const previewState = step.at === 'preview' ? step.preview.state : null;
  useEffect(() => {
    if (previewState !== 'locked' || view.state !== 'open' || step.at !== 'preview') return;
    const { stageId, name } = step;
    // Null: the lock let the file go (its passwords leave memory at a lock), so it's chosen again.
    void api.passwords.importPreview(stageId).then((preview) =>
      setStep(preview ? { at: 'preview', stageId, name, preview } : { at: 'problem', text: 'Your passwords locked, so Chord let the file go. Choose it again.' }),
    );
  }, [previewState, view.state, step]);
  useEffect(
    () =>
      api.passwords.onImportProgress((p: PasswordImportProgress) => {
        if (p.phase === 'writing') setStep((s) => (s.at === 'writing' && s.stageId === p.stageId ? { ...s, done: p.done, total: p.total } : s));
        else if (p.undone) setStep((s) => (s.at === 'done' && s.importId === p.importId ? { at: 'undone', text: undoneText(p.undone!) } : s));
      }),
    [],
  );

  const start = async () => {
    if (step.at !== 'preview') return;
    const { stageId, name, preview } = step;
    if (preview.state === 'none' && !passphraseReady(first)) return setFirst({ ...first, touched: true });
    const all = preview.conflicts.length + preview.conflictsMore;
    // The fewer named: most taken means "take the file's, except these".
    const takeFile = take.size * 2 > all;
    const except = preview.conflicts.filter((c) => take.has(c.at) !== takeFile).map((c) => c.at);
    setStep({ at: 'writing', stageId, name, preview, done: 0, total: preview.added + take.size });
    const run = await api.passwords.importRun(stageId, { take: takeFile ? 'file' : 'yours', except }, preview.state === 'none' ? first.passphrase : undefined).catch(() => ({ ok: false, problem: 'io' }) as const);
    setFirst(EMPTY_PASSPHRASE);
    stage.current = null;
    if (run.ok) return setStep({ at: 'done', name, preview, importId: run.importId, result: run.result });
    if (run.problem === 'locked') {
      setProblem('Your passwords locked. Unlock them, then import again.');
      const again = await api.passwords.importPreview(stageId);
      if (again) {
        stage.current = stageId;
        return setStep({ at: 'preview', stageId, name, preview: again });
      }
    }
    setStep({ at: 'problem', text: run.problem === 'busy' ? 'Another import is still running. Try again when it’s done.' : 'Chord couldn’t import that file. Choose it again to try once more.' });
  };

  const chooseAnother = (
    <button type="button" className={styles.linkButton} onClick={() => void choose()}>
      Choose another file…
    </button>
  );
  return (
    <div className={`${styles.group} ${data.card}`} role="group" aria-label="Import passwords">
      <Row label="Import passwords" description="A CSV file from another browser or password manager." control={step.at === 'preview' ? chooseAnother : null} />
      {step.at === 'reading' && (
        <p className={data.note} role="status">
          Reading the file…
        </p>
      )}
      {step.at === 'problem' && (
        <div className={data.actions}>
          <ProblemCard text={step.text} action={{ label: 'Choose another file…', run: () => void choose() }} />
        </div>
      )}
      {(step.at === 'preview' || step.at === 'writing') && (
        <ImportPreview
          preview={step.preview}
          name={step.name}
          take={take}
          onTake={setTake}
          writing={step.at === 'writing' ? { done: step.done, total: step.total } : null}
          first={first}
          onFirst={setFirst}
          problem={problem}
          onStart={() => void start()}
        />
      )}
      {step.at === 'done' && (
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>{resultText(step.result).title}</span>
            {(resultText(step.result).more || step.preview.issues.length > 0) && (
              <span className={styles.rowDescription}>
                {[resultText(step.result).more, step.preview.issues.length + step.preview.issuesMore > 0 ? `${leftOutTitle(step.preview.issues, step.preview.issuesMore)} stayed out.` : ''].filter(Boolean).join(' ')}
              </span>
            )}
          </div>
          <div className={styles.inlineControls}>
            {step.importId && (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  const importId = step.importId!;
                  void api.passwords.importUndo(importId).then((u) => u && setStep({ at: 'undone', text: undoneText(u) }));
                }}
              >
                Undo
              </button>
            )}
            {chooseAnother}
          </div>
        </div>
      )}
      {step.at === 'undone' && <Row label={step.text} control={chooseAnother} />}
    </div>
  );
}

function ImportPreview({
  preview,
  name,
  take,
  onTake,
  writing,
  first,
  onFirst,
  problem,
  onStart,
}: {
  preview: PasswordImportSummary;
  name: string;
  take: Set<number>;
  onTake(take: Set<number>): void;
  writing: { done: number; total: number } | null;
  first: PassphraseValue;
  onFirst(value: PassphraseValue): void;
  problem: string | null;
  onStart(): void;
}) {
  const ids = useId();
  const [reviewing, setReviewing] = useState(false);
  const [unlockProblem, setUnlockProblem] = useState<string | null>(null);
  const differ = preview.conflicts.length;
  const all = differ > 0 && take.size === differ;
  const disabled = writing !== null;
  const toggle = (at: number) => {
    const next = new Set(take);
    if (next.has(at)) next.delete(at);
    else next.add(at);
    onTake(next);
  };
  const switchText = all ? `All ${numbers.format(differ)}.` : take.size > 0 ? `${numbers.format(take.size)} of ${numbers.format(differ)}. The others keep yours.` : 'Off: yours stay as they are. Tick the ones to take.';
  return (
    <>
      {preview.problem ? (
        <div className={data.actions}>
          <ProblemCard
            text={
              preview.problem === 'url'
                ? 'This file has no address column (url, website or login_uri), so Chord can’t tell which site each password is for.'
                : preview.problem === 'password'
                  ? 'This file has no password column.'
                  : preview.problem === 'empty'
                    ? 'This file is empty.'
                    : 'Chord couldn’t read all of this file.'
            }
          />
        </div>
      ) : (
        <>
          <Row label="From" description={fromText(preview, name)} control={null} />
          <Row label="What comes in" description={comesInText(preview)} control={null} />
          {preview.state === 'locked' && (
            <div className={local.inset}>
              <PassphraseAsk
                text="Enter your passphrase to compare the file with your passwords."
                button="Unlock"
                problem={unlockProblem}
                onSubmit={(passphrase) => void api.passwords.unlock(passphrase).then((r) => setUnlockProblem(r.ok ? null : 'That isn’t the passphrase.'))}
              />
            </div>
          )}
          {preview.state === 'open' && differ > 0 && (
            <div className={`${styles.row} ${local.top}`}>
              <Switch label="Take the file’s where they differ" checked={all} disabled={disabled} describedBy={`${ids}-take`} onChange={(on) => onTake(new Set(on ? preview.conflicts.map((c) => c.at) : []))} />
              <div className={styles.rowText}>
                <span className={styles.rowLabel}>Take the file’s where they differ</span>
                <span id={`${ids}-take`} className={styles.rowDescription}>
                  {switchText}
                </span>
                {reviewing ? (
                  <ReviewAll preview={preview} take={take} disabled={disabled} onToggle={toggle} />
                ) : (
                  <ul className={local.lines} aria-label="Different from yours">
                    {preview.conflicts.slice(0, FOLDED).map((c) => (
                      <ConflictLine key={c.at} conflict={c} checked={take.has(c.at)} disabled={disabled} onToggle={toggle} />
                    ))}
                    {differ + preview.conflictsMore > FOLDED && (
                      <li className={local.line}>
                        <span className={local.grow}>{`and ${numbers.format(differ + preview.conflictsMore - FOLDED)} more`}</span>
                        <button type="button" className={local.tiny} onClick={() => setReviewing(true)}>
                          Review all
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>
          )}
          {preview.issues.length + preview.issuesMore > 0 && <LeftOut issues={preview.issues} more={preview.issuesMore} />}
        </>
      )}
      {preview.state === 'none' && !preview.problem && preview.logins > 0 && (
        <div className={local.inset}>
          <PassphraseStep value={first} onChange={onFirst} />
        </div>
      )}
      <div className={data.actions}>
        {[
          preview.otp ? `${plural(preview.otp, 'one-time-code secret')} in the file ${preview.otp === 1 ? 'was' : 'were'} ignored. Chord doesn’t keep codes.` : '',
          preview.duplicates ? `${plural(preview.duplicates, 'row')} repeated a password already in the file; the later one counts.` : '',
          preview.capped ? `${plural(preview.capped, 'row')} past the first ${numbers.format(50_000)} stayed out.` : '',
          preview.conflictsMore ? `${plural(preview.conflictsMore, 'more password')} differ than are listed: they keep yours unless the switch is on.` : '',
        ]
          .filter(Boolean)
          .map((line) => (
            <p key={line} className={data.small}>
              {line}
            </p>
          ))}
        {problem && (
          <p className={local.problem} role="alert">
            {problem}
          </p>
        )}
        {writing && (
          <ProgressLine
            label="Import"
            share={writing.total > 0 ? writing.done / writing.total : 0}
            now={writing.done}
            max={writing.total}
            going
            text={`Adding passwords: ${numbers.format(writing.done)} of ${numbers.format(writing.total)}`}
          />
        )}
        {!writing && !preview.problem && preview.state !== 'locked' && preview.added + preview.different > 0 && (
          <div className={data.buttons}>
            <button type="button" className={styles.linkButton} onClick={onStart}>
              Import
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function ConflictLine({
  conflict,
  checked,
  disabled,
  onToggle,
  top,
}: {
  conflict: PasswordImportSummary['conflicts'][number];
  checked: boolean;
  disabled: boolean;
  onToggle(at: number): void;
  /** In the virtual list: where it's placed. */
  top?: number;
}) {
  const what = conflict.what.join(', ');
  const label = `${hostOf(conflict.origin)}${conflict.realm ? ` (${conflict.realm})` : ''} · ${conflict.username || 'no username'}`;
  return (
    <li className={`${local.line} ${top !== undefined ? local.placed : ''}`} style={top !== undefined ? { insetBlockStart: top } : undefined}>
      <label className={local.check}>
        <input type="checkbox" checked={checked} disabled={disabled} aria-label={`Take the file’s for ${label}: its ${what} differs`} onChange={() => onToggle(conflict.at)} />
        <span className={local.grow}>{label}</span>
      </label>
      <span className={local.what}>{what}</span>
    </li>
  );
}

/** *Review all*: a search box over every one that differs, in a virtual list (only the lines in view are drawn). */
function ReviewAll({ preview, take, disabled, onToggle }: { preview: PasswordImportSummary; take: Set<number>; disabled: boolean; onToggle(at: number): void }) {
  const [query, setQuery] = useState('');
  const [top, setTop] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return words ? preview.conflicts.filter((c) => `${hostOf(c.origin)} ${c.username} ${c.realm ?? ''}`.toLowerCase().includes(words)) : preview.conflicts;
  }, [preview.conflicts, query]);
  const from = Math.max(0, Math.floor(top / LINE_PX) - 2);
  const to = Math.min(shown.length, from + LINES + 4);
  const total = preview.conflicts.length;
  return (
    <div className={local.review}>
      <label className={local.search}>
        <Search size={14} strokeWidth={2} aria-hidden />
        <input
          ref={field}
          className={local.searchInput}
          type="search"
          value={query}
          placeholder={`Search the ${numbers.format(total)}`}
          aria-label={`Search the ${numbers.format(total)} that differ`}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setTop(0);
          }}
        />
      </label>
      <div className={local.scroll} style={{ maxBlockSize: LINES * LINE_PX }} onScroll={(e) => setTop(e.currentTarget.scrollTop)} tabIndex={-1}>
        <ul className={local.virtual} style={{ blockSize: shown.length * LINE_PX }} aria-label="Different from yours">
          {shown.slice(from, to).map((c, i) => (
            <ConflictLine key={c.at} conflict={c} checked={take.has(c.at)} disabled={disabled} onToggle={onToggle} top={(from + i) * LINE_PX} />
          ))}
        </ul>
      </div>
      {query && <p className={data.small}>{shown.length === 0 ? `None match “${query.trim()}”.` : `${numbers.format(shown.length)} match.`}</p>}
    </div>
  );
}

/** *Left out*: each row with its number and why; past FOLDED, folded behind *Show*. */
function LeftOut({ issues, more }: { issues: readonly ImportIssue[]; more: number }) {
  const [open, setOpen] = useState(false);
  const n = issues.length + more;
  const title = leftOutTitle(issues, more);
  if (n > FOLDED && !open) {
    const rows = issues.slice(0, 3).map((i) => numbers.format(i.row));
    return (
      <Row
        label="Left out"
        description={`${title}: rows ${rows.join(', ')} and ${numbers.format(n - rows.length)} more.`}
        control={
          <button type="button" className={local.tiny} onClick={() => setOpen(true)}>
            Show
          </button>
        }
      />
    );
  }
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>Left out</span>
        <span className={styles.rowDescription}>{`${title}:`}</span>
        <ul className={`${local.lines} ${local.issues}`} aria-label="Rows left out">
          {issues.map((i) => (
            <li key={i.row} className={local.line}>
              <span className={local.grow}>{issueText(i)}</span>
            </li>
          ))}
          {more > 0 && <li className={local.line}>{`and ${numbers.format(more)} more`}</li>}
        </ul>
      </div>
    </div>
  );
}

/* ---------- Export ---------- */

type ExportStep =
  | { at: 'choosing' }
  /** The vault's passphrase, asked for at the save (S17 §7). */
  | { at: 'asking'; wrong: boolean }
  | { at: 'writing'; exportId: string | null }
  | { at: 'saved'; name: string; count: number; show(): void }
  | { at: 'problem'; text: string };

const EXPORT_PROBLEMS: Record<string, string> = {
  locked: 'Your passwords are locked. Unlock them first.',
  none: 'There are no passwords to export.',
  empty: 'There are no passwords to export.',
  busy: 'Chord is still writing your last export. Try again when it’s done.',
  io: 'Chord couldn’t save there. Choose another place.',
  write: 'Chord couldn’t save there. Choose another place.',
  read: 'Chord couldn’t read your passwords to write the file.',
};

/** The export card (option 2A): the kind, then the save, with the passphrase check there when it's due. */
export function ExportCard({ view }: { view: PasswordsView }) {
  const ids = useId();
  const [kind, setKind] = useState<'chord' | 'csv'>('chord');
  const [file, setFile] = useState<PassphraseValue>(EMPTY_PASSPHRASE);
  const [step, setStep] = useState<ExportStep>({ at: 'choosing' });
  const started = useRef<string | null>(null);

  useEffect(
    () =>
      api.exports.onProgress((p: ExportProgress) => {
        if (started.current === '') started.current = p.exportId;
        if (p.exportId !== started.current) return;
        if (p.phase === 'done') {
          setFile(EMPTY_PASSPHRASE);
          setStep({ at: 'saved', name: p.name, count: p.passwords ?? 0, show: () => void api.exports.show(p.exportId) });
        } else if (p.phase === 'failed') setStep({ at: 'problem', text: p.problem === 'locked' ? 'Your passwords locked while the file was written, so it wasn’t kept.' : (EXPORT_PROBLEMS[p.problem ?? 'write'] ?? EXPORT_PROBLEMS['write']!) });
      }),
    [],
  );

  const save = async (vaultPassphrase?: string) => {
    if (kind === 'chord' && !passphraseReady(file)) return setFile({ ...file, touched: true });
    if (kind === 'csv') {
      setStep({ at: 'writing', exportId: null });
      const result = await api.passwords.exportCsv(vaultPassphrase).catch(() => ({ ok: false, problem: 'io' }) as const);
      if (result.ok) return setStep({ at: 'saved', name: result.name, count: result.count, show: () => void api.passwords.exportShow(result.exportId) });
      if (result.problem === 'passphrase' || result.problem === 'wrong') return setStep({ at: 'asking', wrong: result.problem === 'wrong' });
      if (result.problem === 'cancelled') return setStep({ at: 'choosing' });
      return setStep({ at: 'problem', text: EXPORT_PROBLEMS[result.problem] ?? EXPORT_PROBLEMS['io']! });
    }
    started.current = '';
    setStep({ at: 'writing', exportId: null });
    const result = await api.exports
      .run({ history: false, assistant: false, passwords: true, only: 'passwords', passphrase: file.passphrase, ...(vaultPassphrase !== undefined ? { vaultPassphrase } : {}) })
      .catch(() => ({ ok: false, problem: 'cancelled' }) as const);
    if (result.ok) {
      started.current = result.exportId;
      return;
    }
    started.current = null;
    if (result.problem === 'passphrase' || result.problem === 'wrong') return setStep({ at: 'asking', wrong: result.problem === 'wrong' });
    if (result.problem === 'cancelled') return setStep({ at: 'choosing' });
    setStep({ at: 'problem', text: EXPORT_PROBLEMS[result.problem] ?? EXPORT_PROBLEMS['io']! });
  };

  if (step.at === 'saved') {
    return (
      <div className={`${styles.group} ${data.card}`} role="group" aria-label="Export passwords">
        <Row
          label={`Saved ${step.name}, ${passwords(step.count)}`}
          description={kind === 'csv' ? 'Delete it once you’ve imported it where you need it.' : 'Only Chord opens it, with the passphrase you chose for it.'}
          control={
            <button type="button" className={styles.linkButton} onClick={step.show}>
              Show in folder
            </button>
          }
        />
      </div>
    );
  }
  const writing = step.at === 'writing';
  return (
    <div className={`${styles.group} ${data.card}`} role="group" aria-label="Export passwords">
      <Row label="Export passwords" description={`${passwords(view.count)}, to keep or to bring somewhere else.`} control={null} />
      <RadioGroup label="Export as" className={local.kinds}>
        <button type="button" role="radio" aria-checked={kind === 'chord'} disabled={writing} className={`${styles.choice} ${local.kind}`} onClick={() => setKind('chord')} aria-describedby={`${ids}-chord`}>
          <span className={local.radio} aria-hidden />
          <span className={styles.rowText}>
            <span className={styles.rowLabel}>Chord file, encrypted</span>
            <span id={`${ids}-chord`} className={styles.rowDescription}>
              Only Chord opens it, with a passphrase you choose for it.
            </span>
          </span>
        </button>
        <button type="button" role="radio" aria-checked={kind === 'csv'} disabled={writing} className={`${styles.choice} ${local.kind}`} onClick={() => setKind('csv')} aria-describedby={`${ids}-csv ${ids}-warn`}>
          <span className={local.radio} aria-hidden />
          <span className={styles.rowText}>
            <span className={styles.rowLabel}>CSV</span>
            <span id={`${ids}-csv`} className={styles.rowDescription}>
              Every browser and password manager can import it.
            </span>
            <span id={`${ids}-warn`} className={local.warn}>
              <TriangleAlert size={14} strokeWidth={2} aria-hidden />
              Anyone with the file can read your passwords.
            </span>
          </span>
        </button>
      </RadioGroup>
      {kind === 'chord' && step.at !== 'asking' && (
        <div className={local.inset}>
          {/* The file's own passphrase, never the vault's (the owner's decision, S17). */}
          <PassphraseStep value={file} onChange={setFile} note="Chord can’t open the file without it, and can’t get it back for you." />
        </div>
      )}
      {step.at === 'asking' && (
        <div className={local.inset}>
          <PassphraseAsk
            text={kind === 'csv' ? 'Enter your passphrase to export your passwords.' : 'Enter the passphrase your passwords are locked with, to export them.'}
            button="Export"
            problem={step.wrong ? 'That isn’t the passphrase.' : null}
            onSubmit={(passphrase) => void save(passphrase)}
            onCancel={() => setStep({ at: 'choosing' })}
          />
        </div>
      )}
      <div className={data.actions}>
        {step.at === 'problem' && <ProblemCard text={step.text} />}
        {writing && <ProgressLine label="Export" share={0} now={0} max={1} going text="Writing your passwords…" />}
        {step.at !== 'asking' && (
          <div className={data.buttons}>
            <button type="button" className={styles.linkButton} disabled={writing} onClick={() => void save()}>
              Choose where to save…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
