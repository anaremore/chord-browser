/**
 * #347 (frames.md's NN3, B5, SF3; PR 2 owes position): the one check of a ref's frame chain, shared by the act's look
 * and deep.ts' hit test. Run here against plain stand-ins for frames and documents; in Chord it runs in the page's
 * isolated world (agents-frames.spec runs it there).
 */
import { describe, expect, it } from 'vitest';
import { FRAME_CHAIN_FN } from '../../src/main/control/frame-chain';

type Doc = { name: string };
type Frame = { isConnected: boolean; ownerDocument: Doc; contentDocument: Doc | null; title: string; items: string; place: number; row: string; path: string };
type Link = { frame: { deref(): Frame | undefined }; doc: { deref(): Doc | undefined }; name: string; items: string; place: number; row?: string; path?: string };
type Answer = { ok: true; doc: Doc } | { ok: false; why: string };

const frameChain = new Function(`${FRAME_CHAIN_FN}; return frameChain;`)() as (chain: Link[], el: { isConnected: boolean; ownerDocument: Doc } | null | undefined, top: Doc, at: object) => Answer;
const at = { nameOf: (f: Frame) => f.title, itemsOf: (f: Frame) => f.items, placeOf: (f: Frame) => f.place, rowOf: (f: Frame) => f.row, pathOf: (f: Frame) => f.path };
const ref = <T,>(x: T | undefined) => ({ deref: () => x });

/** A page with a frame in it, and a frame in that: the chain as the snapshot recorded it. */
function nested() {
  const top: Doc = { name: 'top' };
  const outerDoc: Doc = { name: 'outer' };
  const innerDoc: Doc = { name: 'inner' };
  const outer: Frame = { isConnected: true, ownerDocument: top, contentDocument: outerDoc, title: 'Outer', items: '[]', place: 0, row: '', path: '[["main",""]]' };
  const inner: Frame = { isConnected: true, ownerDocument: outerDoc, contentDocument: innerDoc, title: 'Inner', items: '["Shelf"]', place: 2, row: '["Order A"]', path: '[["li",""],["ul",""]]' };
  const chain: Link[] = [outer, inner].map((f) => ({ frame: ref(f), doc: ref(f.contentDocument!), name: f.title, items: f.items, place: f.place, row: f.row, path: f.path }));
  const el = { isConnected: true, ownerDocument: innerDoc };
  return { top, outerDoc, innerDoc, outer, inner, chain, el };
}

describe('a ref’s frame chain (#347)', () => {
  it('as the snapshot recorded it: the element’s own document', () => {
    const t = nested();
    expect(frameChain(t.chain, t.el, t.top, at)).toEqual({ ok: true, doc: t.innerDoc });
  });

  it('a frame gone, removed, or moved to another document: stale', () => {
    const rows: [string, (t: ReturnType<typeof nested>) => void][] = [
      ['collected', (t) => (t.chain[1]!.frame = ref<Frame>(undefined))],
      ['removed', (t) => (t.outer.isConnected = false)],
      ['adopted into another document', (t) => (t.inner.ownerDocument = t.top)],
      ['navigated (another document in it)', (t) => (t.inner.contentDocument = { name: 'elsewhere' })],
    ];
    for (const [what, change] of rows) {
      const t = nested();
      change(t);
      expect(frameChain(t.chain, t.el, t.top, at), what).toEqual({ ok: false, why: 'stale' });
    }
  });

  it('a frame retitled, moved into another item, or moved within its item: changed', () => {
    const rows: [string, (t: ReturnType<typeof nested>) => void][] = [
      ['retitled', (t) => (t.outer.title = 'Renamed')],
      ['into another item', (t) => (t.inner.items = '["Other shelf"]')],
      // PR 2 owes position (frames.md's Limits): a moveBefore reorder keeps its document, name and items.
      ['reordered within its item', (t) => (t.inner.place = 3)],
      // Argon's SF3: into another unnamed row (its items alike), or to another depth.
      ['into another unnamed row', (t) => (t.inner.row = '["Order B"]')],
      ['to another depth', (t) => (t.inner.path = '[["div",""],["li",""],["ul",""]]')],
    ];
    for (const [what, change] of rows) {
      const t = nested();
      change(t);
      expect(frameChain(t.chain, t.el, t.top, at), what).toEqual({ ok: false, why: 'changed' });
    }
  });

  it('the frames only (the element replaced, to be looked for again in its document): their document', () => {
    const t = nested();
    expect(frameChain(t.chain, undefined, t.top, at)).toEqual({ ok: true, doc: t.innerDoc });
    t.outer.isConnected = false;
    expect(frameChain(t.chain, undefined, t.top, at)).toEqual({ ok: false, why: 'stale' });
  });

  it('the element gone: changed; moved out of the frame’s document: stale', () => {
    const t = nested();
    expect(frameChain(t.chain, { isConnected: false, ownerDocument: t.innerDoc }, t.top, at)).toEqual({ ok: false, why: 'changed' });
    expect(frameChain(t.chain, null, t.top, at)).toEqual({ ok: false, why: 'changed' });
    expect(frameChain(t.chain, { isConnected: true, ownerDocument: t.top }, t.top, at)).toEqual({ ok: false, why: 'stale' });
  });
});
