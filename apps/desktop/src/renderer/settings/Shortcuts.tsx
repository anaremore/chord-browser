/**
 * Settings → Keyboard shortcuts (DESIGN.md §14): every action, every key, and
 * all of them editable. Click a key to record a new one, + to add another, ↺
 * to go back to Chord's own. Problems show in place: a key another action
 * uses offers to move it here; a key Chord can't use says why. No dialogs.
 */
import {
  MAX_KEYS_PER_ACTION,
  SHORTCUTS,
  checkCombo,
  comboFromInput,
  formatKeys,
  keysFor,
  overrideFor,
  sameCombo,
  shortcutUsing,
  type ActionId,
  type Shortcut,
  type ShortcutOverrides,
} from '@chord/core';
import type { SettingsSnapshot, SystemInfo } from '@chord/ipc';
import { Plus, Search } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from './api';
import { ResetButton, SectionHeader } from './controls';
import settingsStyles from './Settings.module.css';
import styles from './Shortcuts.module.css';

type Platform = SystemInfo['platform'];

const GROUPS: { title: string; prefixes: string[] }[] = [
  { title: 'Address and search', prefixes: ['address.'] },
  { title: 'Tabs', prefixes: ['tab.', 'folder.', 'today.'] },
  { title: 'Navigate', prefixes: ['nav.'] },
  { title: 'Chords', prefixes: ['chord.'] },
  { title: 'Window and view', prefixes: ['window.', 'view.'] },
  { title: 'Page', prefixes: ['page.'] },
  { title: 'Chord', prefixes: ['app.'] },
];

/** What's being edited: one action's key (by its place in the list), or a new one (`index` null). */
interface Editing {
  id: ActionId;
  index: number | null;
  /** A key that's taken (by `owner`) or unusable (`reason`), waiting for an answer or another try. */
  problem?: { combo: string; owner?: Shortcut; reason?: string };
}

/** Keys pressed while recording, as Chord names them (the same rules the router matches with). */
function comboOf(event: KeyboardEvent, platform: Platform): string | null {
  return comboFromInput(
    { type: 'keyDown', key: event.key, code: event.code, control: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey },
    platform,
  );
}

/** The modifiers held so far, as a keycap in progress: "⌘⇧…". */
function heldModifiers(event: KeyboardEvent, platform: Platform): string {
  const mods = [
    platform === 'darwin' ? event.ctrlKey && 'Ctrl' : null,
    platform === 'darwin' ? event.metaKey && 'Mod' : event.ctrlKey && 'Mod',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
  ].filter((m): m is string => Boolean(m));
  return mods.length > 0 ? `${formatKeys(`${mods.join('+')}+X`, platform).slice(0, -1)}…` : '';
}

const PLAIN = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

/** The key being recorded: focused, listening, and telling main to keep its hands off until it's done. */
function Recorder({ label, platform, onKey, onRemove, onCancel }: { label: string; platform: Platform; onKey(combo: string): void; onRemove(): void; onCancel(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [held, setHeld] = useState('');
  // The latest cancel, without restarting the recording each time the row re-renders.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    ref.current?.focus();
    void api.settings.recordingShortcut(true);
    // Leaving the window ends recording, as clicking elsewhere does.
    const leave = () => cancelRef.current();
    window.addEventListener('blur', leave);
    return () => {
      window.removeEventListener('blur', leave);
      void api.settings.recordingShortcut(false);
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Tab still moves focus, so the keyboard can always leave.
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) return onCancel();
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' && PLAIN(event)) return onCancel();
    if ((event.key === 'Backspace' || event.key === 'Delete') && PLAIN(event)) return onRemove();
    const combo = comboOf(event, platform);
    if (combo) onKey(combo);
    else setHeld(heldModifiers(event, platform));
  };
  return (
    <button
      ref={ref}
      type="button"
      className={styles.recorder}
      // Named by what it shows (the keys held so far); what it's for, and Esc and Delete, are its description.
      aria-describedby="shortcut-recorder-help"
      onKeyDown={onKeyDown}
      onKeyUp={(e) => setHeld(heldModifiers(e, platform))}
      onBlur={onCancel}
    >
      {held || 'Press keys…'}
      <span id="shortcut-recorder-help" hidden>
        {`The new keys for ${label}. Esc cancels, Delete removes.`}
      </span>
    </button>
  );
}

function ShortcutRow({
  shortcut,
  platform,
  overrides,
  editing,
  setEditing,
}: {
  shortcut: Shortcut;
  platform: Platform;
  overrides: ShortcutOverrides;
  editing: Editing | null;
  setEditing(next: Editing | null): void;
}) {
  const keys = keysFor(shortcut, platform, overrides);
  const mine = editing?.id === shortcut.id ? editing : null;
  const changed = overrides[shortcut.id] !== undefined;
  const save = (patch: Partial<Record<ActionId, readonly string[] | null>>) => {
    setEditing(null);
    void api.settings.set({ shortcuts: Object.fromEntries(Object.entries(patch).map(([id, keys]) => [id, keys ? [...keys] : null])) });
  };
  const withKey = (combo: string): string[] =>
    mine?.index === null || mine?.index === undefined ? [...keys, combo] : keys.map((k, i) => (i === mine.index ? combo : k));
  const cancel = () => setEditing(null);

  const onKey = (combo: string) => {
    if (!mine) return;
    // Pressing the key it already has (here or in another of its slots) changes nothing.
    if (keys.some((k) => sameCombo(k, combo, platform))) return cancel();
    const reason = checkCombo(combo, platform);
    if (reason) return setEditing({ ...mine, problem: { combo, reason } });
    const owner = shortcutUsing(combo, platform, overrides, shortcut.id);
    if (owner) return setEditing({ ...mine, problem: { combo, owner } });
    save({ [shortcut.id]: overrideFor(shortcut.id, withKey(combo), platform) });
  };
  const onRemove = () => {
    if (!mine || mine.index === null) return cancel();
    save({ [shortcut.id]: overrideFor(shortcut.id, keys.filter((_, i) => i !== mine.index), platform) });
  };
  // "Use it here": the key moves from the other action to this one, in one change.
  const takeOver = () => {
    const problem = mine?.problem;
    if (!problem?.owner) return;
    const theirs = keysFor(problem.owner, platform, overrides).filter((k) => !sameCombo(k, problem.combo, platform));
    save({
      [shortcut.id]: overrideFor(shortcut.id, withKey(problem.combo), platform),
      [problem.owner.id]: overrideFor(problem.owner.id, theirs, platform),
    });
  };

  const recorder = (
    <Recorder key="recorder" label={shortcut.label} platform={platform} onKey={onKey} onRemove={onRemove} onCancel={cancel} />
  );
  return (
    <div className={styles.row} data-action={shortcut.id} data-editing={mine ? '' : undefined}>
      <div className={settingsStyles.shortcut}>
        <span className={settingsStyles.rowLabel}>{shortcut.label}</span>
        <span className={settingsStyles.keys}>
          <ResetButton label={`Reset ${shortcut.label} to its default keys`} visible={changed} onReset={() => save({ [shortcut.id]: null })} />
          {keys.map((k, i) => (
            <span key={`${i}:${k}`} className={settingsStyles.keyAlt}>
              {i > 0 && <span className={settingsStyles.or}>or</span>}
              {mine?.index === i ? (
                recorder
              ) : (
                <button
                  type="button"
                  className={styles.keyButton}
                  aria-label={`Change ${formatKeys(k, platform)} for ${shortcut.label}`}
                  title="Click to change"
                  onClick={() => setEditing({ id: shortcut.id, index: i })}
                >
                  {formatKeys(k, platform)}
                </button>
              )}
            </span>
          ))}
          {mine?.index === null && (
            <span className={settingsStyles.keyAlt}>
              {keys.length > 0 && <span className={settingsStyles.or}>or</span>}
              {recorder}
            </span>
          )}
          {!mine && keys.length < MAX_KEYS_PER_ACTION && (
            <button
              type="button"
              className={styles.addButton}
              aria-label={keys.length > 0 ? `Add another key for ${shortcut.label}` : `Add a key for ${shortcut.label}`}
              title={keys.length > 0 ? 'Add another key' : 'Add a key'}
              onClick={() => setEditing({ id: shortcut.id, index: null })}
            >
              <Plus size={13} strokeWidth={2} />
            </button>
          )}
        </span>
      </div>
      {mine?.problem && (
        <div className={styles.problem} role="alert">
          {mine.problem.owner ? (
            <>
              <span className={styles.problemText}>
                <kbd className={settingsStyles.keycap}>{formatKeys(mine.problem.combo, platform)}</kbd> is used by <em>{mine.problem.owner.label}</em>.
              </span>
              {/* Pressing these mustn't count as recording: they take the pointer, not keys. */}
              <button type="button" className={styles.primary} onMouseDown={(e) => e.preventDefault()} onClick={takeOver}>
                Use it here
              </button>
              <button type="button" className={styles.quiet} onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
                Cancel
              </button>
            </>
          ) : (
            <span className={styles.problemText}>{mine.problem.reason} Try another, or press Esc.</span>
          )}
        </div>
      )}
    </div>
  );
}

export function ShortcutsSection({ snapshot, info }: { snapshot: SettingsSnapshot; info: SystemInfo }) {
  const platform = info.platform;
  const overrides = snapshot.settings.shortcuts;
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // "Reset all" asks once more in place; the question fades if you don't answer.
  useEffect(() => {
    if (!confirmReset) return;
    const timer = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmReset]);

  const needle = filter.trim().toLowerCase();
  const visible = (s: Shortcut) =>
    (!s.only || s.only.includes(platform)) &&
    (!needle ||
      s.label.toLowerCase().includes(needle) ||
      keysFor(s, platform, overrides).some((k) => formatKeys(k, platform).toLowerCase().includes(needle)) ||
      editing?.id === s.id);
  const groups = GROUPS.map((g) => ({ title: g.title, rows: SHORTCUTS.filter((s) => g.prefixes.some((p) => s.id.startsWith(p)) && visible(s)) })).filter(
    (g) => g.rows.length > 0,
  );
  const changedCount = Object.keys(overrides).length;
  const resetAll = () => {
    if (!confirmReset) return setConfirmReset(true);
    setConfirmReset(false);
    setEditing(null);
    void api.settings.set({ shortcuts: Object.fromEntries(Object.keys(overrides).map((id) => [id, null])) });
  };

  return (
    <>
      <SectionHeader title="Keyboard shortcuts" description="Everything Chord does can have a key. Click one to change it, or + to add another." />
      <div className={styles.toolbar}>
        <label className={`${settingsStyles.filter} ${styles.filter}`}>
          <Search size={14} strokeWidth={2} aria-hidden />
          <input type="search" placeholder="Find a shortcut" aria-label="Find a shortcut" spellCheck={false} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        {changedCount > 0 && (
          <button type="button" className={styles.quiet} data-danger={confirmReset || undefined} onClick={resetAll}>
            {confirmReset ? 'Reset every shortcut?' : 'Reset all'}
          </button>
        )}
      </div>
      {groups.map((g) => (
        <section key={g.title}>
          <h2 className={settingsStyles.groupTitle}>{g.title}</h2>
          <div className={settingsStyles.group}>
            {g.rows.map((s) => (
              <ShortcutRow key={s.id} shortcut={s} platform={platform} overrides={overrides} editing={editing} setEditing={setEditing} />
            ))}
          </div>
        </section>
      ))}
      {groups.length === 0 && <p className={settingsStyles.sectionDescription}>No shortcut matches “{filter}”.</p>}
    </>
  );
}
