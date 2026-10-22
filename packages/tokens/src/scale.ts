/**
 * Static scales (DESIGN.md §4): spacing, sizes, radii, type, elevation, layers.
 * Values are CSS pixels unless noted.
 */

export type Platform = 'darwin' | 'win32' | 'linux';

/** 4 px grid. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const size = {
  row: 32,
  iconButton: 28,
  header: 40,
  hitMin: 24,
  iconSm: 12,
  icon: 16,
  iconLg: 20,
  favicon: 16,
  chordIcon: 20,
  urlPill: 36,
  chordHeader: 28,
  divider: 24,
  footer: 44,
  sidebarWidth: 248,
  sidebarMin: 200,
  sidebarMax: 400,
  duetWidth: 380,
  duetMin: 320,
  duetMax: 560,
  /** The bezel around the content frame: as thin as possible while the rounded corners still read. */
  frameInset: 4,
  /** The Windows/Linux top strip and the minimal-mode bar. */
  strip: 40,
  commandBarMin: 480,
  /** The command bar input row (centered placement) and its result rows. */
  inputRow: 56,
  resultRow: 40,
  commandBarMax: 680,
  previewWidth: 280,
  /** Popover cards over the page: the find bar, permission prompts. */
  popoverCard: 320,
  /** Settings window: section list, readable content column, and its controls. */
  settingsNav: 200,
  settingsContent: 600,
  settingRow: 52,
  switchWidth: 36,
  switchHeight: 20,
  switchKnob: 16,
  swatch: 24,
  presetWidth: 64,
  presetHeight: 36,
  hairline: 1,
  focusRing: 2,
} as const;

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  full: 9999,
} as const;

/** The content frame follows each platform's window corners. */
export const frameRadius: Record<Platform, number> = {
  darwin: 12,
  win32: 8,
  linux: 12,
};

export interface TypeStyle {
  size: number;
  line: number;
  weight: number;
  /** em */
  tracking: number;
}

export const type = {
  /** Monogram letters inside 16 px fallback favicons. */
  glyph: { size: 10, line: 12, weight: 650, tracking: 0 },
  micro: { size: 11, line: 16, weight: 500, tracking: 0.01 },
  small: { size: 12, line: 16, weight: 450, tracking: 0 },
  body: { size: 13, line: 20, weight: 450, tracking: 0 },
  label: { size: 13, line: 20, weight: 600, tracking: 0 },
  title: { size: 15, line: 20, weight: 600, tracking: -0.005 },
  input: { size: 18, line: 24, weight: 450, tracking: -0.01 },
  heading: { size: 24, line: 32, weight: 600, tracking: -0.015 },
  display: { size: 36, line: 44, weight: 650, tracking: -0.02 },
} as const satisfies Record<string, TypeStyle>;

export const fontFamily = `'Onest', system-ui, -apple-system, 'Segoe UI', sans-serif`;

export const shadow = {
  light: {
    raised: '0 1px 2px oklch(0 0 0 / 0.08), 0 0 0 1px oklch(0 0 0 / 0.04)',
    frame: '0 0 0 1px oklch(0 0 0 / 0.06), 0 2px 6px oklch(0 0 0 / 0.06), 0 12px 32px -12px oklch(0 0 0 / 0.16)',
    lift: '0 8px 20px -6px oklch(0 0 0 / 0.22)',
    popover: '0 12px 32px -8px oklch(0 0 0 / 0.22), 0 0 0 1px oklch(0 0 0 / 0.06)',
    modal: '0 24px 64px -16px oklch(0 0 0 / 0.32), 0 0 0 1px oklch(0 0 0 / 0.06)',
  },
  dark: {
    raised: '0 1px 2px oklch(0 0 0 / 0.4), inset 0 0 0 1px oklch(1 0 0 / 0.06)',
    frame: '0 0 0 1px oklch(1 0 0 / 0.07), 0 12px 32px -12px oklch(0 0 0 / 0.6)',
    lift: '0 8px 20px -6px oklch(0 0 0 / 0.6)',
    popover: '0 12px 32px -8px oklch(0 0 0 / 0.6), 0 0 0 1px oklch(1 0 0 / 0.08)',
    modal: '0 24px 64px -16px oklch(0 0 0 / 0.7), 0 0 0 1px oklch(1 0 0 / 0.08)',
  },
} as const;

export const zIndex = {
  base: 0,
  raised: 1,
  sticky: 10,
  drag: 20,
  popover: 30,
  toast: 40,
  modal: 50,
} as const;
