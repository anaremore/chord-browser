import { describe, expect, it } from 'vitest';
import { apply, seedState, splitMembers, splitOf, type Command, type Context, type State } from '@chord/core';
import { splitDropFor } from '../../src/renderer/shell/split-drop';

let n = 0;
const ctx: Context = { now: 1_000, newId: () => `n${++n}` };
const size = { width: 1000, height: 600 };

/** Today: a, b, c, d, each opened in turn (d is shown). */
function setup(): { state: State; windowId: string; id: Record<string, string>; run(cmd: Command): void } {
  let state = seedState({ now: 0, newId: ctx.newId, theme: { stops: [{ l: 0.7, c: 0.1, h: 1 }], grain: 0.2, appearance: 'auto' }, homeUrl: 'https://home.test/' });
  const windowId = Object.keys(state.windows)[0]!;
  const chordId = Object.keys(state.chords)[0]!;
  const id: Record<string, string> = {};
  const run = (cmd: Command) => (state = apply(state, cmd, ctx).state);
  for (const name of ['a', 'b', 'c', 'd']) {
    run({ t: 'tab.open', windowId, url: `https://${name}.test/` });
    id[name] = state.windows[windowId]!.activeTab[chordId]!;
  }
  return {
    get state() {
      return state;
    },
    windowId,
    id,
    run,
  };
}

describe('dropping a tab on the page', () => {
  it('with one page shown, the nearest edge picks the side', () => {
    const t = setup();
    const left = splitDropFor(t.state, t.windowId, t.id['a']!, { x: 50, y: 300 }, size)!;
    expect(left.command).toMatchObject({ t: 'split.add', withId: t.id['d'], nodeId: t.id['a'], index: 0, direction: 'row' });
    expect(left.rect).toEqual({ x: 0, y: 0, width: 496, height: 600 });
    const bottom = splitDropFor(t.state, t.windowId, t.id['a']!, { x: 500, y: 580 }, size)!;
    expect(bottom.command).toMatchObject({ index: 1, direction: 'column' });
    expect(bottom.rect.y).toBe(304);
    // The page itself has nowhere to go.
    expect(splitDropFor(t.state, t.windowId, t.id['d']!, { x: 50, y: 300 }, size)).toBeNull();
  });

  it('with a split shown, the half of the pane under the pointer picks the place', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: t.windowId, withId: t.id['d']!, nodeId: t.id['c']! });
    // Panes: d | c. Over the right half of d: between them.
    const between = splitDropFor(t.state, t.windowId, t.id['a']!, { x: 400, y: 300 }, size)!;
    expect(between.command).toMatchObject({ index: 1 });
    expect(between.rect).toEqual({ x: 248, y: 0, width: 248, height: 600 });
    t.run(between.command);
    const split = splitOf(t.state, t.id['a']!)!;
    expect(splitMembers(t.state, split.id).map((p) => p.id)).toEqual([t.id['d'], t.id['a'], t.id['c']]);
  });

  it('moves a pane within its split, but not onto its own place', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: t.windowId, withId: t.id['d']!, nodeId: t.id['c']! });
    expect(splitDropFor(t.state, t.windowId, t.id['c']!, { x: 900, y: 300 }, size)).toBeNull();
    const first = splitDropFor(t.state, t.windowId, t.id['c']!, { x: 10, y: 300 }, size)!;
    expect(first.command).toMatchObject({ withId: t.id['d'], nodeId: t.id['c'], index: 0 });
    t.run(first.command);
    const split = splitOf(t.state, t.id['c']!)!;
    expect(splitMembers(t.state, split.id).map((p) => p.id)).toEqual([t.id['c'], t.id['d']]);
  });

  it('a full split takes no more', () => {
    const t = setup();
    for (const name of ['c', 'b', 'a']) t.run({ t: 'split.add', windowId: t.windowId, withId: t.id['d']!, nodeId: t.id[name]! });
    expect(splitMembers(t.state, splitOf(t.state, t.id['d']!)!.id)).toHaveLength(4);
    t.run({ t: 'tab.open', windowId: t.windowId, url: 'https://e.test/', background: true });
    const e = Object.values(t.state.nodes).find((x) => x.kind === 'tab' && x.url === 'https://e.test/')!.id;
    expect(splitDropFor(t.state, t.windowId, e, { x: 10, y: 300 }, size)).toBeNull();
  });
});
