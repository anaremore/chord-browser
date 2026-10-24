import { describe, expect, it } from 'vitest';
import { READER_MEASURE, READER_TEXT, createReaderTheme, presetStops, readerType, readerTypeVars, type Appearance, type Oklch, type ReaderThemeId, type ThemeContext } from '../src';

const THEMES: ReaderThemeId[] = ['chord', 'light', 'dark', 'sepia'];

/** Every way the computer and Settings can be set, as far as a reader page's colors go. */
const contexts: ThemeContext[] = (['light', 'dark'] as Appearance[]).flatMap((systemAppearance) =>
  [0, 0.5, 1].flatMap((contrast) =>
    [null, { l: 0.6, c: 0.15, h: 250 }, { l: 0.85, c: 0.12, h: 90 }, { l: 0.3, c: 0.1, h: 20 }].map((focus: Oklch | null) => ({
      systemAppearance,
      material: 'translucent' as const,
      contrast,
      glass: contrast,
      focus,
    })),
  ),
);

describe('reader themes', () => {
  it('keep text, secondary text and links at ≥ 4.5:1 and focus rings at ≥ 3:1 on the page, in every theme and setting', () => {
    for (const id of THEMES) {
      for (const context of contexts) {
        for (const stops of [presetStops('dusk'), presetStops('citrus'), presetStops('fog'), [{ l: 0.9, c: 0.3, h: 120 }]]) {
          for (const appearance of ['light', 'dark', 'auto'] as const) {
            const { minContrast } = createReaderTheme(id, { stops, grain: 0.2, appearance }, context);
            const where = `${id} ${JSON.stringify(context)} ${appearance}`;
            expect(minContrast.fg, where).toBeGreaterThanOrEqual(4.5);
            expect(minContrast.fgMuted, where).toBeGreaterThanOrEqual(4.5);
            expect(minContrast.fgSubtle, where).toBeGreaterThanOrEqual(4.5);
            expect(minContrast.accent, where).toBeGreaterThanOrEqual(4.5);
            expect(minContrast.focusRing, where).toBeGreaterThanOrEqual(3);
          }
        }
      }
    }
  });

  it("follow the chord's appearance in the chord theme, and keep their own in the others", () => {
    const context: ThemeContext = { systemAppearance: 'dark', material: 'translucent' };
    const chord = { stops: presetStops('dusk'), grain: 0.2, appearance: 'auto' as const };
    expect(createReaderTheme('chord', chord, context).appearance).toBe('dark');
    expect(createReaderTheme('chord', { ...chord, appearance: 'light' }, context).appearance).toBe('light');
    expect(createReaderTheme('light', chord, context).appearance).toBe('light');
    expect(createReaderTheme('dark', chord, { ...context, systemAppearance: 'light' }).appearance).toBe('dark');
    expect(createReaderTheme('sepia', chord, context).appearance).toBe('light');
  });

  it('read on a solid page: no window material shows through', () => {
    for (const id of THEMES) {
      const { vars } = createReaderTheme(id, { stops: presetStops('aurora'), grain: 0.2, appearance: 'auto' }, { systemAppearance: 'light', material: 'translucent' });
      expect(vars['--color-base']).not.toBe('transparent');
      expect(vars['--color-surface']).toMatch(/^oklch\(/);
    }
  });
});

describe('reader type', () => {
  it('has a size for each of the reader’s steps, growing, with every line on the 4 px grid', () => {
    expect(READER_TEXT).toHaveLength(6);
    let last = 0;
    for (let step = 0; step < READER_TEXT.length; step++) {
      const type = readerType(step);
      expect(type.body.size).toBeGreaterThan(last);
      last = type.body.size;
      for (const style of Object.values(type)) {
        expect(style.line % 4).toBe(0);
        expect(style.line).toBeGreaterThanOrEqual(style.size);
      }
      expect(type.title.size).toBeGreaterThan(type.h2.size);
      expect(type.h2.size).toBeGreaterThan(type.body.size);
    }
    // Out of range clamps to the ends.
    expect(readerType(-3)).toEqual(readerType(0));
    expect(readerType(99)).toEqual(readerType(READER_TEXT.length - 1));
  });

  it('becomes CSS variables for the font, the line width and each role', () => {
    const vars = readerTypeVars(2, 'serif', 'wide');
    expect(vars['--reader-measure']).toBe(`${READER_MEASURE.wide}em`);
    expect(vars['--reader-font']).toContain('Georgia');
    expect(vars['--reader-body']).toBe('450 19px/32px var(--reader-font)');
    expect(vars['--reader-code']).toContain('var(--reader-mono)');
    expect(readerTypeVars(2, 'sans', 'medium')['--reader-font']).toContain('Onest');
  });
});
