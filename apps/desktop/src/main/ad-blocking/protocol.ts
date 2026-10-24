/** Messages between main and ad blocking's worker thread (worker.ts). */
import type { CompiledInfo, ListId } from './lists';

export type WorkerRequest =
  /** Load the engine: the newest compiled set's `engine.bin`, read by main (a bundled one is inside the asar) and transferred. */
  | { type: 'open'; bytes: Uint8Array }
  /** Element hiding for a page: a stylesheet of `display: none` rules, or '' for none. */
  | { type: 'css'; url: string }
  /** A private window's request: whether the lists block it. `sourceUrl` is the page or frame asking. */
  | { type: 'match'; url: string; sourceUrl: string; resourceType: string }
  /**
   * Compile downloaded lists (raw bytes, or null to reuse the copy in `from`)
   * into `out`, replacing what's there. Run in a worker of its own, so pages
   * never wait behind it.
   */
  | { type: 'compile'; lists: Record<ListId, Uint8Array | null>; from: string[]; out: string };

export type WorkerMessage = WorkerRequest & { id: number };

export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export interface CompileResult {
  info: CompiledInfo;
  /** Rules written, all lists together. */
  rules: number;
  took: number;
}
