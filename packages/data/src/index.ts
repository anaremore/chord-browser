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
import type { DuetOp, DuetResult } from './duet';
import type { SyncTimings } from './sync';

/**
 * The latest value of one saved entity, or null to delete it. `sync`: the
 * value came from another computer (`sync.apply`): it's saved, and never
 * stamped as a change made here (S15 §4), so it never goes back into this
 * computer's log.
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
) & { sync?: true };

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
  | { type: 'sync.off' }
  | { type: 'sync.remove'; device: string }
  | { type: 'sync.rename'; name: string }
  | { type: 'sync.pause'; paused: boolean }
  /** Chord came to the front: look at the folder now. */
  | { type: 'sync.check' }
  /** Quitting: what's waiting is written now. */
  | { type: 'sync.flush' }
  /** Things main put off applying while a change of its own to them waited (`chord:<id>`, `node:<id>`…): again, now it's written. */
  | { type: 'sync.repush'; keys: string[] }
  /** safeStorage's ciphertext of the root key (base64), kept in chord.db; null forgets it. */
  | { type: 'sync.keyBlob'; blob: string | null }
  /** How long sync's steps took on chord-data's thread (development builds' test hooks: perf.spec.ts). */
  | { type: 'sync.timings' }
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
  /** Why it didn't work: a wrong passphrase, a folder Chord can't use, two set up at once… */
  problem?: 'wrong' | 'conflict' | 'newer' | 'damaged' | 'missing' | 'io' | 'busy';
  /** Joined: a clearly fresh Chord, whose setup the synced one replaces without asking. */
  fresh?: boolean;
  /** Chosen: everything to apply, and, for *Use the synced setup*, the chord this computer's Today tabs go to and the synced chords that stay. */
  apply?: SyncApply;
  replace?: { to: string; keep: string[] } | null;
  keyBlob?: string | null;
  timings?: SyncTimings;
}

/** chord-data → main, unasked: what another computer changed, to apply; and where sync stands, for Settings. */
export type DataPush = { push: 'sync.apply'; apply: SyncApply } | { push: 'sync.status'; status: SyncStatus };

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
    }
  | { id: number; ok: false; error: string };

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
export function opsFromPatches(patches: readonly PathPatch[], state: State): WriteOp[] {
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
      for (const key of keys) add({ k: 'setting', id: key, value: state.settings[key] ?? null });
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
  return [...ops.values()];
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
