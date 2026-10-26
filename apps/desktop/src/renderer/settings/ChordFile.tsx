/**
 * Settings → Your data → From a Chord file (docs/decisions/S15-your-data.md
 * §8; DESIGN.md §8.8): an export brought back, here or on another computer.
 * Choose the file (the system's open dialog), give its passphrase if it's
 * encrypted, then see what it would bring against what's here, with a switch
 * for each part beyond your setup, and import. Nothing here is removed, and
 * one Undo takes it all back. Main reads the file in a process of its own;
 * this page only says how it's going.
 */
import { importedText, type MergeCounts } from '@chord/core';
import type { FileImportChoices, FileImportPreview, FileImportProblem, FileImportProgress } from '@chord/ipc';
import { useEffect, useId, useRef, useState } from 'react';
import { plural, ProblemCard, ProgressLine } from '../shared/ImportPanel';
import { api } from './api';
import { Row, Switch } from './controls';
import styles from './Settings.module.css';
import local from './YourData.module.css';

/** "2 chords, 40 pinned tabs, 3 Favorites, Effects for 2 sites": a part that's zero is left out; Effects only when they'd come in. */
export function countsText(c: MergeCounts, effects: boolean): string {
  return [
    c.chords ? plural(c.chords, 'chord') : '',
    c.pinnedTabs ? plural(c.pinnedTabs, 'pinned tab') : '',
    c.todayTabs ? plural(c.todayTabs, 'Today tab') : '',
    c.folders ? plural(c.folders, 'folder') : '',
    c.favorites ? plural(c.favorites, 'Favorite') : '',
    c.themes ? plural(c.themes, 'theme') : '',
    c.routes ? plural(c.routes, 'link route') : '',
    effects && c.effects ? `Effects for ${plural(c.effects, 'site')}` : '',
    c.zoom ? `page zoom for ${plural(c.zoom, 'site')}` : '',
    c.blocks ? `blocked permissions for ${plural(c.blocks, 'site')}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** "New: 2 chords, 40 pinned tabs. Newer than yours: 5 tabs. Everything else is here already." */
export function whatComesIn(preview: FileImportPreview, effects: boolean): string {
  const fresh = countsText(preview.counts.new, effects);
  const newer = countsText(preview.counts.newer, effects);
  const parts = [fresh ? `New: ${fresh}.` : '', newer ? `Newer than yours: ${newer}.` : ''].filter(Boolean);
  if (parts.length === 0) return 'Your setup has everything in this file already.';
  if (preview.newProfile && preview.counts.new.chords > 0) parts.push('The chord Chord started with makes way.');
  else parts.push('Everything else is here already.');
  return parts.join(' ');
}

/** "From this computer, exported Nov 30, 2026." */
export function fromText(preview: FileImportPreview): string {
  const when = preview.created ? new Date(preview.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const from = preview.thisComputer ? 'From this computer' : 'From another computer';
  return `${from}${when ? `, exported ${when}` : ''}${preview.app ? ` by Chord ${preview.app}` : ''}.`;
}

/** "nytimes.com, github.com and 3 more". */
export function sitesText(sites: readonly { host: string }[], shown = 8): string {
  const hosts = sites.map((s) => s.host);
  if (hosts.length <= shown) return hosts.length > 1 ? `${hosts.slice(0, -1).join(', ')} and ${hosts.at(-1)}` : (hosts[0] ?? '');
  return `${hosts.slice(0, shown).join(', ')} and ${hosts.length - shown} more`;
}

/** What the line under the bar says. */
export function importText(p: FileImportProgress): string {
  switch (p.phase) {
    case 'setup':
      return 'Adding your setup…';
    case 'history':
      return `Adding history: ${new Intl.NumberFormat('en-US').format(p.done)} of ${plural(p.total, 'page')}`;
    case 'duet':
      return 'Adding Duet chats…';
    case 'done':
      return `${importedText(p.counts)}.`;
    case 'failed':
      return `${importedText(p.counts)}, but Chord couldn’t import all of it.`;
    case 'undone':
      return 'Import undone.';
  }
}

const PROBLEMS: Record<Exclude<FileImportProblem, 'needs-passphrase'>, string> = {
  'not-chord': 'That isn’t a Chord file.',
  newer: 'This file is from a newer Chord. Update Chord to import it.',
  'wrong-passphrase': 'That passphrase doesn’t open this file.',
  unreadable: 'Chord couldn’t read that file.',
  missing: 'That file isn’t open any more. Choose it again.',
  busy: 'Another import is still running. Try again when it’s done.',
};

type Step =
  | { at: 'idle' }
  | { at: 'reading'; fileId: string; name: string; unlocking: boolean }
  | { at: 'locked'; fileId: string; name: string }
  | { at: 'problem'; fileId: string | null; name: string; problem: Exclude<FileImportProblem, 'needs-passphrase'> }
  | { at: 'preview'; preview: FileImportPreview };

/** The row, and the card under it once a file is chosen. `onUpdates` goes to where updates are checked. */
export function FromChordFile({ onUpdates }: { onUpdates(): void }) {
  const ids = useId();
  const [step, setStep] = useState<Step>({ at: 'idle' });
  const [passphrase, setPassphrase] = useState('');
  const [choices, setChoices] = useState<FileImportChoices | null>(null);
  const [progress, setProgress] = useState<FileImportProgress | null>(null);
  /** The import this card started: '' while it starts, since its first steps can come before `run` answers. */
  const started = useRef<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      api.files.onProgress((p) => {
        if (started.current === '') started.current = p.importId;
        if (p.importId === started.current) setProgress(p);
      }),
    [],
  );

  /** Each read's number: a slow read of a file you've since moved off is dropped. */
  const reads = useRef(0);
  const going = Boolean(progress && progress.phase !== 'done' && progress.phase !== 'failed' && progress.phase !== 'undone');
  const read = async (fileId: string, name: string, key: string | null) => {
    const n = ++reads.current;
    setStep({ at: 'reading', fileId, name, unlocking: key !== null });
    const result = await api.files.open(fileId, key).catch(() => ({ ok: false, problem: 'unreadable' }) as const);
    // The passphrase isn't kept once it's been tried.
    setPassphrase('');
    if (n !== reads.current) return;
    if (result.ok) {
      const { preview } = result;
      setChoices({ history: preview.history.pages > 0, duet: preview.duet.chats > 0, effects: preview.effects.length > 0, settings: preview.newProfile });
      setStep({ at: 'preview', preview });
    } else if (result.problem === 'needs-passphrase') setStep({ at: 'locked', fileId, name });
    else setStep({ at: 'problem', fileId, name, problem: result.problem });
  };
  const choose = async () => {
    const result = await api.files.choose().catch(() => ({ ok: false, problem: 'cancelled' }) as const);
    if (!result.ok) {
      if (result.problem === 'busy') setStep({ at: 'problem', fileId: null, name: '', problem: 'busy' });
      return;
    }
    started.current = null;
    setProgress(null);
    setChoices(null);
    await read(result.fileId, result.name, null);
  };
  const start = async () => {
    if (step.at !== 'preview' || !choices || started.current !== null) return;
    started.current = '';
    const result = await api.files.run(step.preview.fileId, choices).catch(() => ({ ok: false, problem: 'missing' }) as const);
    if (result.ok) started.current = result.importId;
    else {
      started.current = null;
      setStep({ at: 'problem', fileId: null, name: step.preview.name, problem: result.problem });
    }
  };
  useEffect(() => {
    if (step.at === 'locked') field.current?.focus();
  }, [step]);

  const chooseButton = (label: string) => (
    <button type="button" className={styles.linkButton} disabled={going} onClick={() => void choose()}>
      {label}
    </button>
  );
  return (
    <div className={styles.group}>
      <Row label="From a Chord file" description="Bring back an export, here or on another computer. Nothing here is removed." control={chooseButton('Choose a file…')} />
      {step.at !== 'idle' && (
        <div id={`${ids}-card`} className={local.card} role="group" aria-label="From a Chord file">
          {step.at === 'reading' && (
            <p className={local.note} role="status">
              {step.unlocking ? `Opening ${step.name}…` : `Reading ${step.name}…`}
            </p>
          )}
          {step.at === 'locked' && (
            <form
              className={local.fields}
              onSubmit={(e) => {
                e.preventDefault();
                if (passphrase) void read(step.fileId, step.name, passphrase);
              }}
            >
              <p className={`${styles.rowDescription} ${local.span}`}>This file is encrypted. Enter its passphrase.</p>
              <label className={local.field}>
                <span className={styles.rowLabel}>Passphrase</span>
                <input
                  ref={field}
                  className={`${styles.siteInput} ${local.input}`}
                  type="password"
                  value={passphrase}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </label>
              <div className={local.suggest}>
                <button type="submit" className={styles.linkButton} disabled={!passphrase}>
                  Open
                </button>
              </div>
            </form>
          )}
          {step.at === 'problem' && (
            <div className={local.actions}>
              {step.problem === 'wrong-passphrase' && step.fileId ? (
                <ProblemCard text={PROBLEMS[step.problem]} action={{ label: 'Try again', run: () => setStep({ at: 'locked', fileId: step.fileId!, name: step.name }) }} />
              ) : step.problem === 'newer' ? (
                <ProblemCard text={PROBLEMS[step.problem]} action={{ label: 'Check for updates', run: onUpdates }} />
              ) : step.problem === 'busy' ? (
                <ProblemCard text={PROBLEMS[step.problem]} />
              ) : (
                <ProblemCard text={PROBLEMS[step.problem]} action={{ label: 'Choose another file…', run: () => void choose() }} />
              )}
            </div>
          )}
          {step.at === 'preview' && choices && <Preview preview={step.preview} choices={choices} onChoose={setChoices} progress={progress} onStart={() => void start()} onChooseAnother={() => void choose()} />}
        </div>
      )}
    </div>
  );
}

function Preview({
  preview,
  choices,
  onChoose,
  progress,
  onStart,
  onChooseAnother,
}: {
  preview: FileImportPreview;
  choices: FileImportChoices;
  onChoose(choices: FileImportChoices): void;
  progress: FileImportProgress | null;
  onStart(): void;
  onChooseAnother(): void;
}) {
  const changesId = useId();
  const locked = progress !== null;
  const set = (key: keyof FileImportChoices) => (value: boolean) => !locked && onChoose({ ...choices, [key]: value });
  const { history, duet } = preview;
  // Every page here already can still bring visits Chord doesn't have.
  const pages =
    history.pages === 0 ? '' : history.newPages > 0 ? `${plural(history.newPages, 'new page')}, for search in every chord` : `${plural(history.pages, 'page')}, all visited here too. Only visits Chord doesn’t have come in.`;
  const chats = duet.newChats > 0 ? `${plural(duet.newChats, 'new chat')}${duet.images ? `, ${plural(duet.images, 'image')}` : ''}. Nothing is sent anywhere until you write in one.` : `${plural(duet.chats, 'chat')}, all here already`;
  const finished = progress?.phase === 'done' || progress?.phase === 'failed';
  const readable = countsText(sum(preview.counts.new, preview.counts.newer), false);
  return (
    <>
      <Row label="From" description={fromText(preview)} control={null} />
      <Row label="What comes in" description={whatComesIn(preview, choices.effects)} control={null} />
      {pages && <Row label="History" description={pages} control={<Switch label="Import history" checked={choices.history} onChange={set('history')} />} />}
      {duet.chats > 0 && <Row label="Duet chats" description={chats} control={<Switch label="Import Duet chats" checked={choices.duet} onChange={set('duet')} />} />}
      {preview.effects.length > 0 && (
        <Row
          label="Effects"
          description={`${sitesText(preview.effects)}. Chord checks every stylesheet again before it uses it.`}
          control={<Switch label="Import Effects" checked={choices.effects} onChange={set('effects')} />}
        />
      )}
      {preview.settings.length > 0 && (
        <>
          <Row
            label="Settings from the file"
            description={choices.settings ? `${plural(preview.settings.length, 'change')}:` : `Off: yours stay as they are. ${plural(preview.settings.length, 'change')} if you turn it on:`}
            control={<Switch label="Import settings from the file" checked={choices.settings} onChange={set('settings')} describedBy={changesId} />}
          />
          <ul id={changesId} className={local.changes} aria-label="What the file’s settings change">
            {preview.settings.map((c) => (
              <li key={c.field}>{`${c.label}: ${c.from} → ${c.to}`}</li>
            ))}
          </ul>
        </>
      )}
      <div className={local.actions}>
        <p className={local.small}>Tabs stay unloaded until you open them. Sites you’d allowed to use your camera, microphone or location ask again.</p>
        {preview.skipped > 0 && <p className={local.small}>{`${plural(preview.skipped, 'item')} from a newer Chord will be skipped.`}</p>}
        {progress && <ProgressLine label="Import" share={progress.phase === 'history' && progress.total > 0 ? progress.done / progress.total : progress.phase === 'setup' ? 0 : 1} now={progress.done} max={progress.total} going={!finished && progress.phase !== 'undone'} text={importText(progress)} />}
        {!progress && preview.damaged && (
          <ProblemCard text={`Part of this file is damaged. Chord can bring in what it read${readable ? `: ${readable}` : ''}.`} action={{ label: 'Import what’s readable', run: onStart }} />
        )}
        <div className={local.buttons}>
          {!progress && !preview.damaged && (
            <button type="button" className={styles.linkButton} onClick={onStart}>
              Import
            </button>
          )}
          {finished && (
            <button type="button" className={styles.linkButton} onClick={() => void api.files.undo(progress.importId)}>
              Undo
            </button>
          )}
          {(finished || progress?.phase === 'undone') && (
            <button type="button" className={styles.linkButton} onClick={onChooseAnother}>
              Choose another file…
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** Two counts added up: what a damaged file can still bring, new or newer. */
function sum(a: MergeCounts, b: MergeCounts): MergeCounts {
  const out = { ...a };
  for (const key of Object.keys(out) as (keyof MergeCounts)[]) out[key] += b[key];
  return out;
}
