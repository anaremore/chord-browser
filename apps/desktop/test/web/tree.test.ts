import { describe, expect, it } from 'vitest';
import { apply, seedState, type Command, type Context, type State } from '@chord/core';
import { flattenPinned, projectDrop, type FlatRow } from '../../src/renderer/shell/tree';

let n = 0;
const ctx: Context = { now: 1_000, newId: () => `n${++n}` };

/** Pinned: a, Folder F [b, Folder G [c]], d */
function tree(): { state: State; chordId: string; id: Record<string, string> } {
  let state = seedState({ now: 0, newId: ctx.newId, theme: { stops: [{ l: 0.7, c: 0.1, h: 1 }], grain: 0.2, appearance: 'auto' }, homeUrl: 'https://home.test/' });
  const windowId = Object.keys(state.windows)[0]!;
  const chordId = Object.keys(state.chords)[0]!;
  const run = (cmd: Command) => (state = apply(state, cmd, ctx).state);
  const id: Record<string, string> = {};
  for (const name of ['a', 'b', 'c', 'd']) {
    run({ t: 'tab.open', windowId, url: `https://${name}.test/` });
    id[name] = state.windows[windowId]!.activeTab[chordId]!;
  }
  run({ t: 'tab.pin', nodeId: id['a']! });
  run({ t: 'folder.create', folderId: 'F', chordId, title: 'F', tabId: id['b']! });
  run({ t: 'folder.create', folderId: 'G', chordId, title: 'G', tabId: id['c']! });
  run({ t: 'node.move', nodeId: 'G', section: 'pinned', index: 1, parentId: 'F' });
  run({ t: 'tab.pin', nodeId: id['d']! });
  return { state, chordId, id };
}

const shape = (rows: FlatRow[], id: Record<string, string>) => {
  const name = (rowId: string) => Object.keys(id).find((k) => id[k] === rowId) ?? rowId;
  return rows.map((r) => `${'.'.repeat(r.depth)}${name(r.id)}`);
};

describe('flattenPinned', () => {
  it('lists the tree depth-first, hiding what closed folders hold', () => {
    const { state, chordId, id } = tree();
    expect(shape(flattenPinned(state, chordId), id)).toEqual(['a', 'F', '.b', '.G', '..c', 'd']);
    // A folder being dragged travels closed.
    expect(shape(flattenPinned(state, chordId, 'F'), id)).toEqual(['a', 'F', 'd']);
  });
});

describe('projectDrop', () => {
  it('drops level with the row above, or inside it when it is an open folder', () => {
    const { state, chordId, id } = tree();
    const rows = flattenPinned(state, chordId).filter((r) => r.id !== id['d']);
    // Below "a" (a tab): level with it.
    expect(projectDrop(rows, 1, 0, 0)).toEqual({ parentId: null, index: 1, depth: 0 });
    // Below open folder F, dragged one level right: first inside F.
    expect(projectDrop(rows, 2, 0, 1)).toEqual({ parentId: 'F', index: 0, depth: 1 });
    // Between F's children, the row below forces at least its depth.
    expect(projectDrop(rows, 2, 0, 0)).toEqual({ parentId: 'F', index: 0, depth: 1 });
  });

  it('climbs out of folders at the end by moving left', () => {
    const { state, chordId, id } = tree();
    const rows = flattenPinned(state, chordId).filter((r) => r.id !== id['d']);
    // After "c" (inside G inside F), at the very end.
    expect(projectDrop(rows, rows.length, 2, 0)).toEqual({ parentId: 'G', index: 1, depth: 2 });
    expect(projectDrop(rows, rows.length, 2, -1)).toEqual({ parentId: 'F', index: 2, depth: 1 });
    expect(projectDrop(rows, rows.length, 2, -5)).toEqual({ parentId: null, index: 2, depth: 0 });
  });

  it('puts the first row at the top level', () => {
    const { state, chordId } = tree();
    expect(projectDrop(flattenPinned(state, chordId), 0, 3, 3)).toEqual({ parentId: null, index: 0, depth: 0 });
  });
});
