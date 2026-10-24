/**
 * Tidying up (ARCHITECTURE.md §7, §9): every few minutes, and when the
 * computer wakes, Today tabs unused for longer than Settings allows go to the
 * archive, and background tabs unused for an hour go to sleep. When the
 * computer runs low on memory (checked every 30 seconds), background tabs go
 * to sleep after 5 minutes instead. Tabs that are playing, using the camera or
 * microphone, sharing the screen or being shared, or in picture-in-picture
 * are left alone.
 */
import { archiveCandidates, sleepCandidates, type ArchiveAfter, type Command, type NodeId, type State } from '@chord/core';
import { powerMonitor } from 'electron';
import type { TabManager } from './tabs';

export interface IdleTiming {
  /** How often to look. */
  checkMs: number;
  /** How long a Today tab may sit unused for each setting (null: never archive). */
  archiveAfterMs(setting: ArchiveAfter): number | null;
  sleepAfterMs: number;
  /** How long a background tab may sit hidden while memory is low. */
  pressureSleepAfterMs: number;
  /** How often to ask whether memory is low. */
  memoryCheckMs: number;
}

export interface IdleDeps {
  state(): State;
  dispatch(command: Command): void;
  tabs: Pick<TabManager, 'loaded' | 'isPlaying' | 'inPictureInPicture'>;
  /** The tab's page was given the camera or microphone. */
  isCapturing(nodeId: NodeId): boolean;
  /** The computer is low on memory (memory.ts). */
  memoryLow(): boolean;
}

export class IdleKeeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private memoryTimer: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private readonly onResume = () => void this.check();

  constructor(
    private readonly deps: IdleDeps,
    private readonly timing: IdleTiming,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.timing.checkMs);
    // Low on memory: look now, with the shorter wait, rather than at the next regular check.
    this.memoryTimer = setInterval(() => {
      if (this.deps.memoryLow()) void this.check();
    }, this.timing.memoryCheckMs);
    powerMonitor.on('resume', this.onResume);
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.memoryTimer);
    this.timer = undefined;
    this.memoryTimer = undefined;
    powerMonitor.off('resume', this.onResume);
  }

  /** Archive and put to sleep whatever has been idle long enough. */
  async check(now = Date.now()): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const { state, dispatch, tabs, isCapturing } = this.deps;
      const busy = new Set<NodeId>();
      for (const id of Object.keys(state().nodes)) {
        const live = state().live[id];
        if (live?.audible || live?.pip || live?.sharing || live?.shared || tabs.isPlaying(id) || isCapturing(id)) busy.add(id);
      }
      // Picture-in-picture means asking the page, so only for tabs that would otherwise go.
      const settings = state().settings;
      const afterMs = this.timing.archiveAfterMs(settings.archiveAfter);
      // Asking takes a moment, in which you might have opened one of them: check again before acting.
      const toArchive = () => archiveCandidates(state(), now, afterMs, busy);
      const archive = await this.withoutPictureInPicture(toArchive(), busy);
      const stillIdle = new Set(toArchive());
      const archived = archive.filter((id) => stillIdle.has(id));
      if (archived.length > 0) dispatch({ t: 'tab.archive', nodeIds: archived, reason: 'auto' });
      if (!state().settings.sleepTabs) return;
      const sleepAfterMs = this.deps.memoryLow() ? Math.min(this.timing.sleepAfterMs, this.timing.pressureSleepAfterMs) : this.timing.sleepAfterMs;
      const toSleep = () => sleepCandidates(state(), now, sleepAfterMs, tabs.loaded(), busy);
      const sleep = await this.withoutPictureInPicture(toSleep(), busy);
      const stillHidden = new Set(toSleep());
      for (const nodeId of sleep) if (stillHidden.has(nodeId)) dispatch({ t: 'tab.sleep', nodeId });
    } finally {
      this.checking = false;
    }
  }

  private async withoutPictureInPicture(ids: NodeId[], busy: Set<NodeId>): Promise<NodeId[]> {
    const out: NodeId[] = [];
    for (const id of ids) {
      if (await this.deps.tabs.inPictureInPicture(id)) busy.add(id);
      else out.push(id);
    }
    return out;
  }
}
