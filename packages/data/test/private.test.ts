import { describe, expect, it } from 'vitest';
import { apply, seedState, type Context, type State } from '@chord/core';
import { opsForState, opsFromPatches } from '../src';

let n = 0;
const ctx: Context = { now: 5, newId: () => `id-${++n}` };
const seeded = seedState({ now: 1, newId: ctx.newId, theme: { stops: [{ l: 0.7, c: 0.1, h: 10 }], grain: 0.2, appearance: 'auto' }, homeUrl: 'https://h.test/' });
const windowId = Object.keys(seeded.windows)[0]!;

/** Run commands, collecting every op persistence would write. */
function drive(state: State, commands: Parameters<typeof apply>[1][]) {
  const ops: ReturnType<typeof opsFromPatches> = [];
  for (const command of commands) {
    const result = apply(state, command, ctx);
    ops.push(...opsFromPatches(result.patches, result.state));
    state = result.state;
  }
  return { state, ops };
}

describe('private windows and persistence', () => {
  it('never writes a private window, its chord, its tabs or its downloads', () => {
    const { state, ops } = drive(seeded, [
      { t: 'window.create', windowId: 'p1', from: windowId, privateChordId: 'pc' },
      { t: 'tab.open', windowId: 'p1', url: 'https://secret.test/' },
      {
        t: 'download.update',
        download: { id: 'd1', url: 'https://secret.test/f', filename: 'f', path: '/f', mime: '', state: 'completed', received: 1, total: 1, speed: 0, startedAt: 1, endedAt: 2, privateWindow: 'p1' },
      },
    ]);
    const written = ops.filter((op) => op.value !== null);
    expect(written.some((op) => op.k === 'window' && op.id === 'p1')).toBe(false);
    expect(written.some((op) => op.k === 'chord' && op.id === 'pc')).toBe(false);
    expect(written.some((op) => op.k === 'node' && op.value && 'url' in op.value && op.value.url.includes('secret'))).toBe(false);
    expect(written.some((op) => op.k === 'download')).toBe(false);
    // Nor does a first write of the whole state.
    const all = opsForState(state);
    expect(all.some((op) => op.id === 'p1' || op.id === 'pc' || op.id === 'd1')).toBe(false);
    expect(all.some((op) => op.k === 'window' && op.id === windowId)).toBe(true);
  });

  it('allows a split in a private window, and never writes it', () => {
    const opened = drive(seeded, [
      { t: 'window.create', windowId: 'p1', from: windowId, privateChordId: 'pc' },
      { t: 'tab.open', windowId: 'p1', url: 'https://secret.test/' },
    ]);
    const shown = opened.state.windows['p1']!.activeTab['pc']!;
    const { state, ops } = drive(opened.state, [{ t: 'split.add', windowId: 'p1', withId: shown, url: 'https://beside.test/' }]);
    expect(Object.values(state.nodes).some((node) => node.kind === 'split' && node.chordId === 'pc')).toBe(true);
    expect(ops.filter((op) => op.value !== null && op.k === 'node')).toEqual([]);
    expect(opsForState(state).some((op) => op.k === 'node' && op.value?.chordId === 'pc')).toBe(false);
  });

  it('still saves the normal window next to it', () => {
    const { ops } = drive(seeded, [
      { t: 'window.create', windowId: 'p1', from: windowId, privateChordId: 'pc' },
      { t: 'tab.open', windowId, url: 'https://kept.test/' },
    ]);
    expect(ops.some((op) => op.k === 'node' && op.value && 'url' in op.value && op.value.url === 'https://kept.test/')).toBe(true);
  });
});
