/**
 * A ref's frame chain, checked (#347; frames.md's B5, SF3 and NN3): one function for the act's look (act.ts) and
 * deep.ts' hit test, so the two never disagree on which frame a ref is in. Run in the page's isolated world, as part
 * of each script that needs it; the unit test runs its source against stand-ins.
 *
 * `chain`: the frames the snapshot found the element in, outermost first, each as it was then: a WeakRef to the
 * `<iframe>` and to the document it held, its name, its items, its unnamed row, its place among its ancestors
 * (refPath), and its index among its sibling frames (Argon's SF3: a reorder, a move between unnamed rows or to another
 * depth). `top`: the document the outermost frame sits in. `at`: the page's own nameOf, itemsOf, rowOf, refPath (as
 * pathOf) and framePlace (as placeOf), as the snapshot used them.
 *
 * `el`: the element, checked to be in the last frame's document; `undefined` to check the frames only (the element
 * replaced, and looked for again in that document: act.ts' refind).
 *
 * Answers the element's own document while every frame is still the one the snapshot found, holding the same document:
 * - a frame gone, removed, adopted into another document, or holding another document (it navigated): stale;
 * - a frame retitled, moved into another item or unnamed row, to another depth, or among its sibling frames (moveBefore
 *   keeps its document, name and items): changed;
 * - the element gone: changed; moved out of the frame's document: stale.
 */
export const FRAME_CHAIN_FN = String.raw`const frameChain = (chain, el, top, at) => {
  let doc = top;
  for (const f of chain) {
    const frame = f.frame.deref();
    const held = f.doc.deref();
    if (!frame || !held || !frame.isConnected || frame.ownerDocument !== doc || frame.contentDocument !== held) return { ok: false, why: 'stale' };
    if (at.nameOf(frame, 'iframe') !== f.name || at.itemsOf(frame) !== f.items || at.placeOf(frame) !== f.place) return { ok: false, why: 'changed' };
    if ((f.row !== undefined && at.rowOf(frame) !== f.row) || (f.path !== undefined && at.pathOf(frame) !== f.path)) return { ok: false, why: 'changed' };
    doc = held;
  }
  if (el === undefined) return { ok: true, doc };
  if (!el || !el.isConnected) return { ok: false, why: 'changed' };
  if (el.ownerDocument !== doc) return { ok: false, why: 'stale' };
  return { ok: true, doc };
}`;
