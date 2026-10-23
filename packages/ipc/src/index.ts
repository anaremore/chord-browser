/**
 * The IPC contract (ARCHITECTURE.md §8). Every channel is declared once here,
 * with the renderer roles allowed to use it and zod schemas for its payloads.
 * Main validates every request against this table; web content gets no IPC.
 */
import {
  ARCHIVE_AFTER_MS,
  SEARCH_ENGINES,
  SHORTCUTS,
  type ActionId as CoreActionId,
  type ArchiveAfter,
  type ArchivedTab,
  type Choice,
  type Chord,
  type CustomTheme,
  type InterfaceSettings,
  type Command,
  type DownloadAction,
  type SearchEngineId,
  type Settings,
  type SettingsPatch as CoreSettingsPatch,
  type SitePermission,
  type SitePermissions,
  type ChordThemeSpec,
  type State,
} from '@chord/core';
import { z } from 'zod';

/** `internal` is the Settings window; `archive` is the archive page (it alone sees archived tabs). */
export type Role = 'shell' | 'overlay' | 'popover' | 'internal' | 'archive';

export const Platform = z.enum(['darwin', 'win32', 'linux']);
export type Platform = z.infer<typeof Platform>;

export const SystemInfo = z.object({
  platform: Platform,
  appearance: z.enum(['light', 'dark']),
  /** OS accent color as `#rrggbb`, when the OS exposes one. */
  accentColor: z.string().nullable(),
  prefersReducedMotion: z.boolean(),
  prefersReducedTransparency: z.boolean(),
  forcedColors: z.boolean(),
  /** Whether an OS material (vibrancy, Mica) shows through the window. */
  material: z.enum(['translucent', 'solid']),
  windowChrome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('traffic-lights'), reservedWidth: z.number() }),
    z.object({ kind: z.literal('overlay'), height: z.number(), reservedWidth: z.number(), side: z.enum(['left', 'right']) }),
  ]),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

export const NavAction = z.enum(['back', 'forward', 'reload', 'stop']);
export type NavAction = z.infer<typeof NavAction>;

/** Any action in the shortcut registry, by id. */
export const ActionId = z.custom<CoreActionId>((value) => typeof value === 'string' && SHORTCUTS.some((s) => s.id === value));

const id = z.string().min(1).max(64);
const url = z.string().min(1).max(32_768);

const Oklch = z.strictObject({ l: z.number().min(0).max(1), c: z.number().min(0).max(0.4), h: z.number().min(0).max(360) });
const ChordTheme = z.strictObject({
  stops: z.array(Oklch).min(1).max(3),
  grain: z.number().min(0).max(1),
  appearance: z.enum(['light', 'dark', 'auto']),
  themeId: z.string().max(64).nullable().optional(),
});

/** A theme in the library (Settings → Appearance). */
export const CustomThemeSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().max(40),
  stops: z.array(Oklch).min(1).max(3),
  grain: z.number().min(0).max(1),
});
/** An emoji, a symbol, or a letter: one or two grapheme clusters at most. */
const chordIcon = z.string().min(1).max(16);
const chordName = z.string().max(64);

/** Commands a renderer may send. Engine-only commands (tab.updated, tab.live) are not accepted from renderers. */
export const RendererCommand = z.discriminatedUnion('t', [
  z.object({ t: z.literal('tab.open'), windowId: id, url, background: z.boolean().optional(), pinned: z.boolean().optional() }),
  z.object({ t: z.literal('tab.activate'), windowId: id, nodeId: id, touch: z.boolean().optional() }),
  z.object({ t: z.literal('tab.close'), windowId: id, nodeId: id }),
  z.object({ t: z.literal('tab.reopenClosed'), windowId: id }),
  z.object({ t: z.literal('tab.navigate'), nodeId: id, url }),
  z.object({ t: z.literal('tab.cycle'), windowId: id, direction: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({
    t: z.literal('node.move'),
    nodeId: id,
    section: z.enum(['pinned', 'today']),
    index: z.number().int().min(0).max(10_000),
    parentId: id.nullable().optional(),
  }),
  // Undo for a move to another chord: back to the exact spot it left.
  z.object({
    t: z.literal('node.moveToChord'),
    nodeId: id,
    chordId: id,
    place: z.object({ section: z.enum(['pinned', 'today']), parentId: id.nullable(), rank: z.string().min(1).max(256) }).optional(),
  }),
  z.object({ t: z.literal('folder.rename'), nodeId: id, title: z.string().max(200) }),
  z.object({ t: z.literal('folder.toggle'), nodeId: id, collapsed: z.boolean() }),
  z.object({ t: z.literal('folder.restore'), nodeId: id }),
  // Dragging a tab onto the Favorites row; the shell picks the id (a UUID).
  z.object({ t: z.literal('favorite.add'), favoriteId: z.uuid(), nodeId: id, index: z.number().int().min(0).max(1000).optional() }),
  z.object({ t: z.literal('favorite.move'), favoriteId: id, index: z.number().int().min(0).max(1000) }),
  z.object({ t: z.literal('favorite.open'), windowId: id, favoriteId: id }),
  // Undo for Clear.
  z.object({ t: z.literal('closed.restore'), windowId: id, nodeIds: z.array(id).max(500), activate: id.nullable().optional() }),
  z.object({ t: z.literal('window.sidebarWidth'), windowId: id, width: z.number().min(0).max(10_000) }),
  z.object({ t: z.literal('tab.pin'), nodeId: id }),
  z.object({ t: z.literal('tab.unpin'), nodeId: id }),
  z.object({ t: z.literal('download.clear'), windowId: id }),
  z.object({ t: z.literal('window.sidebar'), windowId: id, sidebar: z.enum(['docked', 'collapsed']) }),
  z.object({ t: z.literal('chord.create'), windowId: id, name: chordName, icon: chordIcon, theme: ChordTheme }),
  z.object({ t: z.literal('chord.activate'), windowId: id, chordId: id }),
  z.object({ t: z.literal('chord.cycle'), windowId: id, direction: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({ t: z.literal('chord.goto'), windowId: id, index: z.number().int().min(0).max(8) }),
  z.object({ t: z.literal('chord.update'), chordId: id, name: chordName.optional(), icon: chordIcon.optional() }),
  z.object({ t: z.literal('chord.restore'), windowId: id, chordId: id }),
  z.object({ t: z.literal('extension.pin'), profileId: id, id: z.string().regex(/^[a-p]{32}$/), pinned: z.boolean() }),
  z.object({ t: z.literal('extension.restore'), profileId: id, id: z.string().regex(/^[a-p]{32}$/) }),
  // First run (DESIGN.md §8.1) themes the chord being made, and finishes; the shell can't change other settings.
  z.object({ t: z.literal('chord.theme'), chordId: id, theme: ChordTheme.partial() }),
  z.object({ t: z.literal('settings.set'), settings: z.strictObject({ onboarded: z.literal(true) }) }),
  // Undo for "Keep sign-ins separate": back to shared sign-ins, or to the chord's own (Chord's IDs are UUIDs).
  z.object({ t: z.literal('chord.profile'), chordId: id, profileId: z.union([z.literal('default'), z.uuid()]) }),
  // chord.delete isn't here: main deletes, then offers Undo in a toast.
]);
export type RendererCommand = z.infer<typeof RendererCommand>;
// Compile-time check: every renderer command is a real core command.
const _commandsMatch = (c: RendererCommand): Command => c;
void _commandsMatch;

const engineIds = SEARCH_ENGINES.map((e) => e.id) as [SearchEngineId, ...SearchEngineId[]];

const archiveAfterIds = Object.keys(ARCHIVE_AFTER_MS) as [ArchiveAfter, ...ArchiveAfter[]];

export const SettingsPatch = z.strictObject({
  searchEngine: z.enum(engineIds).optional(),
  archiveAfter: z.enum(archiveAfterIds).optional(),
  sleepTabs: z.boolean().optional(),
  autoPip: z.boolean().optional(),
  colorScheme: z.enum(['system', 'light', 'dark']).optional(),
  extensionButtons: z.enum(['sidebar', 'titleBar']).optional(),
  searchSuggestions: z.boolean().optional(),
  checkForUpdates: z.boolean().optional(),
  separateSignIns: z.boolean().optional(),
  spellcheck: z
    .strictObject({ enabled: z.boolean(), language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).nullable() })
    .partial()
    .optional(),
  // Per action: its new keys, or null for the registry's. Main checks every combination again.
  shortcuts: z.record(z.string().max(64), z.array(z.string().max(48)).max(8).nullable()).optional(),
  interface: z.strictObject({ contrast: z.number().min(0).max(1), glass: z.number().min(0).max(1) }).partial().optional(),
  motion: z
    .strictObject({
      followSystem: z.boolean(),
      commandBar: z.boolean(),
      chordSlide: z.boolean(),
      tabMoves: z.boolean(),
      sidebar: z.boolean(),
      colorBlend: z.boolean(),
    })
    .partial()
    .optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;
const _settingsMatch = (p: SettingsPatch): CoreSettingsPatch => p;
void _settingsMatch;

export const ChordThemePatch = ChordTheme.partial();
export type ChordThemePatch = z.infer<typeof ChordThemePatch>;

/** An installed extension, as Settings → Extensions lists it. */
export interface ExtensionInfo {
  id: string;
  profileId: string;
  name: string;
  version: string;
  source: 'store' | 'unpacked';
  description: string;
  /** PNG data URL, or null when it has no icon. */
  icon: string | null;
  hasOptions: boolean;
  /** Loaded and running in this session. */
  loaded: boolean;
}

/**
 * The update check's last answer (Settings → About). `unavailable` in
 * development builds, which aren't released; `idle` before the first check.
 */
export type UpdateStatus =
  | { state: 'unavailable' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current'; checkedAt: number }
  | { state: 'available'; checkedAt: number; version: string; url: string }
  | { state: 'failed'; checkedAt: number };

export const DefaultBrowserStatus = z.enum(['default', 'not-default', 'unavailable']);
export type DefaultBrowserStatus = z.infer<typeof DefaultBrowserStatus>;

/** What the Settings window shows: settings, the chord in the last-used window (for Appearance), every chord, and extensions. */
export interface SettingsSnapshot {
  settings: Settings;
  chord: Pick<Chord, 'id' | 'name' | 'icon' | 'theme'> | null;
  /** Every chord in switcher order, for Settings → General → Sign-ins. */
  chords: Pick<Chord, 'id' | 'name' | 'icon' | 'profileId'>[];
  extensions: ExtensionInfo[];
  /** What you allowed or blocked, by site (Settings → Site permissions). */
  sitePermissions: SitePermissions;
  /** Spelling dictionaries Chord can use (Windows and Linux); empty on macOS, where the system's own checks spelling. */
  spellcheckLanguages: string[];
}

/** One extension's toolbar button, for the window's current tab. */
export interface ExtensionAction {
  id: string;
  profileId: string;
  /** Shown in the shelf (or title bar); the rest are in the extensions list. */
  pinned: boolean;
  title: string;
  badgeText: string;
  /** CSS color, or null for the default. */
  badgeColor: string | null;
  /** PNG data URL at 2× the button's icon size, or null. */
  icon: string | null;
}

/** The extension buttons a window shows (ARCHITECTURE.md §12). */
export interface ExtensionsBarState {
  /** Every extension with a button, pinned or not, in a stable order. */
  actions: ExtensionAction[];
  /** How many extensions the window's profile has, with a button or without (the shelf shows when there are any). */
  installed: number;
  /** The tab shows a Chrome Web Store page for an extension that isn't installed: offer "Add to Chord". */
  offer: { id: string } | null;
  /** Being installed right now, from "Add to Chord". */
  installing: string | null;
}

/** How an install went. */
export type InstallResult = { ok: true; name: string } | { ok: false; error: string };

const extensionId = z.string().regex(/^[a-p]{32}$/);

/** A permission prompt in the popover. */
export interface PermissionPrompt {
  id: number;
  host: string;
  permissions: SitePermission[];
}

export interface FindState {
  text: string;
  matches: number;
  /** 1-based; 0 when nothing matches. */
  active: number;
  /** Changes each time ⌘F is pressed: the bar refocuses and selects its text. */
  focus: number;
}

/** A screen or window a page may capture (getDisplayMedia), for Chord's picker. */
export interface ShareSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** A small JPEG data URL of what would be shared. */
  thumbnail: string;
}

/** A page asking to share your screen: the picker card in the popover. */
export interface SharePrompt {
  id: number;
  host: string;
  sources: ShareSource[];
  /** Offer "Share audio too": the page asked for audio and this OS can capture it (Windows). */
  audio: boolean;
}

/** Everything the popover shows: cards stack top-right over the page. */
export interface PopoverState {
  theme: ChordThemeSpec | null;
  interface: InterfaceSettings;
  find: FindState | null;
  permission: PermissionPrompt | null;
  share: SharePrompt | null;
}

/** The permissions a site can be asked for, in Settings' order. */
export const SITE_PERMISSIONS = ['camera', 'microphone', 'location', 'notifications', 'clipboard-read'] as const satisfies readonly SitePermission[];
const _permissionsMatch = (p: SitePermission): (typeof SITE_PERMISSIONS)[number] => p;
void _permissionsMatch;
const siteOrigin = z.string().max(300).regex(/^https?:[/][/][^/]+$/);

/** History pages, archived tabs and learned picks for a command bar query (chord-data's SearchResult). */
export interface HistorySearch {
  history: { url: string; title: string; visitCount: number; typedCount: number; lastVisitAt: number; frecency: number }[];
  choices: Choice[];
  archive: ArchivedTab[];
}

/** The archive page's entries, newest first (chord-data's ArchivePage). */
export interface ArchiveList {
  items: ArchivedTab[];
  more: boolean;
}

/** What the archive page needs besides its entries: its chord's look, and every chord's name. */
export interface ArchiveSnapshot {
  theme: ChordThemeSpec | null;
  interface: InterfaceSettings;
  chords: Pick<Chord, 'id' | 'name' | 'icon'>[];
}

/** A short-lived note in the sidebar, usually with Undo (DESIGN.md §7.5). */
/** A trackpad scroll gesture starting, ending, or ending in a fling (momentum follows). */
export type GesturePhase = 'begin' | 'end' | 'fling';

export interface Toast {
  id: string;
  message: string;
  action?: { label: string; command: RendererCommand };
}

export interface ChordEdit {
  chordId: string;
  field: 'name' | 'icon';
}

export interface AboutInfo {
  version: string;
  electron: string;
  chromium: string;
  node: string;
  platform: Platform;
  arch: string;
}

export const Rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export type Rect = z.infer<typeof Rect>;

export const OverlayOpen = z.object({
  /**
   * `new`: centered command bar for a new tab. `edit`: anchored on the address,
   * editing the current tab. `downloads`: the downloads panel, anchored on the
   * button that opened it (`anchor`).
   */
  mode: z.enum(['new', 'edit', 'downloads', 'extensions']),
  anchor: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
});
export type OverlayOpen = z.infer<typeof OverlayOpen>;

/** What main tells the overlay when it opens. */
export interface OverlayOpenEvent {
  mode: 'new' | 'edit' | 'downloads' | 'extensions';
  /** Where the address sits, for the anchored placement (window coordinates). */
  anchor: Rect | null;
  /** The current tab's address, prefilled in edit mode. */
  url: string;
  /** Which opening this is: a close for an earlier one is ignored (it can arrive after a newer open). */
  seq: number;
}

export interface StateSnapshot {
  windowId: string;
  state: State;
}

export interface StatePatchEvent {
  version: number;
  /** Immer patches; applied with `applyPatches`. */
  patches: unknown[];
}

/** Renderer → main requests (`ipcRenderer.invoke`). */
export const invokeChannels = {
  'system:info': { roles: ['shell', 'overlay', 'popover', 'internal', 'archive'], request: z.void(), response: SystemInfo },
  'state:snapshot': { roles: ['shell', 'overlay'], request: z.void(), response: z.custom<StateSnapshot>() },
  'cmd:dispatch': { roles: ['shell', 'overlay'], request: RendererCommand, response: z.void() },
  'nav:command': { roles: ['shell', 'overlay'], request: z.object({ action: NavAction }), response: z.void() },
  'overlay:open': { roles: ['shell'], request: OverlayOpen, response: z.void() },
  'overlay:close': { roles: ['overlay'], request: z.object({ seq: z.number().int() }), response: z.void() },
  /** The command bar has started and listens for openings (a new window opens it as soon as it is). */
  'overlay:ready': { roles: ['overlay'], request: z.void(), response: z.void() },
  /** The shell reports where the URL pill / address field sits, for anchored ⌘L. */
  'layout:anchor': { roles: ['shell'], request: Rect.nullable(), response: z.void() },
  'download:action': {
    roles: ['shell', 'overlay'],
    request: z.object({ id, action: z.enum(['open', 'show', 'pause', 'resume', 'cancel', 'retry', 'remove']) }),
    response: z.void(),
  },
  'downloads:openFolder': { roles: ['shell', 'overlay'], request: z.void(), response: z.void() },
  /** The command bar's history and learned picks for what was typed (in the window's chord). */
  'history:search': { roles: ['overlay'], request: z.object({ query: z.string().max(1000) }), response: z.custom<HistorySearch>() },
  /** Search suggestions while typing, from the chosen engine (or a keyword's engine); empty when they're off. */
  'search:suggest': {
    roles: ['overlay'],
    request: z.strictObject({ query: z.string().max(200), engine: z.enum(engineIds).optional() }),
    response: z.array(z.string().max(200)).max(10),
  },
  /** The command bar remembers which row was picked for what was typed. */
  'history:choose': {
    roles: ['overlay'],
    request: z.object({ text: z.string().max(1000), destination: z.string().min(1).max(2048), address: url.optional() }),
    response: z.void(),
  },
  /**
   * Bring an archived tab back. From the command bar it opens and is shown;
   * from the archive page it waits in its chord's sidebar, so you can bring back several.
   */
  'archive:restore': { roles: ['overlay', 'archive'], request: z.strictObject({ archiveId: id }), response: z.void() },
  // The archive page (chord://archive), a tab of its own role.
  'archive:snapshot': { roles: ['archive'], request: z.void(), response: z.custom<ArchiveSnapshot>() },
  'archive:list': {
    roles: ['archive'],
    request: z.strictObject({ query: z.string().max(1000), limit: z.number().int().min(1).max(5000) }),
    response: z.custom<ArchiveList>(),
  },
  /** Forget an archived tab for good. */
  'archive:remove': { roles: ['archive'], request: z.strictObject({ archiveId: id }), response: z.void() },
  /** Windows/Linux options button: pop the app menu below this rect. */
  'menu:app': { roles: ['shell'], request: Rect, response: z.void() },
  /** Right-click on a chord in the switcher, at this point in the window. */
  'menu:chord': { roles: ['shell'], request: z.object({ chordId: id, x: z.number(), y: z.number() }), response: z.void() },
  /** Right-click on a tab or folder row, at this point in the window. */
  'menu:tab': { roles: ['shell'], request: z.object({ nodeId: id, x: z.number(), y: z.number() }), response: z.void() },
  /** Right-click on a favorite. */
  'menu:favorite': { roles: ['shell'], request: z.object({ favoriteId: id, x: z.number(), y: z.number() }), response: z.void() },
  /** Drop a tab on a chord in the switcher: it moves there, with Undo (and a reload if sign-ins differ). */
  'sidebar:moveToChord': { roles: ['shell'], request: z.strictObject({ nodeId: id, chordId: id }), response: z.void() },
  /** Delete a folder and what's in it, with Undo. */
  'sidebar:deleteFolder': { roles: ['shell'], request: z.strictObject({ nodeId: id }), response: z.void() },
  /** Minimal mode: lift the sidebar over the page while it peeks, and put it back. */
  'layout:peek': { roles: ['shell'], request: z.strictObject({ open: z.boolean() }), response: z.void() },
  /** Run an action from the shortcut registry, as if its keys were pressed. */
  'action:run': { roles: ['shell', 'overlay'], request: z.object({ action: ActionId }), response: z.void() },
  // Extensions (ARCHITECTURE.md §12): toolbar buttons in the shell, the list in Settings.
  'extensions:state': { roles: ['shell', 'overlay'], request: z.void(), response: z.custom<ExtensionsBarState>() },
  /** Click an extension's button (or its row in the list): its popup opens under `anchor` (window coordinates). */
  'extension:activate': { roles: ['shell', 'overlay'], request: z.strictObject({ id: extensionId, anchor: Rect }), response: z.void() },
  /** Settings → Extensions, from the list or a button's menu. */
  'extensions:manage': { roles: ['shell', 'overlay'], request: z.void(), response: z.void() },
  /** Right-click an extension's button, at this point in the window. */
  'extension:menu': { roles: ['shell'], request: z.strictObject({ id: extensionId, x: z.number(), y: z.number() }), response: z.void() },
  /** Install from the Chrome Web Store: an extension ID or a store page's address. Into the profile of the caller's chord. */
  'extensions:install': { roles: ['shell', 'internal'], request: z.strictObject({ input: z.string().min(1).max(2048) }), response: z.custom<InstallResult>() },
  'extensions:remove': { roles: ['internal'], request: z.strictObject({ profileId: id, id: extensionId }), response: z.void() },
  /** Open an extension's options page in a new tab of the last-used window. */
  'extensions:options': { roles: ['internal'], request: z.strictObject({ profileId: id, id: extensionId }), response: z.void() },
  /** Check the Chrome Web Store for newer versions now; resolves with how many were updated. */
  'extensions:update': { roles: ['internal'], request: z.void(), response: z.custom<number>() },
  // The Settings window (chord://settings). It sees settings and one chord's theme, not tabs.
  'settings:snapshot': { roles: ['internal'], request: z.void(), response: z.custom<SettingsSnapshot>() },
  'settings:set': { roles: ['internal'], request: SettingsPatch, response: z.void() },
  'settings:theme': { roles: ['internal'], request: z.strictObject({ chordId: id, theme: ChordThemePatch }), response: z.void() },
  'settings:about': { roles: ['internal'], request: z.void(), response: z.custom<AboutInfo>() },
  'settings:saveTheme': { roles: ['internal'], request: z.strictObject({ theme: CustomThemeSchema }), response: z.void() },
  'settings:deleteTheme': { roles: ['internal'], request: z.strictObject({ id: z.string().min(1).max(64) }), response: z.void() },
  /** Put text on the clipboard (Chord's own pages have no clipboard permission of their own). */
  'settings:copyText': { roles: ['internal'], request: z.strictObject({ text: z.string().max(10_000) }), response: z.void() },
  // While Settings records a shortcut, main lets every key through to it (⌘T mustn't open a tab).
  'settings:recordingShortcut': { roles: ['internal'], request: z.strictObject({ recording: z.boolean() }), response: z.void() },
  'settings:chordSignIns': { roles: ['internal'], request: z.strictObject({ chordId: id, separate: z.boolean() }), response: z.void() },
  // Also the shell's, for first run's "Open links in Chord?".
  'settings:defaultBrowser': { roles: ['internal', 'shell'], request: z.void(), response: DefaultBrowserStatus },
  'settings:makeDefaultBrowser': { roles: ['internal', 'shell'], request: z.void(), response: DefaultBrowserStatus },
  'settings:updateStatus': { roles: ['internal'], request: z.void(), response: z.custom<UpdateStatus>() },
  'settings:checkForUpdates': { roles: ['internal'], request: z.void(), response: z.custom<UpdateStatus>() },
  // Settings → Site permissions: change one decision (null asks again next time), or forget a site.
  'settings:sitePermission': {
    roles: ['internal'],
    request: z.strictObject({ origin: siteOrigin, permission: z.enum(SITE_PERMISSIONS), decision: z.enum(['allow', 'block']).nullable() }),
    response: z.void(),
  },
  'settings:forgetSite': { roles: ['internal'], request: z.strictObject({ origin: siteOrigin }), response: z.void() },
  // Screen sharing (ARCHITECTURE.md §9): the picker answers; the sidebar's Stop ends a share.
  'share:respond': {
    roles: ['popover'],
    request: z.strictObject({ id: z.number().int().min(1), sourceId: z.string().max(200).nullable(), audio: z.boolean() }),
    response: z.void(),
  },
  'share:stop': { roles: ['shell'], request: z.strictObject({ nodeId: id }), response: z.void() },
  // The popover: find bar and permission prompts, over the page (ARCHITECTURE.md §5).
  'popover:state': { roles: ['popover'], request: z.void(), response: z.custom<PopoverState>() },
  /** The popover's content size, so main can fit the view to its cards (0 × 0 hides it). */
  'popover:size': { roles: ['popover'], request: z.object({ width: z.number().min(0).max(2000), height: z.number().min(0).max(2000) }), response: z.void() },
  'find:query': { roles: ['popover'], request: z.object({ text: z.string().max(1000), forward: z.boolean() }), response: z.void() },
  'find:close': { roles: ['popover'], request: z.void(), response: z.void() },
  'permission:respond': {
    roles: ['popover'],
    request: z.object({ id: z.number().int().min(1), decision: z.enum(['allow', 'block', 'dismiss']) }),
    response: z.void(),
  },
  /** Open a web link from Settings (About, help) in a new tab of the last-used window. */
  'settings:openUrl': { roles: ['internal'], request: z.strictObject({ url: z.url({ protocol: /^https$/ }) }), response: z.void() },
} as const satisfies Record<string, { roles: readonly Role[]; request: z.ZodType; response: z.ZodType }>;

/** Main → renderer events (`webContents.send`). */
export interface EventPayloads {
  'system:changed': SystemInfo;
  'state:patch': StatePatchEvent;
  'overlay:open': OverlayOpenEvent;
  'settings:changed': SettingsSnapshot;
  'popover:state': PopoverState;
  'toast:show': Toast;
  /** The shell's trackpad gesture phases, for the chord swipe's release (DESIGN.md §6.4). */
  'gesture:phase': GesturePhase;
  /** Start renaming a chord, or choosing its icon, in the sidebar (from its menu). */
  'chord:edit': ChordEdit;
  /** Start renaming a folder in the sidebar (a new one, or from its menu). */
  'sidebar:rename': { nodeId: string };
  /** Jump to a Settings section (`shortcuts` from ⌘⌥/). */
  'settings:section': string;
  'extensions:state': ExtensionsBarState;
  /** The archive gained or lost entries: the archive page lists them again. */
  'archive:changed': null;
  'archive:snapshot': ArchiveSnapshot;
}

export type InvokeChannel = keyof typeof invokeChannels;
export type EventChannel = keyof EventPayloads;
export type InvokeRequest<C extends InvokeChannel> = z.input<(typeof invokeChannels)[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = z.output<(typeof invokeChannels)[C]['response']>;
export type EventPayload<C extends EventChannel> = EventPayloads[C];

/** Largest accepted request payload, serialized (ARCHITECTURE.md §8). */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

interface StateApi {
  snapshot(): Promise<StateSnapshot>;
  onPatch(listener: (event: StatePatchEvent) => void): () => void;
  dispatch(command: RendererCommand): Promise<void>;
}

/** `window.chord` in the shell. */
export interface ShellApi {
  system: {
    info(): Promise<SystemInfo>;
    onChange(listener: (info: SystemInfo) => void): () => void;
  };
  state: StateApi;
  nav: { command(action: NavAction): Promise<void> };
  overlay: { open(mode: OverlayOpen['mode'], anchor?: Rect): Promise<void> };
  downloads: DownloadsApi;
  layout: {
    anchor(rect: Rect | null): Promise<void>;
    /** Minimal mode's sidebar peek: main lifts the shell above the page while it's open. */
    peek(open: boolean): Promise<void>;
  };
  menu: {
    app(anchor: Rect): Promise<void>;
    tab(nodeId: string, at: { x: number; y: number }): Promise<void>;
    chord(chordId: string, at: { x: number; y: number }): Promise<void>;
    favorite(favoriteId: string, at: { x: number; y: number }): Promise<void>;
  };
  sidebar: {
    moveToChord(nodeId: string, chordId: string): Promise<void>;
    deleteFolder(nodeId: string): Promise<void>;
    onRename(listener: (event: { nodeId: string }) => void): () => void;
  };
  chords: { onEdit(listener: (edit: ChordEdit) => void): () => void };
  toasts: { onShow(listener: (toast: Toast) => void): () => void };
  gestures: { onPhase(listener: (phase: GesturePhase) => void): () => void };
  action: { run(action: CoreActionId): Promise<void> };
  extensions: {
    state(): Promise<ExtensionsBarState>;
    onState(listener: (state: ExtensionsBarState) => void): () => void;
    activate(id: string, anchor: Rect): Promise<void>;
    menu(id: string, at: { x: number; y: number }): Promise<void>;
    install(input: string): Promise<InstallResult>;
  };
  /** First run's "Open links in Chord?" (DESIGN.md §8.1). */
  defaultBrowser: { status(): Promise<DefaultBrowserStatus>; make(): Promise<DefaultBrowserStatus> };
  /** Stop a tab's screen share (its sidebar row shows it's sharing). */
  share: { stop(nodeId: string): Promise<void> };
}

interface DownloadsApi {
  run(id: string, action: DownloadAction): Promise<void>;
  openFolder(): Promise<void>;
}

/** `window.chord` in the Settings window. */
export interface SettingsApi {
  system: {
    info(): Promise<SystemInfo>;
    onChange(listener: (info: SystemInfo) => void): () => void;
  };
  settings: {
    snapshot(): Promise<SettingsSnapshot>;
    onChange(listener: (snapshot: SettingsSnapshot) => void): () => void;
    onSection(listener: (section: string) => void): () => void;
    set(patch: SettingsPatch): Promise<void>;
    theme(chordId: string, theme: ChordThemePatch): Promise<void>;
    saveTheme(theme: CustomTheme): Promise<void>;
    deleteTheme(id: string): Promise<void>;
    copyText(text: string): Promise<void>;
    /** Settings is recording a shortcut: main doesn't act on keys pressed in it until this is turned off (or it loses focus). */
    recordingShortcut(recording: boolean): Promise<void>;
    /** Keep a chord's sign-ins separate, or share them again (its tabs reload; the window offers Undo). */
    chordSignIns(chordId: string, separate: boolean): Promise<void>;
    /** Whether Chord opens web links from other apps; `unavailable` in development builds. */
    /** Change one remembered decision for a site (null asks again), or forget the site entirely. */
    sitePermission(origin: string, permission: SitePermission, decision: 'allow' | 'block' | null): Promise<void>;
    forgetSite(origin: string): Promise<void>;
    defaultBrowser(): Promise<DefaultBrowserStatus>;
    /** Asks the OS to make Chord the default (on Windows, opens Settings → Default apps), then reports again. */
    makeDefaultBrowser(): Promise<DefaultBrowserStatus>;
    /** The update check's last answer, and asking again now. */
    updateStatus(): Promise<UpdateStatus>;
    checkForUpdates(): Promise<UpdateStatus>;
    about(): Promise<AboutInfo>;
    openUrl(url: string): Promise<void>;
  };
  extensions: {
    install(input: string): Promise<InstallResult>;
    remove(profileId: string, id: string): Promise<void>;
    options(profileId: string, id: string): Promise<void>;
    update(): Promise<number>;
  };
}

/** `window.chord` on the archive page. */
export interface ArchiveApi {
  system: {
    info(): Promise<SystemInfo>;
    onChange(listener: (info: SystemInfo) => void): () => void;
  };
  archive: {
    snapshot(): Promise<ArchiveSnapshot>;
    onSnapshot(listener: (snapshot: ArchiveSnapshot) => void): () => void;
    list(query: string, limit: number): Promise<ArchiveList>;
    onChange(listener: () => void): () => void;
    restore(archiveId: string): Promise<void>;
    remove(archiveId: string): Promise<void>;
  };
}

/** `window.chord` in the popover (find bar, permission prompts). */
export interface PopoverApi {
  system: {
    info(): Promise<SystemInfo>;
    onChange(listener: (info: SystemInfo) => void): () => void;
  };
  popover: {
    state(): Promise<PopoverState>;
    onState(listener: (state: PopoverState) => void): () => void;
    size(width: number, height: number): Promise<void>;
  };
  find: {
    query(text: string, forward: boolean): Promise<void>;
    close(): Promise<void>;
  };
  permission: { respond(id: number, decision: 'allow' | 'block' | 'dismiss'): Promise<void> };
  /** The screen-share picker: a source to share, or null to cancel. */
  share: { respond(id: number, sourceId: string | null, audio: boolean): Promise<void> };
}

/** `window.chord` in the command bar overlay. */
export interface OverlayApi {
  system: {
    info(): Promise<SystemInfo>;
    onChange(listener: (info: SystemInfo) => void): () => void;
  };
  state: StateApi;
  overlay: {
    onOpen(listener: (event: OverlayOpenEvent) => void): () => void;
    close(seq: number): Promise<void>;
    /** Listening now: main may open the command bar. */
    ready(): Promise<void>;
  };
  action: { run(action: CoreActionId): Promise<void> };
  downloads: DownloadsApi;
  history: {
    search(query: string): Promise<HistorySearch>;
    choose(text: string, destination: string, address?: string): Promise<void>;
  };
  extensions: {
    state(): Promise<ExtensionsBarState>;
    activate(id: string, anchor: Rect): Promise<void>;
    manage(): Promise<void>;
  };
  search: {
    /** What the engine suggests for the text; a newer call cancels an older one. */
    suggest(query: string, engine?: SearchEngineId): Promise<string[]>;
  };
  archive: { restore(archiveId: string): Promise<void> };
}
