/**
 * What screenshots run in a page (DESIGN.md §7.12): finding the element
 * under the pointer, and walking to its parent or child, from Chord's own
 * isolated world, so the page never sees the pointer or the picker. The
 * picked element is kept in that world (`__chordShot`) between calls; its
 * rect is in the page's CSS pixels, from the top-left of its viewport, plus
 * the scroll, so a capture can reach past the screen.
 */

/** Chord's isolated world for screenshots (Duet reads in 4400, reader view in 4410). */
export const SHOT_WORLD = 4420;

const DESCRIBE = String.raw`
  const describe = (el) => {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const id = el.id ? '#' + el.id : '';
    const cls = !id && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
    return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      scroll: { x: scrollX, y: scrollY },
      viewport: { width: innerWidth, height: innerHeight },
      label: (el.localName + id + cls).slice(0, 60),
    };
  };
  // The page itself isn't an element to pick: that's Visible or Full page.
  const pickable = (el) => el && el !== document.documentElement && el !== document.body;
`;

/** The element at a point in the page's CSS pixels, into open shadow roots; null over the page itself. */
export function hitScript(x: number, y: number): string {
  return String.raw`(() => {${DESCRIBE}
  let el = document.elementFromPoint(${Number(x)}, ${Number(y)});
  for (let i = 0; el && el.shadowRoot && i < 16; i++) {
    const inner = el.shadowRoot.elementFromPoint(${Number(x)}, ${Number(y)});
    if (!inner || inner === el) break;
    el = inner;
  }
  globalThis.__chordShot = pickable(el) ? el : null;
  return describe(globalThis.__chordShot);
})()`;
}

/** The picked element's parent (up to, not including, the page itself) or its first visible child. */
export function stepScript(to: 'parent' | 'child'): string {
  return String.raw`(() => {${DESCRIBE}
  const now = globalThis.__chordShot;
  if (!now || !now.isConnected) return null;
  let next = null;
  if (${JSON.stringify(to)} === 'parent') {
    const up = now.parentElement || (now.getRootNode() instanceof ShadowRoot ? now.getRootNode().host : null);
    next = pickable(up) ? up : null;
  } else {
    for (const child of now.children) if (describe(child)) { next = child; break; }
  }
  if (next) globalThis.__chordShot = next;
  return describe(globalThis.__chordShot);
})()`;
}

/** The picked element as it is now (it may have moved since it was picked). */
export const PICKED_SCRIPT = String.raw`(() => {${DESCRIBE}
  return describe(globalThis.__chordShot);
})()`;

/** Forget the pick (the screenshot is done or cancelled). */
export const FORGET_SCRIPT = `globalThis.__chordShot = null;`;
