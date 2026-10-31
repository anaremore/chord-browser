/**
 * What sync's worker thread does (sync-worker.ts runs it; the sync simulation
 * runs it in-process, over a folder in memory), inside chord-data's process (docs/decisions/S15-your-data.md
 * §7, §13): the folder work, so a slow cloud folder, scrypt or a big snapshot
 * never touches the thread that answers the command bar's searches. It reads
 * and writes `<folder>/Chord sync` through core's folder protocol
 * (sync-folder.ts), watches it where the OS allows, and looks every five
 * minutes. It holds the root key only in memory, and never the passphrase
 * past deriving it.
 *
 * chord-data's thread owns the sync tables: it sends what to write, and each
 * batch of records read here waits for its answer (`ack`) before the next is
 * read, so a big log is merged a slice at a time with searches in between. A
 * snapshot comes the same way, a page at a time as this thread asks for it
 * (`pull`), and is written as it comes: neither thread holds it whole.
 *
 * Folder work goes one operation at a time, each begun and ended out loud
 * (`busy`, `idle`), so chord-data can give the one under way a deadline: a
 * file call that never returns (a stalled network drive) and chord-data lets
 * this worker go (`abandon`), and nothing more is done in the folder here.
 */
import { createHash } from "node:crypto";
import {
  AnotherWriter,
  appendRecords,
  ownIntact,
  othersUnder,
  coversOf,
  deviceFolder,
  folderMemory,
  inspectFolder,
  lookAtFolder,
  mayPrune,
  nextGeneration,
  readComputers,
  removeStaleTemps,
  settleAppend,
  SegmentsFull,
  setUp,
  syncFileName,
  unlockNewest,
  writeSnapshot,
  type Appending,
  type DataRecord,
  type FolderInspection,
  type FolderLook,
  type FolderMemory,
  type OwnSegment,
  type SegmentCursor,
  type SyncFs,
} from "@chord/core";
import type { nodeCrypto } from "@chord/data/crypto";

/** A snapshot to write: chord-data sends its records a page at a time when asked (`pull` → `chunk`), and this computer's `device` records for its first frame. */
interface Snapshot {
  stream: number;
  device: DataRecord[];
}

/** chord-data → the worker. */
export type ToWorker =
  | { t: "inspect"; folder: string }
  | ({
      t: "setup";
      folder: string;
      generation: number;
      passphrase: string;
      device: string;
      app: string;
    } & { snapshot: Snapshot })
  | { t: "unlock"; folder: string; passphrase: string }
  /** `appending`: what this computer was writing to its log when it last stopped without an answer (chord-data keeps it). */
  | {
      t: "start";
      folder: string;
      generation: number;
      device: string;
      key: Uint8Array;
      own: OwnSegment | null;
      cursors: { device: string; segment: number; cursor: SegmentCursor }[];
      app: string;
      junk: [string, string][];
      appending: Omit<Appending, "bytes"> | null;
      /** A file of chord-data's own (beside chord.db) holding what this computer is writing, for a worker after this one to cut back. */
      pendingFile: string | null;
      /** Whether a Chord window is in front (`front`). */
      front: boolean;
    }
  | { t: "read" }
  /** A step merged (`ok`), so the worker moves its cursor on; or not, and the pass stops there, to read it again later. */
  /** A batch of records (`id`) merged, or not: an answer that comes too late is never taken for the next batch's. */
  | { t: "ack"; id: number; ok: boolean }
  /** A page of a snapshot; `lost`: chord-data has no such snapshot (it stopped), and nothing is put in place. */
  | {
      t: "chunk";
      stream: number;
      records: DataRecord[];
      done: boolean;
      lost?: boolean;
    }
  | { t: "write"; upto: number; records: DataRecord[]; device: DataRecord[] }
  /** This computer's snapshot: compaction (covering its segments), or under a new id (`as`), which it takes only once the snapshot is there. */
  | { t: "snapshot"; snapshot: Snapshot; as?: string }
  | {
      t: "move";
      folder: string;
      from: number;
      to: number;
      device: string;
      key: Uint8Array;
      app: string;
      snapshot: Snapshot;
    }
  /** Whether a folder is this sync's: its generation's file opens with this computer's key (a folder that moved). */
  | { t: "look"; folder: string; generation: number; key: Uint8Array }
  /** A lost passphrase: the next generation with a new one, without the old key, and this computer's snapshot under it. */
  | {
      t: "restart";
      folder: string;
      from: number;
      passphrase: string;
      device: string;
      app: string;
      snapshot: Snapshot;
    }
  /** A new passphrase, in two steps: the next generation's file (this computer then says so under the old one), then its snapshot there. */
  | { t: "rekey-file"; passphrase: string }
  | { t: "rekey-move"; generation: number; key: Uint8Array; snapshot: Snapshot }
  /** A removed computer's folder, gone if everything real in it has been read here and nothing in it is newer than its removal. */
  | { t: "prune"; device: string; removedAt: number }
  /** An old generation's file, or this computer's folder in one: nothing else. */
  | { t: "remove"; path: string }
  /** A passive checkpoint of chord.db, on this thread's own connection: chord-data's runs none while sync is busy. */
  | { t: "checkpoint"; database: string }
  /** chord-data let this worker go (a file call held it past its deadline): once that call returns, nothing more is done. */
  | { t: "abandon" }
  /** A Chord window came to the front, or none is: on Windows the folder is watched only while one is (WATCH_IN_FRONT). */
  | { t: "front"; front: boolean }
  | { t: "stop" };

/** The worker → chord-data. */
export type FromWorker =
  | { t: "inspected"; inspection: FolderInspection }
  | { t: "set-up"; key: Uint8Array; own: OwnSegment }
  | { t: "unlocked"; key: Uint8Array; generation: number }
  | {
      t: "records";
      id: number;
      device: string;
      segment: number;
      records: DataRecord[];
      cursor: SegmentCursor;
      refused: number;
    }
  | { t: "newer"; device: string }
  /** `seen`: when each computer last wrote here; `wrote`: when each says it made its newest segment read (its own clock). */
  /** `junk`: what the reader remembers of junk, when it changed (chord-data keeps it across launches). */
  | {
      t: "pass-done";
      look: FolderLook;
      seen: Record<string, number>;
      wrote: Record<string, number>;
      tooMany: boolean;
      cluttered: boolean;
      unfinished: boolean;
      /** Computers whose folders hold more than a pass looks through. */
      blocked: string[];
      /** Computers whose log went back to an older version after this one read it: what this one has of it goes again. */
      rewound?: string[];
      /** A step wasn't merged (or its answer never came): the pass stopped there. */
      failed?: boolean;
      junk?: [string, string][];
    }
  /** This computer's own segment isn't as it left it: another copy of the profile writes to it. */
  | { t: "own-changed" }
  | { t: "pull"; stream: number }
  | {
      t: "written";
      upto: number;
      own: OwnSegment;
      frames: number;
      bytes: number;
    }
  | { t: "snapshotted"; own: OwnSegment }
  | { t: "moved"; own: OwnSegment }
  | { t: "looked"; look: FolderLook }
  | { t: "restarted"; key: Uint8Array; generation: number; own: OwnSegment }
  | { t: "rekey-filed"; key: Uint8Array; generation: number }
  | { t: "rekeyed"; own: OwnSegment }
  | { t: "pruned"; device: string }
  /**
   * `copied`: another computer writes under this one's id; `gone`: this computer's segment isn't there (or is shorter)
   * though the folder is; `missing`: the folder isn't there; `full`: its segment numbers reached the top; `io`: the
   * folder couldn't be written.
   */
  | {
      t: "failed";
      problem:
        | "wrong"
        | "conflict"
        | "newer"
        | "damaged"
        | "missing"
        | "copied"
        | "gone"
        | "full"
        | "io";
      for: ToWorker["t"];
    }
  /** The folder changed (a watch fired): chord-data may ask for a read. */
  | { t: "changed" }
  /** A folder operation begun (what was asked, or a pass), and ended: chord-data's deadline runs for the one under way only. */
  | { t: "busy"; op: ToWorker["t"] | "pass" | "tidy" | "watch" }
  /** `reached: false`: it ended without touching the folder (a watch not wanted, behind on Windows): no sign the folder answers. */
  | { t: "idle"; reached?: false }
  /** About to write to this computer's log: chord-data keeps it until the write is answered. */
  | { t: "appending"; appending: Omit<Appending, "bytes"> }
  /** A write of its own that went unanswered landed after all: its segment as it is now, for chord-data to keep. */
  | { t: "settled"; own: OwnSegment };

/** What the worker needs of where it runs: a thread with a folder on the disk, or a test with a folder in memory. */
export interface SyncWorkerEnv {
  send(message: FromWorker): void;
  /** `<folder>/Chord sync`. */
  folderOf(folder: string): SyncFs;
  /** Let go (chord-data's `abandon`): when a call under way returns, nothing more is done in the folder. */
  abandon(): void;
  /** Whether `<folder>/Chord sync` is a folder that's there: off the thread, under the operation's deadline. */
  reachable(folder: string): Promise<boolean>;
  /** A watch of `<folder>/Chord sync`, recursive where the OS has it, or null where there can't be one. */
  watch(
    folder: string,
    changed: (name: string | null) => void,
    failed: () => void,
  ): { close(): void } | null;
  /** chord-data's own file of what's being written (`pendingFile`). */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array | null>;
  crypto: typeof nodeCrypto;
  /** Windows: the folder is watched only while a Chord window is in front (a watch holds a handle inside it). */
  watchInFront: boolean;
}

/** Looks this often, whatever the watch says: watching cloud and network folders isn't reliable (S15 §6). */
const POLL_MS = 5 * 60_000;
/** A burst of changes to the folder (a sync app writing a segment in pieces) reads once, after it settles. */
const SETTLE_MS = 1000;
/** A pass that looked into as many segments as it may goes on after this long: never back to back. */
const NEXT_PASS_MS = 2000;
/** How long a pass waits for chord-data to say a step is merged: past that the pass stops, and the step is read again later. */
const ACK_MS = 120_000;

interface Running {
  fs: SyncFs;
  folder: string;
  generation: number;
  device: string;
  key: Uint8Array;
  own: OwnSegment | null;
  cursors: Map<string, SegmentCursor>;
  app: string;
  /** Junk remembered, and where looking for computers not known yet got to: never forgotten while it's needed (core's MAX_JUNK bounds it). */
  memory: FolderMemory;
  /** What it's writing to its log, until answered: a write of its own that landed though it failed is its own, not another writer's. */
  appending: Appending | null;
  pendingFile: string | null;
}

/** A worker: `receive` takes what chord-data sends it, in order. */
export function createSyncWorker(env: SyncWorkerEnv): {
  receive(message: ToWorker): void;
} {
  const nodeCrypto = env.crypto;
  const send = env.send;
  const folderOf = env.folderOf;
  let running: Running | null = null;
  let watcher: { close(): void } | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  /**
   * On Windows a watch holds a handle inside the folder (ReadDirectoryChangesW),
   * and Windows won't rename or move a folder something holds: the folder that
   * holds `Chord sync` couldn't be renamed while Chord ran. So there it's watched
   * only while a Chord window is in front; behind, the five-minute look and the
   * look when Chord comes to the front still find what changed.
   */
  const WATCH_IN_FRONT = env.watchInFront;
  let front = true;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let again = false;
  let next: ReturnType<typeof setTimeout> | undefined;
  /** The batch of records waiting for its answer, and the last batch's number. */
  let acked: { id: number; resolve(ok: boolean): void } | null = null;
  let batches = 0;
  /** One folder operation at a time: a write never interleaves with a snapshot, a read with a new generation. Each says when it begins and ends. */
  let chain: Promise<void> = Promise.resolve();
  const serial = (
    op: Extract<FromWorker, { t: "busy" }>["op"],
    work: () => Promise<boolean | void>,
  ) => {
    const run = async () => {
      send({ t: "busy", op });
      let reached: boolean | void = true;
      try {
        reached = await work();
      } finally {
        send(reached === false ? { t: "idle", reached: false } : { t: "idle" });
      }
    };
    chain = chain.then(run, run);
    return chain;
  };

  const cursorKey = (device: string, segment: number) => `${device}/${segment}`;

  /* ---------- Snapshots, a page at a time ---------- */

  type Chunk = { records: DataRecord[]; done: boolean; lost?: boolean };
  const pulls = new Map<number, (chunk: Chunk) => void>();

  /** A snapshot's records as chord-data reads them, a page per ask. One cut short throws: a part of a snapshot is never put in place. */
  async function* pages(stream: number): AsyncGenerator<DataRecord[]> {
    for (;;) {
      const chunk = await new Promise<Chunk>((resolve) => {
        pulls.set(stream, resolve);
        send({ t: "pull", stream });
      });
      if (chunk.lost) throw new Error("The snapshot was cut short");
      if (chunk.records.length > 0) yield chunk.records;
      if (chunk.done) return;
    }
  }

  /* ---------- Reading ---------- */

  /**
   * Reads every other computer's log from where it got to, each batch answered
   * before the next. When the passphrase changed, this generation's logs are
   * still read first: a computer that changed it says so here before it moves.
   *
   * A step's cursor moves on only when chord-data says it's merged (`ack` ok);
   * one that wasn't, or whose answer doesn't come within ACK_MS, stops the pass
   * there (`failed`), to be read again later: the serial chain is never held
   * for ever. First, this computer's own segment is checked to be as it left it
   * (`ownIntact`): a copy of the profile that stopped writing still finds out.
   */
  async function pass(): Promise<void> {
    const r = running;
    if (!r) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    let look: FolderLook = { state: "missing" };
    const seen: Record<string, number> = {};
    const wrote: Record<string, number> = {};
    const blocked: string[] = [];
    const rewound: string[] = [];
    let tooMany = false;
    let cluttered = false;
    let unfinished = false;
    let failed = false;
    try {
      look = await lookAtFolder(r.fs, r.generation, r.key, nodeCrypto);
      // Not there (deleted, moved, the sync app not running): a watch of where it was watches nothing, and holds nothing.
      if (look.state === "missing") unwatch();
      if (
        look.state === "ok" &&
        r.own &&
        r.own.generation === r.generation &&
        r.own.device === r.device
      ) {
        // A write of its own that landed though it failed, or was cut short, is settled first: never taken for another writer.
        await settleOwn(r);
        // The folder is there: watched again if a watch failed (it was deleted or moved, and is back).
        if (running === r) await watchOnly(r);
        const intact = await ownIntact(r.fs, r.own, nodeCrypto);
        if (intact === "other" || intact === "gone") send({ t: "own-changed" });
        // Another copy of the profile writing a segment of its own under this id: neither reads its own id's, so each finds
        // the other here.
        else if (intact === "ok" && (await othersUnder(r.fs, r.own, r.key, nodeCrypto, r.memory))) send({ t: "own-changed" });
      }
      if (look.state === "ok" || look.state === "changed") {
        // The segments of each computer read past their first frame: a computer known to have a real log.
        const known = new Map<string, number[]>();
        for (const [key, cursor] of r.cursors) {
          if (cursor.frame === 0) continue;
          const at = key.lastIndexOf("/");
          const device = key.slice(0, at);
          known.set(device, [
            ...(known.get(device) ?? []),
            Number(key.slice(at + 1)),
          ]);
        }
        for await (const event of readComputers(
          r.fs,
          {
            generation: r.generation,
            self: r.device,
            root: r.key,
            cursor: (d, s) => r.cursors.get(cursorKey(d, s)) ?? null,
            known: (d) => known.get(d) ?? [],
            memory: r.memory,
          },
          nodeCrypto,
        )) {
          if (running !== r) return;
          if (event.kind === "seen") {
            seen[event.device] = event.at;
            if (event.wrote !== null) wrote[event.device] = event.wrote;
          } else if (event.kind === "newer")
            send({ t: "newer", device: event.device });
          else if (event.kind === "too-many") tooMany = true;
          else if (event.kind === "unfinished") unfinished = true;
          else if (event.kind === "cluttered") cluttered = true;
          else if (event.kind === "blocked") blocked.push(event.device);
          else if (event.kind === "rewound") rewound.push(event.device);
          else {
            const id = ++batches;
            const merged = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => {
                acked = null;
                resolve(false);
              }, ACK_MS);
              acked = {
                id,
                resolve: (ok) => {
                  clearTimeout(timer);
                  resolve(ok);
                },
              };
              send({
                t: "records",
                id,
                device: event.device,
                segment: event.segment,
                records: event.records,
                cursor: event.cursor,
                refused: event.refused,
              });
            });
            if (!merged) {
              failed = true;
              break;
            }
            r.cursors.set(cursorKey(event.device, event.segment), event.cursor);
          }
        }
      }
    } catch (error) {
      console.error("Sync couldn’t read the folder:", error);
      failed = true;
    } finally {
      reading = false;
    }
    if (running !== r) return;
    const junk = r.memory.dirty ? [...r.memory.junk] : undefined;
    r.memory.dirty = false;
    send({
      t: "pass-done",
      look,
      seen,
      wrote,
      tooMany,
      cluttered,
      unfinished,
      blocked,
      ...(rewound.length > 0 ? { rewound } : {}),
      ...(failed ? { failed } : {}),
      ...(junk ? { junk } : {}),
    });
    // More to look through: the next pass goes on from there, a little later, never straight after. A folder full of
    // junk is looked through at the usual times only; a pass that failed is tried again by chord-data, later and later.
    if (unfinished && !cluttered && !failed) {
      clearTimeout(next);
      next = setTimeout(() => void serial("pass", pass), NEXT_PASS_MS);
    }
    if (again) {
      again = false;
      void serial("pass", pass);
    }
  }

  /** A write of this computer's that may have landed (`appending`): its own if it did, cut back if it was cut short. */
  async function settleOwn(r: Running): Promise<void> {
    if (!r.own || !r.appending) return;
    const settled = await settleAppend(r.fs, r.own, r.appending, nodeCrypto);
    if (settled.settled === "landed") {
      r.own = settled.own;
      // Kept by chord-data at once, before any next write's marker, which is relative to it.
      send({ t: "settled", own: r.own });
    }
    if (settled.settled) r.appending = null;
  }

  /**
   * Kept until answered, before anything is written: the bytes in chord-data's
   * own file (`pendingFile`, once per write), for a worker after this one to cut
   * back a short write; the rest in chord-data's meta. A file it can't write
   * (the disk full) stops the write: never one it couldn't cut back.
   */
  async function appending(r: Running, a: Appending): Promise<void> {
    if (a.bytes && r.pendingFile) await env.writeFile(r.pendingFile, a.bytes);
    r.appending = a;
    send({
      t: "appending",
      appending: { expect: a.expect, at: a.at, length: a.length, hash: a.hash },
    });
  }

  /** What the last worker was writing, with its bytes again if chord-data's file has exactly them. */
  async function withBytes(r: Running): Promise<void> {
    const a = r.appending;
    if (!a || a.bytes || a.hash === null || !r.pendingFile) return;
    const bytes = await env.readFile(r.pendingFile).catch(() => null);
    if (
      bytes &&
      bytes.length === a.length &&
      createHash("sha256").update(bytes).digest("hex") === a.hash
    )
      r.appending = { ...a, bytes: new Uint8Array(bytes) };
  }

  /** The folder changed, or it's time to look: a read, once the burst settles. */
  function later(): void {
    clearTimeout(settle);
    settle = setTimeout(() => send({ t: "changed" }), SETTLE_MS);
  }

  /** Watching `r`'s folder (again), and looking every five minutes whatever the watch says. Within a folder operation, under its deadline. */
  async function watchFolder(r: Running): Promise<boolean> {
    stopWatching();
    poll = setInterval(later, POLL_MS);
    return watchOnly(r);
  }

  /**
   * The watch alone, when it's wanted and not there: recursive where the OS has
   * it. A folder that can't be watched (it's gone, it moved, a cloud folder) is
   * looked at every five minutes and when Chord comes to the front, and watched
   * again once a look finds it.
   */
  /** Whether it reached the folder (false: a watch wasn't wanted, or was there already). */
  async function watchOnly(r: Running): Promise<boolean> {
    if (watcher || (WATCH_IN_FRONT && !front)) return false;
    // Reachable first, off this thread: a share that's stopped answering holds this call, under the operation's deadline,
    // never the thread itself (setting up a watch is synchronous, and would).
    if (!(await env.reachable(r.folder))) return true;
    if (running !== r || watcher || (WATCH_IN_FRONT && !front)) return true;
    // A watch that fails (its folder deleted or moved) is closed; the looks go on, and a look that finds the folder watches it again.
    watcher = env.watch(
      r.folder,
      (name) => {
        // This computer's own writes aren't news.
        if (
          typeof name === "string" &&
          name
            .replaceAll("\\", "/")
            .startsWith(`${deviceFolder(r.generation, r.device)}/`)
        )
          return;
        later();
      },
      () => unwatch(),
    );
    return true;
  }

  /** The watch closed; the five-minute look goes on. */
  function unwatch(): void {
    watcher?.close();
    watcher = null;
  }

  function stopWatching(): void {
    unwatch();
    clearInterval(poll);
    clearTimeout(settle);
  }

  const failed = (
    for_: ToWorker["t"],
    problem: Extract<FromWorker, { t: "failed" }>["problem"],
  ) => send({ t: "failed", problem, for: for_ });

  /** A snapshot of this computer, written as chord-data's pages come, past its newest segment there. */
  const snapshotTo = (
    fs: SyncFs,
    where: { generation: number; device: string },
    snapshot: Snapshot,
    key: Uint8Array,
    app: string,
  ) =>
    writeSnapshot(
      fs,
      where,
      pages(snapshot.stream),
      key,
      {
        app,
        device: snapshot.device,
        ...(running?.fs === fs ? { memory: running.memory } : {}),
      },
      nodeCrypto,
    );

  async function handle(message: ToWorker): Promise<void> {
    switch (message.t) {
      case "inspect":
        send({
          t: "inspected",
          inspection: await inspectFolder(folderOf(message.folder)),
        });
        return;
      case "setup": {
        const fs = folderOf(message.folder);
        const made = await setUp(
          fs,
          message.generation,
          message.passphrase,
          message.device,
          nodeCrypto,
        );
        if (!made.ok) return failed("setup", made.problem);
        const own = await snapshotTo(
          fs,
          { generation: message.generation, device: message.device },
          message.snapshot,
          made.root,
          message.app,
        );
        send({ t: "set-up", key: made.root, own });
        return;
      }
      case "unlock": {
        const opened = await unlockNewest(
          folderOf(message.folder),
          message.passphrase,
          nodeCrypto,
        );
        if (!opened.ok) return failed("unlock", opened.problem);
        send({
          t: "unlocked",
          key: opened.root,
          generation: opened.generation,
        });
        return;
      }
      case "start": {
        running = {
          fs: folderOf(message.folder),
          folder: message.folder,
          generation: message.generation,
          device: message.device,
          key: message.key,
          own: message.own,
          cursors: new Map(
            message.cursors.map((c) => [
              cursorKey(c.device, c.segment),
              c.cursor,
            ]),
          ),
          app: message.app,
          memory: { ...folderMemory(), junk: new Map(message.junk) },
          appending: message.appending,
          pendingFile: message.pendingFile,
        };
        front = message.front;
        const r = running;
        // Nothing here touches the folder: the watch, the tidying and the first pass are folder operations, each under a deadline.
        void serial("watch", () => watchFolder(r));
        // What a write that was stopped left in this computer's own folder (temp names, older than a minute), first.
        void serial("tidy", async () => {
          await withBytes(r);
          await removeStaleTemps(
            r.fs,
            { generation: r.generation, device: r.device },
            Date.now(),
          ).catch(() => 0);
        });
        void serial("pass", pass);
        return;
      }
      case "read":
        void serial("pass", pass);
        return;
      case "write": {
        const r = running;
        if (!r?.own) return failed("write", "gone");
        await settleOwn(r);
        const result = await appendRecords(
          r.fs,
          r.own,
          message.records,
          r.key,
          {
            app: r.app,
            device: message.device,
            memory: r.memory,
            onAppend: (a) => appending(r, a),
          },
          nodeCrypto,
        );
        if (!result.ok) return failed("write", result.problem);
        r.own = result.own;
        r.appending = null;
        send({
          t: "written",
          upto: message.upto,
          own: result.own,
          frames: result.frames,
          bytes: result.bytes,
        });
        return;
      }
      case "snapshot": {
        const r = running;
        if (!r) return failed("snapshot", "missing");
        if (message.as) {
          // A new id: its first snapshot, and only then is it this computer's. The old one's folder is left as it is.
          const own = await snapshotTo(
            r.fs,
            { generation: r.generation, device: message.as },
            message.snapshot,
            r.key,
            r.app,
          );
          r.device = message.as;
          r.own = own;
          r.appending = null;
          await watchFolder(r);
          send({ t: "snapshotted", own });
          return;
        }
        // Compaction: past its newest segment, covering what it wrote; another writer under this id stops it (`copied`).
        await settleOwn(r);
        const mine =
          r.own &&
          r.own.generation === r.generation &&
          r.own.device === r.device
            ? r.own
            : null;
        r.own = await writeSnapshot(
          r.fs,
          { generation: r.generation, device: r.device },
          pages(message.snapshot.stream),
          r.key,
          // Before it's renamed into place, what it will be: a stop before the answer leaves it this computer's own.
          {
            app: r.app,
            device: message.snapshot.device,
            covers: coversOf(mine),
            memory: r.memory,
            ...(mine ? { after: mine.segment, ...(mine.skipped ? { skipped: mine.skipped } : {}), ...(mine.covered ? { covered: mine.covered } : {}) } : {}),
            onRename: (a) => appending(r, a),
          },
          nodeCrypto,
        );
        r.appending = null;
        send({ t: "snapshotted", own: r.own });
        return;
      }
      case "look":
        send({
          t: "looked",
          look: await lookAtFolder(
            folderOf(message.folder),
            message.generation,
            message.key,
            nodeCrypto,
          ),
        });
        return;
      case "restart": {
        // Starting over: a new generation in the same folder, under a new passphrase; this computer's snapshot there, its old folder gone.
        const fs = folderOf(message.folder);
        const next = await nextGeneration(
          fs,
          message.passphrase,
          message.device,
          nodeCrypto,
        );
        const own = await snapshotTo(
          fs,
          { generation: next.generation, device: message.device },
          message.snapshot,
          next.root,
          message.app,
        );
        await fs
          .remove(deviceFolder(message.from, message.device))
          .catch(() => undefined);
        send({
          t: "restarted",
          key: next.root,
          generation: next.generation,
          own,
        });
        return;
      }
      case "move": {
        // The passphrase changed on another computer: this one's snapshot goes under the new generation, with its key, and its old folder goes.
        const fs = folderOf(message.folder);
        const own = await snapshotTo(
          fs,
          { generation: message.to, device: message.device },
          message.snapshot,
          message.key,
          message.app,
        );
        await fs
          .remove(deviceFolder(message.from, message.device))
          .catch(() => undefined);
        send({ t: "moved", own });
        return;
      }
      case "rekey-file": {
        const r = running;
        if (!r) return failed("rekey-file", "missing");
        const next = await nextGeneration(
          r.fs,
          message.passphrase,
          r.device,
          nodeCrypto,
        );
        send({ t: "rekey-filed", key: next.root, generation: next.generation });
        return;
      }
      case "rekey-move": {
        // Its old folder stays until the old generation's file goes (30 days): what it said there, that it moved, is read by the others.
        const r = running;
        if (!r) return failed("rekey-move", "missing");
        r.key.fill(0);
        r.generation = message.generation;
        r.key = message.key;
        r.cursors.clear();
        r.own = await snapshotTo(
          r.fs,
          { generation: r.generation, device: r.device },
          message.snapshot,
          r.key,
          r.app,
        );
        await watchFolder(r);
        send({ t: "rekeyed", own: r.own });
        return;
      }
      case "prune": {
        const r = running;
        if (!r || message.device === r.device) return;
        const where = { generation: r.generation, device: message.device };
        if (
          await mayPrune(
            r.fs,
            where,
            message.removedAt,
            r.key,
            (segment) =>
              r.cursors.get(cursorKey(message.device, segment)) ?? null,
            nodeCrypto,
          )
        ) {
          await r.fs
            .remove(deviceFolder(r.generation, message.device))
            .catch(() => undefined);
          send({ t: "pruned", device: message.device });
        }
        return;
      }
      case "remove": {
        const r = running;
        // Only an old generation's file, or this computer's own folder in one: never anything else.
        const file = /^sync-(\d{1,6})\.json$/.exec(message.path);
        const own = /^(\d{1,6})\/([0-9a-f]{16})$/.exec(message.path);
        if (
          r &&
          ((file &&
            Number(file[1]) < r.generation &&
            message.path === syncFileName(Number(file[1]))) ||
            (own && Number(own[1]) < r.generation && own[2] === r.device))
        ) {
          await r.fs.remove(message.path).catch(() => undefined);
        }
        return;
      }
      case "front":
        front = message.front;
        // The watch set up or closed as a folder operation, under its deadline: a hung share never holds this thread.
        void serial("watch", async () => {
          if (WATCH_IN_FRONT && !front) {
            unwatch();
            return false;
          }
          return running ? watchOnly(running) : false;
        });
        return;
      case "abandon":
        // Let go: the call that held it returns some day, and then nothing more is done in the folder (NodeFolder refuses).
        env.abandon();
        stopWatching();
        clearTimeout(next);
        running = null;
        for (const resolve of pulls.values())
          resolve({ records: [], done: true, lost: true });
        pulls.clear();
        return;
      case "stop":
        stopWatching();
        clearTimeout(next);
        running?.key.fill(0);
        running = null;
        for (const resolve of pulls.values())
          resolve({ records: [], done: true, lost: true });
        pulls.clear();
        return;
      case "ack":
      case "chunk":
        return;
    }
  }

  const problemOf = (
    error: unknown,
  ): Extract<FromWorker, { t: "failed" }>["problem"] =>
    error instanceof SegmentsFull
      ? "full"
      : error instanceof AnotherWriter
        ? "copied"
        : "io";

  const receive = (message: ToWorker): void => {
    if (message.t === "checkpoint") return;
    if (message.t === "ack") {
      if (acked?.id !== message.id) return;
      const { resolve } = acked;
      acked = null;
      resolve(message.ok);
      return;
    }
    if (message.t === "chunk") {
      const resolve = pulls.get(message.stream);
      pulls.delete(message.stream);
      resolve?.({
        records: message.records,
        done: message.done,
        ...(message.lost ? { lost: true } : {}),
      });
      return;
    }
    if (
      message.t === "read" ||
      message.t === "start" ||
      message.t === "stop" ||
      message.t === "abandon" ||
      message.t === "front"
    ) {
      void handle(message).catch((error: unknown) => {
        console.error("Sync failed:", error);
        failed(message.t, problemOf(error));
      });
      return;
    }
    // Folder work, one at a time.
    void serial(message.t, () =>
      handle(message).catch((error: unknown) => {
        console.error("Sync failed:", error);
        failed(message.t, problemOf(error));
      }),
    );
  };

  return { receive };
}
