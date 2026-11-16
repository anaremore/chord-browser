import type { Chord, InterfaceSettings } from '@chord/core';
import type { SystemInfo } from '@chord/ipc';
import { createChordTheme, hexToRgb, presetStops, rgbToOklch, type Appearance } from '@chord/tokens';
import { useLayoutEffect, type CSSProperties } from 'react';

/** The CSS variables and resolved appearance for a chord (DESIGN.md §5). */
export function chordStyle(
  chord: Pick<Chord, 'theme'> | null | undefined,
  info: SystemInfo,
  ui?: InterfaceSettings,
): { style: CSSProperties; appearance: Appearance } {
  // Focus rings wear the OS accent, moved until they read on this chord's tint (DESIGN.md §10).
  const accent = info.accentColor ? hexToRgb(info.accentColor) : null;
  const theme = createChordTheme(chord?.theme ?? { stops: presetStops('dusk'), grain: 0.2, appearance: 'auto' }, {
    systemAppearance: info.appearance,
    material: info.material,
    contrast: ui?.contrast,
    glass: ui?.glass,
    focus: accent ? rgbToOklch(accent) : null,
  });
  // color-scheme follows the chord's appearance, not the system's: native parts (a select's list, scrollbars,
  // form controls) are drawn to match, so an option's text, in the theme's ink, always reads on its background.
  return { style: { ...theme.vars, colorScheme: theme.appearance } as CSSProperties, appearance: theme.appearance };
}

/**
 * The page root's color-scheme, following the chord's appearance. `chordStyle` sets it on the window's own
 * element, but a select's list is drawn from the root's: with the system light and the chord dark, the list
 * came up white under the theme's light ink, unreadable.
 */
export function useRootColorScheme(appearance: Appearance): void {
  useLayoutEffect(() => {
    document.documentElement.style.colorScheme = appearance;
  }, [appearance]);
}
