/**
 * What an agent hears of a dialog or a picker its tab held: the page's own words for its top frame (or a frame of its
 * own origin), never another origin's frame's (an ad's alert would read as a notice in the agent's notes): only that a
 * frame from that origin tried (Claude's review 5 of #110). `topOrigin` is null for the top frame itself.
 */
export function heldDetail(kind: 'dialog' | 'file' | 'print', detail: string, frameOrigin: string | null, topOrigin: string | null): string {
  // Two opaque origins ('null': sandboxed, data:) are never the same site, whatever they say.
  const own = topOrigin === null || (frameOrigin === topOrigin && frameOrigin !== 'null');
  // A print (#115 PR 2): the way it asked is Chord's own words (never the page's), refused and said so.
  if (kind === 'print' && own) return `the page tried to print (${detail.slice(0, 60)}); Chord doesn’t print for agents`;
  if (own) return detail.slice(0, 500);
  const from = frameOrigin && frameOrigin !== 'null' ? frameOrigin.slice(0, 200) : 'another site';
  if (kind === 'print') return `a frame from ${from} tried to print; Chord doesn’t print for agents`;
  return kind === 'dialog' ? `a frame from ${from} tried to show a dialog` : `a frame from ${from} tried to open a file picker`;
}

/**
 * The same, from the frame that sent it, as Electron gives it: the main frame's own words; any other frame's, or one
 * Electron can no longer name (it went, or navigated away, between its message and now: `senderFrame` is null), as
 * a frame from another site (Claude's review 7 of #110: never fails open).
 */
export function heldFromFrame(kind: 'dialog' | 'file' | 'print', detail: string, frame: { origin: string } | null | undefined, main: { origin: string } | null | undefined): string {
  // The page's own top frame, that very frame (Neon's review 4: not "a frame with no parent").
  if (frame && main && frame === main) return heldDetail(kind, detail, frame.origin, null);
  return heldDetail(kind, detail, frame?.origin ?? null, main?.origin || 'unknown');
}
