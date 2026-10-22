import type { Chord } from '@chord/core';
import type { SystemInfo } from '@chord/ipc';
import { createChordTheme, presetStops, type Appearance } from '@chord/tokens';
import type { CSSProperties } from 'react';

/** The CSS variables and resolved appearance for a chord (DESIGN.md §5). */
export function chordStyle(chord: Pick<Chord, 'theme'> | null | undefined, info: SystemInfo): { style: CSSProperties; appearance: Appearance } {
  const theme = createChordTheme(chord?.theme ?? { stops: presetStops('dusk'), grain: 0.2, appearance: 'auto' }, {
    systemAppearance: info.appearance,
    material: info.material,
  });
  return { style: theme.vars as CSSProperties, appearance: theme.appearance };
}
