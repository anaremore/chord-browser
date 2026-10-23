import type { MiniApi } from '@chord/ipc';

/** Exposed by the mini window's preload (src/preload/mini.ts). */
export const api = (window as unknown as { chord: MiniApi }).chord;
