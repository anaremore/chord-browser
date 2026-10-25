import type { ReaderApi } from '@chord/ipc';

/** Exposed by the reader view's preload (src/preload/reader.ts). */
export const api = (window as unknown as { chord: ReaderApi }).chord;
