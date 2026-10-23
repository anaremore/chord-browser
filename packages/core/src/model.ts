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
  /** `auto` follows Settings → Appearance → Color scheme. */
  appearance: 'light' | 'dark' | 'auto';
  /** The library theme this came from (`preset:dusk`, or a custom theme's id), so editing it updates the chord. */
  themeId?: string | null;
}

/** A theme the person made (or imported), in Settings → Appearance. */
export interface CustomTheme {
  id: string;
  name: string;
  stops: Oklch[];
  grain: number;
}

export type ColorScheme = 'system' | 'light' | 'dark';

/** Settings → Appearance → Interface, each 0–1 with 0.5 the default. */
export interface InterfaceSettings {
  contrast: number;
  /** How much color covers the window material ("Window tint"). */
  glass: number;
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
/** Why the page didn't load: Chromium's net error code and the address it was loading. */
export interface LoadError {
  code: number;
  url: string;
}

export interface LiveTab {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  crashed: boolean;
  /** The main frame failed to load; the frame shows why instead of a blank page. */
  error: LoadError | null;
}

export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';

/** A file being or having been downloaded (ARCHITECTURE.md §9). */
export interface Download {
  id: string;
  url: string;
  filename: string;
  /** Where it's saved; empty until the engine has picked a path. */
  path: string;
  mime: string;
  state: DownloadState;
  received: number;
  /** 0 when the server didn't say. */
  total: number;
  /** Bytes per second while progressing. */
  speed: number;
  startedAt: number;
  endedAt: number | null;
}

/** What the downloads panel can do with one download. */
export type DownloadAction = 'open' | 'show' | 'pause' | 'resume' | 'cancel' | 'retry' | 'remove';

/** Permissions a site has to ask for (ARCHITECTURE.md §9). Camera and microphone are separate decisions. */
export type SitePermission = 'camera' | 'microphone' | 'location' | 'notifications' | 'clipboard-read';
export type PermissionDecision = 'allow' | 'block';
/** Remembered decisions, by site origin. */
export type SitePermissions = Record<string, Partial<Record<SitePermission, PermissionDecision>>>;

export interface ClosedTab {
  node: TabNode;
  windowId: WindowId;
  closedAt: number;
}

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'brave' | 'kagi' | 'ecosia';

/** Settings → Motion (DESIGN.md §6.8). Off means instant: no animation is created at all. */
export interface MotionSettings {
  /** Honor the OS "reduce motion" preference. */
  followSystem: boolean;
  /** The ⌘L address morph and the ⌘T panel entrance. */
  commandBar: boolean;
  /** Switching chords. */
  chordSlide: boolean;
  /** Pin, archive, reorder, drop settle, close collapse. */
  tabMoves: boolean;
  /** Collapse and dock, peek, folders. */
  sidebar: boolean;
  /** The theme crossfade between chords. */
  colorBlend: boolean;
}

export interface Settings {
  searchEngine: SearchEngineId;
  motion: MotionSettings;
  /** Light, dark, or the computer's setting; also what web pages see as their color scheme. */
  colorScheme: ColorScheme;
  interface: InterfaceSettings;
  themes: CustomTheme[];
  /** Searches from the engine while typing in the command bar (ROADMAP Q4: on, with a switch). Typed addresses never go out. */
  searchSuggestions: boolean;
  /** Installed builds ask GitHub Releases once a day whether a newer Chord is out; nothing installs by itself. */
  checkForUpdates: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'google',
  motion: { followSystem: true, commandBar: true, chordSlide: true, tabMoves: true, sidebar: true, colorBlend: true },
  colorScheme: 'system',
  interface: { contrast: 0.5, glass: 0.5 },
  themes: [],
  searchSuggestions: true,
  checkForUpdates: true,
};

/** A fresh copy of the defaults (State is frozen by Immer, so nothing may share these objects). */
export const defaultSettings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  motion: { ...DEFAULT_SETTINGS.motion },
  interface: { ...DEFAULT_SETTINGS.interface },
  themes: [],
});

/**
 * Whether an animation runs: its switch is on, and the OS isn't asking for
 * reduced motion (unless the user chose to ignore that). Off means instant.
 */
export function motionEnabled(settings: Settings, gate: Exclude<keyof MotionSettings, 'followSystem'>, osReducedMotion: boolean): boolean {
  return settings.motion[gate] && !(settings.motion.followSystem && osReducedMotion);
}

/** A partial change to settings; nested groups merge. */
export interface SettingsPatch {
  searchEngine?: SearchEngineId;
  motion?: Partial<MotionSettings>;
  colorScheme?: ColorScheme;
  interface?: Partial<InterfaceSettings>;
  searchSuggestions?: boolean;
  checkForUpdates?: boolean;
}

export interface State {
  /** Increments on every change, so mirrors can detect gaps. */
  version: number;
  settings: Settings;
  sitePermissions: SitePermissions;
  downloads: Record<string, Download>;
  chords: Record<ChordId, Chord>;
  nodes: Record<NodeId, SidebarNode>;
  windows: Record<WindowId, WindowModel>;
  live: Record<NodeId, LiveTab>;
  /** Recently closed tabs for ⌘⇧T, newest first. Moves to the archive in M1.4. */
  closed: ClosedTab[];
  /** Chords deleted this session, with their tabs, for Undo (newest first; not persisted). */
  deletedChords: DeletedChord[];
}

export interface DeletedChord {
  chord: Chord;
  nodes: SidebarNode[];
  deletedAt: number;
}

export const emptyState = (): State => ({
  version: 0,
  settings: defaultSettings(),
  sitePermissions: {},
  downloads: {},
  chords: {},
  nodes: {},
  windows: {},
  live: {},
  closed: [],
  deletedChords: [],
});

export const IDLE_LIVE: LiveTab = { loading: false, canGoBack: false, canGoForward: false, audible: false, crashed: false, error: null };
