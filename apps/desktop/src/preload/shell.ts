/**
 * The shell's only door to main (ARCHITECTURE.md §8). Exposes a frozen,
 * typed `window.chord`; raw ipcRenderer never reaches the page.
 */
import type { ShellApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { invoke, stateApi, subscribe, systemApi } from './bridge';

const api: ShellApi = {
  system: systemApi,
  state: stateApi,
  nav: { command: (action) => invoke('nav:command', { action }) },
  overlay: { open: (mode) => invoke('overlay:open', { mode }) },
  layout: { anchor: (rect) => invoke('layout:anchor', rect) },
  menu: {
    app: (anchor) => invoke('menu:app', anchor),
    tab: (nodeId, at) => invoke('menu:tab', { nodeId, x: at.x, y: at.y }),
    chord: (chordId, at) => invoke('menu:chord', { chordId, x: at.x, y: at.y }),
  },
  chords: { onEdit: (listener) => subscribe('chord:edit', listener) },
  action: { run: (action) => invoke('action:run', { action }) },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
