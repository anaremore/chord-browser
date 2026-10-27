/**
 * What main sends chord-data, and how a state change becomes writes
 * (ARCHITECTURE.md §6.2). Pure: main imports this; only the utility process
 * imports `@chord/data/db`, so SQLite never runs on main.
 */
import type {
  ArchivedTab,
  ArchiveReason,
  Choice,
  Chord,
  Download,
  DuetMessage,
  DuetThread,
  Favorite,
  ImportedPage,
  InstalledExtension,
  LinkRoute,
  PersistedState,
  SavedEffects,
  Settings,
  SidebarNode,
  SitePermissions,
  State,
  WindowModel,
} from '@chord/core';
import type { ExportCounts, FolderInspection, SyncApply, SyncStatus } from '@chord/core';
import { localChordFields, localFavoriteFields, localNodeFields, localRouteFields, same } from '@chord/core';
import type { DuetOp, DuetResult } from './duet';
import type { SyncTimings } from './sync';

/**
 * Who a write is from (S15 §13), the one thing sync's stamping goes by:
 * `user`, something you did here, stamped; `sync`, the merged copy applied
 * (`sync.apply`), never stamped, so it never goes back into this computer's
 * log (S15 §4); `tidy`, this computer adjusting on its own (its chords making
 * way for the synced setup), never stamped either, and never a deletion of
 * anything the merged copy has: that comes back.
 */
export type Origin = 'user' | 'sync' | 'tidy';

/** A command's writes, by who they're from: another computer's changes applied are sync's, making way for the synced setup is tidying. */
export const originOf = (command: { t: string } | undefined): Origin => (command?.t === 'sync.apply' ? 'sync' : command?.t === 'sync.replace' ? 'tidy' : 'user');

/**
 * The latest value of one saved entity, or null to delete it, and who it's
 * from (`origin`, `user` when not said). `removed`: for the themes' list,
 * the themes you took out of it (it's written whole): only those are deleted.
 * `took`: for a write of yours that leaves the entity out of sync (gone, or a
 * tab out of Pinned), whether your change is what took it out: false when it
 * was already out before it (sync moved it to Today, say), so it's no deletion
 * of yours; not said, it's taken as yours. `at`: when you made the change
 * (persistence says): it's stamped as of then, not when it was written, which
 * a full disk can put off for minutes. `synced: false`: nothing sync keeps of
 * it changed (a tab's last visit, its scroll), so its row keeps who wrote what
 * sync keeps, and when (`row_origin`): joining and the drift check go by that,
 * not by the row's last write. `back`: your change made it, or brought it back
 * (it wasn't in sync's reach before it, though chord.db may still have it, if
 * what took it, another computer's change, wasn't written yet): it's here as
 * of then, whatever was deleted elsewhere before. `before`: earlier changes
 * of yours to it, waiting with this one, each made more than STEP_MS before
 * the next: each is stamped first, as of its own time (`coalesceOps`).
 */
export type WriteOp = (
  | { k: 'chord'; id: string; value: Chord | null }
  | { k: 'node'; id: string; value: SidebarNode | null }
  | { k: 'window'; id: string; value: WindowModel | null }
  | { k: 'setting'; id: string; value: Settings[keyof Settings] | null }
  /** All of one site's remembered permission decisions. */
  | { k: 'sitePermission'; id: string; value: SitePermissions[string] | null }
  | { k: 'download'; id: string; value: Download | null }
  | { k: 'favorite'; id: string; value: Favorite | null }
  /** One installed extension, by `extensionKey(profileId, id)`. */
  | { k: 'extension'; id: string; value: InstalledExtension | null }
  /** A site's page zoom, by host. */
  | { k: 'siteZoom'; id: string; value: number | null }
  | { k: 'linkRoute'; id: string; value: LinkRoute | null }
  /** A site's Effects, by host (main/effects: they never pass through the store). */
  | { k: 'effect'; id: string; value: SavedEffects | null }
  /** An open tab's back/forward history, by node id: what brings it back where it was after a restart or a crash. */
  | { k: 'nav'; id: string; value: NavState | null }
) & { origin?: Origin; removed?: string[]; took?: boolean; at?: number; synced?: false; back?: true; before?: WriteStep[] };

export const opOrigin = (op: WriteOp): Origin => op.origin ?? 'user';

/** A write's place among those chord-data has taken this run (`run`: one per process start; `n` counts up). */
export interface WriteSeq {
  run: string;
  n: number;
}

/** An earlier change of yours to an entity, waiting with a later one in one write (`WriteOp.before`): stamped first, as of its own time. */
export interface WriteStep {
  value: WriteOp['value'];
  at: number;
  back?: true;
  took?: boolean;
  removed?: string[];
}

/**
 * Changes of yours to one entity made further apart than this, waiting
 * together (a full disk putting writes off for minutes, say), are stamped
 * each as of its own time (`WriteOp.before`); closer (typing), as one, as of
 * the later.
 */
export const STEP_MS = 1000;
/** At most this many earlier changes kept with one write: the first (which may have made it) and the latest. */
const MAX_STEPS = 16;
/** The kinds sync stamps: only theirs are kept in steps (a tab's history, a window, never). */
const STEPPED: ReadonlySet<string> = new Set(['chord', 'node', 'favorite', 'linkRoute', 'effect', 'setting']);

/**
 * Two writes of one entity waiting, the later in the earlier's place (the
 * write persistence keeps): what the earlier said goes with it. Yours, both,
 * made more than STEP_MS apart: the earlier is a step of the later's
 * (`before`), stamped first, as of its own time, so a change made elsewhere
 * between the two wins over the earlier only (S15 §13). Otherwise taken out
 * of sync by either is taken out (`took`), made by either is made (`back`),
 * the themes either took out are out unless one is back (`removed`), and when
 * the later changed nothing sync keeps, the earlier's time and kind stand
 * (`at`, `synced`).
 */
export function coalesceOps(earlier: WriteOp | undefined, later: WriteOp): WriteOp {
  if (!earlier) return later;
  if (STEPPED.has(later.k) && opOrigin(earlier) === 'user' && opOrigin(later) === 'user' && later.synced !== false && earlier.at !== undefined && later.at !== undefined && later.at - earlier.at > STEP_MS) {
    const step: WriteStep = { value: earlier.value, at: earlier.at, ...(earlier.back ? { back: true as const } : {}), ...(earlier.took !== undefined ? { took: earlier.took } : {}), ...(earlier.removed ? { removed: earlier.removed } : {}) };
    let before = [...(earlier.before ?? []), step, ...(later.before ?? [])];
    if (before.length > MAX_STEPS) before = [before[0]!, ...before.slice(-(MAX_STEPS - 1))];
    return { ...later, before } as WriteOp;
  }
  let op: WriteOp = later;
  if (earlier.before) op = { ...op, before: [...earlier.before, ...(later.before ?? [])] };
  if (earlier.took === true || later.took === true) op = { ...op, took: true };
  // Made (or brought back) by the earlier, and not written yet: made by this write, and if it's gone again, made and
  // gone: either way something of yours, as of then.
  if (earlier.back === true) op = { ...op, back: true };
  if (op.k === 'setting' && op.id === 'themes' && earlier.removed) {
    const back = new Set((Array.isArray(op.value) ? (op.value as { id?: unknown }[]) : []).map((t) => t.id));
    const removed = [...new Set([...earlier.removed, ...(op.removed ?? [])])].filter((id) => !back.has(id));
    const { removed: _removed, ...rest } = op;
    op = (removed.length > 0 ? { ...rest, removed } : rest) as WriteOp;
  }
  if (later.synced === false) {
    const { synced: _synced, at: _at, ...rest } = op;
    op = { ...rest, ...(earlier.synced === false ? { synced: false as const } : {}), ...(earlier.at !== undefined ? { at: earlier.at } : {}) } as WriteOp;
  }
  return op;
}

/**
 * A tab's back/forward history as Electron gives it (`navigationHistory`):
 * enough to bring the tab back where it was, scroll position included.
 */
export interface NavState {
  entries: { url: string; title: string; pageState?: string }[];
  index: number;
}

/**
 * History and archive happenings: appended, never coalesced (every visit
 * counts). They're written in the same transaction as the batch they arrive with.
 */
export type HistoryEvent =
  | { k: 'visit'; url: string; title: string; at: number }
  | { k: 'title'; url: string; title: string }
  /** A command bar pick: learned for `text` in the chord, and a typed use of `address` if it has one. */
  | { k: 'choice'; chordId: string; text: string; destination: string; address: string | null; at: number }
  /** A tab went to the archive. */
  | { k: 'archive'; tab: ArchivedTab; nav: NavState | null }
  /** An archive entry left: its tab came back, or you removed it. */
  | { k: 'unarchive'; id: string };

/** One page of the archive, newest first. */
export interface ArchivePage {
  items: ArchivedTab[];
  /** Whether older entries match too. */
  more: boolean;
}

/** One archive entry with the history it needs to come back. */
export interface ArchiveEntry {
  tab: ArchivedTab;
  nav: NavState | null;
}

/** A history page that matched a search, with its frecency now. */
export interface HistoryHit {
  url: string;
  title: string;
  visitCount: number;
  typedCount: number;
  lastVisitAt: number;
  frecency: number;
}

export interface SearchResult {
  history: HistoryHit[];
  /** The chord's picks whose text starts with what was typed. */
  choices: Choice[];
  /** Archived tabs whose title or address matches. */
  archive: ArchivedTab[];
}

/** Main → chord-data. */
export type DataRequest =
  /** `prune` (at app start only): drop the rows of profiles no chord uses. */
  | { id: number; type: 'open'; file: string; prune?: boolean }
  | { id: number; type: 'write'; ops: WriteOp[]; events: HistoryEvent[] }
  | { id: number; type: 'search'; query: string; chordId: string | null; now: number }
  /** The archive page: the newest `limit` entries matching `query` (all of them when it's empty). */
  | { id: number; type: 'archive.list'; query: string; limit: number }
  | { id: number; type: 'archive.get'; archiveId: string }
  /** The newest entry archived for one of these reasons (⌘⇧T after a restart). */
  | { id: number; type: 'archive.latest'; reasons: ArchiveReason[] }
  /** Duet's threads and messages (./duet.ts). */
  | { id: number; type: 'duet'; op: DuetOp }
  /**
   * A port (transferred with this request) on which the import process sends
   * one import's history, a batch at a time (`ImportBatch`), so the pages
   * never pass through main (ARCHITECTURE.md §9). Each batch is answered.
   */
  | { id: number; type: 'import.port'; importId: string }
  /** Take back what an import added to history and Duet: its Undo. The chats it took away come back (`duet.removed`). */
  | { id: number; type: 'import.undo'; importId: string }
  /** This computer's id for Your data (made the first time it's asked for). */
  | { id: number; type: 'device' }
  /** What an export would hold, for Settings' card. The export itself reads the database in a process of its own. */
  | { id: number; type: 'export.counts' }
  /** Sync (docs/decisions/S15-your-data.md §6–§8): chord-data's thread owns its tables, and its worker thread the folder. */
  | ({ id: number } & SyncRequest)
  | { id: number; type: 'close' };

/** This computer as the others list it: its name, its system and its Chord. */
export interface SyncInfo {
  name: string;
  os: string;
  app: string;
}

/** Main → chord-data, for sync. A passphrase is passed on to the worker and kept nowhere; a key only in memory. */
export type SyncRequest =
  | { type: 'sync.status' }
  /** What a folder you picked holds: nothing of Chord's yet, or one to join. */
  | { type: 'sync.inspect'; folder: string }
  | { type: 'sync.setup'; folder: string; passphrase: string; info: SyncInfo }
  /** Opens the folder with the passphrase and reads it; then `sync.choose`, unless this is a clearly fresh Chord. */
  | { type: 'sync.join'; folder: string; passphrase: string; info: SyncInfo }
  | { type: 'sync.choose'; mode: 'synced' | 'both' }
  /** At launch: the root key main kept (safeStorage), so sync starts without asking. */
  | { type: 'sync.start'; key: Uint8Array; info: SyncInfo }
  /** No key kept, or the passphrase changed elsewhere: the passphrase, once. */
  /** `rebind`: the key kept here couldn't be read (this profile may be a copy of another computer's): a new id before it writes. */
  | { type: 'sync.unlock'; passphrase: string; info: SyncInfo; rebind?: boolean }
  | { type: 'sync.passphrase'; passphrase: string }
  /** `keep`: what sync applied isn't all in chord.db (writes refused a while): the merged copy stays, to put it back later. `quitting`: Chord is quitting, so the folder is given only a moment. */
  | { type: 'sync.off'; keep?: boolean; quitting?: boolean }
  | { type: 'sync.remove'; device: string }
  | { type: 'sync.rename'; name: string }
  | { type: 'sync.pause'; paused: boolean }
  /** Chord came to the front: look at the folder now. */
  | { type: 'sync.check' }
  /** A Chord window is in front, or none is: on Windows the folder is watched only while one is (a watch holds it, and it couldn't be renamed). */
  | { type: 'sync.front'; front: boolean }
  /** Quitting: what's waiting is written now. */
  | { type: 'sync.flush' }
  /** Things main put off applying while a change of its own to them waited (`chord:<id>`, `node:<id>`…): again, now it's written. */
  | { type: 'sync.repush'; keys: string[] }
  /** safeStorage's ciphertext of the root key (base64), kept in chord.db; null forgets it. */
  | { type: 'sync.keyBlob'; blob: string | null }
  /** How long sync's steps took on chord-data's thread (development builds' test hooks: perf.spec.ts). */
  | { type: 'sync.timings' }
  /** What's merged but not applied here (a quit or a crash during a pass or an apply, or an apply that failed), pushed again. */
  /** `idle`: as the idle timer's (`local` checked against the rows first); `wait`: answered once done, what it pushed sent first (putting back what was kept, and development builds' test hooks). */
  | { type: 'sync.reconcile'; idle?: boolean; wait?: boolean }
  /** Off with the merged copy kept: main applied what of it applies here, and it's saved: the copy goes (S15 §13). */
  | { type: 'sync.forget' }
  /** The folder moved: this one, if it's this sync's (its generation opens with this computer's key). */
  | { type: 'sync.relocate'; folder: string }
  /** A lost passphrase (S15 §6, *Start over*): the next generation under a new one; the other computers pause until they have it. */
  | { type: 'sync.startOver'; passphrase: string; info: SyncInfo }
  /** The root key, for main to keep with safeStorage when you ask it to on a computer with no keyring (S15 question 6). */
  | { type: 'sync.key' };

/** chord-data's answer to a sync request. */
export interface SyncReply {
  status?: SyncStatus;
  inspection?: FolderInspection;
  /** The root key, after setting up, joining or unlocking: main keeps it with safeStorage, if it can. */
  key?: Uint8Array;
  /** Why it didn't work: a wrong passphrase, a folder Chord can't use, two set up at once, this computer's disk full… */
  problem?: 'wrong' | 'conflict' | 'newer' | 'damaged' | 'missing' | 'io' | 'busy' | 'full';
  /** Joined: a clearly fresh Chord, whose setup the synced one replaces without asking. */
  fresh?: boolean;
  /** Chosen: everything to apply, and, for *Use the synced setup*, the chord this computer's Today tabs go to and the synced chords that stay. */
  apply?: SyncApply;
  replace?: { to: string; keep: string[] } | null;
  keyBlob?: string | null;
  /** Sync is off, and kept its merged copy (turned off while writes were refused): a reconcile puts back what chord.db lacks. */
  kept?: boolean;
  timings?: SyncTimings;
}

/** chord-data → main, unasked: what another computer changed, to apply; and where sync stands, for Settings. */
export type DataPush =
  /** `read`: how many writes chord-data had taken when it read what it pushes (one of yours taken since is newer, and puts it off). */
  | { push: 'sync.apply'; apply: SyncApply; read?: WriteSeq }
  | { push: 'sync.status'; status: SyncStatus }
  /** Chords that were to make way for the synced setup and are still here (the change that took them was lost): again, into `to`. */
  | { push: 'sync.makeWay'; chordIds: string[]; to: string };

/**
 * The import process → chord-data, on an import's port: one batch of history,
 * or of a Chord file's Duet chats (S15 §5), written in one transaction.
 */
export interface ImportBatch {
  pages?: ImportedPage[];
  duet?: { threads: DuetThread[]; messages: DuetMessage[] };
}

/** chord-data's answer to each batch: the pages written (or messages, for chats) and the chats added, or why it couldn't. */
export type ImportBatchReply = { ok: true; added: number; threads?: string[] } | { ok: false; error: string };

/** chord-data → main. */
/** How `open` spent its time, for the launch timeline (ms): the data process's own start, then each step. */
export interface OpenTiming {
  /** From the data process starting to it reading the request. */
  up: number;
  open: number;
  prune: number;
  read: number;
}

export type DataResponse =
  /** `navs`, from `open`: open tabs' saved back/forward histories, by node id; `effects`: every site's Effects. */
  | {
      id: number;
      ok: true;
      saved?: PersistedState | null;
      navs?: Record<string, NavState>;
      effects?: SavedEffects[];
      search?: SearchResult;
      archive?: ArchivePage;
      entry?: ArchiveEntry | null;
      duet?: DuetResult;
      timing?: OpenTiming;
      device?: string;
      counts?: ExportCounts;
      sync?: SyncReply;
      /** A write: which one it was, of chord-data's run (sync's pushes say how many they read after). */
      seq?: WriteSeq;
    }
  /** `passing`: refused for a reason that can pass (SQLite's FULL, IOERR, BUSY, LOCKED, READONLY): the write goes again later. */
  | { id: number; ok: false; error: string; passing?: boolean };

/** The part of an Immer patch this needs. */
export interface PathPatch {
  path: readonly (string | number)[];
}

const COLLECTIONS = { chords: 'chord', nodes: 'node', windows: 'window' } as const;

/** A stable key for coalescing: the last write to an entity wins. */
export const opKey = (op: WriteOp): string => `${op.k}:${op.id}`;

/**
 * Whether an op would save something from a private window, which is never
 * saved. Deletions always go through: deleting what was never written is harmless.
 */
function isPrivate(op: WriteOp, state: State): boolean {
  if (op.value === null) return false;
  switch (op.k) {
    case 'chord':
      return Boolean(op.value.private);
    case 'node':
      return Boolean(state.chords[op.value.chordId]?.private);
    case 'window':
      return Boolean(op.value.private);
    case 'download':
      return Boolean(op.value.privateWindow);
    default:
      return false;
  }
}

/**
 * The entities a change touched, each with its value in `state` after the
 * change. Live engine state, recently closed tabs, the version and anything
 * from a private window are never persisted.
 */
export function opsFromPatches(patches: readonly PathPatch[], state: State, before?: State): WriteOp[] {
  const ops = new Map<string, WriteOp>();
  const add = (op: WriteOp) => {
    if (!isPrivate(op, state)) ops.set(opKey(op), op);
  };
  for (const { path } of patches) {
    const [collection, id] = path;
    if (collection === 'downloads') {
      const ids = id === undefined ? Object.keys(state.downloads) : [String(id)];
      for (const downloadId of ids) add({ k: 'download', id: downloadId, value: state.downloads[downloadId] ?? null });
      continue;
    }
    if (collection === 'extensions') {
      const keys = id === undefined ? Object.keys(state.extensions) : [String(id)];
      for (const key of keys) add({ k: 'extension', id: key, value: state.extensions[key] ?? null });
      continue;
    }
    if (collection === 'linkRoutes') {
      const hosts = id === undefined ? Object.keys(state.linkRoutes) : [String(id)];
      for (const host of hosts) add({ k: 'linkRoute', id: host, value: state.linkRoutes[host] ?? null });
      continue;
    }
    if (collection === 'siteZoom') {
      const hosts = id === undefined ? Object.keys(state.siteZoom) : [String(id)];
      for (const host of hosts) add({ k: 'siteZoom', id: host, value: state.siteZoom[host] ?? null });
      continue;
    }
    if (collection === 'sitePermissions') {
      const origins = id === undefined ? Object.keys(state.sitePermissions) : [String(id)];
      for (const origin of origins) add({ k: 'sitePermission', id: origin, value: state.sitePermissions[origin] ?? null });
      continue;
    }
    if (collection === 'favorites') {
      const ids = id === undefined ? Object.keys(state.favorites) : [String(id)];
      for (const favoriteId of ids) add({ k: 'favorite', id: favoriteId, value: state.favorites[favoriteId] ?? null });
      continue;
    }
    if (collection === 'settings') {
      const keys = id === undefined ? (Object.keys(state.settings) as (keyof Settings)[]) : [String(id) as keyof Settings];
      for (const key of keys) {
        // The themes' list is written whole: what was taken out of it is said, so only that is deleted (S15 §13).
        const removed = key === 'themes' && before ? before.settings.themes.filter((t) => !state.settings.themes.some((n) => n.id === t.id)).map((t) => t.id) : [];
        add({ k: 'setting', id: key, value: state.settings[key] ?? null, ...(removed.length > 0 ? { removed } : {}) });
      }
      continue;
    }
    if (collection !== 'chords' && collection !== 'nodes' && collection !== 'windows') continue;
    const k = COLLECTIONS[collection];
    const ids = id === undefined ? Object.keys(state[collection]) : [String(id)];
    for (const entityId of ids) {
      if (k === 'chord') add({ k, id: entityId, value: state.chords[entityId] ?? null });
      else if (k === 'node') add({ k, id: entityId, value: state.nodes[entityId] ?? null });
      else add({ k, id: entityId, value: state.windows[entityId] ?? null });
    }
  }
  if (!before) return [...ops.values()];
  // Whether each change that leaves a synced thing out of sync is what took it out: it was in sync before it.
  const inSync = (s: State, op: WriteOp): boolean => {
    switch (op.k) {
      case 'chord':
        return Boolean(s.chords[op.id] && !s.chords[op.id]!.private);
      case 'node': {
        const node = s.nodes[op.id];
        return Boolean(node && node.section === 'pinned' && s.chords[node.chordId] && !s.chords[node.chordId]!.private);
      }
      case 'favorite':
        return Boolean(s.favorites[op.id]);
      case 'linkRoute':
        return Boolean(s.linkRoutes[op.id]);
      default:
        return false;
    }
  };
  return [...ops.values()].map((op) => {
    if ((op.k === 'chord' || op.k === 'node' || op.k === 'favorite' || op.k === 'linkRoute') && !inSync(state, op)) return { ...op, took: inSync(before, op) };
    // Made, or brought back, by this change: here as of now (S15 §13).
    if ((op.k === 'chord' || op.k === 'node' || op.k === 'favorite' || op.k === 'linkRoute') && !inSync(before, op)) return { ...op, back: true as const };
    // Nothing sync keeps of it changed (a tab's last visit, say): said, so its row keeps when that last changed.
    if (op.value !== null) {
      const was = syncedOf(before, op);
      if (was !== undefined && same(was, syncedOf(state, op))) return { ...op, synced: false as const };
    }
    return op;
  });
}

/** What sync keeps of an entity in a state, as the stamping hook projects it (and the icon it names, by address); undefined for kinds it doesn't. */
function syncedOf(s: State, op: WriteOp): unknown {
  switch (op.k) {
    case 'chord': {
      const chord = s.chords[op.id];
      return chord ? localChordFields(chord) : null;
    }
    case 'node': {
      const node = s.nodes[op.id];
      if (!node) return null;
      const set = localNodeFields(node, null);
      return set && node.kind === 'tab' ? { ...set, favicon: node.favicon } : set;
    }
    case 'favorite': {
      const favorite = s.favorites[op.id];
      return favorite ? { ...localFavoriteFields(favorite, null), favicon: favorite.favicon } : null;
    }
    case 'linkRoute': {
      const route = s.linkRoutes[op.id];
      return route ? localRouteFields(route) : null;
    }
    case 'setting':
      return s.settings[op.id as keyof Settings] ?? null;
    default:
      return undefined;
  }
}

/** Every saved entity in a state, for the first write of a brand-new profile (private windows' never are). */
export function opsForState(state: State): WriteOp[] {
  const ops: WriteOp[] = [
    ...Object.values(state.chords).map((value): WriteOp => ({ k: 'chord', id: value.id, value })),
    ...Object.values(state.nodes).map((value): WriteOp => ({ k: 'node', id: value.id, value })),
    ...Object.values(state.windows).map((value): WriteOp => ({ k: 'window', id: value.id, value })),
    ...(Object.keys(state.settings) as (keyof Settings)[]).map((key): WriteOp => ({ k: 'setting', id: key, value: state.settings[key] })),
    ...Object.entries(state.sitePermissions).map(([origin, value]): WriteOp => ({ k: 'sitePermission', id: origin, value })),
    ...Object.values(state.downloads).map((value): WriteOp => ({ k: 'download', id: value.id, value })),
    ...Object.values(state.favorites).map((value): WriteOp => ({ k: 'favorite', id: value.id, value })),
    ...Object.entries(state.extensions).map(([key, value]): WriteOp => ({ k: 'extension', id: key, value })),
    ...Object.entries(state.siteZoom).map(([host, value]): WriteOp => ({ k: 'siteZoom', id: host, value })),
    ...Object.values(state.linkRoutes).map((value): WriteOp => ({ k: 'linkRoute', id: value.host, value })),
  ];
  return ops.filter((op) => !isPrivate(op, state));
}

export type { DuetOp, DuetResult } from './duet';
export type { ExportPhase } from './export';
