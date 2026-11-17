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
  auth: {
    respond: (id, credentials, remember) => invoke('auth:respond', { id, credentials, ...(remember !== undefined ? { remember } : {}) }),
    unlock: (id) => invoke('auth:unlock', { id }),
  },
  passkey: { respond: (id, credentialId) => invoke('passkey:respond', { id, credentialId }) },
  passwords: {
    unlock: (id, passphrase, keep) => invoke('passwords:unlockCard', { id, passphrase, keep }),
    choose: (id, index) => invoke('passwords:menuChoose', { id, index }),
    card: (id, action, details) => invoke('passwords:saveCard', { id, action, ...details }),
    reveal: (id) => invoke('passwords:saveCardReveal', { id }),
  },
  safeBrowsing: { choose: (on) => invoke('safeBrowsing:choose', { on }) },
  drm: { open: (browser) => invoke('drm:open', { browser }), dismiss: () => invoke('drm:dismiss'), player: (action) => invoke('drm:player', { action }) },
  effects: { view: () => invoke('effects:view'), onState: (listener) => subscribe('effects:state', listener), act: (action) => invoke('effects:do', action) },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
