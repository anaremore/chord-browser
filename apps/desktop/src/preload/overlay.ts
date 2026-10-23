/** The command bar overlay's door to main (ARCHITECTURE.md §8). */
import type { OverlayApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { downloadsApi, invoke, stateApi, subscribe, systemApi } from './bridge';

const api: OverlayApi = {
  system: systemApi,
  state: stateApi,
  overlay: {
    onOpen: (listener) => subscribe('overlay:open', listener),
    onDismiss: (listener) => subscribe('overlay:dismiss', ({ seq }) => listener(seq)),
    close: (seq) => invoke('overlay:close', { seq }),
    ready: () => invoke('overlay:ready'),
  },
  action: { run: (action) => invoke('action:run', { action }) },
  downloads: downloadsApi,
  duet: {
    search: (query) => invoke('duet:search', { query }),
    open: (chordId, threadId) => invoke('duet:openHit', { chordId, threadId }),
  },
  history: {
    search: (query) => invoke('history:search', { query }),
    choose: (text, destination, address) => invoke('history:choose', address ? { text, destination, address } : { text, destination }),
  },
  extensions: {
    state: () => invoke('extensions:state'),
    activate: (id, anchor) => invoke('extension:activate', { id, anchor }),
    manage: () => invoke('extensions:manage'),
  },
  search: {
    suggest: (query, engine) => invoke('search:suggest', engine ? { query, engine } : { query }),
  },
  archive: { restore: (archiveId) => invoke('archive:restore', { archiveId }) },
  peek: {
    onState: (listener) => subscribe('peek:state', listener),
    expand: () => invoke('peek:expand'),
  },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
