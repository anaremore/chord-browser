/** The command bar overlay's door to main (ARCHITECTURE.md §8). */
import type { OverlayApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { downloadsApi, invoke, stateApi, subscribe, systemApi } from './bridge';

const api: OverlayApi = {
  system: systemApi,
  state: stateApi,
  overlay: {
    onOpen: (listener) => subscribe('overlay:open', listener),
    close: () => invoke('overlay:close'),
  },
  action: { run: (action) => invoke('action:run', { action }) },
  downloads: downloadsApi,
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
