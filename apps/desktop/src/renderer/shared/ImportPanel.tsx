/**
 * Import from another browser (DESIGN.md §8.7): pick a browser, see what it
 * holds, say where each top-level folder goes (a new chord named after it, a
 * chord you have, or Favorites for the bookmarks bar's own links), and watch
 * it come in. First run's step and Settings → Your data share it; each puts its
 * own buttons around it. Main does the reading, off main's own thread.
 */
import { IMPORT_BROWSER_NAMES, type ImportChoices, type ImportTarget } from '@chord/core';
import type { ImportApi, ImportProblem, ImportProgress, ImportSource, ImportSummary } from '@chord/ipc';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoving } from './a11y';
import styles from './ImportPanel.module.css';

export interface ImportChordOption {
  id: string;
  name: string;
  icon: string;
}

export interface ImportFlow {
  /** Null while Chord looks. */
  sources: ImportSource[] | null;
  source: ImportSource | null;
  reading: boolean;
  summary: ImportSummary | null;
  problem: ImportProblem | null;
  choices: ImportChoices | null;
  progress: ImportProgress | null;
  /** Ready to import: read, nothing wrong, not started. */
  ready: boolean;
  pick(key: string): void;
  choose(update: (choices: ImportChoices) => ImportChoices): void;
  start(): Promise<void>;
  undo(): void;
  /** Back to the list, for another import. */
  reset(): void;
}

const numbers = new Intl.NumberFormat('en-US');
export const plural = (n: number, one: string, many = `${one}s`) => `${numbers.format(n)} ${n === 1 ? one : many}`;

/**
 * The import's state, start to finish. With `autoPick`, the first browser
 * Chord can read is chosen as soon as it's found (first run starts there).
 */
export function useImport(api: ImportApi, { autoPick = false }: { autoPick?: boolean } = {}): ImportFlow {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [problem, setProblem] = useState<ImportProblem | null>(null);
  const [choices, setChoices] = useState<ImportChoices | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  /**
   * The import this view started: '' while it starts, since main reports its
   * first steps (all of them, for a small one) before `run` answers with its id.
   */
  const started = useRef<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** Each read's number: a slow read of a browser you've since moved off is dropped. */
  const reads = useRef(0);

  const pick = useCallback(
    (next: string) => {
      const read = ++reads.current;
      setKey(next);
      setSummary(null);
      setChoices(null);
      setProblem(null);
      setProgress(null);
      started.current = null;
      setStarting(false);
      const source = sources?.find((s) => s.key === next);
      if (source?.denied) {
        setReading(false);
        setProblem('denied');
        return;
      }
      setReading(true);
      void api.preview(next).then((result) => {
        if (read !== reads.current) return;
        setReading(false);
        if (!result.ok) return setProblem(result.problem);
        setSummary(result.summary);
        setChoices(result.summary.choices);
      });
    },
    [api, sources],
  );

  useEffect(() => {
    let live = true;
    void api.sources().then((found) => live && setSources(found));
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    if (!autoPick || !sources || key) return;
    const first = sources.find((s) => !s.denied) ?? sources[0];
    if (first) pick(first.key);
  }, [autoPick, sources, key, pick]);
  useEffect(
    () =>
      api.onProgress((p) => {
        if (started.current === '') started.current = p.importId;
        if (p.importId === started.current) setProgress(p);
      }),
    [api],
  );

  const start = async () => {
    if (!key || !choices || started.current !== null) return;
    started.current = '';
    setStarting(true);
    const result = await api.run(key, choices).catch(() => ({ ok: false, problem: 'unreadable' }) as const);
    if (!result.ok) {
      started.current = null;
      setStarting(false);
      return setProblem(result.problem);
    }
    started.current = result.importId;
  };
  return {
    sources,
    source: sources?.find((s) => s.key === key) ?? null,
    reading,
    summary,
    problem,
    choices,
    progress,
    ready: Boolean(summary && choices && !problem && !progress && !starting),
    pick,
    choose: (update) => setChoices((current) => (current ? update(current) : current)),
    start,
    undo: () => {
      if (started.current) void api.undo(started.current);
    },
    reset: () => {
      reads.current++;
      setReading(false);
      setKey(null);
      setSummary(null);
      setChoices(null);
      setProblem(null);
      setProgress(null);
      started.current = null;
      setStarting(false);
    },
  };
}

const PROBLEMS: Record<ImportProblem, (browser: string) => string> = {
  denied: () => 'Chord needs Full Disk Access to read Safari. In System Settings, open Privacy & Security, then Full Disk Access, turn on Chord, and quit and reopen Chord.',
  locked: (browser) => `${browser} is holding its files. Quit ${browser}, then try again.`,
  unreadable: (browser) => `Chord couldn’t read ${browser}’s files.`,
  missing: () => 'That browser profile isn’t there any more.',
  busy: () => 'Another import is still running. Try again when it’s done.',
};

/** What the progress line says. */
export function progressText(progress: ImportProgress): string {
  switch (progress.phase) {
    case 'bookmarks':
      return 'Adding bookmarks and tabs…';
    case 'history':
      return `Adding history: ${numbers.format(progress.done)} of ${plural(progress.total, 'page')}`;
    case 'undone':
      return 'Import undone.';
    case 'failed': {
      const what = imported(progress);
      return what ? `${what.slice(0, -1)}, but Chord couldn’t read all of it.` : 'Chord couldn’t import from this browser.';
    }
    case 'done':
      return imported(progress) ?? 'Nothing to import.';
  }
}

/** "Imported 6 tabs, 1,204 bookmarks and 34,551 pages of history.", or null when nothing came across. */
function imported({ counts }: ImportProgress): string | null {
  const bookmarks = counts.bookmarks + counts.favorites;
  const parts = [counts.tabs ? plural(counts.tabs, 'tab') : '', bookmarks ? plural(bookmarks, 'bookmark') : '', counts.pages ? `${plural(counts.pages, 'page')} of history` : ''].filter(Boolean);
  return parts.length === 0 ? null : `Imported ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`}.`;
}

/** The browsers found, as a radio group: one Tab stop, arrow keys choose. */
export function ImportSources({ flow, label = 'Import from' }: { flow: ImportFlow; label?: string }) {
  const roving = useRoving<HTMLDivElement>({ items: '[role="radio"]', current: '[aria-checked="true"]', activate: true });
  if (!flow.sources) return <p className={styles.note}>Looking for other browsers…</p>;
  return (
    <div ref={roving.ref} className={styles.sources} role="radiogroup" aria-label={label} onKeyDown={roving.onKeyDown}>
      {flow.sources.map((s) => (
        <button
          key={s.key}
          type="button"
          role="radio"
          aria-checked={flow.source?.key === s.key}
          className={styles.source}
          disabled={Boolean(flow.progress && flow.progress.phase !== 'done' && flow.progress.phase !== 'failed' && flow.progress.phase !== 'undone')}
          onClick={() => flow.source?.key !== s.key && flow.pick(s.key)}
        >
          <span className={styles.sourceName}>{s.label}</span>
          {s.denied && <span className={styles.sourceNote}>Needs Full Disk Access</span>}
        </button>
      ))}
    </div>
  );
}

/** A group's choices: Favorites (the bar's own links), a new chord, a chord you have, or nowhere. */
function TargetSelect({ label, value, options, onChange, disabled }: { label: string; value: ImportTarget; options: { value: ImportTarget; label: string }[]; onChange(value: ImportTarget): void; disabled: boolean }) {
  return (
    <select className={styles.select} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ImportTarget)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * What the chosen browser holds and where it goes, then how the import is
 * going; or why it can't be read, with a way on: `onOpenAccess` for Safari's
 * Full Disk Access, or reading it again (after quitting the browser).
 */
export function ImportDetails({ flow, chords, onOpenAccess }: { flow: ImportFlow; chords: ImportChordOption[]; onOpenAccess(): void }) {
  const browser = flow.source ? IMPORT_BROWSER_NAMES[flow.source.browser] : '';
  const { summary, choices, progress } = flow;
  const locked = Boolean(progress);
  const chordOptions = chords.map((c) => ({ value: `chord:${c.id}` as ImportTarget, label: `${c.icon}  ${c.name}`.trim() }));
  const skip = { value: 'skip' as ImportTarget, label: 'Don’t import' };

  if (flow.reading) return <p className={styles.note} role="status">{`Reading ${browser}…`}</p>;
  if (flow.problem) {
    return (
      <div className={styles.problem} role="status">
        <p>{PROBLEMS[flow.problem](browser)}</p>
        {flow.problem === 'denied' && (
          <button type="button" className={styles.button} onClick={onOpenAccess}>
            Open System Settings
          </button>
        )}
        {(flow.problem === 'locked' || flow.problem === 'unreadable' || flow.problem === 'busy') && flow.source && (
          <button type="button" className={styles.button} onClick={() => flow.pick(flow.source!.key)}>
            Try again
          </button>
        )}
      </div>
    );
  }
  if (!summary || !choices) return null;

  const counts = [
    summary.bookmarks > 0 ? `${plural(summary.bookmarks, 'bookmark')}${summary.folders > 0 ? ` in ${plural(summary.folders, 'folder')}` : ''}` : 'No bookmarks',
    summary.history > 0 ? `${plural(summary.history, 'page')} of history` : '',
    summary.tabs ? plural(summary.tabs, 'open tab') : '',
  ].filter(Boolean);
  return (
    <div className={styles.details}>
      <p className={styles.counts}>{counts.join(' · ')}</p>
      {summary.tabs === null && <p className={styles.note}>{`Open tabs stay in ${browser}: Chord can’t read them reliably.`}</p>}
      <ul className={styles.groups} aria-label="Where they go">
        {summary.groups.map((group) => {
          const options = [
            ...(group.kind === 'bar' ? [{ value: 'favorites' as ImportTarget, label: 'Favorites' }] : []),
            { value: 'new' as ImportTarget, label: `New chord “${group.title}”` },
            ...chordOptions,
            skip,
          ];
          return (
            <li key={group.id} className={styles.group}>
              <span className={styles.groupText}>
                <span className={styles.groupTitle}>{group.title}</span>
                <span className={styles.groupCount}>{group.kind === 'folder' ? plural(group.links, 'bookmark') : `${plural(group.links, 'link')} of its own`}</span>
              </span>
              <TargetSelect
                label={`Where ${group.title} goes`}
                value={choices.groups[group.id] ?? 'skip'}
                options={options}
                disabled={locked}
                onChange={(value) => flow.choose((c) => ({ ...c, groups: { ...c.groups, [group.id]: value } }))}
              />
            </li>
          );
        })}
        {summary.tabs ? (
          <li className={styles.group}>
            <span className={styles.groupText}>
              <span className={styles.groupTitle}>Open tabs</span>
              <span className={styles.groupCount}>{`${plural(summary.tabs, 'tab')}, into Today`}</span>
            </span>
            <TargetSelect label="Where open tabs go" value={choices.tabs} options={[...chordOptions, skip]} disabled={locked} onChange={(tabs) => flow.choose((c) => ({ ...c, tabs }))} />
          </li>
        ) : null}
        {summary.history > 0 && (
          <li className={styles.group}>
            <span className={styles.groupText}>
              <span className={styles.groupTitle}>History</span>
              <span className={styles.groupCount}>{`${plural(summary.history, 'page')}, for search in every chord`}</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={choices.history}
              aria-label="Import history"
              className={styles.switch}
              disabled={locked}
              onClick={() => flow.choose((c) => ({ ...c, history: !c.history }))}
            >
              <span className={styles.knob} />
            </button>
          </li>
        )}
      </ul>
      {progress && <ImportProgressLine progress={progress} />}
    </div>
  );
}

/** A 4 px accent bar that fills as work goes (import, export), with what's happening in words under it. */
export function ProgressLine({ label, share, now, max, going, text }: { label: string; share: number; now: number; max: number; going: boolean; text: string }) {
  return (
    <div className={styles.progress}>
      {going && (
        <div className={styles.bar} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={Math.max(1, max)} aria-valuenow={now}>
          <span className={styles.fill} style={{ transform: `scaleX(${Math.min(1, Math.max(0, share))})` }} />
        </div>
      )}
      <p className={styles.status} aria-live="polite">
        {text}
      </p>
    </div>
  );
}

/** What went wrong, in a soft card, with one way on. */
export function ProblemCard({ text, action }: { text: string; action?: { label: string; run(): void } }) {
  return (
    <div className={styles.problem} role="status">
      <p>{text}</p>
      {action && (
        <button type="button" className={styles.button} onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

function ImportProgressLine({ progress }: { progress: ImportProgress }) {
  const share = progress.phase === 'history' && progress.total > 0 ? progress.done / progress.total : progress.phase === 'bookmarks' ? 0 : 1;
  return (
    <ProgressLine
      label="Import"
      share={share}
      now={progress.phase === 'history' ? progress.done : 0}
      max={progress.total}
      going={progress.phase === 'bookmarks' || progress.phase === 'history'}
      text={progressText(progress)}
    />
  );
}

/** The line every import shows: what Chord never copies. */
export const NEVER_COPIED = 'Chord never copies passwords, cookies or extensions. Your password manager can bring passwords across, or use the browser’s own export.';
