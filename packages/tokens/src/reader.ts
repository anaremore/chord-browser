/**
 * Reader view's tokens (DESIGN.md §7.11): a reading type scale at six
 * sizes, three line widths, the fonts it offers, and its four color themes.
 * The chord's own colors are the default; Light and Dark are neutral;
 * Sepia is warm paper and brown ink. Every theme keeps text at 4.5:1 or
 * more on its page, as the chord themes do (§5.2).
 */
import { contrast, cssOklch, oklchToRgb, over, type Oklch, type Rgb } from './color';
import { fontFamily, type TypeStyle } from './scale';
import { createChordTheme, SWATCHES, type Appearance, type ChordThemeInput, type ThemeContext } from './theme';

/** Body text at each of the reader's sizes (core's READER_SIZES), px. 19 px to start: between Safari's and Firefox's. */
export const READER_TEXT = [15, 17, 19, 21, 24, 28] as const;

export type ReaderTypeRole = 'title' | 'h2' | 'h3' | 'h4' | 'body' | 'small' | 'code';

const onGrid = (px: number) => Math.ceil(px / 4) * 4;

/**
 * The reader's type at one size: the article's title and headings scale
 * with its body text, and every line height sits on the 4 px grid.
 */
export function readerType(step: number): Record<ReaderTypeRole, TypeStyle> {
  const body = READER_TEXT[Math.min(READER_TEXT.length - 1, Math.max(0, Math.round(step)))]!;
  const at = (scale: number, leading: number, weight: number, tracking: number): TypeStyle => {
    const size = Math.round(body * scale);
    return { size, line: onGrid(size * leading), weight, tracking };
  };
  return {
    title: at(1.75, 1.2, 650, -0.02),
    h2: at(1.35, 1.3, 650, -0.015),
    h3: at(1.15, 1.35, 600, -0.01),
    h4: at(1, 1.5, 600, 0),
    body: at(1, 1.6, 450, 0),
    small: at(0.85, 1.5, 450, 0),
    code: at(0.9, 1.6, 450, 0),
  };
}

/** The longest line, in ems of the body text: about 60, 70 and 85 characters. */
export const READER_MEASURE = { narrow: 30, medium: 36, wide: 44 } as const;

/**
 * Onest, Chord's own typeface; or the computer's reading serif (Charter on
 * macOS, Sitka on Windows, the desktop's serif on Linux), so no second
 * typeface ships with Chord. Code is the computer's monospace.
 */
export const READER_FONTS = {
  sans: fontFamily,
  serif: `Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif`,
  mono: `ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace`,
} as const;

/**
 * The reader's type, font and line width as CSS custom properties, set on
 * its page through the CSSOM. `--reader-space` (a paragraph's gap, about an
 * em on the grid) and `--reader-code-size` (code in running text) scale with it.
 */
export function readerTypeVars(step: number, font: 'sans' | 'serif', width: keyof typeof READER_MEASURE): Record<`--${string}`, string> {
  const type = readerType(step);
  const vars: Record<`--${string}`, string> = {
    '--reader-font': READER_FONTS[font],
    '--reader-mono': READER_FONTS.mono,
    '--reader-measure': `${READER_MEASURE[width]}em`,
    '--reader-space': `${onGrid(type.body.size)}px`,
    '--reader-code-size': `${type.code.size}px`,
  };
  for (const [role, t] of Object.entries(type)) {
    vars[`--reader-${role}`] = `${t.weight} ${t.size}px/${t.line}px ${role === 'code' ? 'var(--reader-mono)' : 'var(--reader-font)'}`;
    vars[`--reader-${role}-tracking`] = `${t.tracking}em`;
  }
  return vars;
}

export type ReaderThemeId = 'chord' | 'light' | 'dark' | 'sepia';

export interface ReaderLook {
  appearance: Appearance;
  /** The chord theme's variables (`--color-*`), for a page that reads on `--color-surface`. */
  vars: Record<`--${string}`, string>;
  /** Lowest contrasts on the page and its raised surfaces (with a hover fill too), for tests. */
  minContrast: { fg: number; fgMuted: number; fgSubtle: number; accent: number; focusRing: number };
}

/** Sepia: warm paper, a lighter sheet for the reader's panel, and brown ink. */
const PAPER: Oklch = { l: 0.94, c: 0.03, h: 80 };
const PAPER_RAISED: Oklch = { l: 0.965, c: 0.022, h: 80 };
const INK: Oklch = { l: 0.3, c: 0.04, h: 60 };

const TEXT_MIN = 4.5;
const UI_MIN = 3;

function sepia(context: ThemeContext): ReaderLook {
  // Honey's chord theme gives the rest (danger, the active fill, the scrim); its page colors are replaced.
  const base = createChordTheme({ stops: [SWATCHES.honey], grain: 0, appearance: 'light' }, { ...context, systemAppearance: 'light', material: 'solid' });
  const strength = Math.min(1, Math.max(0, context.contrast ?? 0.5));
  const hoverAlpha = 0.04 + 0.06 * strength;
  const ink = oklchToRgb(INK);
  const sheets: Rgb[] = [oklchToRgb(PAPER), oklchToRgb(PAPER_RAISED)];
  const grounds = [...sheets, ...sheets.map((sheet) => over(ink, hoverAlpha, sheet))];
  const lowest = (color: Oklch) => Math.min(...grounds.map((ground) => contrast(oklchToRgb(color), ground)));
  // Each color darkens until it reads on every ground (the paper is light, so darker only raises contrast).
  const readable = (color: Oklch, min: number) => {
    let next = color;
    for (let i = 0; i < 60 && lowest(next) < min; i++) next = { ...next, l: Math.max(0, next.l - 0.01) };
    return next;
  };
  const muted = readable({ l: 0.47 - 0.08 * strength, c: 0.035, h: 60 }, TEXT_MIN);
  const subtle = readable({ l: 0.54 - 0.08 * strength, c: 0.03, h: 60 }, TEXT_MIN);
  const accent = readable({ l: 0.5, c: 0.12, h: 45 }, TEXT_MIN);
  const ring = readable(context.focus && context.focus.c >= 0.02 ? { ...context.focus } : accent, UI_MIN);
  return {
    appearance: 'light',
    vars: {
      ...base.vars,
      '--color-tint': `linear-gradient(${cssOklch(PAPER_RAISED)}, ${cssOklch(PAPER_RAISED)})`,
      '--color-base': cssOklch(PAPER),
      '--color-surface': cssOklch(PAPER),
      '--color-surface-raised': cssOklch(PAPER_RAISED),
      '--color-fg': cssOklch(INK),
      '--color-fg-muted': cssOklch(muted),
      '--color-fg-subtle': cssOklch(subtle),
      '--color-item-hover': cssOklch(INK, hoverAlpha),
      '--color-divider': cssOklch(INK, 0.06 + 0.12 * strength),
      '--color-accent': cssOklch(accent),
      '--color-selection': cssOklch(accent, 0.16),
      '--color-focus-ring': cssOklch(ring),
    },
    minContrast: { fg: lowest(INK), fgMuted: lowest(muted), fgSubtle: lowest(subtle), accent: lowest(accent), focusRing: lowest(ring) },
  };
}

/**
 * A reader theme's colors. `chord` is the tab's chord theme as it is; Light
 * and Dark are neutral (Graphite) whatever the chord or the computer says;
 * none sits over the window material, so all are solid.
 */
export function createReaderTheme(id: ReaderThemeId, chord: ChordThemeInput, context: ThemeContext): ReaderLook {
  if (id === 'sepia') return sepia(context);
  const input: ChordThemeInput = id === 'chord' ? chord : { stops: [SWATCHES.graphite], grain: 0, appearance: id };
  const theme = createChordTheme(input, { ...context, material: 'solid' });
  const { fg, fgMuted, fgSubtle, accent, focusRing } = theme.minContrast;
  return { appearance: theme.appearance, vars: theme.vars, minContrast: { fg, fgMuted, fgSubtle, accent, focusRing } };
}
