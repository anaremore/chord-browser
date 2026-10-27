/**
 * Main's writes, as chord-data takes them (worker.ts; the sync simulation runs
 * the same): each on the next turn, so a search that came in behind it is
 * answered first, then answered, and sync told what happened. A batch too big
 * for one short transaction (a chord with thousands of tabs going) goes a part
 * at a time (`writeSteps`), each on a turn of its own, searches answered
 * between; it's answered once all of it is in.
 */
import type { DataResponse, HistoryEvent, WriteOp } from '@chord/data';
import { errorPasses, type ChordDatabase } from '@chord/data/db';
import type { SyncController } from './sync';

/** One batch main sent (`id`), written in `writing` unless chord-data has moved on to another database (`current`). */
export function writeBatch(
  writing: ChordDatabase,
  current: () => ChordDatabase | null,
  sync: Pick<SyncController, 'afterWrite' | 'writeRefused' | 'tookWrite' | 'writingInParts'>,
  request: { id: number; ops: WriteOp[]; events: HistoryEvent[] },
  reply: (response: DataResponse) => void,
): void {
  const { id, ops, events } = request;
  let steps: Generator<void, void> | null = null;
  // On the next turn: a search that came in behind it (the command bar typing while sync applies) is answered first,
  // rather than waiting out the write. Main sends one write at a time and waits for its answer, so they stay in order.
  const step = () => {
    try {
      if (current() !== writing) throw new Error('chord-data: closed');
      const at = performance.now();
      const stamping = writing.sync.stamping;
      steps ??= writing.writeSteps(ops, Date.now(), events);
      const next = steps.next();
      writing.sync.timed(stamping ? 'write' : 'writeOff', performance.now() - at);
      if (!next.done) {
        // In parts: no checkpoint on this thread meanwhile (one can take tens of ms), as while sync merges.
        sync.writingInParts();
        setImmediate(step);
        return;
      }
      reply({ id, ok: true, seq: sync.tookWrite() });
      // What sync stamped goes to the folder a moment after the last change.
      sync.afterWrite();
    } catch (error) {
      reply({ id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error), passing: errorPasses(error) });
      // Refused (a full disk): what sync applied isn't in chord.db, and a reconcile finds it again.
      sync.writeRefused();
    }
  };
  setImmediate(step);
}
