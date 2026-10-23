/**
 * The IPC contract (ARCHITECTURE.md §8). Every channel is declared once here,
 * with the renderer roles allowed to use it and zod schemas for its payloads.
 * Main validates every request against this table; web content gets no IPC.
 */
import {
  SEARCH_ENGINES,
  SHORTCUTS,
  type ActionId as CoreActionId,
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
  type ChordThemeSpec,
  type State,
} from '@chord/core';
import { z } from 'zod';

export type Role = 'shell' | 'overlay' | 'popover' | 'internal';

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
  z.object({ t: z.literal('tab.open'), windowId: id, url, background: z.boolean().optional() }),
  z.object({ t: z.literal('tab.activate'), windowId: id, nodeId: id, touch: z.boolean().optional() }),
  z.object({ t: z.literal('tab.close'), windowId: id, nodeId: id }),
  z.object({ t: z.literal('tab.reopenClosed'), windowId: id }),
  z.object({ t: z.literal('tab.navigate'), nodeId: id, url }),
  z.object({ t: z.literal('tab.cycle'), windowId: id, direction: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({ t: z.literal('node.move'), nodeId: id, section: z.enum(['pinned', 'today']), index: z.number().int().min(0).max(10_000) }),
  z.object({ t: z.literal('tab.pin'), nodeId: id }),
  z.object({ t: z.literal('tab.unpin'), nodeId: id }),
  z.object({ t: z.literal('download.clear') }),
  z.object({ t: z.literal('window.sidebar'), windowId: id, sidebar: z.enum(['docked', 'collapsed']) }),
  z.object({ t: z.literal('chord.create'), windowId: id, name: chordName, icon: chordIcon, theme: ChordTheme }),
  z.object({ t: z.literal('chord.activate'), windowId: id, chordId: id }),
  z.object({ t: z.literal('chord.cycle'), windowId: id, direction: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({ t: z.literal('chord.goto'), windowId: id, index: z.number().int().min(0).max(8) }),
  z.object({ t: z.literal('chord.update'), chordId: id, name: chordName.optional(), icon: chordIcon.optional() }),
  z.object({ t: z.literal('chord.restore'), windowId: id, chordId: id }),
  z.object({ t: z.literal('extension.pin'), profileId: id, id: z.string().regex(/^[a-p]{32}$/), pinned: z.boolean() }),
  z.object({ t: z.literal('extension.restore'), profileId: id, id: z.string().regex(/^[a-p]{32}$/) }),
  // chord.delete isn't here: it goes through main's confirmation (menu:chord).
]);
export type RendererCommand = z.infer<typeof RendererCommand>;
// Compile-time check: every renderer command is a real core command.
const _commandsMatch = (c: RendererCommand): Command => c;
void _commandsMatch;

const engineIds = SEARCH_ENGINES.map((e) => e.id) as [SearchEngineId, ...SearchEngineId[]];

export const SettingsPatch = z.strictObject({
  searchEngine: z.enum(engineIds).optional(),
  colorScheme: z.enum(['system', 'light', 'dark']).optional(),
  extensionButtons: z.enum(['sidebar', 'titleBar']).optional(),
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

/** What the Settings window shows: settings, the chord in the last-used window (for Appearance), and extensions. */
export interface SettingsSnapshot {
  settings: Settings;
  chord: Pick<Chord, 'id' | 'name' | 'icon' | 'theme'> | null;
  extensions: ExtensionInfo[];
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

/** Everything the popover shows: cards stack top-right over the page. */
export interface PopoverState {
  theme: ChordThemeSpec | null;
  interface: InterfaceSettings;
  find: FindState | null;
  permission: PermissionPrompt | null;
}

/** History pages and learned picks for a command bar query (chord-data's SearchResult). */
export interface HistorySearch {
  history: { url: string; title: string; visitCount: number; typedCount: number; lastVisitAt: number; frecency: number }[];
  choices: Choice[];
}

/** A short-lived note in the sidebar, usually with Undo (DESIGN.md §7.5). */
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
  'system:info': { roles: ['shell', 'overlay', 'popover', 'internal'], request: z.void(), response: SystemInfo },
  'state:snapshot': { roles: ['shell', 'overlay'], request: z.void(), response: z.custom<StateSnapshot>() },
  'cmd:dispatch': { roles: ['shell', 'overlay'], request: RendererCommand, response: z.void() },
  'nav:command': { roles: ['shell', 'overlay'], request: z.object({ action: NavAction }), response: z.void() },
  'overlay:open': { roles: ['shell'], request: OverlayOpen, response: z.void() },
  'overlay:close': { roles: ['overlay'], request: z.object({ seq: z.number().int() }), response: z.void() },
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
  /** The command bar remembers which row was picked for what was typed. */
  'history:choose': {
    roles: ['overlay'],
    request: z.object({ text: z.string().max(1000), destination: z.string().min(1).max(2048), address: url.optional() }),
    response: z.void(),
  },
  /** Windows/Linux options button: pop the app menu below this rect. */
  'menu:app': { roles: ['shell'], request: Rect, response: z.void() },
  /** Right-click on a chord in the switcher, at this point in the window. */
  'menu:chord': { roles: ['shell'], request: z.object({ chordId: id, x: z.number(), y: z.number() }), response: z.void() },
  /** Right-click on a tab row, at this point in the window. */
  'menu:tab': { roles: ['shell'], request: z.object({ nodeId: id, x: z.number(), y: z.number() }), response: z.void() },
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
  /** Start renaming a chord, or choosing its icon, in the sidebar (from its menu). */
  'chord:edit': ChordEdit;
  /** Jump to a Settings section (`shortcuts` from ⌘⌥/). */
  'settings:section': string;
  'extensions:state': ExtensionsBarState;
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
  layout: { anchor(rect: Rect | null): Promise<void> };
  menu: {
    app(anchor: Rect): Promise<void>;
    tab(nodeId: string, at: { x: number; y: number }): Promise<void>;
    chord(chordId: string, at: { x: number; y: number }): Promise<void>;
  };
  chords: { onEdit(listener: (edit: ChordEdit) => void): () => void };
  toasts: { onShow(listener: (toast: Toast) => void): () => void };
  action: { run(action: CoreActionId): Promise<void> };
  extensions: {
    state(): Promise<ExtensionsBarState>;
    onState(listener: (state: ExtensionsBarState) => void): () => void;
    activate(id: string, anchor: Rect): Promise<void>;
    menu(id: string, at: { x: number; y: number }): Promise<void>;
    install(input: string): Promise<InstallResult>;
  };
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
}
