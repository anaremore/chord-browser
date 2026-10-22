/** Small pure helpers for page actions (zoom, copy as link). */

/** Chromium's zoom presets, so ⌘+ / ⌘− land where Chrome users expect. */
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

/** The next preset above (1) or below (-1) the current factor; stays put at either end. */
export function zoomStep(factor: number, direction: 1 | -1): number {
  const epsilon = 0.001;
  if (direction > 0) return ZOOM_LEVELS.find((z) => z > factor + epsilon) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;
  return [...ZOOM_LEVELS].reverse().find((z) => z < factor - epsilon) ?? ZOOM_LEVELS[0];
}

/** `[title](url)`, with brackets in the title escaped and parentheses in the URL encoded. */
export function markdownLink(title: string, url: string): string {
  const text = (title.trim() || url).replace(/([\\[\]])/g, '\\$1');
  const href = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `[${text}](${href})`;
}
