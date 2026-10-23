/**
 * A mini window's bar (DESIGN.md §7.9): it shows its page's site and moves
 * the page into a chord. It sees no tabs, history or settings.
 */
import type { MiniApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { invoke, subscribe, systemApi } from './bridge';

const api: MiniApi = {
  system: systemApi,
  mini: {
    state: () => invoke('mini:state'),
    onState: (listener) => subscribe('mini:state', listener),
    promote: () => invoke('mini:promote'),
    chooseChord: (anchor) => invoke('mini:chooseChord', anchor),
    copyLink: () => invoke('mini:copyLink'),
  },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
