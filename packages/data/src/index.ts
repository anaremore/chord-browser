/**
 * What main sends chord-data, and how a state change becomes writes
 * (ARCHITECTURE.md §6.2). Pure: main imports this; only the utility process
 * imports `@chord/data/db`, so SQLite never runs on main.
 */
import type { Choice, Chord, Download, InstalledExtension, PersistedState, Settings, SidebarNode, SitePermissions, State, WindowModel } from '@chord/core';

/** The latest value of one saved entity, or null to delete it. */
export type WriteOp =
  | { k: 'chord'; id: string; value: Chord | null }
  | { k: 'node'; id: string; value: SidebarNode | null }
  | { k: 'window'; id: string; value: WindowModel | null }
  | { k: 'setting'; id: string; value: Settings[keyof Settings] | null }
  /** All of one site's remembered permission decisions. */
  | { k: 'sitePermission'; id: string; value: SitePermissions[string] | null }
  | { k: 'download'; id: string; value: Download | null }
  /** One installed extension, by `extensionKey(profileId, id)`. */
  | { k: 'extension'; id: string; value: InstalledExtension | null };

/**
 * History happenings: appended, never coalesced (every visit counts). They're
 * written in the same transaction as the batch they arrive with.
 */
export type HistoryEvent =
  | { k: 'visit'; url: string; title: string; at: number }
  | { k: 'title'; url: string; title: string }
  /** A command bar pick: learned for `text` in the chord, and a typed use of `address` if it has one. */
  | { k: 'choice'; chordId: string; text: string; destination: string; address: string | null; at: number };

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
}

/** Main → chord-data. */
export type DataRequest =
  | { id: number; type: 'open'; file: string }
  | { id: number; type: 'write'; ops: WriteOp[]; events: HistoryEvent[] }
  | { id: number; type: 'search'; query: string; chordId: string | null; now: number }
  | { id: number; type: 'close' };

/** chord-data → main. */
export type DataResponse =
  | { id: number; ok: true; saved?: PersistedState | null; search?: SearchResult }
  | { id: number; ok: false; error: string };

/** The part of an Immer patch this needs. */
export interface PathPatch {
  path: readonly (string | number)[];
}

const COLLECTIONS = { chords: 'chord', nodes: 'node', windows: 'window' } as const;

/** A stable key for coalescing: the last write to an entity wins. */
export const opKey = (op: WriteOp): string => `${op.k}:${op.id}`;

/**
 * The entities a change touched, each with its value in `state` after the
 * change. Live engine state, recently closed tabs and the version are never
 * persisted.
 */
export function opsFromPatches(patches: readonly PathPatch[], state: State): WriteOp[] {
  const ops = new Map<string, WriteOp>();
  const add = (op: WriteOp) => ops.set(opKey(op), op);
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
    if (collection === 'sitePermissions') {
      const origins = id === undefined ? Object.keys(state.sitePermissions) : [String(id)];
      for (const origin of origins) add({ k: 'sitePermission', id: origin, value: state.sitePermissions[origin] ?? null });
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

/** Every saved entity in a state, for the first write of a brand-new profile. */
export function opsForState(state: State): WriteOp[] {
  return [
    ...Object.values(state.chords).map((value): WriteOp => ({ k: 'chord', id: value.id, value })),
    ...Object.values(state.nodes).map((value): WriteOp => ({ k: 'node', id: value.id, value })),
    ...Object.values(state.windows).map((value): WriteOp => ({ k: 'window', id: value.id, value })),
    ...(Object.keys(state.settings) as (keyof Settings)[]).map((key): WriteOp => ({ k: 'setting', id: key, value: state.settings[key] })),
    ...Object.entries(state.sitePermissions).map(([origin, value]): WriteOp => ({ k: 'sitePermission', id: origin, value })),
    ...Object.values(state.downloads).map((value): WriteOp => ({ k: 'download', id: value.id, value })),
    ...Object.entries(state.extensions).map(([key, value]): WriteOp => ({ k: 'extension', id: key, value })),
  ];
}
