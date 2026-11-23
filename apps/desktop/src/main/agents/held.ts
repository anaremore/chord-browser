/**
 * What an agent hears of a dialog or a picker its tab held: the page's own words for its top frame (or a frame of its
 * own origin), never another origin's frame's (an ad's alert would read as a notice in the agent's notes): only that a
 * frame from that origin tried (Claude's review 5 of #110). `topOrigin` is null for the top frame itself.
 */
export function heldDetail(kind: 'dialog' | 'file', detail: string, frameOrigin: string | null, topOrigin: string | null): string {
  if (topOrigin === null || frameOrigin === topOrigin) return detail.slice(0, 500);
  const from = frameOrigin && frameOrigin !== 'null' ? frameOrigin.slice(0, 200) : 'another site';
  return kind === 'dialog' ? `a frame from ${from} tried to show a dialog` : `a frame from ${from} tried to open a file picker`;
}
