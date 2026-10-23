/** What main and Safe Browsing's worker thread say to each other (worker.ts, service.ts). */
import type { CheckStep, ListName, Purpose, Verdict } from './database';

export type WorkerRequest =
  /** Read the lists saved at `file` (if any). Everything after waits for it. */
  | { type: 'open'; file: string }
  /** Which lists may be asked for now, with their versions (base64). */
  | { type: 'due'; now: number }
  /** A hashLists.batchGet answer to asking for `asked`: apply it and save the lists. */
  | { type: 'update'; body: Uint8Array; json: boolean; now: number; asked?: ListName[] }
  /** The service failed: ask again no sooner than `at` (saved, so a restart respects it too). */
  | { type: 'defer'; at: number }
  | { type: 'check'; urls: string[]; purpose: Purpose; now: number }
  /** hashes.search answered for `prefixes` (null: it failed, so the answer is SAFE): cache it and finish the check. */
  | { type: 'searched'; prefixes: number[]; body: Uint8Array | null; json: boolean; urls: string[]; purpose: Purpose; now: number }
  /** Turned off: forget the cache, which came from browsing. */
  | { type: 'forget' };

export interface OpenResult {
  entries: number;
  nextUpdateAt: number;
  savedAt: number | null;
}
export interface DueResult {
  lists: { name: ListName; version: string | null }[];
  nextUpdateAt: number;
}
export interface UpdateResult {
  failed: ListName[];
  entries: number;
  nextUpdateAt: number;
}
/** A check's answer, and how long the worker spent on it (ms). */
export type CheckResult = CheckStep & { took: number };
export type SearchedResult = Verdict;

export type WorkerMessage = WorkerRequest & { id: number };
export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
