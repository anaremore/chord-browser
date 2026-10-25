/**
 * The shell's only door to main (ARCHITECTURE.md §8). Exposes a frozen,
 * typed `window.chord`; raw ipcRenderer never reaches the page.
 */
import type { ShellApi, SNAPSHOT_PORT_MESSAGE } from '@chord/ipc';
import { contextBridge, ipcRenderer } from 'electron';
import { downloadsApi, invoke, stateApi, subscribe, systemApi } from './bridge';

/** The value of `SNAPSHOT_PORT_MESSAGE`, without bundling @chord/ipc's runtime into the preload. */
const PORT_MESSAGE: typeof SNAPSHOT_PORT_MESSAGE = 'chord:frame-port';

/** The page this preload serves (preloads build without the DOM's types). */
const page = globalThis as unknown as { location: { origin: string }; postMessage(message: string, targetOrigin: string, transfer: unknown[]): void };

// The snapshot's own port (FrameSnapshot.tsx): handed straight to the page, so the pictures never pass through here.
ipcRenderer.on('frame:port', (event) => {
  if (event.ports[0]) page.postMessage(PORT_MESSAGE, page.location.origin, [event.ports[0]]);
});

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
    connectSnapshots: () => invoke('layout:snapshotPort'),
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
    onArchived: (listener) => subscribe('sidebar:archived', listener),
  },
  chords: { onEdit: (listener) => subscribe('chord:edit', listener) },
  toasts: { onShow: (listener) => subscribe('toast:show', listener) },
  duet: { view: () => invoke('duet:view'), act: (action) => invoke('duet:do', action), onState: (listener) => subscribe('duet:state', listener) },
  gestures: { onPhase: (listener) => subscribe('gesture:phase', listener) },
  action: { run: (action) => invoke('action:run', { action }) },
  updates: { restart: () => invoke('update:restart') },
  screenshots: { act: (id, action) => invoke('screenshots:do', { id, do: action }) },
  extensions: {
    state: () => invoke('extensions:state'),
    onState: (listener) => subscribe('extensions:state', listener),
    activate: (id, anchor) => invoke('extension:activate', { id, anchor }),
    menu: (id, at) => invoke('extension:menu', { id, x: at.x, y: at.y }),
    install: (input) => invoke('extensions:install', { input }),
  },
  defaultBrowser: { status: () => invoke('settings:defaultBrowser'), make: () => invoke('settings:makeDefaultBrowser') },
  share: { stop: (nodeId) => invoke('share:stop', { nodeId }) },
  media: {
    view: () => invoke('media:view'),
    onState: (listener) => subscribe('media:state', listener),
    act: (nodeId, action) => invoke('media:do', { nodeId, action }),
  },
  preview: { hover: (target) => invoke('preview:hover', target) },
  focus: { onRegion: (listener) => subscribe('focus:region', listener), move: (to) => invoke('focus:move', { to }) },
  perf: { shell: (milestone) => invoke('perf:shell', { milestone }) },
  safeBrowsing: {
    status: () => invoke('safeBrowsing:status'),
    choose: (on) => invoke('safeBrowsing:choose', { on }),
    back: (nodeId) => invoke('safeBrowsing:back', { nodeId }),
    proceed: (nodeId) => invoke('safeBrowsing:proceed', { nodeId }),
  },
  imports: {
    sources: () => invoke('import:sources'),
    preview: (key) => invoke('import:preview', { key }),
    run: (key, choices) => invoke('import:run', { key, choices }),
    // The same Undo as the import's toast.
    undo: (importId) => invoke('cmd:dispatch', { t: 'import.undo', importId }),
    openAccess: () => invoke('import:openAccess'),
    onProgress: (listener) => subscribe('import:progress', listener),
  },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
