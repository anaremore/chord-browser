import type { SettingsApi } from '@chord/ipc';

/** Exposed by the internal-page preload (src/preload/internal.ts). */
export const api = (window as unknown as { chord: SettingsApi }).chord;
