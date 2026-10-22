import type { ShellApi } from '@chord/ipc';

/** Exposed by the shell preload (src/preload/shell.ts). */
export const api = (window as unknown as { chord: ShellApi }).chord;
