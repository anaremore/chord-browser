import type { PopoverApi } from '@chord/ipc';

/** Exposed by the popover preload (src/preload/popover.ts). */
export const api = (window as unknown as { chord: PopoverApi }).chord;
