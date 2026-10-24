/**
 * The filter lists as files (ARCHITECTURE.md §9): which lists, what a list
 * says about itself in its header, whether a download is really that list,
 * and when to ask its host again. Pure and dependency-free: the build runs it
 * too (electron.vite.config.ts).
 */

/** The lists Chord blocks with: bundled at build time, refreshed from their own host, never through Chord. */
export const FILTER_LISTS = [
  { id: 'easylist', name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'easyprivacy', name: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
] as const;

export type ListId = (typeof FILTER_LISTS)[number]['id'];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A list's own `! Expires:` decides when it's fetched again, within these bounds. */
export const MIN_REFRESH_MS = 12 * HOUR;
export const MAX_REFRESH_MS = 14 * DAY;
/** EasyList and EasyPrivacy both say 4 days. */
export const DEFAULT_REFRESH_MS = 4 * DAY;
/** A list smaller or larger than this isn't the list (an error page, or something else entirely). */
const MIN_LIST_BYTES = 50_000;
const MAX_LIST_BYTES = 30_000_000;

export interface ListHeader {
  title: string | null;
  /** `! Version: 202610241745`. */
  version: string | null;
  /** `! Expires: 4 days`, in ms, bounded; the default when it's missing. */
  refreshMs: number;
}

/** What a list's header says (only the first lines are read). */
export function listHeader(text: string): ListHeader {
  const head = text.slice(0, 4000);
  const field = (name: string) => new RegExp(`^! ${name}:[ \\t]*(.+?)[ \\t]*$`, 'mi').exec(head)?.[1] ?? null;
  const expires = /^(\d+)\s*(day|hour)s?/i.exec(field('Expires') ?? '');
  const refreshMs = expires ? Number(expires[1]) * (expires[2]!.toLowerCase() === 'day' ? DAY : HOUR) : DEFAULT_REFRESH_MS;
  return { title: field('Title'), version: field('Version'), refreshMs: Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, refreshMs)) };
}

/** Whether a download is the list it should be: an Adblock Plus list with the expected title, a version, and a plausible size. */
export function isList(text: string, title: string): boolean {
  if (text.length < MIN_LIST_BYTES || text.length > MAX_LIST_BYTES) return false;
  if (!/^\uFEFF?\[Adblock Plus [\d.]+\]/.test(text)) return false;
  const header = listHeader(text);
  return header.title === title && header.version !== null;
}

/** What a compiled set says about itself (its `lists.json`). */
export interface CompiledInfo {
  /** Each list's `! Version:`. */
  versions: Record<ListId, string>;
  /** Each list's `! Expires:`, in ms. */
  refreshMs: Record<ListId, number>;
  /** Filters, rules written, and filters skipped by reason, per list. */
  stats: Record<ListId, { filters: number; rules: number; skipped: Record<string, number> }>;
}

/** Whether one compiled set is newer than another: no list older, at least one newer. */
export function isNewer(a: CompiledInfo['versions'], b: CompiledInfo['versions']): boolean {
  return FILTER_LISTS.every((l) => (a[l.id] ?? '') >= (b[l.id] ?? '')) && FILTER_LISTS.some((l) => (a[l.id] ?? '') > (b[l.id] ?? ''));
}

/** A compiled set's version as one string: it changes whenever either list does. */
export const setVersion = (versions: CompiledInfo['versions']): string => FILTER_LISTS.map((l) => `${l.id}@${versions[l.id] ?? ''}`).join(',');

/** After a failed refresh: 15 minutes × 2^(n−1) × (1 + random), at most a day. */
export function backoffMs(failures: number, random = Math.random()): number {
  return Math.min(DAY, 15 * 60_000 * 2 ** Math.max(0, failures - 1) * (1 + random));
}
