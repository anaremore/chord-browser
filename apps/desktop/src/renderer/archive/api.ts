import type { ArchiveApi } from '@chord/ipc';

/** Exposed by the archive page's preload (src/preload/archive.ts). */
export const api = (window as unknown as { chord: ArchiveApi }).chord;
