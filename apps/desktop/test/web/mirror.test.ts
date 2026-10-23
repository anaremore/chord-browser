import { emptyState, type State } from '@chord/core';
import type { StatePatchEvent, StateSnapshot } from '@chord/ipc';
import { describe, expect, it } from 'vitest';
import { createMirror } from '../../src/renderer/shared/mirror';

/** Main's side: a snapshot, and patches sent one IPC message at a time. */
function fakeMain(state: State) {
  let send: (event: StatePatchEvent) => void = () => {};
  return {
    source: {
      snapshot: async (): Promise<StateSnapshot> => ({ windowId: 'w1', state }),
      onPatch: (listener: (event: StatePatchEvent) => void) => {
        send = listener;
        return () => {};
      },
    },
    patch: (version: number, title: string) =>
      send({ version, patches: [{ op: 'replace', path: ['version'], value: version }, { op: 'add', path: ['nodes', `n${version}`], value: { id: `n${version}`, title } }] }),
  };
}

describe('the state mirror', () => {
  it('tells its subscribers once for every patch that came before it got to, with the newest state', async () => {
    const main = fakeMain(emptyState());
    // A frame's worth of work, run when the test says the frame has come.
    const frame: (() => void)[] = [];
    const mirror = await createMirror(main.source, { notify: (tell) => frame.push(tell) });
    frame.splice(0).forEach((tell) => tell());
    let told = 0;
    mirror.subscribe(() => told++);

    main.patch(1, 'One');
    main.patch(2, 'Two');
    main.patch(3, 'Three');
    // Applied as they came: get() is always current, even before the frame.
    expect(mirror.get().version).toBe(3);
    expect(Object.keys(mirror.get().nodes)).toEqual(['n1', 'n2', 'n3']);
    expect(told).toBe(0);
    expect(frame).toHaveLength(1);

    frame.splice(0).forEach((tell) => tell());
    expect(told).toBe(1);

    // The next patch asks for the next frame.
    main.patch(4, 'Four');
    expect(frame).toHaveLength(1);
    frame.splice(0).forEach((tell) => tell());
    expect(told).toBe(2);
  });

  it('tells at once by default', async () => {
    const main = fakeMain(emptyState());
    const mirror = await createMirror(main.source);
    let told = 0;
    mirror.subscribe(() => told++);
    main.patch(1, 'One');
    main.patch(2, 'Two');
    expect(told).toBe(2);
  });
});
