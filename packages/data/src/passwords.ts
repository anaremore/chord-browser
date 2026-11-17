/**
 * Chord's own passwords, chord-data's side (docs/decisions/S17-passwords.md
 * §7, §8; migration 24): the vault key and every sealed sign-in. Only
 * chord-data holds the key, as a Buffer, while the vault is open; only it
 * seals, opens and tags. Nothing here keeps a password in the clear: each op
 * opens what it needs and lets it go.
 *
 * - **The key** `K`: 32 random bytes, wrapped (AES-256-GCM) under scrypt of
 *   your passphrase with S15's parameters, in `meta` (`passwords`). Changing
 *   the passphrase wraps `K` again; no row is sealed again. *Keep unlocked on
 *   this computer* adds a second copy wrapped by the OS (`safeStorage`, which
 *   only main can call): main unwraps it and hands `K` here (`open`).
 * - **A sign-in**: one blob, `1 ‖ nonce ‖ AES-256-GCM(JSON) ‖ tag`, under
 *   HKDF(K, `chord passwords v1 item`), with its id and the format's version
 *   as associated data, so a blob moved to another row doesn't open.
 * - **Its site**: HMAC-SHA256 under HKDF(K, `chord passwords v1 index`) of the
 *   registrable domain, cut to 16 bytes, so lookup needs no opening and the
 *   file doesn't list where you have accounts.
 *
 * Errors thrown here never carry a value: chord-data's replies include an
 * error's stack.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import { loginProblem, normalizePassphrase, passphraseProblem, SCRYPT, type LoginSecret, type LoginSummary, type ScryptParams } from '@chord/core';
import type * as Sites from '@chord/core/password-sites';
import { nodeCrypto } from './crypto';

type Row = Record<string, unknown>;
type Sql = (text: string) => StatementSync;

/**
 * Matching by site carries the Public Suffix List (about 130 KB): loaded the
 * first time an op needs it, never as chord-data starts (it opens chord.db
 * on launch's way to the first window).
 */
let sitesModule: Promise<typeof Sites> | null = null;
let sites: typeof Sites | null = null;
const loadSites = async (): Promise<typeof Sites> => (sites ??= await (sitesModule ??= import('@chord/core/password-sites')));
const loginOrigin = (url: string) => sites!.loginOrigin(url);
const loginSite = (origin: string) => sites!.loginSite(origin);
const matchLogin = (page: string, saved: string) => sites!.matchLogin(page, saved);

/** `none`: no passphrase yet (nothing saved). `locked`: a vault, its key not here. `open`: the key is here. */
export type VaultState = 'none' | 'locked' | 'open';

export interface VaultStatus {
  state: VaultState;
  /** A copy of the key is kept with the OS (*Keep unlocked on this computer*). */
  kept: boolean;
  /** How many sign-ins are saved (counted without the key). */
  count: number;
}

/** A sign-in to add from Settings, or to save from a page. */
export interface NewLogin {
  origin: string;
  username: string;
  password: string;
  note?: string;
  /** Saved from the browser's own sign-in box (HTTP Basic or Digest): its realm. Absent for a page's form. */
  realm?: string;
}

/** What Settings can change of a sign-in: a new password keeps the old one as `previous`. */
export interface LoginPatch {
  origin?: string;
  username?: string;
  password?: string;
  note?: string;
}

/**
 * What a page's sign-in that worked is to the vault (S17 §6, step 5):
 * nothing saved for that username on the site, a new password for a saved
 * one, or exactly what's saved.
 */
export type Candidate = { kind: 'new' } | { kind: 'update'; id: string } | { kind: 'same'; id: string };

export type PasswordOp =
  | { op: 'status' }
  /** The first passphrase: a new vault, open. */
  | { op: 'setup'; passphrase: string }
  | { op: 'unlock'; passphrase: string }
  /** The kept copy of the key, unwrapped by main; refused if the vault was locked since `generation` (from `status`). */
  | { op: 'open'; key: Uint8Array; generation?: number }
  /** `held`: *Lock now*, which holds until the passphrase is typed, across launches too. */
  | { op: 'lock'; held?: boolean }
  /** Whether this is the passphrase (Show and Copy ask again after a while); the vault stays as it is. */
  | { op: 'verify'; passphrase: string }
  | { op: 'passphrase'; current: string; next: string }
  /** The key, for main to keep with the OS (only while open). */
  | { op: 'key' }
  /** The OS-wrapped copy to keep (base64), or null to forget it. */
  | { op: 'keep'; blob: string | null }
  /** The OS-wrapped copy, if one is kept. */
  | { op: 'kept' }
  | { op: 'list'; chordId: string | null }
  /**
   * The sign-ins saved for the site of `origin`, for the menu under the field to rank (main's `offersFor`): a page's
   * forms' only. With `realm`, the browser's own sign-in box's instead: those saved for exactly that origin and realm.
   */
  | { op: 'forSite'; origin: string; chordId: string | null; realm?: string }
  | { op: 'reveal'; id: string }
  /** A password for a page, only if the sign-in matches the page's origin (S17 §5); its use is recorded unless `chordId` is null. */
  | { op: 'fill'; id: string; origin: string; chordId: string | null; realm?: string }
  | { op: 'used'; id: string; chordId: string }
  | { op: 'add'; login: NewLogin; chordId: string | null }
  | { op: 'edit'; id: string; patch: LoginPatch }
  /**
   * Undo of an update: the password before it back (the one it replaces becomes the one before), only while the
   * password is still the one that update wrote (`changedAt`, from `save`): refused once anything changed it since.
   */
  | { op: 'revert'; id: string; changedAt: number }
  /** Deleted, and kept sealed in memory for its Undo until chord-data quits. */
  | { op: 'delete'; id: string }
  | { op: 'undelete'; id: string }
  | { op: 'compare'; origin: string; username: string; password: string; realm?: string }
  /** A page's sign-in saved (or, with `realm`, the sign-in box's): new, or in place of `replace`'s password. */
  | { op: 'save'; origin: string; username: string; password: string; chordId: string | null; replace?: string; realm?: string }
  /**
   * A generated password, saved the moment it's filled (S17 §6, *Generating*): a new form sign-in for `origin` with
   * no username yet, *Not confirmed*. Saved whatever the never list says: generating is asking.
   */
  | { op: 'presave'; origin: string; password: string; chordId: string | null }
  /**
   * A *Not confirmed* sign-in, before a submit worked: the username it was submitted with, or the password it holds
   * now (a new one generated in the same form; the one before is kept as `previous`). Refused once it's confirmed.
   */
  | { op: 'pending'; id: string; origin: string; username?: string; password?: string }
  /** A submit worked: the *Not confirmed* sign-in is confirmed, with the username and password it was submitted with. */
  | { op: 'confirm'; id: string; origin: string; username?: string; password?: string }
  /** A change-password form's account (S17 §6): the form sign-ins for `origin` whose password is `current`. */
  | { op: 'matchCurrent'; origin: string; current: string }
  | { op: 'never'; origin: string }
  | { op: 'isNever'; origin: string }
  | { op: 'nevers' }
  | { op: 'forgetNever'; site: string }
  /** A lost passphrase: every sign-in, the never list and the key go. */
  | { op: 'startOver' };

/** `locked`: the op needs the key. `wrong`: not the passphrase (or not the key). `exists`/`none`: setup with a vault, or the other way round. */
export type PasswordProblem = 'locked' | 'wrong' | 'none' | 'exists' | 'missing' | 'invalid' | 'refused';

export interface PasswordResult {
  problem?: PasswordProblem;
  status?: VaultStatus;
  logins?: LoginSummary[];
  /** Sign-ins whose blob didn't open (damaged, or moved): left as they are, and counted. */
  unreadable?: number;
  password?: string;
  id?: string;
  key?: Uint8Array;
  blob?: string | null;
  candidate?: Candidate;
  nevers?: string[];
  never?: boolean;
  /** From `status`: how many locks chord-data has seen, for `open`. */
  generation?: number;
  /** From `status`: *Lock now* holds (the kept copy waits for the passphrase). */
  held?: boolean;
  /** From `fill`: the sign-in's own origin, so main checks the match too. */
  loginOrigin?: string;
  /** From `fill`: the sign-in's realm (null for a form's), so main checks that too. */
  loginRealm?: string | null;
  /** From `save` (an update): when its password changed, which a `revert` names. */
  changedAt?: number;
}

/** What `meta` keeps under `passwords`. */
interface VaultMeta {
  v: 1;
  kdf: ScryptParams & { salt: string };
  /** `nonce ‖ AES-256-GCM(K) ‖ tag` under scrypt of the passphrase, base64. */
  key: string;
  /** HMAC of a fixed word under K's check key, base64: a key that isn't this vault's is told apart. */
  check: string;
  /** The OS-wrapped copy (safeStorage), base64, or null. */
  kept: string | null;
  /** *Lock now*: the kept copy isn't used until the passphrase is typed, across launches too. */
  held?: boolean;
}

const VERSION = 1;
/** A checkpoint another connection held up is tried again this often. */
const CHECKPOINT_RETRY_MS = 2000;
const NONCE = 12;
const TAG = 16;
const KEY = 32;
const SITE_TAG = 16;
const WRAP_AAD = Buffer.from('chord passwords key v1');
const CHECK_WORD = Buffer.from('chord passwords check v1');
const utf8 = (text: string) => Buffer.from(text, 'utf8');
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : num(v));
const bytes = (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.alloc(0));

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
  cipher.setAAD(aad);
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Null when it doesn't open: another key, other associated data, or damage. */
function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer | null {
  if (sealed.length < NONCE + TAG) return null;
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE), { authTagLength: TAG });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(NONCE, sealed.length - TAG)), decipher.final()]);
  } catch {
    return null;
  }
}

/** A sign-in's associated data: the format's version and its id. */
const itemAad = (id: string) => utf8(`chord login v${VERSION}\0${id}`);
const neverAad = (tag: Buffer) => utf8(`chord never v${VERSION}\0${tag.toString('hex')}`);

/** The keys made from K: kept together, wiped together. */
interface Keys {
  root: Buffer;
  item: Buffer;
  index: Buffer;
  /** Seals the names of sites you said never to save for: a key of its own, apart from sign-ins'. */
  never: Buffer;
}

function keysOf(root: Buffer): Keys {
  const derive = (label: string) => Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), label, KEY));
  return { root, item: derive('chord passwords v1 item'), index: derive('chord passwords v1 index'), never: derive('chord passwords v1 never') };
}

/** Whether a key is this vault's: its check matches (a stored check of the wrong length fails closed, never throws). */
const checks = (root: Buffer, meta: { check: string }): boolean => {
  const want = Buffer.from(meta.check, 'base64');
  const got = checkOf(root);
  return want.length === got.length && timingSafeEqual(got, want);
};

/** The check of a key: an HMAC under a key made from it, which is wiped once used. */
function checkOf(root: Buffer): Buffer {
  const key = Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'chord passwords v1 check', KEY));
  const check = createHmac('sha256', key).update(CHECK_WORD).digest();
  key.fill(0);
  return check;
}

/** A sealed sign-in's JSON, as it may come out: anything else is unreadable. */
function secretOf(plain: Buffer | null): LoginSecret | null {
  if (!plain) return null;
  try {
    const s = JSON.parse(plain.toString('utf8')) as Partial<LoginSecret>;
    if (typeof s.origin !== 'string' || typeof s.username !== 'string' || typeof s.password !== 'string') return null;
    const previous = s.previous && typeof s.previous.password === 'string' ? { password: s.previous.password, changedAt: num(s.previous.changedAt) } : null;
    return {
      origin: s.origin,
      username: s.username,
      password: s.password,
      realm: typeof s.realm === 'string' ? s.realm : null,
      note: str(s.note),
      changedAt: num(s.changedAt),
      previous,
      ...(s.unconfirmed === true ? { unconfirmed: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/** A sign-in without its *Not confirmed* mark. */
function confirmed(secret: LoginSecret): LoginSecret {
  const { unconfirmed: _unconfirmed, ...rest } = secret;
  return rest;
}

/** A deleted sign-in, sealed as it was, for its Undo. */
interface Deleted {
  row: { id: string; site_tag: Buffer; sealed: Buffer; created_at: number; updated_at: number };
  uses: { chord_id: string; used_at: number }[];
}

export class PasswordStore {
  private keys: Keys | null = null;
  /** Counts up at each lock: an unlock that was typed before it doesn't open the vault after it. */
  private generation = 0;
  private readonly deleted = new Map<string, Deleted>();

  constructor(
    private readonly sql: Sql,
    /** S15's scrypt parameters; tests pass smaller ones. */
    private readonly kdf: ScryptParams = SCRYPT,
    /**
     * After the key's copies changed (a new passphrase, *Keep unlocked* on or
     * off, *Start over*): chord.db's write-ahead log is checkpointed and cut
     * back, and its migration backups get the vault's row as it is now
     * (ChordDatabase.scrubBackups), so no old copy stays readable there.
     */
    private readonly scrub: (meta: string | null) => void = () => undefined,
  ) {}

  /* ---------- meta and the key ---------- */

  private get meta(): VaultMeta | null {
    const row = this.sql(`SELECT value FROM meta WHERE key = 'passwords'`).get() as Row | undefined;
    if (!row) return null;
    try {
      const meta = JSON.parse(str(row['value'])) as VaultMeta;
      return meta && meta.v === 1 && typeof meta.key === 'string' && typeof meta.check === 'string' && meta.kdf ? meta : null;
    } catch {
      return null;
    }
  }

  private setMeta(meta: VaultMeta | null): void {
    if (meta) this.sql(`INSERT INTO meta (key, value) VALUES ('passwords', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(meta));
    else this.sql(`DELETE FROM meta WHERE key = 'passwords'`).run();
  }

  /**
   * A change to the key's copies, written so the old ones don't linger:
   * SQLite zeroes what it frees while it's written (`secure_delete`), the
   * write-ahead log is checkpointed and truncated, and the backups are
   * rewritten. A checkpoint another connection holds up (an export reading,
   * sync's own checkpoint) answers `busy` without throwing: it's tried again
   * every CHECKPOINT_RETRY_MS, and at close, until it goes through.
   */
  private setKeyMeta(write: () => void): void {
    this.sql('PRAGMA secure_delete = ON').run();
    try {
      write();
    } finally {
      this.sql('PRAGMA secure_delete = OFF').run();
    }
    this.truncate();
    // Backups get the vault as it is, but never the OS-kept copy, nor *Lock now* (a backup restored by hand asks for the passphrase).
    const meta = this.meta;
    try {
      this.scrub(meta ? JSON.stringify({ ...meta, kept: null, held: undefined }) : null);
    } catch {
      // A backup that can't be opened stays as it is; S17's honest limits say so.
    }
  }

  /** Whether the write-ahead log still holds frames from before a change to the key's copies. */
  private truncatePending = false;
  private truncateTimer: ReturnType<typeof setTimeout> | null = null;

  /** Checkpoints and truncates the log; when another connection holds it up, tries again later, and at close. */
  private truncate(): boolean {
    let done: boolean;
    try {
      const result = this.sql('PRAGMA wal_checkpoint(TRUNCATE)').get() as Row | undefined;
      done = num(result?.['busy']) === 0;
    } catch {
      done = false;
    }
    this.truncatePending = !done;
    if (this.truncateTimer) clearTimeout(this.truncateTimer);
    this.truncateTimer = null;
    if (!done) {
      this.truncateTimer = setTimeout(() => {
        this.truncateTimer = null;
        if (this.truncatePending) this.truncate();
      }, CHECKPOINT_RETRY_MS);
      this.truncateTimer.unref?.();
    }
    return done;
  }

  private wrapKey(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
    return nodeCrypto.scrypt(utf8(normalizePassphrase(passphrase)), salt, params, KEY).then((k) => Buffer.from(k.buffer, k.byteOffset, k.byteLength));
  }

  /** K from the passphrase, or null when it's not this vault's. */
  private async unwrap(meta: VaultMeta, passphrase: string): Promise<Buffer | null> {
    const { N, r, p, salt } = meta.kdf;
    const wrap = await this.wrapKey(passphrase, Buffer.from(salt, 'base64'), { N, r, p });
    const root = open(wrap, Buffer.from(meta.key, 'base64'), WRAP_AAD);
    wrap.fill(0);
    if (!root || root.length !== KEY) return null;
    if (!checks(root, meta)) {
      root.fill(0);
      return null;
    }
    return root;
  }

  private async wrapped(root: Buffer, passphrase: string): Promise<Pick<VaultMeta, 'kdf' | 'key'>> {
    const salt = randomBytes(32);
    const wrap = await this.wrapKey(passphrase, salt, this.kdf);
    const key = seal(wrap, root, WRAP_AAD).toString('base64');
    wrap.fill(0);
    return { kdf: { ...this.kdf, salt: salt.toString('base64') }, key };
  }

  private install(root: Buffer): void {
    this.wipe();
    this.keys = keysOf(root);
  }

  private wipe(): void {
    if (!this.keys) return;
    this.keys.root.fill(0);
    this.keys.item.fill(0);
    this.keys.index.fill(0);
    this.keys.never.fill(0);
    this.keys = null;
  }

  private tag(site: string): Buffer {
    return createHmac('sha256', this.keys!.index).update(utf8(site)).digest().subarray(0, SITE_TAG);
  }

  status(): VaultStatus {
    const meta = this.meta;
    const count = num((this.sql('SELECT COUNT(*) AS n FROM login').get() as Row)['n']);
    return { state: !meta ? 'none' : this.keys ? 'open' : 'locked', kept: Boolean(meta?.kept), count };
  }

  /* ---------- rows ---------- */

  private sealSecret(id: string, secret: LoginSecret): Buffer {
    return Buffer.concat([Buffer.from([VERSION]), seal(this.keys!.item, utf8(JSON.stringify(secret)), itemAad(id))]);
  }

  private openRow(row: Row): LoginSecret | null {
    const sealed = bytes(row['sealed']);
    if (sealed[0] !== VERSION) return null;
    return secretOf(open(this.keys!.item, sealed.subarray(1), itemAad(str(row['id']))));
  }

  private summary(row: Row, secret: LoginSecret, chordId: string | null): LoginSummary {
    return {
      id: str(row['id']),
      origin: secret.origin,
      username: secret.username,
      realm: secret.realm,
      note: secret.note,
      createdAt: num(row['created_at']),
      updatedAt: num(row['updated_at']),
      lastUsed: numOrNull(row['last_used']),
      chordUsed: chordId === null ? null : numOrNull(row['chord_used']),
      ...(secret.unconfirmed ? { unconfirmed: true as const } : {}),
    };
  }

  private readonly SELECT = `SELECT l.*, (SELECT MAX(used_at) FROM login_use u WHERE u.login_id = l.id) AS last_used,
       (SELECT used_at FROM login_use u WHERE u.login_id = l.id AND u.chord_id = ?) AS chord_used FROM login l`;

  private rowById(id: string): Row | undefined {
    return this.sql(`${this.SELECT} WHERE l.id = ?`).get('', id) as Row | undefined;
  }

  /** Summaries of rows, opened one at a time; those that don't open are counted. */
  private summaries(rows: Row[], chordId: string | null): { logins: LoginSummary[]; unreadable: number } {
    const logins: LoginSummary[] = [];
    let unreadable = 0;
    for (const row of rows) {
      const secret = this.openRow(row);
      if (secret) logins.push(this.summary(row, secret, chordId));
      else unreadable++;
    }
    return { logins, unreadable };
  }

  private use(id: string, chordId: string, at: number): void {
    this.sql(`INSERT INTO login_use (login_id, chord_id, used_at) VALUES (?, ?, ?) ON CONFLICT(login_id, chord_id) DO UPDATE SET used_at = excluded.used_at`).run(id, chordId, at);
  }

  private insert(login: NewLogin, chordId: string | null, now: number, unconfirmed = false): string | PasswordProblem {
    const origin = loginOrigin(login.origin);
    const site = origin ? loginSite(origin) : null;
    if (!origin || !site || loginProblem({ ...login, origin }) !== null) return 'invalid';
    const id = randomUUID();
    const secret: LoginSecret = {
      origin,
      username: login.username,
      password: login.password,
      realm: login.realm ?? null,
      note: login.note ?? '',
      changedAt: now,
      previous: null,
      ...(unconfirmed ? { unconfirmed: true as const } : {}),
    };
    this.sql('INSERT INTO login (id, site_tag, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, this.tag(site), this.sealSecret(id, secret), now, now);
    if (chordId) this.use(id, chordId, now);
    return id;
  }

  /** A sign-in written again with what changed; a new password keeps the one before it. */
  private rewrite(row: Row, secret: LoginSecret, patch: LoginPatch, now: number): PasswordProblem | null {
    const origin = patch.origin === undefined ? secret.origin : loginOrigin(patch.origin);
    const site = origin ? loginSite(origin) : null;
    if (!origin || !site) return 'invalid';
    const passwordChanged = patch.password !== undefined && patch.password !== secret.password;
    const next: LoginSecret = {
      ...secret,
      origin,
      username: patch.username ?? secret.username,
      password: patch.password ?? secret.password,
      note: patch.note ?? secret.note,
      ...(passwordChanged ? { changedAt: now, previous: { password: secret.password, changedAt: secret.changedAt } } : {}),
    };
    if (loginProblem(next) !== null) return 'invalid';
    const id = str(row['id']);
    this.sql('UPDATE login SET site_tag = ?, sealed = ?, updated_at = ? WHERE id = ?').run(this.tag(site), this.sealSecret(id, next), now, id);
    return null;
  }

  /** The rows saved for the site of an origin. */
  private siteRows(origin: string, chordId: string | null): Row[] {
    const site = loginSite(origin);
    if (!site) return [];
    return this.sql(`${this.SELECT} WHERE l.site_tag = ?`).all(chordId ?? '', this.tag(site)) as Row[];
  }

  /**
   * Whether a saved sign-in may be used where it's asked for (S17 §5, §10). A page's form (`realm` undefined) gets
   * the form sign-ins that `matchLogin` allows. The browser's own sign-in box gets only those saved from that box for
   * exactly its origin (scheme, host and port) and realm: never another port or scheme, never the rest of the site.
   */
  private fits(secret: LoginSecret, origin: string, realm: string | undefined): boolean {
    if (realm === undefined) return secret.realm === null && matchLogin(origin, secret.origin) !== null;
    const exact = loginOrigin(origin);
    return secret.realm === realm && exact !== null && secret.origin === exact;
  }

  /* ---------- ops ---------- */

  async run(op: PasswordOp, now = Date.now()): Promise<PasswordResult> {
    switch (op.op) {
      case 'status':
        return { status: this.status(), generation: this.generation, held: this.meta?.held === true };
      case 'setup': {
        if (this.meta) return { problem: 'exists', status: this.status() };
        if (passphraseProblem(op.passphrase) !== null) return { problem: 'invalid' };
        const generation = this.generation;
        const root = randomBytes(KEY);
        const wrapped = await this.wrapped(root, op.passphrase);
        // Another setup won the race while scrypt ran: its vault stands.
        if (this.meta) {
          root.fill(0);
          return { problem: 'exists', status: this.status() };
        }
        this.setMeta({ v: 1, ...wrapped, check: checkOf(root).toString('base64'), kept: null });
        // Locked while scrypt ran: the vault is made, and locked; the passphrase opens it.
        if (generation !== this.generation) {
          root.fill(0);
          return { problem: 'locked', status: this.status() };
        }
        this.install(root);
        return { status: this.status() };
      }
      case 'unlock': {
        const meta = this.meta;
        if (!meta) return { problem: 'none', status: this.status() };
        const generation = this.generation;
        const root = await this.unwrap(meta, op.passphrase);
        if (!root) return { problem: 'wrong', status: this.status() };
        // Locked again after this was typed (or the passphrase changed meanwhile): locked it stays, and says so.
        if (generation !== this.generation || this.meta?.key !== meta.key) {
          root.fill(0);
          return { problem: 'locked', status: this.status() };
        }
        this.install(root);
        // The passphrase was typed: *Lock now* holds no longer. Read again: meta may have changed while scrypt ran
        // (*Keep unlocked* turned off), and only `held` is this op's to write.
        const latest = this.meta;
        if (latest?.held) this.setMeta({ ...latest, held: false });
        return { status: this.status() };
      }
      case 'open': {
        const meta = this.meta;
        if (!meta) return { problem: 'none', status: this.status() };
        const root = Buffer.from(op.key);
        op.key.fill(0);
        // Locked since main read the status it unwrapped the kept key after (*Lock now* while the OS answered): locked.
        if (op.generation !== undefined && op.generation !== this.generation) {
          root.fill(0);
          return { problem: 'locked', status: this.status() };
        }
        if (meta.held) {
          root.fill(0);
          return { problem: 'locked', status: this.status() };
        }
        if (root.length !== KEY || !checks(root, meta)) {
          root.fill(0);
          return { problem: 'wrong', status: this.status() };
        }
        this.install(root);
        return { status: this.status() };
      }
      case 'lock': {
        this.generation++;
        this.wipe();
        const meta = this.meta;
        if (op.held && meta && !meta.held) this.setMeta({ ...meta, held: true });
        return { status: this.status() };
      }
      case 'verify': {
        const meta = this.meta;
        if (!meta) return { problem: 'none' };
        const root = await this.unwrap(meta, op.passphrase);
        if (!root) return { problem: 'wrong' };
        root.fill(0);
        return {};
      }
      case 'passphrase': {
        const meta = this.meta;
        if (!meta) return { problem: 'none' };
        if (passphraseProblem(op.next) !== null) return { problem: 'invalid' };
        const root = await this.unwrap(meta, op.current);
        if (!root) return { problem: 'wrong' };
        const wrapped = await this.wrapped(root, op.next);
        root.fill(0);
        // The kept copy is of K, which doesn't change: it stays.
        const latest = this.meta;
        if (!latest || latest.key !== meta.key) return { problem: 'refused' };
        // The old wrap opens with the old passphrase: it mustn't stay anywhere. A *Lock now* that came in meanwhile holds.
        this.setKeyMeta(() => this.setMeta({ ...latest, ...wrapped }));
        return { status: this.status() };
      }
      case 'key':
        if (!this.keys) return { problem: 'locked' };
        return { key: new Uint8Array(this.keys.root) };
      case 'keep': {
        const meta = this.meta;
        if (!meta) return { problem: 'none' };
        // Turned off, the OS-wrapped copy mustn't stay anywhere.
        this.setKeyMeta(() => this.setMeta({ ...meta, kept: op.blob }));
        return { status: this.status() };
      }
      case 'kept':
        return { blob: this.meta?.kept ?? null };
      case 'startOver':
        // Open, nothing is forgotten: starting over is for a passphrase that's lost.
        if (this.keys) return { problem: 'refused', status: this.status() };
        this.generation++;
        this.wipe();
        this.deleted.clear();
        this.setKeyMeta(() => {
          this.sql('DELETE FROM login').run();
          this.sql('DELETE FROM login_never').run();
          this.setMeta(null);
        });
        return { status: this.status() };
      default:
        if (!this.keys) return { problem: this.meta ? 'locked' : 'none' };
        await loadSites();
        // Locked while the list loaded (a lock came in behind this op): it waits for the passphrase.
        if (!this.keys) return { problem: 'locked' };
        return this.runOpen(op, now);
    }
  }

  /** The ops that need the vault open. */
  private runOpen(op: PasswordOp, now: number): PasswordResult {
    switch (op.op) {
      case 'list': {
        const rows = this.sql(this.SELECT).all(op.chordId ?? '') as Row[];
        const { logins, unreadable } = this.summaries(rows, op.chordId);
        return { logins, unreadable };
      }
      case 'forSite': {
        const { logins, unreadable } = this.summaries(this.siteRows(op.origin, op.chordId), op.chordId);
        // A form is never offered what the sign-in box saved, nor the box a form's (S17 §10).
        return { logins: logins.filter((l) => (op.realm === undefined ? l.realm === null : l.realm === op.realm && l.origin === loginOrigin(op.origin))), unreadable };
      }
      case 'reveal': {
        const row = this.rowById(op.id);
        const secret = row ? this.openRow(row) : null;
        return secret ? { password: secret.password } : { problem: 'missing' };
      }
      case 'fill': {
        const row = this.rowById(op.id);
        const secret = row ? this.openRow(row) : null;
        if (!secret) return { problem: 'missing' };
        // Never for a page whose origin it doesn't match, whoever asks (S17 §5), nor across a form and the sign-in box: main checks too.
        if (!this.fits(secret, op.origin, op.realm)) return { problem: 'refused' };
        if (op.chordId) this.use(op.id, op.chordId, now);
        return { password: secret.password, loginOrigin: secret.origin, loginRealm: secret.realm };
      }
      case 'used':
        if (!this.rowById(op.id)) return { problem: 'missing' };
        this.use(op.id, op.chordId, now);
        return {};
      case 'add': {
        const id = this.insert(op.login, op.chordId, now);
        return id === 'invalid' ? { problem: 'invalid' } : { id };
      }
      case 'edit': {
        const row = this.rowById(op.id);
        const secret = row ? this.openRow(row) : null;
        if (!row || !secret) return { problem: 'missing' };
        const problem = this.rewrite(row, secret, op.patch, now);
        return problem ? { problem } : { id: op.id };
      }
      case 'revert': {
        const row = this.rowById(op.id);
        const secret = row ? this.openRow(row) : null;
        if (!row || !secret?.previous) return { problem: 'missing' };
        // Changed again since (by hand, another save, an earlier Undo): what's before it isn't what Undo meant.
        if (secret.changedAt !== op.changedAt) return { problem: 'refused' };
        const problem = this.rewrite(row, secret, { password: secret.previous.password }, now);
        return problem ? { problem } : { id: op.id };
      }
      case 'delete': {
        const row = this.sql('SELECT * FROM login WHERE id = ?').get(op.id) as Row | undefined;
        if (!row) return { problem: 'missing' };
        const uses = (this.sql('SELECT chord_id, used_at FROM login_use WHERE login_id = ?').all(op.id) as Row[]).map((u) => ({ chord_id: str(u['chord_id']), used_at: num(u['used_at']) }));
        this.deleted.set(op.id, {
          row: { id: op.id, site_tag: bytes(row['site_tag']), sealed: bytes(row['sealed']), created_at: num(row['created_at']), updated_at: num(row['updated_at']) },
          uses,
        });
        this.sql('DELETE FROM login WHERE id = ?').run(op.id);
        return { id: op.id };
      }
      case 'undelete': {
        const gone = this.deleted.get(op.id);
        if (!gone) return { problem: 'missing' };
        this.deleted.delete(op.id);
        const { row } = gone;
        this.sql('INSERT OR IGNORE INTO login (id, site_tag, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(row.id, row.site_tag, row.sealed, row.created_at, row.updated_at);
        for (const u of gone.uses) this.use(row.id, u.chord_id, u.used_at);
        return { id: op.id };
      }
      case 'compare': {
        let best: { id: string; same: boolean; exact: boolean } | null = null;
        for (const row of this.siteRows(op.origin, null)) {
          const secret = this.openRow(row);
          if (!secret || secret.username !== op.username || !this.fits(secret, op.origin, op.realm)) continue;
          const match = matchLogin(op.origin, secret.origin);
          if (!match) continue;
          const found = { id: str(row['id']), same: secret.password === op.password, exact: match !== 'site' };
          // The page's own origin over the rest of its site; a sign-in that already has this password over one that doesn't.
          if (!best || (found.exact && !best.exact) || (found.exact === best.exact && found.same && !best.same)) best = found;
        }
        if (!best) return { candidate: { kind: 'new' } };
        return { candidate: best.same ? { kind: 'same', id: best.id } : { kind: 'update', id: best.id } };
      }
      case 'save': {
        if (op.replace) {
          const row = this.rowById(op.replace);
          const secret = row ? this.openRow(row) : null;
          if (!row || !secret) return { problem: 'missing' };
          if (!this.fits(secret, op.origin, op.realm)) return { problem: 'refused' };
          // Saved on http and now signed in on https: it moves to https (S17 §5). A sign-in box's never moves.
          const upgrade = op.realm === undefined && matchLogin(op.origin, secret.origin) === 'upgrade' ? { origin: op.origin } : {};
          // Saved after a sign-in that worked, or from a card you answered: a *Not confirmed* one is confirmed by it.
          const problem = this.rewrite(row, confirmed(secret), { ...upgrade, username: op.username, password: op.password }, now);
          if (problem) return { problem };
          if (op.chordId) this.use(op.replace, op.chordId, now);
          return { id: op.replace, changedAt: secret.password === op.password ? secret.changedAt : now };
        }
        const id = this.insert({ origin: op.origin, username: op.username, password: op.password, ...(op.realm !== undefined ? { realm: op.realm } : {}) }, op.chordId, now);
        return id === 'invalid' ? { problem: 'invalid' } : { id };
      }
      case 'presave': {
        const id = this.insert({ origin: op.origin, username: '', password: op.password }, op.chordId, now, true);
        return id === 'invalid' ? { problem: 'invalid' } : { id };
      }
      case 'pending':
      case 'confirm': {
        const row = this.rowById(op.id);
        const secret = row ? this.openRow(row) : null;
        if (!row || !secret) return { problem: 'missing' };
        // Only a page's form sign-in for this page, still *Not confirmed*: a confirmed one is changed by Save or Settings.
        if (!secret.unconfirmed || !this.fits(secret, op.origin, undefined)) return { problem: 'refused' };
        const patch: LoginPatch = { ...(op.username !== undefined ? { username: op.username } : {}), ...(op.password !== undefined ? { password: op.password } : {}) };
        const problem = this.rewrite(row, op.op === 'confirm' ? confirmed(secret) : secret, patch, now);
        return problem ? { problem } : { id: op.id };
      }
      case 'matchCurrent': {
        const logins: LoginSummary[] = [];
        for (const row of this.siteRows(op.origin, null)) {
          const secret = this.openRow(row);
          if (secret && secret.password === op.current && this.fits(secret, op.origin, undefined)) logins.push(this.summary(row, secret, null));
        }
        return { logins };
      }
      case 'never': {
        const site = loginSite(op.origin);
        if (!site) return { problem: 'invalid' };
        const tag = this.tag(site);
        this.sql('INSERT OR IGNORE INTO login_never (site_tag, sealed, created_at) VALUES (?, ?, ?)').run(tag, seal(this.keys!.never, utf8(site), neverAad(tag)), now);
        return { never: true };
      }
      case 'isNever': {
        const site = loginSite(op.origin);
        return { never: site !== null && this.sql('SELECT 1 FROM login_never WHERE site_tag = ?').get(this.tag(site)) !== undefined };
      }
      case 'nevers': {
        const nevers: string[] = [];
        for (const row of this.sql('SELECT site_tag, sealed FROM login_never ORDER BY created_at DESC').all() as Row[]) {
          const site = open(this.keys!.never, bytes(row['sealed']), neverAad(bytes(row['site_tag'])));
          if (site) nevers.push(site.toString('utf8'));
        }
        return { nevers };
      }
      case 'forgetNever':
        this.sql('DELETE FROM login_never WHERE site_tag = ?').run(this.tag(op.site));
        return { never: false };
      default:
        return { problem: 'invalid' };
    }
  }

  /** chord-data closing, or opening another database: the key goes. */
  close(): void {
    this.generation++;
    this.wipe();
    this.deleted.clear();
    if (this.truncateTimer) clearTimeout(this.truncateTimer);
    this.truncateTimer = null;
    // The last try before the connection goes (closing checkpoints too, once no other connection reads).
    if (this.truncatePending) this.truncate();
    if (this.truncateTimer) clearTimeout(this.truncateTimer);
    this.truncateTimer = null;
  }
}
