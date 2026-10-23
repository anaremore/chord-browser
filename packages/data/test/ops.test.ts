import { describe, expect, it } from 'vitest';
import { apply, seedState, type Context } from '@chord/core';
import { opsFromPatches } from '../src';

let n = 0;
const ctx: Context = { now: 5, newId: () => `id-${++n}` };
const state = seedState({ now: 1, newId: ctx.newId, theme: { stops: [{ l: 0.7, c: 0.1, h: 10 }], grain: 0.2, appearance: 'auto' }, homeUrl: 'https://h.test/' });
const windowId = Object.keys(state.windows)[0]!;

describe('opsFromPatches', () => {
  it('writes each touched entity once, with its latest value', () => {
    const result = apply(state, { t: 'tab.open', windowId, url: 'https://a.test/' }, ctx);
    const ops = opsFromPatches(result.patches, result.state);
    const newTab = Object.keys(result.state.nodes).find((id) => !state.nodes[id])!;
    // The tab it left records when it stopped being used.
    const left = state.windows[windowId]!.activeTab[state.windows[windowId]!.activeChordId]!;
    expect(ops.map((op) => `${op.k}:${op.id}`).sort()).toEqual([`node:${newTab}`, `node:${left}`, `window:${windowId}`].sort());
    expect(ops.find((op) => op.k === 'node' && op.id === newTab)!.value).toEqual(result.state.nodes[newTab]);
  });

  it('turns removals into deletes and ignores engine-only state', () => {
    const tabId = Object.keys(state.nodes)[0]!;
    const loading = apply(state, { t: 'tab.live', nodeId: tabId, live: { loading: false } }, ctx);
    expect(opsFromPatches(loading.patches, loading.state)).toEqual([]);
    const closed = apply(state, { t: 'tab.close', windowId, nodeId: tabId }, ctx);
    expect(opsFromPatches(closed.patches, closed.state)).toContainEqual({ k: 'node', id: tabId, value: null });
  });

  it('writes a settings group as one value', () => {
    const result = apply(state, { t: 'settings.set', settings: { motion: { sidebar: false } } }, ctx);
    expect(opsFromPatches(result.patches, result.state)).toEqual([{ k: 'setting', id: 'motion', value: result.state.settings.motion }]);
  });
});
