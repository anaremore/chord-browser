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
    onWarm: (listener) => subscribe('overlay:warm', () => listener()),
    close: (seq, dismissed) => invoke('overlay:close', dismissed === true ? { seq, dismissed: true } : { seq }),
    ready: () => invoke('overlay:ready'),
  },
  action: { run: (action) => invoke('action:run', { action }) },
  downloads: downloadsApi,
  duet: {
    search: (query) => invoke('duet:search', { query }),
    open: (chordId, threadId) => invoke('duet:openHit', { chordId, threadId }),
    ask: (text, image) => invoke('duet:ask', { text, image }),
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
    image: (engine, image, where) => invoke('search:image', { engine, image, where }),
  },
  archive: { restore: (archiveId) => invoke('archive:restore', { archiveId }) },
  peek: {
    onState: (listener) => subscribe('peek:state', listener),
    expand: () => invoke('peek:expand'),
  },
  capture: {
    hover: (x, y) => invoke('capture:hover', { x, y }),
    step: (to) => invoke('capture:step', { to }),
    take: (choice) => invoke('capture:take', choice),
    scroll: (x, y, deltaX, deltaY) => invoke('capture:scroll', { x, y, deltaX, deltaY }),
  },
  screenshots: {
    list: () => invoke('screenshots:list'),
    act: (id, action) => invoke('screenshots:do', { id, do: action }),
    clear: () => invoke('screenshots:clear'),
  },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
