/**
 * Choosing the vault passphrase (docs/decisions/S17-passwords.md §7): two
 * fields and *Suggest one*, as the Export card asks for one (DESIGN.md §8.8),
 * with the line that says Chord can't get it back. Settings → Passwords uses
 * it while there's no passphrase yet, and to change it; the first save card
 * (in the popover) uses it for the first password saved. Its parent holds
 * the value and decides when it's sent; nothing here keeps it.
 */
import { passphraseProblem, suggestPassphrase } from '@chord/core';
import { useEffect, useId, useRef } from 'react';
import styles from './PassphraseStep.module.css';

export interface PassphraseValue {
  passphrase: string;
  repeat: string;
  /** *Suggest one* shows what it chose, so it can be written down; typing hides it again. */
  shown: boolean;
  /** A problem shows once you've left a field, or tried to go on. */
  touched: boolean;
}

export const EMPTY_PASSPHRASE: PassphraseValue = { passphrase: '', repeat: '', shown: false, touched: false };

/** Whether it can be used: long enough, and the same twice. */
export const passphraseReady = (value: PassphraseValue): boolean => passphraseProblem(value.passphrase) === null && value.repeat === value.passphrase;

export function PassphraseStep({
  value,
  onChange,
  note = 'Choose a passphrase to lock your passwords. Chord can’t get it back for you.',
  label = 'Passphrase',
  autoFocus = false,
  readOnly = false,
}: {
  value: PassphraseValue;
  onChange(next: PassphraseValue): void;
  /** The line above the fields; null for none. */
  note?: string | null;
  label?: string;
  autoFocus?: boolean;
  /** Read-only, and no *Suggest one*: the save card while its save waits (S17 §6, phase 3A-2), what it shows is what's saved. */
  readOnly?: boolean;
}) {
  const ids = useId();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) first.current?.focus();
  }, [autoFocus]);
  const lengthProblem = passphraseProblem(value.passphrase);
  const mismatch = value.repeat !== value.passphrase;
  const type = (key: 'passphrase' | 'repeat') => (text: string) => onChange({ ...value, [key]: text, shown: false });
  return (
    <div className={styles.step}>
      {note && <p className={styles.note}>{note}</p>}
      <label className={styles.field}>
        <span className={styles.label}>{label}</span>
        <input
          ref={first}
          className={styles.input}
          type={value.shown ? 'text' : 'password'}
          value={value.passphrase}
          readOnly={readOnly}
          autoComplete="new-password"
          spellCheck={false}
          aria-invalid={(value.touched && Boolean(lengthProblem)) || undefined}
          aria-describedby={value.touched && lengthProblem ? `${ids}-length` : undefined}
          onChange={(e) => type('passphrase')(e.target.value)}
          onBlur={() => value.passphrase && onChange({ ...value, touched: true })}
        />
      </label>
      {value.touched && lengthProblem && (
        <span id={`${ids}-length`} className={styles.problem}>
          {lengthProblem}
        </span>
      )}
      <label className={styles.field}>
        <span className={styles.label}>Again</span>
        <input
          className={styles.input}
          type={value.shown ? 'text' : 'password'}
          value={value.repeat}
          readOnly={readOnly}
          autoComplete="new-password"
          spellCheck={false}
          aria-invalid={(value.touched && mismatch && !lengthProblem) || undefined}
          aria-describedby={value.touched && mismatch && !lengthProblem ? `${ids}-match` : undefined}
          onChange={(e) => type('repeat')(e.target.value)}
          onBlur={() => value.repeat && onChange({ ...value, touched: true })}
        />
      </label>
      {value.touched && mismatch && !lengthProblem && (
        <span id={`${ids}-match`} className={styles.problem}>
          The two don’t match.
        </span>
      )}
      <div className={styles.suggest}>
        <button
          type="button"
          className={styles.suggestButton}
          disabled={readOnly}
          onClick={() => {
            const words = suggestPassphrase();
            onChange({ passphrase: words, repeat: words, shown: true, touched: false });
          }}
        >
          Suggest one
        </button>
        {value.shown && <span className={styles.hint}>Five words at random. Write them down: Chord can’t get them back for you.</span>}
      </div>
    </div>
  );
}
