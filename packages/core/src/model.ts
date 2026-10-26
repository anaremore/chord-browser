/**
 * Chord's domain model (ARCHITECTURE.md §6–7). Plain serializable data: the
 * main process owns the authoritative copy, renderers mirror it via patches,
 * and chord-data persists everything except `live` and `closed` (the archive
 * keeps closed tabs in its own table).
 */
import { DEFAULT_DEVTOOLS, type DevtoolsPlace, type DevtoolsSettings } from './devtools';
import type { DuetKeep, DuetProvider, DuetScope } from './duet';
import type { ImportRecord } from './import';
import { DEFAULT_READER, type ReaderSettings } from './reader';
import type { ProxySettings } from './proxy';
import type { PageThreat, ThreatKind } from './safe-browsing';
import type { ActionId, ShortcutOverrides } from './shortcuts';

export type ChordId = string;
export type NodeId = string;
export type WindowId = string;
export type ProfileId = string;

/**
 * The sign-ins every chord shares, unless it keeps its own ("Keep sign-ins
 * separate" gives it a profile of its own: ARCHITECTURE.md §6, Profiles).
 */
export const DEFAULT_PROFILE: ProfileId = 'default';

/** A private window's sign-ins: one per window, in memory only, gone when the window closes. */
export const privateProfileId = (windowId: WindowId): ProfileId => `private-${windowId}`;
export const isPrivateProfile = (profileId: ProfileId): boolean => profileId.startsWith('private-');
/** The private window a private profile belongs to. */
export const privateWindowOf = (profileId: ProfileId): WindowId => profileId.slice('private-'.length);

/**
 * The Electron session partition that holds a profile's cookies, storage and
 * cache. A private window's has no `persist:` prefix, so Electron keeps it in
 * memory only.
 */
export const profilePartition = (profileId: ProfileId): string =>
  profileId === DEFAULT_PROFILE ? 'persist:default' : isPrivateProfile(profileId) ? `chord-${profileId}` : `persist:p-${profileId}`;

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

/** The sizes Chord's own interface comes in (DESIGN.md §10: 90–150%), as zoom factors. */
export const UI_SCALES = [0.9, 1, 1.1, 1.25, 1.5] as const;
export type UiScale = (typeof UI_SCALES)[number];
export const isUiScale = (value: unknown): value is UiScale => UI_SCALES.includes(value as UiScale);

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
  /** A private window's own chord: only that window sees it, and nothing of it is ever saved. */
  private?: boolean;
  /** A private window's chord only: sites its page menu turned ad blocking off for, on top of Settings' list, forgotten with the window. */
  blockingOff?: string[];
  /**
   * A proxy of its own (ARCHITECTURE.md §9, Proxies); absent, it uses
   * Settings' proxy for every chord. Only a chord that keeps its own sign-ins
   * has one: Electron sets proxies per session.
   */
  proxy?: ProxySettings;
}

/** How a private window's chord looks: quiet graphite, always dark. */
export const PRIVATE_CHORD_THEME: ChordThemeSpec = { stops: [{ l: 0.72, c: 0.015, h: 260 }], grain: 0.2, appearance: 'dark' };

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
  /** You muted it: its page stays silent through sleep and restarts until you unmute it. */
  muted?: boolean;
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

/** Panes side by side (`row`) or stacked (`column`). */
export type SplitDirection = 'row' | 'column';

/**
 * A split view (DESIGN.md §7.9, §8.4): 2–4 tabs shown together, saved as one
 * unit in Pinned or Today. Its tabs are its children (their `parentId` is the
 * split), in pane order; `sizes` are their shares of the frame, in the same
 * order, summing to 1.
 */
export interface SplitNode {
  kind: 'split';
  id: NodeId;
  chordId: ChordId;
  section: Section;
  parentId: NodeId | null;
  rank: string;
  direction: SplitDirection;
  sizes: number[];
  createdAt: number;
}

export type SidebarNode = TabNode | FolderNode | SplitNode;

/** Split view's limits (DESIGN.md §7.9): up to 4 panes, none narrower than 320 px, 8 px apart. */
export const SPLIT = { maxPanes: 4, minPane: 320, gap: 8 } as const;

/**
 * A site in the Favorites row at the top of the sidebar, shared by every
 * chord (ROADMAP.md Q5). Opening one switches to a tab already showing that
 * site in the current chord, or opens it there.
 */
export interface Favorite {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  rank: string;
  createdAt: number;
}

/** The most favorites; the row wraps well before this. */
export const MAX_FAVORITES = 48;

/** The sidebar's width range (DESIGN.md §3.1): resizable, with a detent at the default. */
export const SIDEBAR_WIDTH = { default: 248, min: 200, max: 400, detent: 8 } as const;

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
  /** The docked sidebar's width, within SIDEBAR_WIDTH. */
  sidebarWidth: number;
  bounds: Bounds | null;
  /** A private window: it shows only its own chord, and Chord forgets it when it closes. */
  private?: boolean;
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
  /** Chord popped the page's video out into picture-in-picture (auto PiP, ARCHITECTURE.md §9). */
  pip: boolean;
  /** The page is sharing your screen, a window or a tab (getDisplayMedia, ARCHITECTURE.md §9). */
  sharing: boolean;
  /** A page is sharing this tab (picked in Chord's picker): it never sleeps, and stays painting off screen. */
  shared: boolean;
  /** Safe Browsing suspects the page (or a frame in it): the frame shows a warning instead (ARCHITECTURE.md §14.5). */
  threat: PageThreat | null;
  /** The page reads as an article: the address offers reader view (ARCHITECTURE.md §9). */
  readable: boolean;
  /** The tab shows its article in reader view, over its page. */
  reader: boolean;
  /** Its service plays in Chord Player instead (ARCHITECTURE.md §9): the frame says so, with a way back. */
  player: boolean;
  /**
   * The count the page gave itself (the Badging API, as an app's icon shows unread messages):
   * a number, 'dot' for one without a number, or null. Null when counts are hidden for its site.
   */
  badge: number | 'dot' | null;
  /**
   * Effects on its page's site (ARCHITECTURE.md §9): applied (`wet`), kept but
   * not applied (`dry`, the site's switch or the one for everywhere), or none.
   */
  effects: 'wet' | 'dry' | null;
  /** The tab's developer tools are open: docked beside its page, or in a window of their own (DESIGN.md §7.16). */
  devtools: DevtoolsPlace | null;
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
  /** Started in this private window: listed only there, never saved, and forgotten when it closes (the file stays). */
  privateWindow?: WindowId;
  /**
   * Safe Browsing suspects where it came from: Chord holds it, paused, until
   * you keep or delete it. Never saved: a held download comes back as interrupted.
   */
  threat?: ThreatKind;
}

/** What the downloads panel can do with one download. `keep` and `discard` answer a held one. */
export type DownloadAction = 'open' | 'show' | 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'keep' | 'discard';

/** A Chrome extension installed in a profile (ARCHITECTURE.md §12). */
export interface InstalledExtension {
  /** 32 letters a–p; for the Chrome Web Store, the store's ID. */
  id: string;
  profileId: string;
  name: string;
  version: string;
  /** `store`: from the Chrome Web Store, verified and kept up to date. `unpacked`: a folder loaded for development. */
  source: 'store' | 'unpacked';
  /** The unpacked folder it loads from. */
  path: string;
  /**
   * The version the extension was last told it was installed or updated to
   * (`runtime.onInstalled`); null until it has been told once. Electron skips
   * Chrome's install step, so Chord does this itself.
   */
  notifiedVersion: string | null;
  /** Its button shows in the sidebar's extensions shelf (or the title bar); every install starts pinned. */
  pinned: boolean;
  installedAt: number;
  updatedAt: number;
}

/** Where extension buttons go (DESIGN.md §3): the sidebar's shelf, or the title bar. */
export type ExtensionButtons = 'sidebar' | 'titleBar';

/** Installed extensions are keyed by profile and ID: the same extension can be in two profiles. */
export const extensionKey = (profileId: string, id: string): string => `${profileId}:${id}`;

/** Permissions a site has to ask for (ARCHITECTURE.md §9). Camera and microphone are separate decisions. */
export type SitePermission = 'camera' | 'microphone' | 'location' | 'notifications' | 'clipboard-read';
export type PermissionDecision = 'allow' | 'block';
/** Remembered decisions, by site origin. */
export type SitePermissions = Record<string, Partial<Record<SitePermission, PermissionDecision>>>;

export interface ClosedTab {
  node: TabNode;
  windowId: WindowId;
  closedAt: number;
  /** Its entry in the archive, which keeps it (with its back/forward history) after this session; null for Chord's own pages. */
  archiveId: string | null;
}

/** Why a tab went to the archive: you closed it, cleared Today, or it sat unused (ARCHITECTURE.md §7). */
export type ArchiveReason = 'auto' | 'closed' | 'cleared';

/** A Today tab in the archive: enough to show it, search it and bring it back. */
export interface ArchivedTab {
  id: string;
  chordId: ChordId;
  url: string;
  title: string;
  favicon: string | null;
  reason: ArchiveReason;
  archivedAt: number;
}

/** Settings → General → "Archive tabs after": how long a Today tab may sit unused. */
export type ArchiveAfter = '12h' | '24h' | '7d' | '30d' | 'never';

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
  /** Chord's sidebar, bars, menus and Settings at this size (Settings → Appearance). Pages keep their own zoom. */
  uiScale: UiScale;
  themes: CustomTheme[];
  extensionButtons: ExtensionButtons;
  /** Searches from the engine while typing in the command bar (ROADMAP Q4: on, with a switch). Typed addresses never go out. */
  searchSuggestions: boolean;
  /** Installed builds ask GitHub Releases once a day whether a newer Chord is out; nothing installs by itself. */
  checkForUpdates: boolean;
  /** New chords keep their own sign-ins (a profile of their own) instead of sharing everyone's. */
  separateSignIns: boolean;
  /** First run is done (DESIGN.md §8.1). Only a brand-new profile starts without it. */
  onboarded: boolean;
  /** Today tabs unused this long go to the archive. */
  archiveAfter: ArchiveAfter;
  /** Background tabs unused for an hour (sooner on battery or low memory) free their memory, and wake when shown again. */
  sleepTabs: boolean;
  /** A playing video pops out into a floating window when you switch away from its tab (ARCHITECTURE.md §9). Off by default. */
  autoPip: boolean;
  /** The one-time switch-off of `autoPip`, when its default became off (2026-10-25), is done: profiles from before get it once. */
  autoPipDefaultOff: boolean;
  /** Hovering a pinned tab or folder shows a preview; pinned pages are kept as small pictures in `<userData>/Captures/` (DESIGN.md §7.6). */
  pagePreviews: boolean;
  /** Presenting mode collapses each window's sidebar, and docks it again when it ends (ARCHITECTURE.md §9). */
  presentingHidesSidebar: boolean;
  /** Minimal mode: pointing at the window's left edge, or resting on the sidebar button, shows the hidden sidebar over the page (DESIGN.md §3.3). Off unless you turn it on. */
  sidebarPeek: boolean;
  /** Recent screenshots are kept in `<userData>/Screenshots/` for the downloads panel's list (DESIGN.md §7.12); off deletes them. */
  keepScreenshots: boolean;
  /** Your changes to the keyboard shortcuts (Settings → Keyboard shortcuts); actions not listed keep the registry's keys. */
  shortcuts: ShortcutOverrides;
  spellcheck: SpellcheckSettings;
  /**
   * Chord itself never contacts Google (docs/decisions/S10-google-free.md): a
   * non-Google search engine (so its suggestions aren't Google's either),
   * spelling only with dictionaries already downloaded, and no background
   * Web Store update checks. Pages you visit can still load from Google.
   */
  googleFree: boolean;
  /**
   * Safe Browsing (ARCHITECTURE.md §14.5): warnings before suspected phishing
   * and malware sites and downloads, from Google's lists. Off in Google-free
   * mode, and never on before its notice was shown.
   */
  safeBrowsing: boolean;
  /** Safe Browsing's notice has been shown and answered (first run, the one-time offer, or Settings). */
  safeBrowsingAsked: boolean;
  /** Ad and tracker blocking (ARCHITECTURE.md §9, decision D5): on by default, in every chord and private window. */
  adBlocking: AdBlockingSettings;
  tabCounts: TabCountsSettings;
  /** Duet, the chat panel (ARCHITECTURE.md §11). */
  duet: DuetSettings;
  /** Where links from other apps open (Chord as the default browser): a mini window, or a new tab. */
  externalLinks: ExternalLinks;
  /** The mini window's size, as you last left it; null until you resize one (DESIGN.md §7.9). */
  miniWindowSize: { width: number; height: number } | null;
  /** Reader view's text size, line width, colors and font, the same on every page (DESIGN.md §7.11). */
  reader: ReaderSettings;
  /** Effects (ARCHITECTURE.md §9): the Dry/Wet switch for every site at once. */
  effects: EffectsSettings;
  /** Developer tools: the side and size docked ones take, and whether new ones open in a window (DESIGN.md §7.16). */
  devtools: DevtoolsSettings;
  /**
   * The proxy for every chord (Settings → Privacy → Proxy): private windows'
   * and Chord's own requests too, and every chord without one of its own.
   * The system's, as Electron does by default, unless you choose another.
   */
  proxy: ProxySettings;
  /** Settings → Your data → Export: *Encrypt with a passphrase*, remembered for next time (the passphrase never is). */
  encryptExports: boolean;
}

/** Settings → Effects: dry everywhere keeps every site's Effects and applies none; each site keeps its own switch too. */
export interface EffectsSettings {
  wet: boolean;
}

export type ExternalLinks = 'mini' | 'tab';

/**
 * A link route (from Crest): links to this site, from other apps or typed in
 * the command bar, open in this chord. `host` matches itself and its
 * subdomains (`github.com` covers `gist.github.com`).
 */
export interface LinkRoute {
  /** The site it covers, as `routeKey` gives it: a host, and maybe a path (`github.com/acme`). */
  host: string;
  chordId: ChordId;
  createdAt: number;
}

/** What Google-free mode searches with until you pick another (any engine but Google). */
export const GOOGLE_FREE_ENGINE: SearchEngineId = 'duckduckgo';

/** Settings → Privacy → Block ads and trackers, and the sites it's off for. */
/** Counts on tabs: the number a page shows on an installed web app's icon (ARCHITECTURE.md §9). */
export interface TabCountsSettings {
  enabled: boolean;
  /** Hosts whose counts don't show (`mail.google.com`), subdomains included. */
  offSites: string[];
}

export interface AdBlockingSettings {
  enabled: boolean;
  /** Sites (registrable domains, `nytimes.com`) where nothing is blocked, subdomains included. */
  offSites: string[];
}

/** Spelling in text fields (ARCHITECTURE.md §9). */
export interface SpellcheckSettings {
  enabled: boolean;
  /** A dictionary language like `en-US` (Windows and Linux); null follows the system. macOS always uses its own. */
  language: string | null;
}

export interface DuetSettings {
  /** Off removes the panel, its button, shortcut and menu items; nothing is ever spawned. */
  enabled: boolean;
  /** Chosen in Setup; null until then. */
  provider: DuetProvider | null;
  /** The provider's model alias or id; null uses its default. */
  model: string | null;
  keep: DuetKeep;
  /** What new threads may read without asking. */
  scope: DuetScope;
  /**
   * Settings' "Nothing": Duet reads no pages at all, whatever a chat's scope.
   * Its sessions get no tools, and nothing can be attached (ARCHITECTURE.md §11.3).
   */
  readsNothing: boolean;
  /** Sites Duet may never read or have attached (origins). */
  neverSites: string[];
  /** Chords where Duet is off. */
  offChords: string[];
  /** Codex may make images when asked (its own image tool, on the user's plan). */
  codexImages: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'google',
  motion: { followSystem: true, commandBar: true, chordSlide: true, tabMoves: true, sidebar: true, colorBlend: true },
  colorScheme: 'system',
  interface: { contrast: 0.5, glass: 0.5 },
  uiScale: 1,
  themes: [],
  extensionButtons: 'sidebar',
  searchSuggestions: true,
  checkForUpdates: true,
  separateSignIns: false,
  onboarded: true,
  archiveAfter: '12h',
  sleepTabs: true,
  autoPip: false,
  autoPipDefaultOff: true,
  pagePreviews: true,
  presentingHidesSidebar: false,
  sidebarPeek: false,
  keepScreenshots: true,
  spellcheck: { enabled: true, language: null },
  shortcuts: {},
  googleFree: false,
  // Off until its notice has been seen: first run shows it (and turns it on), older profiles get a one-time offer.
  safeBrowsing: false,
  safeBrowsingAsked: false,
  adBlocking: { enabled: true, offSites: [] },
  tabCounts: { enabled: true, offSites: [] },
  duet: { enabled: true, provider: null, model: null, keep: 'forever', scope: 'ask', readsNothing: false, neverSites: [], offChords: [], codexImages: true },
  externalLinks: 'mini',
  miniWindowSize: null,
  reader: DEFAULT_READER,
  effects: { wet: true },
  devtools: DEFAULT_DEVTOOLS,
  proxy: { mode: 'system', server: null, pac: null },
  // Plain by default (S15 §3): a forgotten passphrase is a worse failure for a backup than a file someone else might read.
  encryptExports: false,
};

/** A fresh copy of the defaults (State is frozen by Immer, so nothing may share these objects). */
export const defaultSettings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  motion: { ...DEFAULT_SETTINGS.motion },
  interface: { ...DEFAULT_SETTINGS.interface },
  themes: [],
  spellcheck: { ...DEFAULT_SETTINGS.spellcheck },
  shortcuts: {},
  adBlocking: { ...DEFAULT_SETTINGS.adBlocking, offSites: [] },
  tabCounts: { ...DEFAULT_SETTINGS.tabCounts, offSites: [] },
  duet: { ...DEFAULT_SETTINGS.duet, neverSites: [], offChords: [] },
  reader: { ...DEFAULT_SETTINGS.reader },
  effects: { ...DEFAULT_SETTINGS.effects },
  devtools: { ...DEFAULT_SETTINGS.devtools },
  proxy: { mode: 'system', server: null, pac: null },
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
  uiScale?: UiScale;
  extensionButtons?: ExtensionButtons;
  searchSuggestions?: boolean;
  checkForUpdates?: boolean;
  separateSignIns?: boolean;
  onboarded?: boolean;
  archiveAfter?: ArchiveAfter;
  sleepTabs?: boolean;
  autoPip?: boolean;
  autoPipDefaultOff?: boolean;
  pagePreviews?: boolean;
  presentingHidesSidebar?: boolean;
  sidebarPeek?: boolean;
  keepScreenshots?: boolean;
  spellcheck?: Partial<SpellcheckSettings>;
  externalLinks?: ExternalLinks;
  miniWindowSize?: { width: number; height: number } | null;
  googleFree?: boolean;
  /** Ignored while Google-free mode is on. Turning it on counts as having seen its notice. */
  safeBrowsing?: boolean;
  safeBrowsingAsked?: boolean;
  /** `offSites` is the whole new list; entries that aren't sites are dropped. */
  adBlocking?: Partial<AdBlockingSettings>;
  /** `offSites` is the whole new list; entries that aren't hosts are dropped. */
  tabCounts?: Partial<TabCountsSettings>;
  /** Per action: its whole new list of keys, or null to go back to the registry's. */
  shortcuts?: Partial<Record<ActionId, readonly string[] | null>>;
  duet?: Partial<DuetSettings>;
  reader?: Partial<ReaderSettings>;
  effects?: Partial<EffectsSettings>;
  /** Sizes are clamped to their side's minimum and DEVTOOLS.max. */
  devtools?: Partial<DevtoolsSettings>;
  /** The whole new proxy for every chord; one that can't be used (core's cleanProxy) is ignored. */
  proxy?: ProxySettings;
  encryptExports?: boolean;
}

/**
 * Why presenting mode is on (ARCHITECTURE.md §9): a page in Chord is sharing
 * something (`share`, it ends with the last share), or you turned it on
 * (`you`: the switch or its shortcut, for when another app shares Chord).
 */
export type Presenting = 'share' | 'you';

export interface State {
  /** Increments on every change, so mirrors can detect gaps. */
  version: number;
  settings: Settings;
  sitePermissions: SitePermissions;
  downloads: Record<string, Download>;
  /** By `extensionKey(profileId, id)`. */
  extensions: Record<string, InstalledExtension>;
  /** Extensions removed this session, newest first, for Undo (not persisted). */
  removedExtensions: InstalledExtension[];
  chords: Record<ChordId, Chord>;
  nodes: Record<NodeId, SidebarNode>;
  windows: Record<WindowId, WindowModel>;
  live: Record<NodeId, LiveTab>;
  /**
   * Tabs you closed (or cleared) this session, newest first, for ⌘⇧T. They're
   * in the archive too; this keeps their exact place in the sidebar.
   */
  closed: ClosedTab[];
  /** Chords deleted this session, with their tabs, for Undo (newest first; not persisted). */
  deletedChords: DeletedChord[];
  /**
   * Chords sync took away this session (another computer deleted them, or they made way for the synced setup), with
   * their tabs and what moved out of them, for the toast's Undo (newest first; not persisted). Apart from
   * deletedChords, so deleting chords here never pushes one out.
   */
  syncUndo: DeletedChord[];
  /** The Favorites row, shared by every chord. */
  favorites: Record<string, Favorite>;
  /** Folders deleted this session, with what was in them, for Undo (newest first; not persisted). */
  deletedFolders: DeletedFolder[];
  /** Page zoom you chose for a site, by host (1 isn't stored). Shared by every chord, like permissions. */
  siteZoom: Record<string, number>;
  /** Link routes, by host. */
  linkRoutes: Record<string, LinkRoute>;
  /** What each import from another browser added this session, for its Undo (not persisted). */
  imports: Record<string, ImportRecord>;
  /** Presenting mode, and why it's on; null when off. Hides what's private while something is shared (not persisted). */
  presenting: Presenting | null;
  /** Chord windows a page is sharing, as a window or on a shared screen: their edge is tinted (not persisted). */
  sharedWindows: WindowId[];
}

export interface DeletedFolder {
  folder: FolderNode;
  /** Everything that was inside, at any depth. */
  nodes: SidebarNode[];
  deletedAt: number;
}

export interface DeletedChord {
  chord: Chord;
  nodes: SidebarNode[];
  deletedAt: number;
  /** What moved out of it to another chord's Today as it went (sync, S15 §13), as it was: Undo puts it back. */
  moved?: SidebarNode[];
  /** Sync's: which entry it is, for the toast that offers its Undo. */
  id?: string;
  /** Sync took some of its pinned tabs and folders away, not the chord (another computer deleted them): Undo puts them back in it. */
  nodesOnly?: boolean;
}

export const emptyState = (): State => ({
  version: 0,
  settings: defaultSettings(),
  sitePermissions: {},
  downloads: {},
  extensions: {},
  removedExtensions: [],
  chords: {},
  nodes: {},
  windows: {},
  live: {},
  closed: [],
  deletedChords: [],
  syncUndo: [],
  favorites: {},
  deletedFolders: [],
  siteZoom: {},
  linkRoutes: {},
  imports: {},
  presenting: null,
  sharedWindows: [],
});

export const IDLE_LIVE: LiveTab = { loading: false, canGoBack: false, canGoForward: false, audible: false, crashed: false, error: null, pip: false, sharing: false, shared: false, threat: null, readable: false, reader: false, player: false, badge: null, effects: null, devtools: null };

/** Page zoom Chord remembers per site: Chromium's own range. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
