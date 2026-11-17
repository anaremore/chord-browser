/**
 * Bringing passwords in and taking them out (docs/decisions/S17-passwords.md
 * §10, phase 2), the parts that are pure: a CSV reader, which columns are
 * which, what a row is, what a file is against the vault (new, the same, or
 * different), and the `login` record Chord's own encrypted file carries
 * (docs/data-format.md). No crypto, no storage, no Public Suffix List: the
 * import process reads the file with these, and chord-data, which alone holds
 * the vault key, compares and writes.
 *
 * Nothing here logs, and no problem it returns holds a password.
 */
import { PASSWORD_LIMITS, loginProblem } from './passwords';
import type { DataRecord } from './records';

declare const URL: new (url: string) => { protocol: string; hostname: string; origin: string; username: string; password: string };

/* ---------- Limits ---------- */

/** What one import reads at most. A file past them is read to its limit, and the rest counted, never thrown on. */
export const PASSWORD_IMPORT_LIMITS = {
  /** Bytes of a CSV file: far past any real export (50,000 sign-ins are about 10 MB). */
  bytes: 64 * 1024 * 1024,
  /** Rows (sign-ins and the rows listed as not imported): the rest are counted as left out. */
  rows: 50_000,
  /** Characters of one field; a longer one makes its row too long, and isn't kept. */
  field: 64 * 1024,
  /** Columns of one row that are read. */
  columns: 200,
  /** Rows listed as not imported, each with what it says; past this they're only counted. */
  issues: 1_000,
  /** Characters of an address, a username or a name a listed row shows. */
  shown: 200,
  /** Sign-ins that differ from yours listed in the preview, each choosable; past this, they keep yours unless the switch takes the file's. */
  conflicts: 10_000,
} as const;

/* ---------- CSV ---------- */

/**
 * RFC 4180 CSV, read as it comes (a chunk of text at a time): fields split by
 * commas, rows by `\n`, `\r\n` or `\r`; a field in double quotes may hold
 * commas, line breaks and `""` for a quote. A byte-order mark at the start is
 * passed over. Lenient where exporters are: a quote inside an unquoted field
 * is kept as it is, and text after a closing quote joins the field. A field
 * longer than PASSWORD_IMPORT_LIMITS.field isn't kept (its row says `long`).
 */
export class CsvReader {
  private field = '';
  private row: string[] = [];
  private quoted = false;
  /** Just read a quote inside a quoted field: the next character says whether it was `""`. */
  private quote = false;
  /** Just read `\r`: a `\n` after it ends nothing more. */
  private cr = false;
  private started = false;
  /** A field in this row went past the limit. */
  private long = false;
  /** Whether the row has had any character (a blank line is no row). */
  private touched = false;

  /** The next text: the rows whole in it so far, each with whether one of its fields was too long. */
  push(text: string): { fields: string[]; long: boolean }[] {
    const rows: { fields: string[]; long: boolean }[] = [];
    let at = 0;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) at = 1;
    }
    for (; at < text.length; at++) {
      const c = text[at]!;
      if (this.cr) {
        this.cr = false;
        if (c === '\n') continue;
      }
      if (this.quoted) {
        if (this.quote) {
          this.quote = false;
          if (c === '"') {
            this.add('"');
            continue;
          }
          // The quote closed the field; what follows is read as unquoted.
          this.quoted = false;
        } else if (c === '"') {
          this.quote = true;
          continue;
        } else {
          this.add(c);
          continue;
        }
      }
      if (c === ',') {
        this.endField();
      } else if (c === '\n' || c === '\r') {
        if (c === '\r') this.cr = true;
        const row = this.endRow();
        if (row) rows.push(row);
      } else if (c === '"' && this.field.length === 0 && !this.touchedField) {
        this.quoted = true;
        this.touched = true;
        this.touchedField = true;
      } else {
        this.add(c);
      }
    }
    return rows;
  }

  /** The text has ended: the last row, if it had no line break after it. */
  end(): { fields: string[]; long: boolean }[] {
    this.quote = false;
    this.quoted = false;
    const row = this.endRow();
    return row ? [row] : [];
  }

  /** Whether the field being read has had anything, a quote included. */
  private touchedField = false;

  private add(c: string): void {
    this.touched = true;
    this.touchedField = true;
    if (this.field.length >= PASSWORD_IMPORT_LIMITS.field) {
      this.long = true;
      return;
    }
    this.field += c;
  }

  private endField(): void {
    this.touched = true;
    if (this.row.length < PASSWORD_IMPORT_LIMITS.columns) this.row.push(this.field);
    this.field = '';
    this.touchedField = false;
    this.quoted = false;
    this.quote = false;
  }

  private endRow(): { fields: string[]; long: boolean } | null {
    if (!this.touched) {
      this.field = '';
      return null;
    }
    this.endField();
    const row = { fields: this.row, long: this.long };
    this.row = [];
    this.long = false;
    this.touched = false;
    return row;
  }
}

/* ---------- Columns ---------- */

/** What a column can be, for an import. */
export type CsvColumn = 'url' | 'username' | 'password' | 'note' | 'name' | 'realm' | 'otp' | 'type';

/**
 * Each column's names, as managers write them (S17 §10's table), compared
 * without case, spaces, `_` or `-`; the first name found wins. ✅ Chrome,
 * Edge, Brave: `name,url,username,password,note`. ✅ Firefox:
 * `url,username,password,httpRealm,formActionOrigin,guid,…`. ⚠ Safari and
 * Apple Passwords: `Title,URL,Username,Password,Notes,OTPAuth`. ✅ Bitwarden:
 * `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,
 * login_password,login_totp`. ⚠ 1Password: `Title,Url,Username,Password,
 * OTPAuth,…,Notes` (8) or `title,website,username,password,notes,…` (older).
 */
export const CSV_COLUMNS: Record<CsvColumn, readonly string[]> = {
  url: ['url', 'loginuri', 'website', 'uri', 'urls', 'loginurl', 'address', 'webaddress', 'hostname', 'origin'],
  username: ['username', 'loginusername', 'login', 'user', 'email', 'emailaddress'],
  password: ['password', 'loginpassword', 'pass'],
  note: ['note', 'notes', 'comment', 'comments', 'extra'],
  name: ['name', 'title'],
  realm: ['httprealm', 'realm'],
  otp: ['otpauth', 'logintotp', 'totp', 'onetimepassword', 'otp', 'otpsecret'],
  type: ['type'],
};

const columnName = (header: string) => header.trim().toLowerCase().replace(/[\s_-]+/g, '');

/** Which column is which, by name; `problem` names a column the file must have and doesn't. */
export function csvColumns(header: readonly string[]): { columns: Partial<Record<CsvColumn, number>> } | { problem: 'url' | 'password' } {
  const names = header.map(columnName);
  const columns: Partial<Record<CsvColumn, number>> = {};
  for (const [column, aliases] of Object.entries(CSV_COLUMNS) as [CsvColumn, readonly string[]][]) {
    for (const alias of aliases) {
      const at = names.indexOf(alias);
      if (at >= 0 && !Object.values(columns).includes(at)) {
        columns[column] = at;
        break;
      }
    }
  }
  if (columns.url === undefined) return { problem: 'url' };
  if (columns.password === undefined) return { problem: 'password' };
  return { columns };
}

/** Whose export a file is, by the header it was written with. */
export type PasswordSource = 'chrome' | 'firefox' | 'safari' | 'bitwarden' | '1password';

/** The preview's *From*: "A Chrome, Edge or Brave export". */
export const PASSWORD_SOURCE_NAMES: Record<PasswordSource, string> = {
  chrome: 'Chrome, Edge or Brave',
  firefox: 'Firefox',
  safari: 'Safari or Apple Passwords',
  bitwarden: 'Bitwarden',
  '1password': '1Password',
};

/** Whose header this is: S17 §10's table, the names in order (case and spacing aside). */
export function csvSource(header: readonly string[]): PasswordSource | null {
  const names = header.map(columnName).join(',');
  if (names === 'name,url,username,password,note') return 'chrome';
  if (names.startsWith('url,username,password,httprealm,formactionorigin')) return 'firefox';
  if (names.startsWith('title,url,username,password,notes,otpauth')) return 'safari';
  if (names.startsWith('folder,favorite,type,name,notes,fields,reprompt,loginuri')) return 'bitwarden';
  if (names.startsWith('title,url,username,password,otpauth,favorite,archived') || names.startsWith('title,website,username,password')) return '1password';
  return null;
}

/* ---------- Rows ---------- */

/** A sign-in read from a file, before it's compared with the vault. */
export interface ImportedLogin {
  /** Scheme, host and port: `https://example.com`. */
  origin: string;
  username: string;
  password: string;
  note: string;
  /** The browser's own sign-in box's realm (Firefox's `httpRealm`); null for a page's form. */
  realm: string | null;
  /** When its password last changed, when the file says (a Chord file does); else null. */
  changedAt: number | null;
}

/**
 * Why a row didn't come in:
 * - `address`: no address, or not a web page's (`chrome://`, a file);
 * - `app`: an app's sign-in (`android://`, `ios-app://`), which a browser can't fill;
 * - `password`: no password;
 * - `long`: a part is longer than a sign-in may be (S17 §8's limits);
 * - `kind`: not a sign-in (a password manager's note, card or identity).
 */
export type ImportIssueKind = 'address' | 'app' | 'password' | 'long' | 'kind';

/** A row that didn't come in, listed with what it says so you can find it: never its password. */
export interface ImportIssue {
  /** Its row in the file, the header being row 1 (as a spreadsheet numbers it, when no field spans lines). */
  row: number;
  kind: ImportIssueKind;
  /** What it says, cut to PASSWORD_IMPORT_LIMITS.shown characters. */
  address: string;
  username: string;
  name: string;
}

const shown = (text: string) => (text.length > PASSWORD_IMPORT_LIMITS.shown ? `${text.slice(0, PASSWORD_IMPORT_LIMITS.shown - 1)}…` : text);

/** An app's sign-in: Android's (Chrome and Bitwarden write `android://…`), iOS's, or a Windows app's. */
const APP = /^(android|androidapp|ios-app|iosapp|ms-app|app):/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** A bare host (1Password and others sometimes write `example.com`): a dot, or localhost, and no spaces. */
const BARE_HOST = /^(localhost|[^\s/:?#]+\.[^\s/:?#]+)(:\d+)?([/?#]\S*)?$/i;

/** An address as an origin a sign-in can be saved for (`http:` and `https:` only, no user or password in it), or why not. */
export function importOrigin(text: string): { origin: string } | { issue: 'address' | 'app' } {
  const t = text.trim();
  if (!t) return { issue: 'address' };
  const tries = [t];
  // Several addresses in one field (some managers join them with commas or line breaks): the first that works.
  if (/[,\n\r ]/.test(t)) tries.push(...t.split(/[,\n\r ]+/).filter(Boolean));
  let app = false;
  for (const one of tries) {
    if (APP.test(one)) {
      app = true;
      continue;
    }
    // `example.com:8443/login` looks like a scheme to a URL parser: a bare host is read as one first.
    const url = BARE_HOST.test(one) ? `https://${one}` : SCHEME.test(one) ? one : null;
    if (!url) continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname || parsed.username || parsed.password) continue;
    if (parsed.origin.length > PASSWORD_LIMITS.origin) continue;
    return { origin: parsed.origin };
  }
  return { issue: app ? 'app' : 'address' };
}

/** What one data row is: a sign-in, or an issue; and whether it held a one-time-code secret (never kept). */
export function csvRow(fields: readonly string[], long: boolean, columns: Partial<Record<CsvColumn, number>>, row: number): { login?: ImportedLogin; issue?: ImportIssue; otp: boolean } {
  const get = (column: CsvColumn) => {
    const at = columns[column];
    return at === undefined ? '' : (fields[at] ?? '');
  };
  const otp = get('otp').trim() !== '';
  const address = get('url');
  const username = get('username');
  const issue = (kind: ImportIssueKind): { issue: ImportIssue; otp: boolean } => ({ issue: { row, kind, address: shown(address.trim()), username: shown(username), name: shown(get('name').trim()) }, otp });
  const type = get('type').trim().toLowerCase();
  // Bitwarden lists notes, cards and identities beside sign-ins.
  if (columns.type !== undefined && type !== '' && type !== 'login') return issue('kind');
  const where = importOrigin(address);
  if ('issue' in where) return issue(where.issue);
  const password = get('password');
  if (!password) return issue('password');
  const realm = get('realm');
  const login: ImportedLogin = { origin: where.origin, username, password, note: get('note'), realm: realm === '' ? null : realm, changedAt: null };
  if (long || loginProblem(login) !== null) return issue('long');
  return { login, otp };
}

/** What a file brought, as it was read: sign-ins, rows listed, and what's only counted. */
export interface CsvReadCounts {
  /** Data rows read (blank lines aren't rows). */
  rows: number;
  /** Rows with a one-time-code secret: the secret isn't kept (one-time codes aren't in the vault, S17 decision 7). */
  otp: number;
  /** Rows past PASSWORD_IMPORT_LIMITS.rows, left out. */
  capped: number;
  /** Rows listed past PASSWORD_IMPORT_LIMITS.issues: only counted. */
  issuesMore: number;
}

/**
 * A password CSV, read as it comes: give it text (`push`) and it gives back
 * the sign-ins and listed rows whole so far. The header is the first row that
 * isn't blank; `problem` says when it lacks a column a sign-in needs.
 */
export class PasswordCsv {
  private readonly reader = new CsvReader();
  private columns: Partial<Record<CsvColumn, number>> | null = null;
  private line = 1;
  private issuesListed = 0;
  problem: 'url' | 'password' | 'empty' | null = null;
  source: PasswordSource | null = null;
  readonly counts: CsvReadCounts = { rows: 0, otp: 0, capped: 0, issuesMore: 0 };

  push(text: string): { logins: ImportedLogin[]; issues: ImportIssue[] } {
    return this.take(this.reader.push(text));
  }

  end(): { logins: ImportedLogin[]; issues: ImportIssue[] } {
    const out = this.take(this.reader.end());
    if (!this.columns && !this.problem) this.problem = 'empty';
    return out;
  }

  private take(rows: { fields: string[]; long: boolean }[]): { logins: ImportedLogin[]; issues: ImportIssue[] } {
    const logins: ImportedLogin[] = [];
    const issues: ImportIssue[] = [];
    for (const { fields, long } of rows) {
      if (this.problem) return { logins, issues };
      if (!this.columns) {
        const found = csvColumns(fields);
        if ('problem' in found) {
          this.problem = found.problem;
          return { logins, issues };
        }
        this.columns = found.columns;
        this.source = csvSource(fields);
        continue;
      }
      this.line++;
      if (this.counts.rows >= PASSWORD_IMPORT_LIMITS.rows) {
        this.counts.capped++;
        continue;
      }
      this.counts.rows++;
      const read = csvRow(fields, long, this.columns, this.line);
      if (read.otp) this.counts.otp++;
      if (read.login) logins.push(read.login);
      else if (read.issue) {
        if (this.issuesListed < PASSWORD_IMPORT_LIMITS.issues) {
          this.issuesListed++;
          issues.push(read.issue);
        } else this.counts.issuesMore++;
      }
    }
    return { logins, issues };
  }
}

/* ---------- Against the vault ---------- */

/** A saved sign-in, as chord-data opened it to compare. */
export interface VaultLogin {
  id: string;
  origin: string;
  username: string;
  password: string;
  realm: string | null;
  note: string;
}

/** The same sign-in: its origin, username and realm (a page's form and the sign-in box are never the same one). */
const loginKey = (l: { origin: string; username: string; realm: string | null }) => `${l.origin}\0${l.username}\0${l.realm === null ? '' : `r${l.realm}`}`;

/**
 * A file's sign-ins, once each: the same origin, username and realm twice is
 * one, the later row's. `duplicates`: how many rows that took.
 */
export function uniqueLogins(logins: readonly ImportedLogin[]): { logins: ImportedLogin[]; duplicates: number } {
  const byKey = new Map<string, number>();
  const out: ImportedLogin[] = [];
  let duplicates = 0;
  for (const login of logins) {
    const key = loginKey(login);
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, out.length);
      out.push(login);
    } else {
      duplicates++;
      out[at] = login;
    }
  }
  return { logins: out, duplicates };
}

/** What a file is to the vault, by each sign-in's place in the file's unique list. */
export interface PasswordImportPlan {
  /** Not saved here: they come in. */
  added: number[];
  /** Saved here with the same password, and the file's note empty or yours: nothing to do. */
  same: number[];
  /**
   * Saved here with another password or note: yours kept, or the file's taken (the password before it kept, as an
   * update keeps it). `what` says which differ.
   */
  different: { at: number; id: string; what: PasswordDifference[] }[];
}

/** What differs between a file's sign-in and yours. The username can't: it's part of what makes them the same sign-in. */
export type PasswordDifference = 'password' | 'note';

/**
 * The file against the vault: a sign-in of the file is the vault's when its
 * origin, username and realm are the same. Exactly the same address, not the
 * rest of its site: an import mustn't fold `login.example.com` into
 * `example.com`. A note the file doesn't have isn't a difference; one it has
 * that isn't yours is. Several saved for the same one (made by hand): the same
 * if any is, else different from the first.
 */
export function planPasswordImport(file: readonly ImportedLogin[], here: readonly VaultLogin[]): PasswordImportPlan {
  const saved = new Map<string, VaultLogin[]>();
  for (const login of here) {
    const key = loginKey(login);
    const list = saved.get(key);
    if (list) list.push(login);
    else saved.set(key, [login]);
  }
  const plan: PasswordImportPlan = { added: [], same: [], different: [] };
  file.forEach((login, at) => {
    const matches = saved.get(loginKey(login));
    if (!matches) plan.added.push(at);
    else {
      const what = (m: VaultLogin): PasswordDifference[] => [
        ...(m.password !== login.password ? (['password'] as const) : []),
        ...(login.note !== '' && login.note !== m.note ? (['note'] as const) : []),
      ];
      if (matches.some((m) => what(m).length === 0)) plan.same.push(at);
      else plan.different.push({ at, id: matches[0]!.id, what: what(matches[0]!) });
    }
  });
  return plan;
}

/* ---------- Chord's own file: the `login` record ---------- */

/** The `login` record's type: only in an encrypted file (S17 decision 6, docs/data-format.md). */
export const LOGIN_RECORD = 'login';

/** A saved sign-in as a record of Chord's encrypted file. Its id is the vault's; the use, the sign-in before, and the never list stay here. */
export function loginRecord(id: string, login: { origin: string; username: string; password: string; note: string; realm: string | null; changedAt: number }, created: number): DataRecord {
  return {
    type: LOGIN_RECORD,
    id,
    set: { origin: login.origin, username: login.username, password: login.password, note: login.note, realm: login.realm, created, changed: login.changedAt },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 253402300799999;

/** A file's `login` record as a sign-in to import, checked as a CSV row is; null when it isn't one. */
export function loginFromRecord(record: DataRecord): ImportedLogin | null {
  if (record.type !== LOGIN_RECORD || !UUID.test(record.id)) return null;
  const s = record.set;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const origin = text(s['origin']);
  const username = text(s['username']);
  const password = text(s['password']);
  const note = s['note'] === undefined ? '' : text(s['note']);
  const realm = s['realm'] === undefined || s['realm'] === null ? null : text(s['realm']);
  if (origin === null || username === null || password === null || note === null || (s['realm'] != null && realm === null)) return null;
  const where = importOrigin(origin);
  // A record's origin must already be one: an address that needs fixing isn't Chord's.
  if ('issue' in where || where.origin !== origin) return null;
  const login: ImportedLogin = { origin, username, password, note, realm, changedAt: isTime(s['changed']) ? s['changed'] : null };
  return loginProblem(login) === null ? login : null;
}

/* ---------- CSV export ---------- */

/** Chrome's header, which every manager imports (`password_csv_writer.cc`). */
export const PASSWORD_CSV_HEADER = 'name,url,username,password,note\n';

/** A field as CSV writes it: quoted when it must be, `"` doubled. Never changed otherwise: a password must stay what it is. */
export const csvField = (value: string): string => (/[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value);

/** One sign-in as a CSV line: its site's host for a name, its address, username, password and note. */
export function passwordCsvLine(login: { origin: string; username: string; password: string; note: string }): string {
  let host = login.origin;
  try {
    host = new URL(login.origin).hostname.replace(/^www\./, '');
  } catch {
    // An origin that doesn't parse is written as it is.
  }
  return `${[host, `${login.origin}/`, login.username, login.password, login.note].map(csvField).join(',')}\n`;
}

/* ---------- What Settings is told ---------- */

/** Why a file's passwords can't be read at all: no address or password column, nothing in it, or it couldn't be read. */
export type PasswordFileProblem = 'url' | 'password' | 'empty' | 'unreadable';

/**
 * What an import would do, before anything is written (S17 §10's preview):
 * counts, the sign-ins that differ from yours (by their place in the file,
 * with their address and username, never a password), and the rows that
 * won't come in. While the vault is locked nothing is compared: `state` says
 * so, and only the file's own counts are filled.
 */
export interface PasswordImportSummary {
  /** `none`: no vault yet, so everything is new (the passphrase is chosen on Import). */
  state: 'open' | 'locked' | 'none';
  problem: PasswordFileProblem | null;
  /** Whose export it looks like, by its header; null for a manager Chord doesn't know (or a Chord file). */
  source: PasswordSource | null;
  /** Data rows in the file (a Chord file: its `login` records). */
  rows: number;
  /** Sign-ins in the file, once each. */
  logins: number;
  added: number;
  same: number;
  different: number;
  /** Each different one: `at` names it in the choices. At most PASSWORD_IMPORT_LIMITS.conflicts; the rest only counted. */
  conflicts: { at: number; origin: string; username: string; realm: string | null; what: PasswordDifference[] }[];
  conflictsMore: number;
  issues: ImportIssue[];
  issuesMore: number;
  /** Rows with a one-time-code secret, which isn't kept. */
  otp: number;
  /** The same sign-in twice: once, the later row's. */
  duplicates: number;
  /** Rows past what one import reads, left out. */
  capped: number;
  /** A Chord file's `login` records that didn't read as sign-ins, left out. */
  skipped: number;
}

/** For the sign-ins that differ: keep yours or take the file's, and the ones (by `at`) chosen the other way. */
export interface PasswordImportChoices {
  take: 'yours' | 'file';
  except: number[];
}

/** What an import did. `stopped`: the vault locked part way; what landed has its Undo. */
export interface PasswordImportResult {
  added: number;
  updated: number;
  /** Different, and yours kept. */
  kept: number;
  same: number;
  stopped: boolean;
}

/** What Undo did: `changed` were changed since the import, and stay as they are. */
export interface PasswordImportUndone {
  removed: number;
  restored: number;
  changed: number;
}

/** Whether a sign-in that differs takes the file's password, by the choices. */
export const takesFile = (take: PasswordImportChoices['take'], except: ReadonlySet<number>, at: number): boolean => (take === 'file') !== except.has(at);
