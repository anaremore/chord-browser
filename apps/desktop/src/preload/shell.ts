/**
 * The shell's only door to main (ARCHITECTURE.md §8). Exposes a frozen,
 * typed `window.chord`; raw ipcRenderer never reaches the page.
 */
import type { ShellApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { downloadsApi, invoke, stateApi, subscribe, systemApi } from './bridge';

const api: ShellApi = {
  system: systemApi,
  state: stateApi,
  nav: { command: (action) => invoke('nav:command', { action }) },
  overlay: { open: (mode, anchor) => invoke('overlay:open', anchor ? { mode, anchor } : { mode }) },
  downloads: downloadsApi,
  layout: {
    anchor: (rect) => invoke('layout:anchor', rect),
    peek: (open) => invoke('layout:peek', { open }),
    lift: (lifted) => invoke('layout:lift', { lifted }),
    onSnapshot: (listener) => subscribe('frame:snapshot', listener),
    snapshot: (seq, phase) => invoke('layout:snapshot', { seq, phase }),
  },
  menu: {
    app: (anchor) => invoke('menu:app', anchor),
    tab: (nodeId, at) => invoke('menu:tab', { nodeId, x: at.x, y: at.y }),
    chord: (chordId, at) => invoke('menu:chord', { chordId, x: at.x, y: at.y }),
    favorite: (favoriteId, at) => invoke('menu:favorite', { favoriteId, x: at.x, y: at.y }),
  },
  sidebar: {
    moveToChord: (nodeId, chordId) => invoke('sidebar:moveToChord', { nodeId, chordId }),
    deleteFolder: (nodeId) => invoke('sidebar:deleteFolder', { nodeId }),
    onRename: (listener) => subscribe('sidebar:rename', listener),
  },
  chords: { onEdit: (listener) => subscribe('chord:edit', listener) },
  toasts: { onShow: (listener) => subscribe('toast:show', listener) },
  duet: { view: () => invoke('duet:view'), act: (action) => invoke('duet:do', action), onState: (listener) => subscribe('duet:state', listener) },
  gestures: { onPhase: (listener) => subscribe('gesture:phase', listener) },
  action: { run: (action) => invoke('action:run', { action }) },
  updates: { restart: () => invoke('update:restart') },
  extensions: {
    state: () => invoke('extensions:state'),
    onState: (listener) => subscribe('extensions:state', listener),
    activate: (id, anchor) => invoke('extension:activate', { id, anchor }),
    menu: (id, at) => invoke('extension:menu', { id, x: at.x, y: at.y }),
    install: (input) => invoke('extensions:install', { input }),
  },
  defaultBrowser: { status: () => invoke('settings:defaultBrowser'), make: () => invoke('settings:makeDefaultBrowser') },
  share: { stop: (nodeId) => invoke('share:stop', { nodeId }) },
  preview: { hover: (target) => invoke('preview:hover', target) },
  focus: { onRegion: (listener) => subscribe('focus:region', listener), move: (to) => invoke('focus:move', { to }) },
  perf: { shell: (milestone) => invoke('perf:shell', { milestone }) },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
