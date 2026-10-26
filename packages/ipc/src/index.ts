/**
 * The IPC contract (ARCHITECTURE.md §8). Every channel is declared once here,
 * with the renderer roles allowed to use it and zod schemas for its payloads.
 * Main validates every request against this table; web content gets no IPC.
 */
import {
  ARCHIVE_AFTER_MS,
  EFFECT_PRESET_IDS,
  EFFECTS_LIMITS,
  MAX_PROXY_BYPASS,
  PROXY_SCHEMES,
  READER_FONTS,
  READER_SIZES,
  READER_THEMES,
  READER_WIDTHS,
  SEARCH_ENGINES,
  SHORTCUTS,
  UI_SCALES,
  PASSPHRASE_MAX,
  passphraseProblem,
  DUET_FORM_AREA_MAX,
  DUET_FORM_MAX_FIELDS,
  DUET_SCOPES,
  type ActionId as CoreActionId,
  type ArchiveAfter,
  type ArchivedTab,
  type Choice,
  type Chord,
  type CustomTheme,
  type InterfaceSettings,
  type LinkRoute,
  type Command,
  type DownloadAction,
  type DuetContextUsage,
  type DuetTabName,
  type EffectPresetId,
  type ExportCounts,
  type DuetHit,
  type DuetMessage,
  type DuetProvider,
  type DuetScope,
  type ImportBrowser,
  type ImportChoices,
  type ImportOverview,
  type ImportTarget,
  type ImportedCounts,
  type MergeCapped,
  type MergeCounts,
  type FolderInspection,
  type SyncStatus,
  type ReaderArticle,
  type SettingChange,
  type ScreenshotEntry,
  type ReaderSettings,
  type SearchEngineId,
  type Settings,
  type SettingsPatch as CoreSettingsPatch,
  type SitePermission,
  type SitePermissions,
  type ChordThemeSpec,
  type ProxySettings as CoreProxySettings,
  type State,
} from '@chord/core';
import { z } from 'zod';

/**
 * `internal` is the Settings window; `archive` is the archive page (it alone sees archived tabs); `preview` draws hover
 * previews; `mini` is a mini window's bar; `reader` is a tab's reader view (it sees that tab's article and nothing else);
 * `devtools` is the bar of a tab's developer tools in a window of their own (it sees that tab's site, and docks them).
 */
export type Role = 'shell' | 'overlay' | 'popover' | 'internal' | 'archive' | 'preview' | 'mini' | 'reader' | 'devtools';

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

/**
 * A proxy (Settings → Privacy → Proxy), for every chord or a chord's own.
 * Its shape only: core's cleanProxy checks the host, port, addresses and file
 * the way Chromium reads them, and drops a proxy it can't use.
 */
const proxyServer = z.strictObject({
  scheme: z.enum(PROXY_SCHEMES),
  host: z.string().min(1).max(260),
  port: z.number().int().min(1).max(65_535),
  bypass: z.array(z.string().min(1).max(260)).max(MAX_PROXY_BYPASS),
});
const proxyPac = z.string().min(1).max(8192);
export const ProxySettingsSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('system'), server: proxyServer.nullable(), pac: proxyPac.nullable() }),
  z.strictObject({ mode: z.literal('none'), server: proxyServer.nullable(), pac: proxyPac.nullable() }),
  z.strictObject({ mode: z.literal('server'), server: proxyServer, pac: proxyPac.nullable() }),
  z.strictObject({ mode: z.literal('pac'), server: proxyServer.nullable(), pac: proxyPac }),
]);
// Compile-time check: the schema is core's type.
const _proxyMatch = (p: z.infer<typeof ProxySettingsSchema>): CoreProxySettings => p;
void _proxyMatch;

/** A theme in the library (Settings → Appearance). */
export const CustomThemeSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().max(40),
  stops: z.array(Oklch).min(1).max(3),
  grain: z.number().min(0).max(1),
});
/** An emoji, a symbol, or a letter: one or two grapheme clusters at most. */
/** What a Duet chat may read without asking (core's DUET_SCOPES). */
const duetScope = z.enum(DUET_SCOPES);
const chordIcon = z.string().min(1).max(16);
const chordName = z.string().max(64);

/** Commands a renderer may send. Engine-only commands (tab.updated, tab.live) are not accepted from renderers. */
export const RendererCommand = z.discriminatedUnion('t', [
  z.object({ t: z.literal('tab.open'), windowId: id, url, background: z.boolean().optional(), pinned: z.boolean().optional(), route: z.boolean().optional() }),
  // Link routes (from Crest): "Always open linear.app in Work?" answers with linkRoute.set.
  // A route's site: a host, and maybe a path (`github.com/acme`).
  z.object({ t: z.literal('linkRoute.set'), host: z.string().min(1).max(1000), chordId: id }),
  z.object({ t: z.literal('linkRoute.delete'), host: z.string().min(1).max(1000) }),
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
  // The speaker on a tab's row, its menu, and the Now playing card.
  z.object({ t: z.literal('tab.mute'), nodeId: id, muted: z.boolean() }),
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
  // Undo for a chord's own proxy: the proxy it had, and the sign-ins it had with it.
  z.object({ t: z.literal('chord.proxy'), chordId: id, proxy: ProxySettingsSchema.nullable(), profileId: z.union([z.literal('default'), z.uuid()]).optional() }),
  // Split view (DESIGN.md §8.4): drop a tab on the page, drag a divider, drag a pane out, Undo for separating, ⌘⌥[ / ⌘⌥].
  z.object({
    t: z.literal('split.add'),
    windowId: id,
    withId: id,
    nodeId: id.optional(),
    url: url.optional(),
    index: z.number().int().min(0).max(4).optional(),
    direction: z.enum(['row', 'column']).optional(),
  }),
  z.object({ t: z.literal('split.resize'), splitId: id, sizes: z.array(z.number().positive().max(1)).min(2).max(4) }),
  z.object({ t: z.literal('split.remove'), nodeId: id }),
  z.object({
    t: z.literal('split.join'),
    windowId: id,
    splitId: id,
    nodeIds: z.array(id).min(2).max(4),
    direction: z.enum(['row', 'column']),
    sizes: z.array(z.number().positive().max(1)).min(2).max(4).optional(),
    focus: id.optional(),
  }),
  z.object({ t: z.literal('split.focus'), windowId: id, direction: z.union([z.literal(1), z.literal(-1)]) }),
  // Undo for a page's "Block ads on this site".
  z.object({ t: z.literal('adBlocking.site'), site: z.string().min(1).max(300), off: z.boolean(), chordId: id.optional() }),
  z.object({ t: z.literal('tabCounts.site'), site: z.string().min(1).max(300), off: z.boolean() }),
  // An import's toast: Undo. (Main also takes its history back; import.add is main's alone.)
  z.object({ t: z.literal('import.undo'), importId: id }),
  // A toast's Undo for a change to a site's Effects (main takes it over: Effects live outside the store).
  z.object({ t: z.literal('effects.undo'), token: z.string().regex(/^[0-9a-f]{16,32}$/) }),
  // A toast's Undo for a form Duet filled (main takes it over: what was there before stays in the page).
  z.object({ t: z.literal('duet.undoFill'), token: z.string().regex(/^[0-9a-f]{16,32}$/) }),
  // Presenting mode's indicator turns it off. Only yours: shares start and end it in main.
  z.object({ t: z.literal('presenting.set'), on: z.boolean(), by: z.literal('you') }),
  // Sync (S15 §8): Undo for turning it off or removing a computer, before either happens (main takes it over);
  // Undo for joining with the synced setup, whose chords made way; and a problem's toast, opening Settings.
  z.object({ t: z.literal('sync.undo'), token: z.string().regex(/^[0-9a-f]{16,32}$/) }),
  z.object({ t: z.literal('sync.unreplace'), windowId: id, chordIds: z.array(id).max(1000) }),
  z.object({ t: z.literal('sync.open') }),
  // chord.delete isn't here: main deletes, then offers Undo in a toast. So is split.separate.
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
  pagePreviews: z.boolean().optional(),
  presentingHidesSidebar: z.boolean().optional(),
  sidebarPeek: z.boolean().optional(),
  keepScreenshots: z.boolean().optional(),
  uiScale: z.literal(UI_SCALES).optional(),
  colorScheme: z.enum(['system', 'light', 'dark']).optional(),
  extensionButtons: z.enum(['sidebar', 'titleBar']).optional(),
  searchSuggestions: z.boolean().optional(),
  checkForUpdates: z.boolean().optional(),
  googleFree: z.boolean().optional(),
  // Settings → Privacy's switch, with the notice beside it (main ignores it in Google-free mode).
  safeBrowsing: z.boolean().optional(),
  // Settings → Privacy → Block ads and trackers, and the sites it's off for (core normalizes them).
  tabCounts: z
    .strictObject({
      enabled: z.boolean(),
      offSites: z.array(z.string().max(300)).max(500),
    })
    .partial()
    .optional(),
  adBlocking: z
    .strictObject({ enabled: z.boolean(), offSites: z.array(z.string().max(300)).max(1000) })
    .partial()
    .optional(),
  separateSignIns: z.boolean().optional(),
  externalLinks: z.enum(['mini', 'tab']).optional(),
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
  // Settings → Effects: dry or wet everywhere.
  effects: z.strictObject({ wet: z.boolean() }).partial().optional(),
  // Settings → Privacy → Proxy: the proxy for every chord, whole.
  proxy: ProxySettingsSchema.optional(),
  // Settings → Your data → Export: whether the card starts with Encrypt with a passphrase on.
  encryptExports: z.boolean().optional(),
  duet: z
    .strictObject({
      enabled: z.boolean(),
      provider: z.enum(['claude', 'codex']).nullable(),
      model: z.string().max(100).nullable(),
      keep: z.enum(['forever', '90d', '30d']),
      scope: duetScope,
      readsNothing: z.boolean(),
      neverSites: z.array(z.string().max(300)).max(500),
      offChords: z.array(z.string().max(64)).max(500),
      codexImages: z.boolean(),
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
 * development builds, which aren't released; `managed` in a Flatpak, which
 * Flathub updates; `idle` before the first check.
 */
export type UpdateStatus =
  | { state: 'unavailable' }
  | { state: 'managed' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current'; checkedAt: number }
  | { state: 'available'; checkedAt: number; version: string; url: string }
  /** Installing itself (Windows installer, AppImage): downloading in the background, then waiting for a restart. */
  | { state: 'downloading'; checkedAt: number; version: string; url: string; percent: number }
  | { state: 'ready'; checkedAt: number; version: string; url: string }
  | { state: 'failed'; checkedAt: number };

/**
 * Whether Chord is the default browser. `system`: only the OS's settings can
 * tell or change it (a Flatpak can't); `unavailable`: a development build,
 * which the OS doesn't know about.
 */
export const DefaultBrowserStatus = z.enum(['default', 'not-default', 'system', 'unavailable']);
export type DefaultBrowserStatus = z.infer<typeof DefaultBrowserStatus>;

/** What the Settings window shows: settings, the chord in the last-used window (for Appearance), every chord, and extensions. */
export interface SettingsSnapshot {
  settings: Settings;
  chord: Pick<Chord, 'id' | 'name' | 'icon' | 'theme'> | null;
  /** Every chord in switcher order, for Settings → General → Sign-ins and Privacy → Proxy. */
  chords: Pick<Chord, 'id' | 'name' | 'icon' | 'profileId' | 'proxy'>[];
  extensions: ExtensionInfo[];
  /** What you allowed or blocked, by site (Settings → Site permissions). */
  sitePermissions: SitePermissions;
  /** Spelling dictionaries Chord can use (Windows and Linux); empty on macOS, where the system's own checks spelling. */
  spellcheckLanguages: string[];
  /** Settings → General → Link routes, by site. */
  linkRoutes: LinkRoute[];
  /** Settings → Effects: every site with Effects, newest change first. */
  effects: EffectsSite[];
}

/** A site with Effects, as Settings → Effects lists it. */
export interface EffectsSite {
  host: string;
  /** Its own switch. */
  wet: boolean;
  /** "Your CSS · 2 hidden · Dark". */
  summary: string;
  updatedAt: number;
}

/** Settings → Effects: a site dry or wet, or its Effects removed (Settings asks a second time first). */
export const EffectsSiteChange = z.discriminatedUnion('do', [
  z.strictObject({ do: z.literal('wet'), host: z.string().min(1).max(300), wet: z.boolean() }),
  z.strictObject({ do: z.literal('remove'), host: z.string().min(1).max(300) }),
]);
export type EffectsSiteChange = z.infer<typeof EffectsSiteChange>;

/** Something the sanitizer left out ("url()", "@import"), the line it was on, and why: it would load a file, or Chord doesn't know it. */
export interface EffectsRemoval {
  what: string;
  line: number;
  kind: 'fetch' | 'unknown';
}

/** One site's Effects as the card shows them (DESIGN.md §7.15), pushed as `effects:state` while it's open. */
export interface EffectsView {
  host: string;
  /** The site's own switch. */
  wet: boolean;
  /** Settings' switch for every site: dry there makes every site dry, whatever its own switch says. */
  everywhere: boolean;
  /** Your CSS, as you wrote it, and its own switch. */
  css: string;
  cssOn: boolean;
  /** What the sanitizer left out of your CSS, and the line each was on. */
  removed: EffectsRemoval[];
  /** Each element you hid, with its own switch; `usable` is false when the sanitizer can't use its selector, so it hides nothing. */
  hidden: { selector: string; label: string; on: boolean; usable: boolean }[];
  presets: EffectPresetId[];
  /** Each of Duet's patches: its stylesheet (as Duet or you wrote it), its own switch, and what was left out of it while it's on. */
  duet: { id: string; ask: string; summary: string; css: string; on: boolean; removed: EffectsRemoval[] }[];
  /**
   * Ask Duet: offered only where Duet may read the page (set up, on in this
   * chord, not a Never site, not a private window); how a request is going.
   */
  ask: {
    available: boolean;
    /** "Claude Code" or "Codex". */
    provider: string | null;
    busy: boolean;
    startedAt: number | null;
    /** Why the last request gave nothing, in a sentence. */
    error: string | null;
    /** What Chord left out of the last patch Duet wrote. */
    note: string | null;
  };
  /** A private window's: what's changed here lasts only as long as the window. */
  private: boolean;
}

/** What the card asks main to do. Main checks it against the card's own site again. */
export const EffectsAction = z.discriminatedUnion('do', [
  z.object({ do: z.literal('css'), css: z.string().max(EFFECTS_LIMITS.css) }),
  z.object({ do: z.literal('cssOn'), on: z.boolean() }),
  z.object({ do: z.literal('wet'), wet: z.boolean() }),
  z.object({ do: z.literal('everywhere'), wet: z.boolean() }),
  z.object({ do: z.literal('preset'), id: z.enum(EFFECT_PRESET_IDS), on: z.boolean() }),
  /** A hidden element by its selector: on or off, edited (a narrower selector, another name), or removed. */
  z.object({ do: z.literal('hiddenOn'), selector: z.string().min(1).max(EFFECTS_LIMITS.selector), on: z.boolean() }),
  z.object({
    do: z.literal('editHidden'),
    selector: z.string().min(1).max(EFFECTS_LIMITS.selector),
    next: z.object({ selector: z.string().trim().min(1).max(EFFECTS_LIMITS.selector), label: z.string().max(EFFECTS_LIMITS.label) }),
  }),
  z.object({ do: z.literal('unhide'), selector: z.string().min(1).max(EFFECTS_LIMITS.selector) }),
  /** One of Duet's patches by its id: on or off, edited (its name and CSS), or removed. */
  z.object({ do: z.literal('duetOn'), id: z.string().min(1).max(64), on: z.boolean() }),
  z.object({ do: z.literal('editDuet'), id: z.string().min(1).max(64), summary: z.string().max(EFFECTS_LIMITS.summary), css: z.string().max(EFFECTS_LIMITS.duetCss) }),
  z.object({ do: z.literal('removeDuet'), id: z.string().min(1).max(64) }),
  z.object({ do: z.literal('clear') }),
  /** Hide an element: the card steps aside for the picker. */
  z.object({ do: z.literal('pick') }),
  z.object({ do: z.literal('ask'), text: z.string().trim().min(1).max(EFFECTS_LIMITS.ask) }),
  z.object({ do: z.literal('stop') }),
  z.object({ do: z.literal('close') }),
]);
export type EffectsAction = z.infer<typeof EffectsAction>;

/** What a mini window's bar shows (DESIGN.md §7.9): the page, and the chord "Open in" puts it in. */
export interface MiniState {
  url: string;
  host: string;
  title: string;
  /** Loaded over https: the bar shows a lock. */
  secure: boolean;
  loading: boolean;
  /** The chord "Open in" moves the page to; null when there's none it can go to. */
  target: { id: string; name: string; icon: string } | null;
}

/** What the bar of a tab's developer tools in a window of their own shows (DESIGN.md §7.16): the tab's site, and the side they'd dock on. */
export interface DevtoolsBar {
  host: string;
  title: string;
  side: 'right' | 'bottom';
}

/**
 * Developer tools' controls (DESIGN.md §7.16): close a tab's, pop them out
 * into a window, dock them back, put docked ones on the other side, and the
 * edge being dragged (`done` once it's let go, which saves the size). From
 * the shell, `nodeId` is a tab its window shows; the bar acts on its own tab.
 */
export const DevtoolsAction = z.discriminatedUnion('do', [
  z.strictObject({ do: z.literal('close'), nodeId: id.optional() }),
  z.strictObject({ do: z.literal('window'), nodeId: id.optional() }),
  z.strictObject({ do: z.literal('dock'), nodeId: id.optional() }),
  z.strictObject({ do: z.literal('side'), side: z.enum(['right', 'bottom']) }),
  z.strictObject({ do: z.literal('resize'), size: z.number().min(0).max(10_000), done: z.boolean() }),
]);
export type DevtoolsAction = z.infer<typeof DevtoolsAction>;

/** What Peek's chrome shows (DESIGN.md §7.9, §8.5). */
export interface PeekState {
  url: string;
  host: string;
  title: string;
  /** The card, in window coordinates; the page sits in it below the header. */
  card: Rect;
  /** Where the card grows from: the click that opened it. */
  origin: { x: number; y: number } | null;
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

/**
 * A site (or a proxy) asking for a username and password in the browser's own
 * box: HTTP Basic, Digest or NTLM (ARCHITECTURE.md §9).
 */
export interface AuthPrompt {
  id: number;
  /** The scheme, host and port that asked, as Chromium's own box shows it: `http://router.local:8080`. */
  origin: string;
  /** What the site calls the area (its realm), the site's own words; empty when it gave none. */
  realm: string;
  /** A proxy between you and the web is asking, not the site. */
  proxy: boolean;
  /** The site isn't on HTTPS: what you type crosses the network unencrypted. */
  insecure: boolean;
  /** The last answer didn't work. */
  retry: boolean;
}

/** Choosing which passkey signs you in, when the authenticator holds several for the site. */
export interface PasskeyPrompt {
  id: number;
  /** The site asking (its relying party ID, a domain). */
  site: string;
  /** The site's own names for each account. */
  accounts: { credentialId: string; name: string; displayName: string }[];
}

export interface FindState {
  text: string;
  matches: number;
  /** 1-based; 0 when nothing matches. */
  active: number;
  /** Changes each time ⌘F is pressed: the bar refocuses and selects its text. */
  focus: number;
}

/** What a page may capture (getDisplayMedia), for Chord's picker: one of Chord's tabs, a screen or a window. */
export interface ShareSource {
  /** `tab:<node id>` for a tab; the OS's id for a screen or window. */
  id: string;
  /** A tab's title, or the screen's or window's name. */
  name: string;
  kind: 'tab' | 'screen' | 'window';
  /** A screen's or window's picture, a small JPEG data URL; empty until it's taken (names come first), and for tabs. */
  thumbnail: string;
  /** A tab's site, and its icon (a data: URL, or null for the monogram). */
  host?: string;
  favicon?: string | null;
  /** The tab that's asking. */
  self?: boolean;
}

/** The picker's answer that hands screens and windows over to the system's own picker (`SharePrompt.systemPicker`). */
export const SYSTEM_SHARE_SOURCE = 'system';

/** A page asking to share your screen, a window or a tab: the picker card in the popover. */
export interface SharePrompt {
  id: number;
  host: string;
  /** Tabs, the asking one first, then screens and windows by name. */
  sources: ShareSource[];
  /** Screens' and windows' pictures are still on their way. */
  loading: boolean;
  /** The page asked for sound: a tab's comes with it if you like; a screen's is the computer's (`systemAudio`). */
  audio: boolean;
  /** The computer's sound can be shared with a screen or window (Windows only). */
  systemAudio: boolean;
  /**
   * Screens and windows are picked in the system's own picker, which Chord's
   * opens (`SYSTEM_SHARE_SOURCE`): macOS 15 and later, and Wayland's portal.
   * Chord lists only tabs itself then.
   */
  systemPicker: boolean;
}

/**
 * A tab playing media, or paused a moment ago, for the sidebar's Now playing
 * card (DESIGN.md §7.10). What it plays comes from the page's Media Session,
 * read where the page's scripts can't see (ARCHITECTURE.md §9).
 */
export interface NowPlaying {
  nodeId: string;
  /** The track, from the page's Media Session; empty when it gives none (the card shows the tab's title instead). */
  title: string;
  artist: string;
  album: string;
  /** The track's artwork as a small data: URL, or null (the card shows the site's icon). */
  artwork: string | null;
  /** Playing now; false while it waits, paused, for a little while before the card lets it go. */
  playing: boolean;
  /** Chord can pause and play it: its player is in the page itself, not an embedded frame. */
  pausable: boolean;
  /** A video is playing that can pop out into picture-in-picture. */
  video: boolean;
  /** Its video is in picture-in-picture now, put there by Chord or by the site itself. */
  pip: boolean;
  /** It plays in Chord Player, for this tab (ARCHITECTURE.md §9): the card goes back to the player, not the tab, and mutes the player. */
  player?: boolean;
  /** The player's own mute (a tab's is `TabNode.muted`). */
  muted?: boolean;
}

/** What the Now playing card's buttons ask main to do (a tab's mute and Go to tab are commands; Chord Player's mute is `mute`/`unmute`). */
export const MediaAction = z.enum(['play', 'pause', 'pictureInPicture', 'mute', 'unmute']);
export type MediaAction = z.infer<typeof MediaAction>;

/** Everything the popover shows: cards stack top-right over the page. */
/** One row of a folder's hover preview. */
export interface PreviewRow {
  title: string;
  url: string;
  favicon: string | null;
}

/** A hover preview (DESIGN.md §7.6): what main sends the preview view to draw, in the hovered tab's chord colors. */
export type PreviewCard = {
  theme: ChordThemeSpec;
  interface: InterfaceSettings;
  /** Crossfade between cards (Settings → Motion → Animate the sidebar, and reduced motion). */
  animate: boolean;
} & (
  | {
      kind: 'tab';
      id: string;
      title: string;
      url: string;
      favicon: string | null;
      /** "Opened 2 h ago". */
      opened: string;
      /** The last picture of the page, as a data URL; null shows its icon on its tint. */
      thumbnail: string | null;
    }
  | {
      kind: 'folder';
      id: string;
      title: string;
      /** The first six tabs inside, nested folders flattened. */
      rows: PreviewRow[];
      /** "and 4 more". */
      more: number;
    }
);

/** The sidebar row the pointer rests on (shell coordinates), or null when it leaves. */
export const PreviewTarget = z
  .object({
    nodeId: id,
    top: z.number().min(-10_000).max(100_000),
    bottom: z.number().min(-10_000).max(100_000),
  })
  .nullable();
export type PreviewTarget = z.infer<typeof PreviewTarget>;

export interface PopoverState {
  theme: ChordThemeSpec | null;
  interface: InterfaceSettings;
  find: FindState | null;
  permission: PermissionPrompt | null;
  share: SharePrompt | null;
  auth: AuthPrompt | null;
  passkey: PasskeyPrompt | null;
  /** The one-time offer to turn Safe Browsing on, with its notice (profiles from before it existed). */
  safeBrowsingOffer: boolean;
  /** The page is on a service that needs Widevine, which Chord doesn't include yet (D4). */
  drm: DrmNotice | null;
  /** The Effects card for the site on screen (DESIGN.md §7.15); `opened` changes each time it opens, and it takes the keyboard. */
  effects: { host: string; opened: number } | null;
}

export const OTHER_BROWSERS = ['chrome', 'edge', 'firefox', 'safari', 'brave'] as const;
export type OtherBrowserId = (typeof OTHER_BROWSERS)[number];

/** The DRM notice: the service, Chord Player when it's offered, and up to two other browsers on this computer to open its page in. */
export interface DrmNotice {
  service: string;
  browsers: { id: OtherBrowserId; name: string }[];
  /** Chord Player (ARCHITECTURE.md §9): null in Google-free mode, private windows, and where it can't run or no signed release is found. */
  player: PlayerOffer | null;
  /** Linux: some services refuse it or play it at lower quality (S14 §1). */
  linux: boolean;
}

/**
 * What the DRM notice offers of Chord Player (DESIGN.md §7.1, the notice's states): installing it
 * (its download's size; `update` when the installed one is too old for this Chord), its progress,
 * opening the page in it, or why installing failed (with Try again).
 */
export type PlayerOffer =
  | { state: 'install'; size: number; update: boolean }
  | { state: 'installing'; phase: 'downloading' | 'checking' | 'unpacking'; percent: number }
  | { state: 'ready' }
  | { state: 'opening' }
  | { state: 'failed'; why: PlayerFailure };

/** Why installing or starting Chord Player failed. */
export type PlayerFailure = 'download' | 'verify' | 'unpack' | 'start' | 'widevine';

/** Chord Player for Settings (General → Chord Player). */
export interface PlayerStatus {
  /** This computer can have it: a supported OS and architecture, not a Flatpak, and a build that can check its signature. */
  available: boolean;
  googleFree: boolean;
  installed: { version: string; ecs: string; vmp: 'production' | 'development' | 'none' } | null;
  /** A newer version downloaded, waiting to start the next time the player opens. */
  pending: string | null;
  running: boolean;
}

/**
 * Safe Browsing on this computer (ARCHITECTURE.md §14.5), for Settings and
 * first run. `available`: this build has Google's API key (or, in
 * development, a test server); without it Chord never turns it on.
 */
export interface SafeBrowsingStatus {
  available: boolean;
  /** On, and not stopped by Google-free mode. */
  active: boolean;
  /** When the lists last updated, or null before the first time. */
  updatedAt: number | null;
  /** The last update failed; Chord tries again later. */
  failing: boolean;
  /** Hash prefixes in the lists on this computer. */
  entries: number;
}

/** Ad and tracker blocking's lists on this computer (ARCHITECTURE.md §9), for Settings → Privacy. */
export interface AdBlockingStatus {
  /** On (Settings' switch). */
  active: boolean;
  /** Each list's version (its `! Version:` line) and when Chord last got it or confirmed it was current. */
  lists: { id: string; name: string; version: string | null; checkedAt: number | null }[];
  /** The last refresh failed; Chord tries again later and keeps blocking with the lists it has. */
  failing: boolean;
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

/**
 * A tab's article for its reader view (ARCHITECTURE.md §9), already cleaned
 * by core's `sanitizeArticle`, as JSON text of a `ReaderArticleView`: main
 * passes it along without walking it. An image's `src` is a number: the
 * reader loads `imageBase` + that number, which main fetches through the
 * tab's own session (its cookies), and nothing else.
 */
export interface ReaderPage {
  article: string;
  /** `chord://reader/image/<this reader's key>/`. */
  imageBase: string;
}

/** What a reader view's `article` holds. */
export type ReaderArticleView = Omit<ReaderArticle, 'images'>;

/** How a reader view looks: its tab's chord colors, Settings' interface and reader choices, and its keys. */
export interface ReaderLook {
  theme: ChordThemeSpec | null;
  interface: InterfaceSettings;
  reader: ReaderSettings;
  /** The OS asks for reduced motion and Settings → Motion follows it. */
  reducedMotion: boolean;
  /** The keycap for showing and hiding reader view ("F9", "⌥⌘R"), as you set it; empty when it has none. */
  toggleKeys: string;
}

/** A change to the reader's controls, from the reader itself. */
export const ReaderSettingsPatch = z
  .strictObject({
    size: z.number().int().min(0).max(READER_SIZES - 1),
    width: z.enum(READER_WIDTHS),
    theme: z.enum(READER_THEMES),
    font: z.enum(READER_FONTS),
  })
  .partial();

/**
 * Settings a Chord file brings (S15 §5), checked in main against the same
 * schema Settings' own changes pass: only the ones that travel (never the
 * interface's size or update checks, which are this computer's), with the
 * two no Settings row sets alone: Safe Browsing's notice answered, and reader
 * view's look.
 */
export const ImportedSettings = SettingsPatch.omit({ uiScale: true, checkForUpdates: true }).extend({ safeBrowsingAsked: z.boolean().optional(), reader: ReaderSettingsPatch.optional() });

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

/** What a toast's button does: a command in the shell's store (Undo), "Restart to update", or a screenshot's Save or Ask Duet. */
export type ToastAction = { label: string; command: RendererCommand } | { label: string; update: 'restart' } | { label: string; screenshot: { id: string; do: 'save' | 'duet' } };

export interface Toast {
  id: string;
  message: string;
  /** Most run a command in the shell's store (Undo); "Restart to update" asks main to install. */
  action?: ToastAction;
  /** A second button, before the first (a screenshot's Ask Duet beside its Save). */
  secondary?: ToastAction;
  /** A second line with its own action, about the same thing ("Always open linear.app here?" under "Moved to Work"). */
  also?: { message: string; action: { label: string; command: RendererCommand } };
  /** Shown even in presenting mode, which hides Chord's other toasts: it's about the share itself, or answers what you just did (a screenshot). */
  whilePresenting?: boolean;
}

/** Taking a screenshot (DESIGN.md §7.12): where the page is, in UI units (the overlay's CSS pixels). */
export interface CaptureStart {
  pane: Rect;
  /** Picking elements to hide (Effects, DESIGN.md §7.15) rather than a screenshot; the site they're hidden on. */
  hide?: { host: string };
}

/** The element under the pointer: where it shows (UI units, cut to the pane), what it is, and its size in the page. */
export interface CaptureHit {
  rect: Rect;
  label: string;
  width: number;
  height: number;
}

/** What to take: the picked element, a dragged area (UI units), what's on screen, or the whole page. */
export const ScreenshotChoice = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('element') }),
  z.strictObject({ kind: z.literal('area'), rect: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive().max(100_000), height: z.number().positive().max(100_000) }) }),
  z.strictObject({ kind: z.literal('visible') }),
  z.strictObject({ kind: z.literal('page') }),
]);
export type ScreenshotChoice = z.infer<typeof ScreenshotChoice>;

/** One of the recent screenshots, with its thumbnail as a data URL (JPEG). */
export interface ScreenshotItem extends ScreenshotEntry {
  thumb: string | null;
  /** Duet may be asked about it here (it's set up, and may read the page it's of). */
  duet: boolean;
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
  mode: z.enum(['new', 'edit', 'downloads', 'extensions', 'split']),
  anchor: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
});
export type OverlayOpen = z.infer<typeof OverlayOpen>;

/** What main tells the overlay when it opens. */
export interface OverlayOpenEvent {
  /**
   * `peek`: Peek's chrome around a link from a pinned tab (main opens it; the shell can't).
   * `split`: the command bar for "Split with…": what you pick opens beside the current tab.
   */
  mode: 'new' | 'edit' | 'downloads' | 'extensions' | 'split' | 'peek' | 'capture';
  /** Where the address sits, for the anchored placement (window coordinates). */
  anchor: Rect | null;
  /** The current tab's address, prefilled in edit mode. */
  url: string;
  /** Which opening this is: a close for an earlier one is ignored (it can arrive after a newer open). */
  seq: number;
  /** Peek's page and card, in peek mode. */
  peek?: PeekState;
  /** Taking a screenshot: the page's pane, in capture mode. */
  capture?: CaptureStart;
  /**
   * When main got the request to open (the shortcut, or the shell's button), in
   * epoch ms (`performance.timeOrigin + performance.now()`). The command bar
   * measures its open budget from here (ARCHITECTURE.md §1).
   */
  requestedAt: number;
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

/* ---------- Duet (ARCHITECTURE.md §11) ---------- */

export const DuetProviderSchema = z.enum(['claude', 'codex']);

/** What the panel asks main to do. Everything is checked again in main (scope, private, never-sites). */
export const DuetAction = z.discriminatedUnion('do', [
  z.object({ do: z.literal('toggle'), open: z.boolean().optional() }),
  /** Settings → Duet, from the panel (what it can read). */
  z.object({ do: z.literal('settings') }),
  z.object({ do: z.literal('dismissFirstUse') }),
  z.object({ do: z.literal('setup'), provider: DuetProviderSchema }),
  /** Duet off (or back on) in the window's current chord. */
  z.object({ do: z.literal('chordOff'), off: z.boolean() }),
  z.object({ do: z.literal('signIn'), provider: DuetProviderSchema }),
  z.object({ do: z.literal('refresh') }),
  z.object({ do: z.literal('send'), text: z.string().min(1).max(50_000) }),
  z.object({ do: z.literal('stop') }),
  z.object({ do: z.literal('retry') }),
  z.object({ do: z.literal('unqueue'), index: z.number().int().min(0).max(100) }),
  z.object({ do: z.literal('approve'), messageId: id, decision: z.enum(['once', 'thread', 'denied']) }),
  z.object({ do: z.literal('new') }),
  z.object({ do: z.literal('open'), threadId: id }),
  z.object({ do: z.literal('continue') }),
  z.object({ do: z.literal('delete'), threadId: id }),
  z.object({ do: z.literal('rename'), threadId: id, title: z.string().min(1).max(80) }),
  z.object({ do: z.literal('scope'), scope: duetScope }),
  z.object({ do: z.literal('model'), provider: DuetProviderSchema, model: z.string().max(100).nullable() }),
  z.object({ do: z.literal('attach'), nodeId: id }),
  z.object({ do: z.literal('detach'), nodeId: id }),
  z.object({ do: z.literal('unattachImage'), id: z.string().regex(/^[0-9a-f]{24}$/) }),
  /** Edit and send again: that message's images go back in the composer. */
  z.object({ do: z.literal('reuseImages'), messageId: id }),
  z.object({ do: z.literal('draft'), text: z.string().max(20_000) }),
  z.object({ do: z.literal('citation'), messageId: id, n: z.number().int().min(1).max(500) }),
  /** An image in the chat: copy it, or save it to Downloads. */
  z.object({ do: z.literal('image'), id: z.string().regex(/^[0-9a-f]{24}$/), what: z.enum(['copy', 'save']) }),
  /** Claude said it can't make the image asked for: go on with Codex, asking it again. */
  z.object({ do: z.literal('makeWithCodex') }),
  /** A tab a reply mentions: switch to it, or open its page if it's gone. */
  z.object({ do: z.literal('showTab'), ref: z.string().regex(/^t[0-9]{1,4}$/) }),
  /**
   * A fill card's Fill (D16): the fields you kept, with your values. Main checks each against
   * what it read, the tab against the one on screen, and the page against the one read.
   */
  z.object({
    do: z.literal('fill'),
    messageId: id,
    fields: z
      .array(z.strictObject({ id: z.string().regex(/^f[0-9]{1,6}$/), value: z.union([z.string().max(DUET_FORM_AREA_MAX), z.boolean()]) }))
      .max(DUET_FORM_MAX_FIELDS),
  }),
  /** A fill card's Not now. */
  z.object({ do: z.literal('dismissFill'), messageId: id }),
  z.object({ do: z.literal('export') }),
]);
export type DuetAction = z.infer<typeof DuetAction>;

export interface DuetProviderInfo {
  provider: DuetProvider;
  installed: boolean;
  path: string | null;
  version: string | null;
  signedIn: boolean | null;
  billing: 'subscription' | 'api-key' | 'other' | null;
  tooOld: boolean;
  /** Installed only inside WSL: the distro it runs in ("Claude Code in WSL (Ubuntu)"). */
  wsl: string | null;
}

/** What one window's Duet panel shows (pushed as `duet:state`). */
export interface DuetView {
  /** Duet is on (Settings) and this isn't a private window. */
  enabled: boolean;
  open: boolean;
  provider: DuetProvider | null;
  providers: DuetProviderInfo[];
  chordOff: boolean;
  /** Settings → Duet's "Nothing": no tabs, pages or images, and no scope to choose per chat. */
  readsNothing: boolean;
  /** The transparency card hasn't been dismissed yet. */
  firstUse: boolean;
  thread: { id: string | null; title: string; scope: DuetScope; provider: DuetProvider; model: string | null } | null;
  continueFrom: { id: string; title: string } | null;
  threads: { id: string; title: string; lastUsedAt: number }[];
  messages: DuetMessage[];
  busy: boolean;
  startedAt: number | null;
  queue: string[];
  attachments: { nodeId: string; title: string; url: string; current: boolean }[];
  attachable: { nodeId: string; title: string; url: string }[];
  readTabIds: string[];
  error: { kind: string; message: string } | null;
  draft: string;
  /** How full the chat's context is, when the provider's CLI reports it (null hides the meter). */
  context: DuetContextUsage | null;
  /** Images waiting in the composer, to go with the next message (a pasted image, a screenshot). */
  pendingImages: { id: string }[];
  /**
   * Thumbnails (JPEG data URLs) of images in the chat or the composer, by id: each sent to a window
   * once (all of them when it asks for the whole view), so a streaming reply doesn't resend them.
   */
  imageThumbs: Record<string, string>;
  /** Codex can make images (allowed, installed, signed in): Claude's "can't" offers it. */
  codexImages: boolean;
  /** The chat's tabs by handle ("t1"), so a reply that mentions one shows its name. */
  tabNames: Record<string, DuetTabName>;
  /** Providers Setup is still looking for inside WSL (Windows). */
  lookingInWsl: DuetProvider[];
}

/* ---------- Import from other browsers (ARCHITECTURE.md §9) ---------- */

/** A browser profile Chord found. Main keeps where it is; a renderer only names it back by `key`. */
export interface ImportSource {
  key: string;
  browser: ImportBrowser;
  /** "Chrome", or "Chrome · Work" when the browser has several profiles; Flatpak and Snap copies say so. */
  label: string;
  /** Safari without Full Disk Access: Chord says how to grant it. */
  denied: boolean;
}

/**
 * Why a profile couldn't be read: macOS' Full Disk Access (`denied`), a file
 * the browser holds (`locked`), a damaged or unknown file (`unreadable`),
 * nothing there (`missing`), or another import still running (`busy`).
 */
export type ImportProblem = 'denied' | 'locked' | 'unreadable' | 'missing' | 'busy';

/** What a profile holds, counted before anything is imported, with each group's mapping to start from. */
export interface ImportSummary extends ImportOverview {
  key: string;
}

export type ImportPreviewResult = { ok: true; summary: ImportSummary } | { ok: false; problem: ImportProblem };
export type ImportRunResult = { ok: true; importId: string } | { ok: false; problem: ImportProblem };

/** What an import brought. */
export interface ImportCounts {
  bookmarks: number;
  folders: number;
  chords: number;
  favorites: number;
  tabs: number;
  /** History pages written. */
  pages: number;
}

/** How an import is going, pushed to whoever started it (`import:progress`). */
export interface ImportProgress {
  importId: string;
  /**
   * `bookmarks` while folders and tabs land, `history` while pages are
   * written (`done` of `total`), then `done`; `failed` keeps what had landed;
   * `undone` after Undo.
   */
  phase: 'bookmarks' | 'history' | 'done' | 'failed' | 'undone';
  done: number;
  total: number;
  counts: ImportCounts;
  problem?: ImportProblem;
}

const importTarget = z.custom<ImportTarget>((v) => typeof v === 'string' && /^(new|favorites|skip|chord:[A-Za-z0-9-]{1,64})$/.test(v));

/** Where each group, the open tabs and the history go. Main checks every chord again, and never uses a private window's. */
export const ImportChoicesSchema = z.strictObject({
  groups: z.record(z.string().regex(/^r\d{1,4}(\/\d{1,6})?$/), importTarget).refine((groups) => Object.keys(groups).length <= 2000),
  tabs: importTarget,
  history: z.boolean(),
});
const _choicesMatch = (c: z.infer<typeof ImportChoicesSchema>): ImportChoices => c;
void _choicesMatch;
const importKey = z.string().regex(/^[0-9a-f]{16}$/);

/* ---------- Your data: export (docs/decisions/S15-your-data.md §7–§8) ---------- */

/** Why an export stopped: Chord couldn't write where you chose (`write`), or couldn't read its own data (`read`). */
export type ExportProblem = 'write' | 'read';

/** `cancelled`: the save dialog was closed; `busy`: another export is still being written. */
export type ExportRunResult = { ok: true; exportId: string; name: string } | { ok: false; problem: 'cancelled' | 'busy' };

/** How an export is going, pushed to Settings (`export:progress`). */
export interface ExportProgress {
  exportId: string;
  /**
   * `key` while the passphrase becomes the file's key, then each part as it's
   * written (setup, Today tabs and icons, history, Duet), then `done` or `failed`.
   */
  phase: 'key' | 'setup' | 'today' | 'history' | 'duet' | 'done' | 'failed';
  /** History's pages, or Duet's chats, written so far, of `total`. */
  done: number;
  total: number;
  /** How much of the whole is written, 0 to 1: the bar. */
  share: number;
  /** The file's name, without its folder. */
  name: string;
  /** Its size, once saved. */
  bytes?: number;
  /** Things left out for being bigger than a file's line may be (32 MB): a huge image, say. */
  skipped?: number;
  problem?: ExportProblem;
}

/** What goes in, and how (a passphrase only when Encrypt with a passphrase is on). Main checks the passphrase's length again. */
export const ExportRequestSchema = z.strictObject({
  history: z.boolean(),
  duet: z.boolean(),
  passphrase: z
    .string()
    .max(PASSPHRASE_MAX * 4)
    .refine((p) => passphraseProblem(p) === null)
    .nullable(),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

/* ---------- Your data: import from a Chord file (docs/decisions/S15-your-data.md §5, §8) ---------- */

/**
 * Why a Chord file can't be imported: it isn't one (`not-chord`), a newer
 * Chord wrote it (`newer`), it's encrypted (`needs-passphrase`) and that
 * passphrase doesn't open it (`wrong-passphrase`), Chord couldn't read it
 * (`unreadable`), the file chosen isn't open any more (`missing`), or another
 * import is still running (`busy`).
 */
export type FileImportProblem = 'not-chord' | 'newer' | 'needs-passphrase' | 'wrong-passphrase' | 'unreadable' | 'missing' | 'busy';

/** What a Chord file would bring, counted before anything comes in, against what's here (S15 §8). */
export interface FileImportPreview {
  fileId: string;
  /** The file's name, without its folder. */
  name: string;
  encrypted: boolean;
  /** This computer wrote it (its id is the file's). */
  thisComputer: boolean;
  /** When it was exported (ISO 8601), and by which Chord. */
  created: string;
  app: string;
  /** A clearly fresh Chord here (core's planMerge): everything in the file comes in, and Settings from the file starts on. */
  newProfile: boolean;
  /** Setup that's new, and newer than yours; everything else is here already. */
  counts: { new: MergeCounts; newer: MergeCounts };
  history: { pages: number; newPages: number };
  duet: { chats: number; newChats: number; images: number };
  /** Sites with Effects that are new or newer, for the switch's list. */
  effects: { host: string; new: boolean }[];
  /** Each setting the file would change, and each chord's own proxy, named. */
  settings: SettingChange[];
  /** Things from a newer Chord, passed over. */
  skipped: number;
  /** New chords, tabs and folders past what one import brings (core's IMPORT_LIMITS), left out; folders nested too deep, moved up. */
  capped: MergeCapped;
  /** Part of the file is damaged or cut short: what's counted is what could be read. */
  damaged: boolean;
}

export type FileChooseResult = { ok: true; fileId: string; name: string } | { ok: false; problem: 'cancelled' | 'busy' };
export type FileOpenResult = { ok: true; preview: FileImportPreview } | { ok: false; problem: FileImportProblem };

/** The preview's switches. Main checks the file again, and the reducer every part of it. */
export const FileImportChoicesSchema = z.strictObject({ history: z.boolean(), duet: z.boolean(), effects: z.boolean(), settings: z.boolean() });
export type FileImportChoices = z.infer<typeof FileImportChoicesSchema>;
export type FileRunResult = { ok: true; importId: string } | { ok: false; problem: 'missing' | 'busy' };

/** What an import from a Chord file brought (core's importedText says it). */
export type FileImportCounts = ImportedCounts;

/** How an import from a Chord file is going, pushed to Settings (`importFile:progress`). */
export interface FileImportProgress {
  importId: string;
  /** `setup` while chords and tabs land, `history` while pages are written (`done` of `total`), `duet`, then `done`; `failed` keeps what landed; `undone` after Undo. */
  phase: 'setup' | 'history' | 'duet' | 'done' | 'failed' | 'undone';
  done: number;
  total: number;
  counts: FileImportCounts;
}

/* ---------- Your data: sync (docs/decisions/S15-your-data.md §6–§8) ---------- */

/** Where sync stands, for Settings: chord-data's status, and main's part of it. */
export interface SyncView extends SyncStatus {
  /** The folder's own name ("Dropbox"), to show: Settings never sees a path it could send back. */
  folderName: string | null;
  /** This computer keeps the key (safeStorage); false on Linux without a keyring, which asks after each launch. */
  keyKept: boolean;
  /** *Turn off* or *Remove*, waiting for its Undo to run out. */
  pendingUndo: { what: 'off' | 'remove'; device?: string; token: string; until: number } | null;
}

/** The folder picked (by an id, main keeps the path), and what's in it. `busy`: sync is on already. */
export type SyncFolderResult = { ok: true; folderId: string; name: string; inspection: FolderInspection } | { ok: false; problem: 'cancelled' | 'busy' };

/** A step's answer: where sync stands now, or why it didn't work. */
export type SyncStepResult = { ok: true; view: SyncView } | { ok: false; problem: 'wrong' | 'conflict' | 'newer' | 'damaged' | 'missing' | 'io' | 'busy' };

const syncPassphrase = z
  .string()
  .max(PASSPHRASE_MAX * 4)
  .refine((p) => passphraseProblem(p) === null);
const deviceId = z.string().regex(/^[0-9a-f]{16}$/);

/** Renderer → main requests (`ipcRenderer.invoke`). */
export const invokeChannels = {
  // Your data: sync. Settings only; a passphrase is passed on and kept nowhere, a folder is named by its id.
  'sync:status': { roles: ['internal'], request: z.void(), response: z.custom<SyncView>() },
  'sync:chooseFolder': { roles: ['internal'], request: z.void(), response: z.custom<SyncFolderResult>() },
  'sync:setup': { roles: ['internal'], request: z.strictObject({ folderId: id, passphrase: syncPassphrase }), response: z.custom<SyncStepResult>() },
  // Joining takes any passphrase that could be one: a wrong one is told by the folder's key check.
  'sync:join': { roles: ['internal'], request: z.strictObject({ folderId: id, passphrase: z.string().min(1).max(PASSPHRASE_MAX * 4) }), response: z.custom<SyncStepResult>() },
  'sync:choose': { roles: ['internal'], request: z.strictObject({ mode: z.enum(['synced', 'both']) }), response: z.custom<SyncStepResult>() },
  'sync:unlock': { roles: ['internal'], request: z.strictObject({ passphrase: z.string().min(1).max(PASSPHRASE_MAX * 4) }), response: z.custom<SyncStepResult>() },
  'sync:passphrase': { roles: ['internal'], request: z.strictObject({ passphrase: syncPassphrase }), response: z.custom<SyncStepResult>() },
  'sync:off': { roles: ['internal'], request: z.void(), response: z.custom<SyncView>() },
  'sync:remove': { roles: ['internal'], request: z.strictObject({ device: deviceId }), response: z.custom<SyncView>() },
  'sync:undo': { roles: ['internal'], request: z.strictObject({ token: z.string().regex(/^[0-9a-f]{16,32}$/) }), response: z.custom<SyncView>() },
  'sync:rename': { roles: ['internal'], request: z.strictObject({ name: z.string().trim().min(1).max(100) }), response: z.custom<SyncView>() },
  'sync:pause': { roles: ['internal'], request: z.strictObject({ paused: z.boolean() }), response: z.custom<SyncView>() },
  // Import from other browsers: first run's step (shell) and Settings → Your data. Never from a private window.
  'import:sources': { roles: ['shell', 'internal'], request: z.void(), response: z.custom<ImportSource[]>() },
  'import:preview': { roles: ['shell', 'internal'], request: z.strictObject({ key: importKey }), response: z.custom<ImportPreviewResult>() },
  'import:run': { roles: ['shell', 'internal'], request: z.strictObject({ key: importKey, choices: ImportChoicesSchema }), response: z.custom<ImportRunResult>() },
  /** Settings' Undo (the window's toast dispatches import.undo). */
  'import:undo': { roles: ['internal'], request: z.strictObject({ importId: id }), response: z.void() },
  /** macOS: System Settings → Privacy & Security → Full Disk Access, which Safari's files need. */
  'import:openAccess': { roles: ['shell', 'internal'], request: z.void(), response: z.void() },
  // Your data: Settings' Export card. Main shows the save dialog and starts the export process, which reads and writes
  // everything itself; Settings hears only how far it's got (export:progress) and can show the saved file in its folder.
  'export:counts': { roles: ['internal'], request: z.void(), response: z.custom<ExportCounts>() },
  'export:run': { roles: ['internal'], request: ExportRequestSchema, response: z.custom<ExportRunResult>() },
  'export:show': { roles: ['internal'], request: z.strictObject({ exportId: id }), response: z.void() },
  // Your data: from a Chord file. Main shows the system's open dialog and keeps the path; a process of its own reads the
  // file. A renderer names the file by its id, never a path. The passphrase goes to that process and is kept nowhere.
  'importFile:choose': { roles: ['internal'], request: z.void(), response: z.custom<FileChooseResult>() },
  'importFile:open': { roles: ['internal'], request: z.strictObject({ fileId: id, passphrase: z.string().max(PASSPHRASE_MAX * 4).nullable() }), response: z.custom<FileOpenResult>() },
  'importFile:run': { roles: ['internal'], request: z.strictObject({ fileId: id, choices: FileImportChoicesSchema }), response: z.custom<FileRunResult>() },
  /** Settings' Undo (the window's toast dispatches import.undo). */
  'importFile:undo': { roles: ['internal'], request: z.strictObject({ importId: id }), response: z.void() },
  'duet:view': { roles: ['shell'], request: z.void(), response: z.custom<DuetView>() },
  'duet:do': { roles: ['shell'], request: DuetAction, response: z.void() },
  /** The command bar's @duet. */
  'duet:search': { roles: ['overlay'], request: z.strictObject({ query: z.string().max(200) }), response: z.custom<DuetHit[]>() },
  'duet:openHit': { roles: ['overlay'], request: z.strictObject({ chordId: id, threadId: id }), response: z.void() },
  /** Settings → Duet: the providers on this computer, sign in, clear all chats. */
  'settings:duet': {
    roles: ['internal'],
    request: z.discriminatedUnion('do', [z.object({ do: z.literal('detect') }), z.object({ do: z.literal('signIn'), provider: DuetProviderSchema }), z.object({ do: z.literal('clearAll') })]),
    response: z.custom<DuetProviderInfo[]>(),
  },
  'system:info': { roles: ['shell', 'overlay', 'popover', 'internal', 'archive', 'preview', 'mini', 'reader', 'devtools'], request: z.void(), response: SystemInfo },
  'preview:hover': { roles: ['shell'], request: PreviewTarget, response: z.void() },
  'preview:size': { roles: ['preview'], request: z.object({ width: z.number().min(0).max(2000), height: z.number().min(0).max(2000) }), response: z.void() },
  'state:snapshot': { roles: ['shell', 'overlay'], request: z.void(), response: z.custom<StateSnapshot>() },
  'cmd:dispatch': { roles: ['shell', 'overlay'], request: RendererCommand, response: z.void() },
  'nav:command': { roles: ['shell', 'overlay'], request: z.object({ action: NavAction }), response: z.void() },
  'overlay:open': { roles: ['shell'], request: OverlayOpen, response: z.void() },
  /** `dismissed`: Esc or a click outside, rather than a pick (the keyboard goes back where it came from). */
  'overlay:close': { roles: ['overlay'], request: z.object({ seq: z.number().int(), dismissed: z.boolean().optional() }), response: z.void() },
  /** F6 (DESIGN.md §10): the shell moves the keyboard to the page, the find bar or permission prompt, or itself. */
  'focus:move': { roles: ['shell'], request: z.strictObject({ to: z.enum(['page', 'devtools', 'popover', 'shell']) }), response: z.void() },
  /** The command bar has started and listens for openings (a new window opens it as soon as it is). */
  'overlay:ready': { roles: ['overlay'], request: z.void(), response: z.void() },
  /** The command bar's chosen row is a page: main opens a connection to its server now, so it loads sooner on Enter. */
  'overlay:preconnect': { roles: ['overlay'], request: z.object({ url: z.string().max(4096) }), response: z.void() },
  /** The shell reports where the URL pill / address field sits, for anchored ⌘L. */
  'layout:anchor': { roles: ['shell'], request: Rect.nullable(), response: z.void() },
  /**
   * Launch timing (ARCHITECTURE.md §1): the shell's sidebar is in the DOM with its handlers attached
   * (`ready`), then its first frame is painted (`painted`). Main times the launch up to each, and
   * once the window is up, lets its command bar warm up for its first opening.
   */
  'perf:shell': { roles: ['shell'], request: z.strictObject({ milestone: z.enum(['ready', 'painted']) }), response: z.void() },
  'download:action': {
    roles: ['shell', 'overlay'],
    request: z.object({ id, action: z.enum(['open', 'show', 'pause', 'resume', 'cancel', 'retry', 'remove', 'keep', 'discard']) }),
    response: z.void(),
  },
  // Safe Browsing (ARCHITECTURE.md §14.5). Settings and first run read whether it's available.
  'safeBrowsing:status': { roles: ['shell', 'internal'], request: z.void(), response: z.custom<SafeBrowsingStatus>() },
  /** First run's step and the one-time offer: on or off, having seen the notice. */
  'safeBrowsing:choose': { roles: ['shell', 'popover'], request: z.strictObject({ on: z.boolean() }), response: z.void() },
  /** The warning's "Back to safety": the page before, or the tab closes if there's none. */
  'safeBrowsing:back': { roles: ['shell'], request: z.strictObject({ nodeId: id }), response: z.void() },
  /** The warning's "Visit anyway": the site isn't flagged again until Chord quits. */
  'safeBrowsing:proceed': { roles: ['shell'], request: z.strictObject({ nodeId: id }), response: z.void() },
  /** Ad and tracker blocking's lists (ARCHITECTURE.md §9), for Settings → Privacy. */
  'adBlocking:status': { roles: ['internal'], request: z.void(), response: z.custom<AdBlockingStatus>() },
  'downloads:openFolder': { roles: ['shell', 'overlay'], request: z.void(), response: z.void() },
  // Taking a screenshot (DESIGN.md §7.12), from the overlay's capture mode: the element under the pointer (UI units),
  // its parent or child, what to take, and the wheel passed on to the page.
  'capture:hover': { roles: ['overlay'], request: z.strictObject({ x: z.number(), y: z.number() }), response: z.custom<CaptureHit | null>() },
  'capture:step': { roles: ['overlay'], request: z.strictObject({ to: z.enum(['parent', 'child']) }), response: z.custom<CaptureHit | null>() },
  'capture:take': { roles: ['overlay'], request: ScreenshotChoice, response: z.void() },
  'capture:scroll': { roles: ['overlay'], request: z.strictObject({ x: z.number(), y: z.number(), deltaX: z.number(), deltaY: z.number() }), response: z.void() },
  /** Picking for Effects: hide the element under the pointer on the site, and stay picking. Answers what was hidden. */
  'capture:hide': { roles: ['overlay'], request: z.void(), response: z.custom<{ label: string } | null>() },
  // The Effects card (DESIGN.md §7.15), in the popover: its site's Effects, and what it changes.
  'effects:view': { roles: ['popover'], request: z.void(), response: z.custom<EffectsView | null>() },
  'effects:do': { roles: ['popover'], request: EffectsAction, response: z.void() },
  /** Settings → Effects: a site dry or wet, or removed. */
  'settings:effects': { roles: ['internal'], request: EffectsSiteChange, response: z.void() },
  // The recent screenshots, in the downloads panel (the window's own, for a private window), and the toast's Save.
  'screenshots:list': { roles: ['overlay'], request: z.void(), response: z.custom<ScreenshotItem[]>() },
  'screenshots:do': { roles: ['overlay', 'shell'], request: z.strictObject({ id: z.string().regex(/^[0-9a-f]{24}$/), do: z.enum(['copy', 'save', 'delete', 'duet']) }), response: z.void() },
  'screenshots:clear': { roles: ['overlay'], request: z.void(), response: z.void() },
  /** The command bar's history and learned picks for what was typed (in the window's chord). */
  'history:search': { roles: ['overlay'], request: z.object({ query: z.string().max(1000) }), response: z.custom<HistorySearch>() },
  /** Search suggestions while typing, from the chosen engine (or a keyword's engine); empty when they're off. */
  /** "Search … for this image" in the command bar: the window opens the engine's upload (main/image-search.ts). */
  /** "Ask Duet about this image" in the command bar: Duet opens with the image and the words typed (main/duet/service.ts). */
  'duet:ask': {
    roles: ['overlay'],
    request: z.strictObject({
      text: z.string().max(50_000),
      image: z.strictObject({
        bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= 4_000_000),
        thumb: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= 500_000),
        width: z.number().int().positive().max(4096),
        height: z.number().int().positive().max(4096),
      }),
    }),
    response: z.void(),
  },
  'search:image': {
    roles: ['overlay'],
    request: z.strictObject({
      engine: z.enum(['google', 'bing']),
      where: z.enum(['current', 'front', 'background']),
      image: z.strictObject({
        bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= 4_000_000),
        width: z.number().int().positive().max(4096),
        height: z.number().int().positive().max(4096),
        originalWidth: z.number().int().positive().max(100_000),
        originalHeight: z.number().int().positive().max(100_000),
      }),
    }),
    response: z.void(),
  },
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
  /** A tab is being dragged from the sidebar: lift the shell over the page for split drop zones, and put it back. */
  'layout:lift': { roles: ['shell'], request: z.strictObject({ lifted: z.boolean() }), response: z.void() },
  /**
   * The frame's snapshot (ARCHITECTURE.md §5): its pictures are painted where the pages are (`shown`),
   * or have reached where the pages are going (`moved`).
   */
  'layout:snapshot': { roles: ['shell'], request: z.strictObject({ seq: z.number().int().min(1), phase: z.enum(['shown', 'moved']) }), response: z.void() },
  /** The shell is listening: send it a MessagePort for the snapshot's events (`frame:port`). */
  'layout:snapshotPort': { roles: ['shell'], request: z.void(), response: z.void() },
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
  // A chord's own proxy, or (null) the proxy for every chord; one for a chord sharing sign-ins gives it its own (main offers Undo).
  'settings:chordProxy': { roles: ['internal'], request: z.strictObject({ chordId: id, proxy: ProxySettingsSchema.nullable() }), response: z.void() },
  // Also the shell's, for first run's "Open links in Chord?".
  'settings:defaultBrowser': { roles: ['internal', 'shell'], request: z.void(), response: DefaultBrowserStatus },
  'settings:makeDefaultBrowser': { roles: ['internal', 'shell'], request: z.void(), response: DefaultBrowserStatus },
  'settings:updateStatus': { roles: ['internal'], request: z.void(), response: z.custom<UpdateStatus>() },
  'settings:checkForUpdates': { roles: ['internal'], request: z.void(), response: z.custom<UpdateStatus>() },
  // "Restart to update", from Settings → About or the update's toast.
  'update:restart': { roles: ['internal', 'shell'], request: z.void(), response: z.void() },
  // Settings → Site permissions: change one decision (null asks again next time), or forget a site.
  'settings:sitePermission': {
    roles: ['internal'],
    request: z.strictObject({ origin: siteOrigin, permission: z.enum(SITE_PERMISSIONS), decision: z.enum(['allow', 'block']).nullable() }),
    response: z.void(),
  },
  'settings:forgetSite': { roles: ['internal'], request: z.strictObject({ origin: siteOrigin }), response: z.void() },
  /** Settings → General → Link routes: send a site's links to a chord, or (null) stop. */
  'settings:linkRoute': { roles: ['internal'], request: z.strictObject({ host: z.string().min(1).max(1000), chordId: id.nullable() }), response: z.void() },
  // Developer tools in the window (DESIGN.md §7.16): their header in the shell, and the bar of ones in a window of their own.
  'devtools:do': { roles: ['shell', 'devtools'], request: DevtoolsAction, response: z.void() },
  'devtools:bar': { roles: ['devtools'], request: z.void(), response: z.custom<DevtoolsBar>() },
  // A mini window's bar (DESIGN.md §7.9): links from other apps open there.
  'mini:state': { roles: ['mini'], request: z.void(), response: z.custom<MiniState>() },
  /** Move the page into its "Open in" chord, as a tab with its history. */
  'mini:promote': { roles: ['mini'], request: z.void(), response: z.void() },
  /** "Open in ▾": the chords, below this rect; picking one moves the page there. */
  'mini:chooseChord': { roles: ['mini'], request: Rect, response: z.void() },
  'mini:copyLink': { roles: ['mini'], request: z.void(), response: z.void() },
  /** Peek's "Open in Today": the page becomes a tab, history and all. Closing goes through overlay:close. */
  'peek:expand': { roles: ['overlay'], request: z.void(), response: z.void() },
  // Screen sharing (ARCHITECTURE.md §9): the picker answers (a source's id, SYSTEM_SHARE_SOURCE, or null to refuse);
  // the sidebar's Stop ends a share, from the sharing tab's row or the shared tab's.
  'share:respond': {
    roles: ['popover'],
    request: z.strictObject({ id: z.number().int().min(1), sourceId: z.string().max(200).nullable(), audio: z.boolean() }),
    response: z.void(),
  },
  'share:stop': { roles: ['shell'], request: z.strictObject({ nodeId: id }), response: z.void() },
  // Now playing (DESIGN.md §7.10): what the window's card offers, and its play, pause and picture-in-picture buttons.
  'media:view': { roles: ['shell'], request: z.void(), response: z.custom<NowPlaying[]>() },
  'media:do': { roles: ['shell'], request: z.strictObject({ nodeId: id, action: MediaAction }), response: z.void() },
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
  /** A sign-in box's answer, or null to cancel (the site then shows its own "unauthorized" page). */
  'auth:respond': {
    roles: ['popover'],
    request: z.strictObject({
      id: z.number().int().min(1),
      credentials: z.strictObject({ username: z.string().max(1000), password: z.string().max(1000) }).nullable(),
    }),
    response: z.void(),
  },
  /** The DRM notice's buttons: the window's page in another browser the notice offered, or not now (until Chord quits). */
  'drm:open': { roles: ['popover'], request: z.strictObject({ browser: z.enum(OTHER_BROWSERS) }), response: z.void() },
  'drm:dismiss': { roles: ['popover'], request: z.void(), response: z.void() },
  /** The notice's Chord Player button, for the page the sender's window shows: install it (then open the page), open the page in it, or try again. */
  'drm:player': { roles: ['popover'], request: z.strictObject({ action: z.enum(['install', 'open', 'retry']) }), response: z.void() },
  /** A tab that plays in Chord Player: back to the player, or show the page here instead. */
  'player:do': { roles: ['shell'], request: z.strictObject({ nodeId: id, action: z.enum(['show', 'release']) }), response: z.void() },
  /** Settings → General → Chord Player: its state, and removing it (with its sign-ins). */
  'settings:player': { roles: ['internal'], request: z.void(), response: z.custom<PlayerStatus>() },
  'settings:removePlayer': { roles: ['internal'], request: z.void(), response: z.custom<PlayerStatus>() },
  /** A passkey chosen (one the prompt offered), or null to decline: the site then gets NotAllowedError, as after Cancel in Chrome. */
  'passkey:respond': { roles: ['popover'], request: z.strictObject({ id: z.number().int().min(1), credentialId: z.string().max(1024).nullable() }), response: z.void() },
  // A tab's reader view (chord://reader): its own tab's article, how it looks, its controls, and closing it.
  'reader:page': { roles: ['reader'], request: z.void(), response: z.custom<ReaderPage>() },
  'reader:look': { roles: ['reader'], request: z.void(), response: z.custom<ReaderLook>() },
  /** The article is on the page: main can put the view in front of the tab's page now. */
  'reader:ready': { roles: ['reader'], request: z.void(), response: z.void() },
  'reader:set': { roles: ['reader'], request: ReaderSettingsPatch, response: z.void() },
  /** Esc or the close button: the tab's page comes back, as it was. */
  'reader:close': { roles: ['reader'], request: z.void(), response: z.void() },
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
  /** What the hover preview shows, or null to clear it. */
  'preview:card': PreviewCard | null;
  'toast:show': Toast;
  /** F6 or ⇧F6 (DESIGN.md §10): move the keyboard to the next or previous region, starting from `from`. */
  'focus:region': FocusRegionEvent;
  /** The shell's trackpad gesture phases, for the chord swipe's release (DESIGN.md §6.4). */
  'gesture:phase': GesturePhase;
  /** Start renaming a chord, or choosing its icon, in the sidebar (from its menu). */
  'chord:edit': ChordEdit;
  /** Start renaming a folder in the sidebar (a new one, or from its menu). */
  'sidebar:rename': { nodeId: string };
  /**
   * Tabs about to go to the archive (Clear Today, or tidying up idle tabs), sent just before the state
   * patch that removes them: their rows leave for the footer's Archive button (DESIGN.md §6.5).
   */
  'sidebar:archived': { nodeIds: string[] };
  /** Jump to a Settings section (`shortcuts` from ⌘⌥/). */
  'settings:section': string;
  'extensions:state': ExtensionsBarState;
  /** The archive gained or lost entries: the archive page lists them again. */
  'archive:changed': null;
  'archive:snapshot': ArchiveSnapshot;
  'mini:state': MiniState;
  'devtools:bar': DevtoolsBar;
  /** Main closed this opening of the overlay itself (Peek, by Esc in its page, ⌘W, or Open in Today). */
  'overlay:dismiss': { seq: number };
  /** The window is up (its shell painted): the command bar may warm itself for its first opening now. */
  'overlay:warm': null;
  /** Peek's page moved on (title, address) or its card moved (the window resized). */
  'peek:state': PeekState;
  'duet:state': DuetView;
  /** The frame changes size by its snapshot (ARCHITECTURE.md §5): pictures of the pages to show, move, then drop. */
  'frame:snapshot': FrameSnapshotEvent;
  /** An import from another browser, to the view that started it. */
  'import:progress': ImportProgress;
  /** An export of your data, to Settings. */
  'export:progress': ExportProgress;
  /** An import from a Chord file, to Settings. */
  'importFile:progress': FileImportProgress;
  /** Where sync stands, to Settings, whenever it changes. */
  'sync:status': SyncView;
  /** Tabs in the window's chords playing media (or paused a moment ago), newest first, when that changes. */
  'media:state': NowPlaying[];
  /** A reader view's look changed: its chord's colors, its controls, reduced motion. */
  'reader:look': ReaderLook;
  /** The Effects card's site changed (or the card closed: null). */
  'effects:state': EffectsView | null;
}

/**
 * One page's picture: where it is, in the shell's CSS pixels, and its pixels
 * as `capturePage` gives them (BGRA, `width` × `height`, device pixels). The
 * shell turns them into RGBA off its main thread.
 */
export interface SnapshotPane {
  rect: Rect;
  width: number;
  height: number;
  pixels: Uint8Array;
  /**
   * Docked developer tools (DESIGN.md §7.16): `rect` is their whole frame, and
   * the picture fills it below the header Chord draws for that tab, `height` tall.
   */
  header?: { tab: string; height: number };
}

/**
 * The snapshot technique, step by step (ARCHITECTURE.md §5): `show` the
 * pictures where the pages are; `move` them to where the pages are going (the
 * frame changed; again if it changes on the way); `drop` them once the pages
 * are back.
 */
/** The `message` event's data on the shell's window when main's snapshot port arrives (`connectSnapshots`). */
export const SNAPSHOT_PORT_MESSAGE = 'chord:frame-port';

export type FrameSnapshotEvent =
  | { seq: number; phase: 'show'; panes: SnapshotPane[] }
  | { seq: number; phase: 'move'; rects: Rect[] }
  | { seq: number; phase: 'drop' };

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
    /** While a tab is dragged, the shell sits above the page so split view's drop zones show over it. */
    lift(lifted: boolean): Promise<void>;
    /** The frame's snapshot: main's pictures of the pages while the frame changes size, and the shell's replies. */
    onSnapshot(listener: (event: FrameSnapshotEvent) => void): () => void;
    snapshot(seq: number, phase: 'shown' | 'moved'): Promise<void>;
    /**
     * Ask main for a port of its own for the snapshot's events, so pictures skip
     * the preload: it arrives as a `message` event on this window, data
     * `SNAPSHOT_PORT_MESSAGE`. Until then (and if it never does), they come
     * through `onSnapshot`.
     */
    connectSnapshots(): Promise<void>;
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
    /** Rows about to leave for the archive (comes before the patch that removes them). */
    onArchived(listener: (event: { nodeIds: string[] }) => void): () => void;
  };
  chords: { onEdit(listener: (edit: ChordEdit) => void): () => void };
  toasts: { onShow(listener: (toast: Toast) => void): () => void };
  gestures: { onPhase(listener: (phase: GesturePhase) => void): () => void };
  action: { run(action: CoreActionId): Promise<void> };
  /** "Restart to update" from a toast. */
  updates: { restart(): Promise<void> };
  /** A screenshot toast's Save and Ask Duet. */
  screenshots: { act(id: string, action: 'save' | 'duet'): Promise<void> };
  extensions: {
    state(): Promise<ExtensionsBarState>;
    onState(listener: (state: ExtensionsBarState) => void): () => void;
    activate(id: string, anchor: Rect): Promise<void>;
    menu(id: string, at: { x: number; y: number }): Promise<void>;
    install(input: string): Promise<InstallResult>;
  };
  /** First run's "Open links in Chord?" (DESIGN.md §8.1). */
  defaultBrowser: { status(): Promise<DefaultBrowserStatus>; make(): Promise<DefaultBrowserStatus> };
  /** Duet's panel in this window (ARCHITECTURE.md §11). */
  duet: { view(): Promise<DuetView>; act(action: DuetAction): Promise<void>; onState(listener: (view: DuetView) => void): () => void };
  /** Stop a tab's share (its sidebar row shows it's sharing), or the shares of a tab that's being shared. */
  share: { stop(nodeId: string): Promise<void> };
  /** A tab that plays in Chord Player: back to the player, or show its page here instead. */
  player: { act(nodeId: string, action: 'show' | 'release'): Promise<void> };
  /** The Now playing card: the window's media as main pushes it, and the card's own buttons. */
  media: {
    view(): Promise<NowPlaying[]>;
    onState(listener: (playing: NowPlaying[]) => void): () => void;
    act(nodeId: string, action: MediaAction): Promise<void>;
  };
  /** The pinned tab or folder row the pointer rests on, for its hover preview (null when it leaves). */
  preview: { hover(target: PreviewTarget): Promise<void> };
  /** Launch timing: the sidebar is ready to use, then painted. */
  perf: { shell(milestone: 'ready' | 'painted'): Promise<void> };
  /** F6's regions (DESIGN.md §10): main says where the keyboard is; the shell picks the next region. */
  focus: {
    onRegion(listener: (event: FocusRegionEvent) => void): () => void;
    move(to: 'page' | 'devtools' | 'popover' | 'shell'): Promise<void>;
  };
  /** Developer tools docked in the frame: their header's buttons and the edge between them and the page. */
  devtools: { act(action: DevtoolsAction): Promise<void> };
  /** Safe Browsing: first run's step, and the warning's two ways out. */
  safeBrowsing: {
    status(): Promise<SafeBrowsingStatus>;
    choose(on: boolean): Promise<void>;
    back(nodeId: string): Promise<void>;
    proceed(nodeId: string): Promise<void>;
  };
  /** First run's "Bring your bookmarks?" step. */
  imports: ImportApi;
}

/** Import from other browsers: first run's step and Settings → Your data (ARCHITECTURE.md §9). */
export interface ImportApi {
  sources(): Promise<ImportSource[]>;
  /** Read a profile (copies of its files, off main) and count what it holds. */
  preview(key: string): Promise<ImportPreviewResult>;
  run(key: string, choices: ImportChoices): Promise<ImportRunResult>;
  undo(importId: string): Promise<void>;
  /** macOS: open the Full Disk Access settings, for Safari. */
  openAccess(): Promise<void>;
  onProgress(listener: (progress: ImportProgress) => void): () => void;
}

/** F6 or ⇧F6: which way, where the keyboard is now, and whether a find bar or prompt shows over the page. */
export interface FocusRegionEvent {
  direction: 1 | -1;
  from: 'shell' | 'popover' | 'page' | 'devtools';
  popover: boolean;
  /** The focused pane's tab has developer tools docked beside it (a region of their own, after the page). */
  devtools: boolean;
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
    /**
     * A chord's own proxy, or (null) the proxy for every chord. A chord sharing sign-ins gets its own with it:
     * its tabs reload, signed out, and the window offers Undo.
     */
    chordProxy(chordId: string, proxy: CoreProxySettings | null): Promise<void>;
    /** Whether Chord opens web links from other apps; `unavailable` in development builds. */
    /** Change one remembered decision for a site (null asks again), or forget the site entirely. */
    sitePermission(origin: string, permission: SitePermission, decision: 'allow' | 'block' | null): Promise<void>;
    forgetSite(origin: string): Promise<void>;
    /** Send a site's links to a chord, or (null) stop. */
    linkRoute(host: string, chordId: string | null): Promise<void>;
    defaultBrowser(): Promise<DefaultBrowserStatus>;
    /** Asks the OS to make Chord the default (on Windows, opens Settings → Default apps), then reports again. */
    makeDefaultBrowser(): Promise<DefaultBrowserStatus>;
    /** The update check's last answer, and asking again now. */
    updateStatus(): Promise<UpdateStatus>;
    checkForUpdates(): Promise<UpdateStatus>;
    /** Install the downloaded update and reopen Chord. */
    restartToUpdate(): Promise<void>;
    about(): Promise<AboutInfo>;
    /** Settings → Duet: which providers are installed and signed in; sign in; clear all chats. */
    duet(request: { do: 'detect' } | { do: 'signIn'; provider: DuetProvider } | { do: 'clearAll' }): Promise<DuetProviderInfo[]>;
    openUrl(url: string): Promise<void>;
    /** Settings → Privacy → Safe Browsing: available in this build, and how its lists are doing. */
    safeBrowsing(): Promise<SafeBrowsingStatus>;
    /** Settings → Privacy → Block ads and trackers: the lists on this computer. */
    adBlocking(): Promise<AdBlockingStatus>;
    /** Settings → General → Chord Player. */
    player(): Promise<PlayerStatus>;
    removePlayer(): Promise<PlayerStatus>;
    /** Settings → Effects: a site dry or wet, or removed. */
    effects(change: EffectsSiteChange): Promise<void>;
  };
  extensions: {
    install(input: string): Promise<InstallResult>;
    remove(profileId: string, id: string): Promise<void>;
    options(profileId: string, id: string): Promise<void>;
    update(): Promise<number>;
  };
  /** Settings → Your data → From another browser. */
  imports: ImportApi;
  /** Settings → Your data → Export. */
  exports: ExportApi;
  /** Settings → Your data → From a Chord file. */
  files: FileImportApi;
  /** Settings → Your data → Sync. */
  sync: SyncApi;
}

/** Your data's sync (Settings → Your data → Sync, docs/decisions/S15-your-data.md §8). */
export interface SyncApi {
  status(): Promise<SyncView>;
  /** The system's folder picker; the folder is then the session's, by its id. */
  chooseFolder(): Promise<SyncFolderResult>;
  setup(folderId: string, passphrase: string): Promise<SyncStepResult>;
  join(folderId: string, passphrase: string): Promise<SyncStepResult>;
  choose(mode: 'synced' | 'both'): Promise<SyncStepResult>;
  unlock(passphrase: string): Promise<SyncStepResult>;
  changePassphrase(passphrase: string): Promise<SyncStepResult>;
  /** Turn off, or remove a computer: each happens when its Undo runs out. */
  off(): Promise<SyncView>;
  remove(device: string): Promise<SyncView>;
  undo(token: string): Promise<SyncView>;
  rename(name: string): Promise<SyncView>;
  pause(paused: boolean): Promise<SyncView>;
  onStatus(listener: (view: SyncView) => void): () => void;
}

/** Your data's import from a Chord file (Settings → Your data, docs/decisions/S15-your-data.md §8). */
export interface FileImportApi {
  /** The system's open dialog; the file is then the session's, by its id. */
  choose(): Promise<FileChooseResult>;
  /** Read it (off main), with its passphrase if it's encrypted, and count what it would bring. */
  open(fileId: string, passphrase: string | null): Promise<FileOpenResult>;
  run(fileId: string, choices: FileImportChoices): Promise<FileRunResult>;
  undo(importId: string): Promise<void>;
  onProgress(listener: (progress: FileImportProgress) => void): () => void;
}

/** Your data's export (Settings → Your data, docs/decisions/S15-your-data.md §8). */
export interface ExportApi {
  counts(): Promise<ExportCounts>;
  /** The save dialog, then the export, which goes on by itself and reports through `onProgress`. */
  run(request: ExportRequest): Promise<ExportRunResult>;
  /** The saved file, selected in the system's file manager. */
  show(exportId: string): Promise<void>;
  onProgress(listener: (progress: ExportProgress) => void): () => void;
}

/** `window.chord` in a mini window's bar. */
export interface MiniApi {
  system: {
    info(): Promise<SystemInfo>;
    onChange(listener: (info: SystemInfo) => void): () => void;
  };
  mini: {
    state(): Promise<MiniState>;
    onState(listener: (state: MiniState) => void): () => void;
    promote(): Promise<void>;
    chooseChord(anchor: Rect): Promise<void>;
    copyLink(): Promise<void>;
  };
}

/** `window.chord` in the bar of a tab's developer tools in a window of their own (DESIGN.md §7.16). */
export interface DevtoolsBarApi {
  system: {
    info(): Promise<SystemInfo>;
    onChange(listener: (info: SystemInfo) => void): () => void;
  };
  devtools: {
    bar(): Promise<DevtoolsBar>;
    onBar(listener: (bar: DevtoolsBar) => void): () => void;
    /** Put them back in the window, beside the tab's page. */
    dock(): Promise<void>;
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

/** `window.chord` in a reader view. */
export interface ReaderApi {
  system: {
    info(): Promise<SystemInfo>;
    onChange(listener: (info: SystemInfo) => void): () => void;
  };
  reader: {
    page(): Promise<ReaderPage>;
    look(): Promise<ReaderLook>;
    onLook(listener: (look: ReaderLook) => void): () => void;
    ready(): Promise<void>;
    set(patch: z.input<typeof ReaderSettingsPatch>): Promise<void>;
    close(): Promise<void>;
  };
}

/** `window.chord` in the hover-preview view. */
export interface PreviewApi {
  system: {
    info(): Promise<SystemInfo>;
    onChange(listener: (info: SystemInfo) => void): () => void;
  };
  preview: {
    onCard(listener: (card: PreviewCard | null) => void): () => void;
    /** The card's size; 0 × 0 hides the view. */
    size(width: number, height: number): Promise<void>;
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
  /** The screen-share picker: a source to share (or SYSTEM_SHARE_SOURCE, the system's picker), or null to cancel. */
  share: { respond(id: number, sourceId: string | null, audio: boolean): Promise<void> };
  /** A sign-in box: a username and password, or null to cancel. */
  auth: { respond(id: number, credentials: { username: string; password: string } | null): Promise<void> };
  /** Choosing a passkey: one the prompt offered, or null to decline. */
  passkey: { respond(id: number, credentialId: string | null): Promise<void> };
  /** The one-time offer: turn Safe Browsing on, or not now (either way it isn't offered again). */
  safeBrowsing: { choose(on: boolean): Promise<void> };
  /** The DRM notice: open the page in another browser or Chord Player (installing it first), or not now. */
  drm: { open(browser: OtherBrowserId): Promise<void>; dismiss(): Promise<void>; player(action: 'install' | 'open' | 'retry'): Promise<void> };
  /** The Effects card: its site's Effects as main pushes them, and its changes. */
  effects: { view(): Promise<EffectsView | null>; onState(listener: (view: EffectsView | null) => void): () => void; act(action: z.input<typeof EffectsAction>): Promise<void> };
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
    /** Main closed an opening itself: forget it, so it never shows again. */
    onDismiss(listener: (seq: number) => void): () => void;
    /** The window's launch is over: warming up for the first opening won't slow it down. */
    onWarm(listener: () => void): () => void;
    /** `dismissed`: Esc or a click outside, so the keyboard goes back where it was. */
    close(seq: number, dismissed?: boolean): Promise<void>;
    /** Listening now: main may open the command bar. */
    ready(): Promise<void>;
    /** The chosen row would open this page: connect to its server ahead of Enter. */
    preconnect(url: string): Promise<void>;
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
    /** Search by a pasted image, in a new tab (front or behind) or the current one. */
    image(engine: 'google' | 'bing', image: { bytes: Uint8Array<ArrayBuffer>; width: number; height: number; originalWidth: number; originalHeight: number }, where: 'current' | 'front' | 'background'): Promise<void>;
  };
  archive: { restore(archiveId: string): Promise<void> };
  /** Peek's chrome: its page's title and address as they change, and "Open in Today". */
  peek: {
    onState(listener: (state: PeekState) => void): () => void;
    expand(): Promise<void>;
  };
  /** @duet: Duet chats by their words, and opening one; and asking about a pasted image. */
  duet: {
    search(query: string): Promise<DuetHit[]>;
    open(chordId: string, threadId: string): Promise<void>;
    ask(text: string, image: { bytes: Uint8Array<ArrayBuffer>; thumb: Uint8Array<ArrayBuffer>; width: number; height: number }): Promise<void>;
  };
  /** Taking a screenshot (capture mode). */
  capture: {
    hover(x: number, y: number): Promise<CaptureHit | null>;
    step(to: 'parent' | 'child'): Promise<CaptureHit | null>;
    take(choice: ScreenshotChoice): Promise<void>;
    scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
    /** Picking for Effects: hide the element under the pointer. */
    hide(): Promise<{ label: string } | null>;
  };
  /** The recent screenshots, in the downloads panel. */
  screenshots: {
    list(): Promise<ScreenshotItem[]>;
    act(id: string, action: 'copy' | 'save' | 'delete' | 'duet'): Promise<void>;
    clear(): Promise<void>;
  };
}
