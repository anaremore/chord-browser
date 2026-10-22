import { describe, expect, it } from 'vitest';
import {
  DANGER,
  PRESETS,
  contrast,
  createChordTheme,
  oklchToRgb,
  presetStops,
  type Appearance,
  type Oklch,
  type PresetId,
  type ThemeContext,
} from '../src';

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const contexts: ThemeContext[] = (['light', 'dark'] as Appearance[]).flatMap((systemAppearance) =>
  (['translucent', 'solid'] as const).map((material) => ({ systemAppearance, material })),
);

describe('createChordTheme', () => {
  it('keeps text at ≥ 4.5:1 and the accent at ≥ 3:1 for 10,000 random themes', () => {
    const random = mulberry32(0xc0ffee);
    for (let i = 0; i < 10_000; i++) {
      const stops: Oklch[] = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
        l: random(),
        c: random() * 0.37,
        h: random() * 360,
      }));
      // Any Contrast and Window tint setting keeps the guarantee.
      const context = { ...contexts[i % contexts.length]!, contrast: random(), glass: random() };
      const appearance = (['light', 'dark', 'auto'] as const)[Math.floor(random() * 3)]!;
      const theme = createChordTheme({ stops, grain: random(), appearance }, context);
      expect(theme.minContrast.fg, JSON.stringify({ stops, appearance, context })).toBeGreaterThanOrEqual(4.5);
      expect(theme.minContrast.fgMuted, JSON.stringify({ stops, appearance, context })).toBeGreaterThanOrEqual(4.5);
      expect(theme.minContrast.accent).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(Object.keys(PRESETS) as PresetId[])('renders the %s preset in both appearances', (id) => {
    for (const appearance of ['light', 'dark'] as const) {
      const theme = createChordTheme(
        { stops: presetStops(id), grain: 0.35, appearance },
        { systemAppearance: 'light', material: 'translucent' },
      );
      expect(theme.appearance).toBe(appearance);
      expect(theme.vars['--color-tint']).toMatch(/gradient\(/);
      expect(theme.vars['--color-base']).toBe('transparent');
    }
  });

  it('follows the system appearance when set to auto', () => {
    const theme = createChordTheme(
      { stops: presetStops('dusk'), grain: 0, appearance: 'auto' },
      { systemAppearance: 'dark', material: 'solid' },
    );
    expect(theme.appearance).toBe('dark');
    expect(theme.vars['--color-base']).not.toBe('transparent');
  });

  it('scales grain by appearance', () => {
    const ctx: ThemeContext = { systemAppearance: 'light', material: 'translucent' };
    const light = createChordTheme({ stops: presetStops('fog'), grain: 1, appearance: 'light' }, ctx);
    const dark = createChordTheme({ stops: presetStops('fog'), grain: 1, appearance: 'dark' }, ctx);
    expect(light.vars['--grain-opacity']).toBe('0.200');
    expect(dark.vars['--grain-opacity']).toBe('0.280');
  });

  it('keeps the danger red readable on the lightest and darkest surfaces', () => {
    for (let h = 0; h < 360; h += 15) {
      const lightSurfaces = [{ l: 0.975, c: 0.006, h }, { l: 1, c: 0, h }];
      const darkSurfaces = [{ l: 0.21, c: 0.006, h }, { l: 0.25, c: 0.008, h }];
      for (const s of lightSurfaces) expect(contrast(oklchToRgb(DANGER.light), oklchToRgb(s))).toBeGreaterThanOrEqual(4.5);
      for (const s of darkSurfaces) expect(contrast(oklchToRgb(DANGER.dark), oklchToRgb(s))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('rejects a theme without colors', () => {
    expect(() =>
      createChordTheme({ stops: [], grain: 0, appearance: 'light' }, { systemAppearance: 'light', material: 'solid' }),
    ).toThrow();
  });
});
