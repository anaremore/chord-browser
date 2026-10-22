/**
 * Chord's domain model (ARCHITECTURE.md §6–7). Plain serializable data: the
 * main process owns the authoritative copy, renderers mirror it via patches,
 * and chord-data persists everything except `live` and `closed`.
 */

export type ChordId = string;
export type NodeId = string;
export type WindowId = string;
export type ProfileId = string;

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export interface ChordThemeSpec {
  stops: Oklch[];
  grain: number;
  appearance: 'light' | 'dark' | 'auto';
}

/** A set of tabs with its own color: what other browsers call a space. */
export interface Chord {
  id: ChordId;
  profileId: ProfileId;
  name: string;
  /** Emoji, a symbol name, or a single letter. */
  icon: string;
  theme: ChordThemeSpec;
  rank: string;
  createdAt: number;
}

export type Section = 'pinned' | 'today';

export interface TabNode {
  kind: 'tab';
  id: NodeId;
  chordId: ChordId;
  section: Section;
  parentId: NodeId | null;
  rank: string;
  url: string;
  title: string;
  /** The pinned "home" URL; null for Today tabs. */
  pinnedUrl: string | null;
  customTitle: string | null;
  /** Small data: URL for the site icon, or null for the monogram fallback. */
  favicon: string | null;
  lastActiveAt: number;
  createdAt: number;
}

export interface FolderNode {
  kind: 'folder';
  id: NodeId;
  chordId: ChordId;
  section: 'pinned';
  parentId: NodeId | null;
  rank: string;
  title: string;
  collapsed: boolean;
  createdAt: number;
}

export type SidebarNode = TabNode | FolderNode;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface WindowModel {
  id: WindowId;
  activeChordId: ChordId;
  /** The tab shown for each chord, so switching back lands where you were. */
  activeTab: Record<ChordId, NodeId | null>;
  sidebar: 'docked' | 'collapsed';
  bounds: Bounds | null;
}

/** Engine state that is shown but never persisted. */
export interface LiveTab {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  crashed: boolean;
}

export interface ClosedTab {
  node: TabNode;
  windowId: WindowId;
  closedAt: number;
}

export interface State {
  /** Increments on every change, so mirrors can detect gaps. */
  version: number;
  chords: Record<ChordId, Chord>;
  nodes: Record<NodeId, SidebarNode>;
  windows: Record<WindowId, WindowModel>;
  live: Record<NodeId, LiveTab>;
  /** Recently closed tabs for ⌘⇧T, newest first. Moves to the archive in M1.4. */
  closed: ClosedTab[];
}

export const emptyState = (): State => ({ version: 0, chords: {}, nodes: {}, windows: {}, live: {}, closed: [] });

export const IDLE_LIVE: LiveTab = { loading: false, canGoBack: false, canGoForward: false, audible: false, crashed: false };
