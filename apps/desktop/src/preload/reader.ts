/**
 * A reader view's preload (ARCHITECTURE.md §8, §9): it reads its own tab's
 * article and how it should look, changes reader view's controls, and
 * closes. It sees no other tab, no history and no other setting.
 */
import type { ReaderApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { invoke, subscribe, systemApi } from './bridge';

const api: ReaderApi = {
  system: systemApi,
  reader: {
    page: () => invoke('reader:page'),
    look: () => invoke('reader:look'),
    onLook: (listener) => subscribe('reader:look', listener),
    ready: () => invoke('reader:ready'),
    set: (patch) => invoke('reader:set', patch),
    close: () => invoke('reader:close'),
  },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
