import type { PreviewApi } from '@chord/ipc';

/** Exposed by the preview preload (src/preload/preview.ts). */
export const api = (window as unknown as { chord: PreviewApi }).chord;
