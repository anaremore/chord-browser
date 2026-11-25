/**
 * Scores the password detector on DuckDuckGo's labelled corpus (S17 §13, layer 2; M0 §4).
 * Pure: it takes each file's fields, as the agent's scan read them in Chromium, with their
 * roles and DuckDuckGo's `data-manual-scoring` labels, and says which fields are wrong.
 *
 * - *username* is the username.
 * - *username OR emailAddress* is either one: the username, or an email that's nothing
 *   until there's a password to save with it. Only a password role is wrong for it
 *   (M0's change 3: DuckDuckGo's own harness can never match this label).
 * - *password.current* is the current password; *password.new* is the new one or its confirmation.
 * - A plain *password* takes the variant its file's name implies (a `_login` file's is
 *   current; a sign-up's, change's or reset's is new), or any password elsewhere.
 * - *emailAddress* is right as anything but a password, and as the username only in a file with a
 *   credential: one with a password or a username-first step. A newsletter's email is no username.
 * - Every other label must get no role.
 */
import type { PasswordFieldRole } from '@chord/core';

/** A labelled field, as the scan reported it and the detector classified it. */
interface ScoredField {
  /** Its index among the file's labelled fields (`[data-manual-scoring]`, in document order). */
  readonly index: number;
  readonly label: string;
  /** What the baseline names it by: `type#id[name]`. */
  readonly field: string;
  readonly role: PasswordFieldRole | null;
}

/** One corpus file's labelled fields; `missing` are labelled ones the scan didn't take (a select, a button). */
export interface ScoredFile {
  readonly html: string;
  readonly fields: readonly ScoredField[];
  readonly missing: readonly { index: number; label: string }[];
}

export type FileType = 'login' | 'signup' | 'change' | 'payment' | 'other';

/** The kind of page a corpus file is, from its name (the corpus names them so). */
export function fileType(html: string): FileType {
  if (/change-password|password-reset|_password\b|new-password|reset/.test(html)) return 'change';
  if (/login|signin|sign-in/.test(html)) return 'login';
  if (/signup|register|sign-up|join/.test(html)) return 'signup';
  if (/checkout|payment|card|payout|refund|billing/.test(html)) return 'payment';
  return 'other';
}

const PASSWORD_ROLES: ReadonlySet<PasswordFieldRole | null> = new Set(['current-password', 'new-password', 'confirmation-password']);
const isPassword = (role: PasswordFieldRole | null) => PASSWORD_ROLES.has(role);
const isNew = (role: PasswordFieldRole | null) => role === 'new-password' || role === 'confirmation-password';

/** Whether a labelled field's role is right. `credential`: its file has a password or username field labelled. */
export function fieldRight(label: string, role: PasswordFieldRole | null, type: FileType, credential = true): boolean {
  switch (label) {
    case 'username':
      return role === 'username';
    case 'username OR emailAddress':
      return role === 'username' || role === null;
    case 'password.current':
      return role === 'current-password';
    case 'password.new':
      return isNew(role);
    case 'password':
      return type === 'login' ? role === 'current-password' : type === 'signup' || type === 'change' ? isNew(role) : isPassword(role);
    case 'emailAddress':
      return !isPassword(role) && (credential || role !== 'username');
    default:
      return role === null;
  }
}

/** Whether a label names a credential, which makes its file one that's scored whole. */
const isCredential = (label: string) => label === 'username' || label === 'username OR emailAddress' || label.startsWith('password');

/** A wrong field, as the baseline lists it: `index label field → role`. */
const failureLine = (f: { index: number; label: string; field: string; role: PasswordFieldRole | null }) => `${f.index} ${f.label} ${f.field} → ${f.role ?? 'none'}`;

export interface CorpusScore {
  /** Files with a credential label. */
  readonly scoredFiles: number;
  /** Of those, the ones with every labelled field right. */
  readonly rightFiles: number;
  /** The same, counting *username OR emailAddress* as username only, as the M0 bake-off did. */
  readonly rightFilesStrict: number;
  readonly fields: number;
  readonly wrongFields: number;
  /** Every wrong field, by file. */
  readonly failures: Readonly<Record<string, readonly string[]>>;
}

export function scoreCorpus(files: readonly ScoredFile[]): CorpusScore {
  let scoredFiles = 0;
  let rightFiles = 0;
  let rightFilesStrict = 0;
  let fields = 0;
  let wrongFields = 0;
  const failures: Record<string, string[]> = {};
  for (const file of files) {
    const type = fileType(file.html);
    const credential = [...file.fields, ...file.missing].some((f) => isCredential(f.label));
    const wrong: string[] = [];
    let strictOk = true;
    for (const f of file.fields) {
      fields++;
      if (!fieldRight(f.label, f.role, type, credential)) wrong.push(failureLine(f));
      if (f.label === 'username OR emailAddress' ? f.role !== 'username' : !fieldRight(f.label, f.role, type, credential)) strictOk = false;
    }
    for (const m of file.missing) {
      fields++;
      // A label the scan never took is right only if it wanted no role.
      if (!fieldRight(m.label, null, type, credential)) wrong.push(failureLine({ ...m, field: '(not scanned)', role: null }));
      if (isCredential(m.label)) strictOk = false;
    }
    wrongFields += wrong.length;
    if (wrong.length) failures[file.html] = wrong;
    if (credential) {
      scoredFiles++;
      if (!wrong.length) rightFiles++;
      if (strictOk) rightFilesStrict++;
    }
  }
  return { scoredFiles, rightFiles, rightFilesStrict, fields, wrongFields, failures };
}

/** The baseline file: what's wrong today, by file, and the totals it was taken with. */
export interface CorpusBaseline {
  readonly corpus: string;
  readonly rightFiles: number;
  readonly scoredFiles: number;
  readonly failures: Readonly<Record<string, readonly string[]>>;
}

/** The ratchet (both suites'): a field that was right and is now wrong, and one that's newly right (the baseline must be taken again). */
export function compareBaseline(
  score: { readonly failures: Readonly<Record<string, readonly string[]>> },
  baseline: { readonly failures: Readonly<Record<string, readonly string[]>> },
): { regressed: string[]; fixed: string[] } {
  const regressed: string[] = [];
  const fixed: string[] = [];
  const files = new Set([...Object.keys(score.failures), ...Object.keys(baseline.failures)]);
  for (const html of [...files].sort()) {
    const now = new Set(score.failures[html] ?? []);
    const before = new Set(baseline.failures[html] ?? []);
    for (const line of now) if (!before.has(line)) regressed.push(`${html}: ${line}`);
    for (const line of before) if (!now.has(line)) fixed.push(`${html}: ${line}`);
  }
  return { regressed, fixed };
}
