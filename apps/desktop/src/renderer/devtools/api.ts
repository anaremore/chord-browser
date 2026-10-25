import type { DevtoolsBarApi } from '@chord/ipc';

/** Exposed by the developer tools window's preload (src/preload/devtools.ts). */
export const api = (window as unknown as { chord: DevtoolsBarApi }).chord;
