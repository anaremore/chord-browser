/**
 * Safe Browsing's Local List Mode (developers.google.com/safe-browsing/reference/Local.List.Mode):
 * Google's threat lists kept here as sorted 4-byte SHA-256 prefixes, updated
 * with hashLists.batchGet, and the "Local Threat List URL Check Procedure".
 * An address is expanded into its expressions and hashed; a prefix that's in
 * a list but not answered by the cache has to be asked about (hashes.search,
 * which sees only the 4-byte prefix). Only a full hash from an unexpired
 * answer makes an address unsafe.
 *
 * No Electron and no network: it runs in Safe Browsing's worker thread, and
 * in unit tests. The lists are hashes of unsafe sites, so they're saved to
 * disk; the cache comes from your browsing, so it never is.
 */
import { createHash } from 'node:crypto';
import type { ThreatKind } from '@chord/core';
import type { FullHashDetail, HashListUpdate, SearchAnswer } from './proto';
import { decodeRice32, RiceError } from './rice';
import { urlExpressions } from './url';

/** The desktop threat lists, 4-byte prefixes: social engineering, malware, unwanted software. Their names never change. */
export const LIST_NAMES = ['se-4b', 'mw-4b', 'uws-4b'] as const;
export type ListName = (typeof LIST_NAMES)[number];

/** What an address is being checked for: a page or frame, or a file's download. */
export type Purpose = 'frame' | 'download';

export type Verdict = { verdict: 'safe' } | { verdict: 'unsafe'; kind: ThreatKind; url: string };
/** A check that needs the service: these prefixes are in a list, and the cache doesn't answer them. */
export type CheckStep = Verdict | { verdict: 'search'; prefixes: number[] };

/** ThreatType numbers (safebrowsing.proto). */
const MALWARE = 1;
const SOCIAL_ENGINEERING = 2;
const UNWANTED_SOFTWARE = 3;
const POTENTIALLY_HARMFUL_APPLICATION = 4;
/** ThreatAttribute numbers. */
const CANARY = 1;
const FRAME_ONLY = 2;

/** Worst first, when an address matches more than one. */
const SEVERITY: ThreatKind[] = ['malware', 'phishing', 'unwanted'];

/** The cache keeps at most this many prefixes (it's in memory only). */
const MAX_CACHE = 20_000;

interface List {
  name: ListName;
  version: Uint8Array;
  prefixes: Uint32Array;
  /** SHA-256 of the prefixes (the service's checksum), so a damaged file is caught when it's read back. */
  checksum: Uint8Array | null;
  /** Not to be asked for again before this (minimumWaitDuration). */
  nextAt: number;
}

interface CacheEntry {
  expiresAt: number;
  /** Full hashes (hex) the service knows under this prefix, with what they are. */
  hashes: Map<string, FullHashDetail[]>;
}

export const prefixOf = (hash: Uint8Array): number => ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0;
const sha256 = (data: string | Uint8Array): Buffer => createHash('sha256').update(data).digest();

/** SHA-256 of the prefixes as 4-byte big-endian values, in order: the list's checksum. */
export function checksumOf(prefixes: Uint32Array): Uint8Array {
  const bytes = Buffer.allocUnsafe(prefixes.length * 4);
  for (let i = 0; i < prefixes.length; i++) bytes.writeUInt32BE(prefixes[i]!, i * 4);
  return sha256(bytes);
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function contains(sorted: Uint32Array, value: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid]!;
    if (v === value) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Two ascending arrays as one. */
function merge(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i]! <= b[j]! ? a[i++]! : b[j++]!;
  while (i < a.length) out[k++] = a[i++]!;
  while (j < b.length) out[k++] = b[j++]!;
  return out;
}

/** What a full hash is a threat of, for this purpose; null when none of its details apply. */
function threatOf(details: readonly FullHashDetail[], purpose: Purpose): ThreatKind | null {
  let worst: ThreatKind | null = null;
  for (const detail of details) {
    // "Clients MUST check every ThreatType and ThreatAttribute for validity"; an invalid one voids its detail.
    if (detail.threatType < MALWARE || detail.threatType > POTENTIALLY_HARMFUL_APPLICATION) continue;
    if (detail.attributes.some((a) => a !== CANARY && a !== FRAME_ONLY)) continue;
    // CANARY: not for enforcement. FRAME_ONLY: only for pages and frames, so never a download.
    if (detail.attributes.includes(CANARY)) continue;
    if (detail.attributes.includes(FRAME_ONLY) && purpose !== 'frame') continue;
    const kind: ThreatKind | null =
      detail.threatType === MALWARE ? 'malware' : detail.threatType === SOCIAL_ENGINEERING ? 'phishing' : detail.threatType === UNWANTED_SOFTWARE ? 'unwanted' : null;
    // Downloads are checked for malware and unwanted software, as Chrome does.
    if (!kind || (purpose === 'download' && kind === 'phishing')) continue;
    if (worst === null || SEVERITY.indexOf(kind) < SEVERITY.indexOf(worst)) worst = kind;
  }
  return worst;
}

export class ListError extends Error {}

export class SafeBrowsingDatabase {
  private readonly lists = new Map<ListName, List>();
  private readonly cache = new Map<number, CacheEntry>();
  /** When the lists read from disk were saved (null for new ones). */
  savedAt: number | null = null;

  /** Prefixes across the lists. */
  get entries(): number {
    let n = 0;
    for (const list of this.lists.values()) n += list.prefixes.length;
    return n;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  /** The lists that may be asked for now, with the versions Chord has (none for a list it doesn't have). */
  due(now: number): { name: ListName; version: Uint8Array | null }[] {
    return LIST_NAMES.filter((name) => (this.lists.get(name)?.nextAt ?? 0) <= now).map((name) => {
      const version = this.lists.get(name)?.version;
      return { name, version: version && version.length > 0 ? version : null };
    });
  }

  /** When the next list may be asked for. */
  nextUpdateAt(): number {
    return Math.min(...LIST_NAMES.map((name) => this.lists.get(name)?.nextAt ?? 0));
  }

  /** Hold off every list until `at` (after the service failed). */
  deferAll(at: number): void {
    for (const name of LIST_NAMES) {
      const list = this.lists.get(name);
      if (list) list.nextAt = Math.max(list.nextAt, at);
      else this.lists.set(name, { name, version: new Uint8Array(0), prefixes: new Uint32Array(0), checksum: null, nextAt: at });
    }
  }

  /**
   * Apply a hashLists.batchGet answer: a full list replaces what's kept; a
   * partial one removes by index, then adds. A list whose checksum doesn't
   * match is dropped, so the next update is a full one. Returns the names
   * that failed.
   */
  apply(updates: readonly HashListUpdate[], now: number): ListName[] {
    const failed: ListName[] = [];
    for (const update of updates) {
      const name = LIST_NAMES.find((n) => n === update.name);
      if (!name) continue;
      const wait = update.minimumWaitMs && update.minimumWaitMs > 0 ? update.minimumWaitMs : 0;
      try {
        this.lists.set(name, { ...this.updated(name, update), nextAt: now + wait });
      } catch (error) {
        if (!(error instanceof ListError || error instanceof RiceError)) throw error;
        // Corrupt or out of step: start over with a full update (no version), after the wait the service asked for.
        this.lists.set(name, { name, version: new Uint8Array(0), prefixes: new Uint32Array(0), checksum: null, nextAt: now + wait });
        failed.push(name);
      }
    }
    return failed;
  }

  private updated(name: ListName, update: HashListUpdate): Omit<List, 'nextAt'> {
    if (update.otherAdditions) throw new ListError(`${name}: additions of another prefix length`);
    const current = this.lists.get(name);
    let prefixes: Uint32Array;
    if (update.partialUpdate) {
      if (!current || current.version.length === 0) throw new ListError(`${name}: a partial update for a list Chord doesn't have`);
      prefixes = current.prefixes;
      // A message that's there holds at least its first value (an empty one is index 0), as in Chromium's v4 store.
      if (update.removals) {
        const indices = decodeRice32(update.removals, { strict: true });
        if (indices[indices.length - 1]! >= prefixes.length) throw new ListError(`${name}: a removal past the end`);
        const kept = new Uint32Array(prefixes.length - indices.length);
        let next = 0;
        let k = 0;
        for (let i = 0; i < prefixes.length; i++) {
          if (next < indices.length && indices[next] === i) next++;
          else kept[k++] = prefixes[i]!;
        }
        prefixes = kept;
      }
    } else {
      prefixes = new Uint32Array(0);
    }
    if (update.additions) prefixes = merge(prefixes, decodeRice32(update.additions));
    // "The client should check the stored data against the checksum provided by the server." Omitted means nothing changed.
    const checksum = checksumOf(prefixes);
    if (update.checksum && !sameBytes(checksum, update.checksum)) throw new ListError(`${name}: checksum mismatch`);
    return { name, version: update.version.length > 0 ? update.version : (current?.version ?? new Uint8Array(0)), prefixes, checksum };
  }

  /** Whether any list holds this prefix. */
  has(prefix: number): boolean {
    for (const list of this.lists.values()) if (contains(list.prefixes, prefix)) return true;
    return false;
  }

  /**
   * Google's check procedure, up to the network: the cache first (an
   * unexpired entry answers its prefix; an expired one goes), then the
   * lists. Prefixes left over must be asked about.
   */
  check(urls: readonly string[], purpose: Purpose, now: number): CheckStep {
    const remaining = new Set<number>();
    for (const url of urls) {
      for (const expression of urlExpressions(url)) {
        const hash = sha256(expression);
        const prefix = prefixOf(hash);
        const entry = this.cache.get(prefix);
        if (entry && now > entry.expiresAt) this.cache.delete(prefix);
        else if (entry) {
          const details = entry.hashes.get(hash.toString('hex'));
          const kind = details ? threatOf(details, purpose) : null;
          if (kind) return { verdict: 'unsafe', kind, url };
          continue;
        }
        remaining.add(prefix);
      }
    }
    for (const prefix of remaining) if (!this.has(prefix)) remaining.delete(prefix);
    return remaining.size === 0 ? { verdict: 'safe' } : { verdict: 'search', prefixes: [...remaining] };
  }

  /**
   * Cache a hashes.search answer: its expiry holds for every prefix asked
   * about, found or not ("this fact MUST also be cached"). An answer with no
   * expiry isn't cached at all, so its prefixes count as an error: safe.
   */
  remember(asked: readonly number[], answer: SearchAnswer, now: number): boolean {
    if (answer.cacheDurationMs === null || answer.cacheDurationMs < 0) return false;
    const expiresAt = now + answer.cacheDurationMs;
    for (const prefix of asked) this.cache.set(prefix, { expiresAt, hashes: new Map() });
    for (const { fullHash, details } of answer.fullHashes) {
      if (fullHash.length !== 32) continue;
      const prefix = prefixOf(fullHash);
      const entry = this.cache.get(prefix) ?? { expiresAt, hashes: new Map<string, FullHashDetail[]>() };
      entry.hashes.set(Buffer.from(fullHash).toString('hex'), details);
      this.cache.set(prefix, entry);
    }
    this.trimCache(now);
    return true;
  }

  private trimCache(now: number): void {
    if (this.cache.size <= MAX_CACHE) return;
    for (const [prefix, entry] of this.cache) if (now > entry.expiresAt) this.cache.delete(prefix);
    // Still too many: the oldest go first (Map keeps insertion order).
    for (const prefix of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHE) break;
      this.cache.delete(prefix);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  /* ---------- On disk ---------- */

  /**
   * The lists as a file: "CSB1", a JSON header (names, versions, counts,
   * checksums, when each may be asked for again), then each list's prefixes
   * as little-endian 32-bit values.
   */
  serialize(savedAt: number): Uint8Array {
    const lists = LIST_NAMES.map((name) => this.lists.get(name)).filter((l): l is List => l !== undefined);
    const header = Buffer.from(
      JSON.stringify({
        savedAt,
        lists: lists.map((l) => ({
          name: l.name,
          version: Buffer.from(l.version).toString('base64'),
          count: l.prefixes.length,
          checksum: l.checksum ? Buffer.from(l.checksum).toString('base64') : null,
          nextAt: l.nextAt,
        })),
      }),
    );
    const size = 8 + header.length + lists.reduce((n, l) => n + l.prefixes.length * 4, 0);
    const out = Buffer.alloc(size);
    out.write('CSB1', 0, 'latin1');
    out.writeUInt32LE(header.length, 4);
    header.copy(out, 8);
    let at = 8 + header.length;
    for (const list of lists) {
      for (const prefix of list.prefixes) {
        out.writeUInt32LE(prefix, at);
        at += 4;
      }
    }
    return out;
  }

  /** Lists read back from a file. A list whose prefixes don't match its checksum is left out (it updates in full). */
  static parse(file: Uint8Array): SafeBrowsingDatabase {
    const db = new SafeBrowsingDatabase();
    const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
    if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'CSB1') return db;
    const headerLength = buf.readUInt32LE(4);
    if (8 + headerLength > buf.length) return db;
    let header: { savedAt?: number; lists?: { name: string; version: string; count: number; checksum: string | null; nextAt: number }[] };
    try {
      header = JSON.parse(buf.toString('utf8', 8, 8 + headerLength)) as typeof header;
    } catch {
      return db;
    }
    if (typeof header.savedAt === 'number' && Number.isFinite(header.savedAt)) db.savedAt = header.savedAt;
    let at = 8 + headerLength;
    for (const entry of header.lists ?? []) {
      const count = Number(entry.count);
      if (!Number.isInteger(count) || count < 0 || at + count * 4 > buf.length) break;
      const prefixes = new Uint32Array(count);
      for (let i = 0; i < count; i++) prefixes[i] = buf.readUInt32LE(at + i * 4);
      at += count * 4;
      const name = LIST_NAMES.find((n) => n === entry.name);
      const checksum = entry.checksum ? new Uint8Array(Buffer.from(entry.checksum, 'base64')) : null;
      if (!name || !checksum || !sameBytes(checksumOf(prefixes), checksum)) continue;
      const nextAt = Number.isFinite(entry.nextAt) ? entry.nextAt : 0;
      db.lists.set(name, { name, version: new Uint8Array(Buffer.from(entry.version ?? '', 'base64')), prefixes, checksum, nextAt });
    }
    return db;
  }
}
