/** The popover's door to main: the find bar, permission prompts and sign-in boxes (ARCHITECTURE.md §8). */
import type { PopoverApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { invoke, subscribe, systemApi } from './bridge';

const api: PopoverApi = {
  system: systemApi,
  popover: {
    state: () => invoke('popover:state'),
    onState: (listener) => subscribe('popover:state', listener),
    size: (width, height) => invoke('popover:size', { width, height }),
  },
  find: {
    query: (text, forward) => invoke('find:query', { text, forward }),
    close: () => invoke('find:close'),
  },
  permission: { respond: (id, decision) => invoke('permission:respond', { id, decision }) },
  share: { respond: (id, sourceId, audio) => invoke('share:respond', { id, sourceId, audio }) },
  auth: { respond: (id, credentials) => invoke('auth:respond', { id, credentials }) },
  passkey: { respond: (id, credentialId) => invoke('passkey:respond', { id, credentialId }) },
  safeBrowsing: { choose: (on) => invoke('safeBrowsing:choose', { on }) },
  drm: { open: (browser) => invoke('drm:open', { browser }), dismiss: () => invoke('drm:dismiss'), player: (action) => invoke('drm:player', { action }) },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
