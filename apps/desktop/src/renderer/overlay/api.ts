import type { OverlayApi } from '@chord/ipc';

/** Exposed by the overlay preload (src/preload/overlay.ts). */
export const api = (window as unknown as { chord: OverlayApi }).chord;
