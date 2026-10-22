/**
 * The IPC contract (ARCHITECTURE.md §8). Every channel is declared once here,
 * with the renderer roles allowed to use it and zod schemas for its payloads.
 * Main validates every request against this table; web content gets no IPC.
 */
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

export const TabState = z.object({
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  faviconUrl: z.string().nullable(),
});
export type TabState = z.infer<typeof TabState>;

export const NavAction = z.enum(['back', 'forward', 'reload', 'stop']);
export type NavAction = z.infer<typeof NavAction>;

/** Renderer → main requests (`ipcRenderer.invoke`). */
export const invokeChannels = {
  'system:info': { roles: ['shell', 'overlay', 'popover', 'internal'], request: z.void(), response: SystemInfo },
  'nav:command': { roles: ['shell', 'overlay'], request: z.object({ action: NavAction }), response: z.void() },
  /** Current state, so a renderer that subscribes late never misses the first push. */
  'tab:current': { roles: ['shell'], request: z.void(), response: TabState },
} as const satisfies Record<string, { roles: readonly Role[]; request: z.ZodType; response: z.ZodType }>;

/** Main → renderer events (`webContents.send`). */
export const eventChannels = {
  'system:changed': SystemInfo,
  'tab:state': TabState,
} as const satisfies Record<string, z.ZodType>;

export type InvokeChannel = keyof typeof invokeChannels;
export type EventChannel = keyof typeof eventChannels;
export type InvokeRequest<C extends InvokeChannel> = z.input<(typeof invokeChannels)[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = z.output<(typeof invokeChannels)[C]['response']>;
export type EventPayload<C extends EventChannel> = z.output<(typeof eventChannels)[C]>;

/** Largest accepted request payload, serialized (ARCHITECTURE.md §8). */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/** The API each preload exposes as `window.chord`. */
export interface ShellApi {
  system: {
    info(): Promise<SystemInfo>;
    onChange(listener: (info: SystemInfo) => void): () => void;
  };
  tab: {
    current(): Promise<TabState>;
    onState(listener: (state: TabState) => void): () => void;
  };
  nav: {
    command(action: NavAction): Promise<void>;
  };
}
