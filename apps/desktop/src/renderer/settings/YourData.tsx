/**
 * Settings → Your data (docs/decisions/S15-your-data.md §8; DESIGN.md §8.8):
 * everything in Chord in one file you can keep, read or bring to another
 * computer, and what comes in: a Chord file (ChordFile.tsx), or another
 * browser's bookmarks and history. Main asks where to save with the system's
 * dialog and a process of its own writes the file; this page only says how
 * it's going.
 */
import { passphraseProblem, suggestPassphrase, type ExportCounts } from '@chord/core';
import type { ExportProgress, SettingsSnapshot, SystemInfo } from '@chord/ipc';
import { useEffect, useId, useRef, useState } from 'react';
import { plural, ProblemCard, ProgressLine } from '../shared/ImportPanel';
import { api } from './api';
import { Row, SectionHeader, Switch } from './controls';
import { exportText } from './export-text';
import { PassphraseAsk } from './Passwords';
import { FromChordFile } from './ChordFile';
import { FromAnotherBrowser } from './Import';
import { SyncSection } from './Sync';
import styles from './Settings.module.css';
import local from './YourData.module.css';

const numbers = new Intl.NumberFormat('en-US');

export { exportText, fileSize } from './export-text';

/** "6 chords · 214 pinned tabs in 18 folders · 31 Today tabs · … · your settings." */
export function whatGoesIn(c: ExportCounts): string {
  const parts = [
    plural(c.chords, 'chord'),
    c.pinnedTabs ? `${plural(c.pinnedTabs, 'pinned tab')}${c.folders ? ` in ${plural(c.folders, 'folder')}` : ''}` : '',
    c.todayTabs ? plural(c.todayTabs, 'unpinned tab') : '',
    c.favorites ? plural(c.favorites, 'Favorite') : '',
    c.themes ? plural(c.themes, 'theme') : '',
    c.routes ? plural(c.routes, 'link route') : '',
    c.effects ? `Effects for ${plural(c.effects, 'site')}` : '',
    'your settings',
  ].filter(Boolean);
  return `${parts.join(' · ')}.`;
}

/** The Export row, and the card under it once it's opened. */
function Export({ snapshot }: { snapshot: SettingsSnapshot }) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<ExportCounts | null>(null);
  const [history, setHistory] = useState(true);
  const [assistant, setAssistant] = useState(true);
  /** Passwords (S17 decision 6): only into an encrypted file, on to start with; how many there are, counted without the key. */
  const [withPasswords, setWithPasswords] = useState(true);
  const [passwordCount, setPasswordCount] = useState(0);
  /** The vault's passphrase, asked for at the save when it wasn't typed in the last 5 minutes (as *Show* asks). */
  const [vaultAsk, setVaultAsk] = useState<'ask' | 'wrong' | 'locked' | 'same' | null>(null);
  const encrypt = snapshot.settings.encryptExports;
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  /** Suggest one shows what it chose, so it can be written down; typing hides it again. */
  const [shown, setShown] = useState(false);
  const [touched, setTouched] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [busy, setBusy] = useState(false);
  /** The export this card started: '' while it starts, since its first steps can come before `run` answers. */
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (open) void api.exports.counts().then(setCounts);
    // Counted without the key: opening the vault (with the key kept here) would restart *Lock after* just to count.
    if (open) void api.passwords.count().then(setPasswordCount);
  }, [open]);
  useEffect(
    () =>
      api.exports.onProgress((p) => {
        if (started.current === '') started.current = p.exportId;
        if (p.exportId !== started.current) return;
        setProgress(p);
        // The passphrase isn't kept once the file is written.
        if (p.phase === 'done') {
          setPassphrase('');
          setRepeat('');
          setShown(false);
          setTouched(false);
        }
      }),
    [],
  );

  const writing = Boolean(progress && progress.phase !== 'done' && progress.phase !== 'failed');
  const lengthProblem = passphraseProblem(passphrase);
  const mismatch = repeat !== passphrase;
  const ready = !writing && (!encrypt || (!lengthProblem && !mismatch));
  const bringPasswords = encrypt && withPasswords && passwordCount > 0;
  const save = async (vaultPassphrase?: string) => {
    if (!ready) return setTouched(true);
    setBusy(false);
    started.current = '';
    const result = await api.exports
      .run({ history, assistant, passphrase: encrypt ? passphrase : null, ...(bringPasswords ? { passwords: true } : {}), ...(bringPasswords && vaultPassphrase !== undefined ? { vaultPassphrase } : {}) })
      .catch(() => ({ ok: false, problem: 'cancelled' }) as const);
    setVaultAsk(null);
    if (!result.ok && (result.problem === 'passphrase' || result.problem === 'wrong' || result.problem === 'locked' || result.problem === 'vault-passphrase')) {
      started.current = null;
      return setVaultAsk(result.problem === 'passphrase' ? 'ask' : result.problem === 'vault-passphrase' ? 'same' : result.problem);
    }
    if (result.ok) {
      started.current = result.exportId;
      setProgress((p) => (p?.exportId === result.exportId ? p : { exportId: result.exportId, phase: encrypt ? 'key' : 'setup', done: 0, total: 0, share: 0, name: result.name }));
    } else {
      started.current = null;
      setBusy(result.problem === 'busy');
    }
  };
  const suggest = () => {
    const words = suggestPassphrase();
    setPassphrase(words);
    setRepeat(words);
    setShown(true);
  };
  const type = (set: (value: string) => void) => (value: string) => {
    set(value);
    setShown(false);
  };

  const chats = counts ? (counts.chats ? `${plural(counts.chats, 'chat')}${counts.images ? `, ${plural(counts.images, 'image')}` : ''}` : 'No chats yet') : '';
  const saveButton = (
    <button type="button" className={styles.linkButton} disabled={writing || (encrypt && touched && !ready)} onClick={() => void save()}>
      Choose where to save…
    </button>
  );
  return (
    <div className={styles.group}>
      <Row
        label="Export your data"
        description="Everything in Chord in one file you can keep, read, or bring to another computer."
        control={
          <button type="button" className={styles.linkButton} aria-expanded={open} aria-controls={open ? `${ids}-card` : undefined} onClick={() => setOpen(!open)}>
            Export…
          </button>
        }
      />
      {open && (
        <div id={`${ids}-card`} className={local.card} role="group" aria-label="Export your data">
          <Row label="What goes in" description={counts ? whatGoesIn(counts) : 'Counting…'} control={null} />
          <Row
            label="History"
            description={counts ? (counts.pages ? plural(counts.pages, 'page') : 'No history yet') : ''}
            control={<Switch label="Include history" checked={history} onChange={setHistory} />}
          />
          <Row label="Assistant chats" description={chats} control={<Switch label="Include assistant chats" checked={assistant} onChange={setAssistant} />} />
          {passwordCount > 0 && (
            <Row
              label="Passwords"
              description={encrypt ? `${plural(passwordCount, 'password')}, locked in the file with its passphrase.` : `A plain file leaves passwords out. Encrypt it with a passphrase to bring your ${numbers.format(passwordCount)}.`}
              control={<Switch label="Include passwords" checked={encrypt && withPasswords} disabled={!encrypt} onChange={setWithPasswords} />}
            />
          )}
          <Row
            label="Encrypt with a passphrase"
            description={encrypt ? 'Chord can’t open the file without it, and can’t get it back for you.' : history || assistant ? 'Anyone with the file can read it.' : undefined}
            control={<Switch label="Encrypt with a passphrase" checked={encrypt} onChange={(encryptExports) => void api.settings.set({ encryptExports })} />}
          />
          {encrypt && (
            <div className={local.fields}>
              <label className={local.field}>
                <span className={styles.rowLabel}>Passphrase</span>
                <input
                  className={`${styles.siteInput} ${local.input}`}
                  type={shown ? 'text' : 'password'}
                  value={passphrase}
                  autoComplete="new-password"
                  spellCheck={false}
                  aria-invalid={(touched && Boolean(lengthProblem)) || undefined}
                  aria-describedby={touched && lengthProblem ? `${ids}-length` : undefined}
                  onChange={(e) => type(setPassphrase)(e.target.value)}
                  onBlur={() => passphrase && setTouched(true)}
                />
              </label>
              {touched && lengthProblem && (
                <span id={`${ids}-length`} className={local.problem}>
                  {lengthProblem}
                </span>
              )}
              <label className={local.field}>
                <span className={styles.rowLabel}>Again</span>
                <input
                  className={`${styles.siteInput} ${local.input}`}
                  type={shown ? 'text' : 'password'}
                  value={repeat}
                  autoComplete="new-password"
                  spellCheck={false}
                  aria-invalid={(touched && mismatch) || undefined}
                  aria-describedby={touched && mismatch ? `${ids}-match` : undefined}
                  onChange={(e) => type(setRepeat)(e.target.value)}
                  onBlur={() => repeat && setTouched(true)}
                />
              </label>
              {touched && mismatch && !lengthProblem && (
                <span id={`${ids}-match`} className={local.problem}>
                  The two don’t match.
                </span>
              )}
              <div className={local.suggest}>
                <button type="button" className={styles.linkButton} onClick={suggest}>
                  Suggest one
                </button>
                {shown && <span className={styles.rowDescription}>Five words at random. Write them down, or keep them in your password manager.</span>}
              </div>
            </div>
          )}
          {vaultAsk && (
            <div className={local.actions}>
              {vaultAsk === 'same' ? (
                <ProblemCard text="Use a different passphrase from the one your passwords are locked with." />
              ) : vaultAsk === 'locked' ? (
                <ProblemCard text="Your passwords are locked. Unlock them in Settings → Passwords, or turn Passwords off here." />
              ) : (
                <PassphraseAsk
                  text="Enter the passphrase your passwords are locked with, to put them in the file."
                  button="Export"
                  problem={vaultAsk === 'wrong' ? 'That isn’t the passphrase.' : null}
                  onSubmit={(typed) => void save(typed)}
                  onCancel={() => setVaultAsk(null)}
                />
              )}
            </div>
          )}
          <div className={local.actions}>
            {busy && <ProblemCard text="Chord is still writing your last export. Try again when it’s done." />}
            {progress?.phase === 'failed' ? (
              <ProblemCard text={exportText(progress)} action={{ label: 'Choose where to save…', run: () => void save() }} />
            ) : (
              progress && (
                <ProgressLine label="Export" share={progress.share} now={Math.round(progress.share * 100)} max={100} going={writing} text={exportText(progress)} />
              )
            )}
            <div className={local.buttons}>
              {progress?.phase === 'done' && (
                <button type="button" className={styles.linkButton} onClick={() => void api.exports.show(progress.exportId)}>
                  Show in folder
                </button>
              )}
              {progress?.phase !== 'failed' && saveButton}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function YourDataSection({ snapshot, info, onUpdates }: { snapshot: SettingsSnapshot; info: SystemInfo; onUpdates(): void }) {
  return (
    <>
      <SectionHeader title="Your data" description="Take everything in Chord with you in one file, bring in what you had in another browser, or keep your setup the same on each of your computers." />
      <h2 className={styles.groupTitle}>Export</h2>
      <Export snapshot={snapshot} />
      <h2 className={styles.groupTitle}>Import</h2>
      <FromChordFile onUpdates={onUpdates} />
      <FromAnotherBrowser snapshot={snapshot} info={info} />
      <h2 className={styles.groupTitle}>Sync</h2>
      <SyncSection onUpdates={onUpdates} />
    </>
  );
}
