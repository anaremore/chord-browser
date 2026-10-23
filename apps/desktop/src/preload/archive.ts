/**
 * The archive page's preload (ARCHITECTURE.md §8): it lists, restores and
 * removes archived tabs, and sees its chord's look. Nothing else.
 */
import type { ArchiveApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { invoke, subscribe, systemApi } from './bridge';

const api: ArchiveApi = {
  system: systemApi,
  archive: {
    snapshot: () => invoke('archive:snapshot'),
    onSnapshot: (listener) => subscribe('archive:snapshot', listener),
    list: (query, limit) => invoke('archive:list', { query, limit }),
    onChange: (listener) => subscribe('archive:changed', () => listener()),
    restore: (archiveId) => invoke('archive:restore', { archiveId }),
    remove: (archiveId) => invoke('archive:remove', { archiveId }),
  },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
