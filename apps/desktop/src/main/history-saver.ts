/**
 * Open tabs' back/forward history, saved so a restart or a crash brings each
 * tab back where it was: the same page, its history, its scroll position and
 * form fields (ARCHITECTURE.md §6.2). A tab is saved about two seconds after
 * it navigates, within 30 seconds while you scroll or type in it, when it
 * falls asleep, and on quit. Only what changed is written, and with nothing
 * to write no timer runs. A private window's tabs are never saved. No
 * Electron imports, so it's unit-testable.
 */
import { createHash } from 'node:crypto';
import type { NodeId } from '@chord/core';
import type { NavState } from '@chord/data';

export interface HistorySaverDeps {
  /** The tab's history as it is now, or as it fell asleep. */
  history(nodeId: NodeId): NavState | null;
  save(nodeId: NodeId, nav: NavState | null): void;
  /** A tab whose history may be kept: it still exists, and isn't in a private window. */
  savable(nodeId: NodeId): boolean;
}

export const SAVE_SOON_MS = 2000;
export const SAVE_EVERY_MS = 30_000;

/** A short fingerprint of a history, so an unchanged one isn't written again (page state can run to hundreds of KB). */
const fingerprint = (nav: NavState | null) => createHash('sha1').update(JSON.stringify(nav)).digest('base64');

export class HistorySaver {
  private readonly dirty = new Set<NodeId>();
  private readonly saved = new Map<NodeId, string>();
  private soon: ReturnType<typeof setTimeout> | undefined;
  private later: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: HistorySaverDeps,
    private readonly timing = { soonMs: SAVE_SOON_MS, everyMs: SAVE_EVERY_MS },
  ) {}

  /** Something changed in a tab: saved `soon` after a navigation, otherwise within the regular wait. */
  touch(nodeId: NodeId, soon = false): void {
    this.dirty.add(nodeId);
    if (soon) this.soon ??= this.flushIn(this.timing.soonMs);
    else this.later ??= this.flushIn(this.timing.everyMs);
  }

  private flushIn(ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.flush(), ms);
    timer.unref?.();
    return timer;
  }

  /** Write every changed tab's history now (on quit, and before views are torn down). */
  flush(): void {
    // All of it is written now, so neither timer needs to fire.
    this.stop();
    for (const nodeId of this.dirty) {
      this.dirty.delete(nodeId);
      if (!this.deps.savable(nodeId)) {
        this.saved.delete(nodeId);
        continue;
      }
      const nav = this.deps.history(nodeId);
      const print = fingerprint(nav);
      if (this.saved.get(nodeId) === print) continue;
      this.saved.set(nodeId, print);
      this.deps.save(nodeId, nav);
    }
  }

  /** What was restored at launch is already saved: no need to write it again. */
  restored(nodeId: NodeId, nav: NavState): void {
    this.saved.set(nodeId, fingerprint(nav));
  }

  /** A tab closed: nothing more to save for it. */
  forget(nodeId: NodeId): void {
    this.dirty.delete(nodeId);
    this.saved.delete(nodeId);
  }

  stop(): void {
    clearTimeout(this.soon);
    clearTimeout(this.later);
    this.soon = this.later = undefined;
  }
}
