/**
 * The shell's only door to main (ARCHITECTURE.md §8). Exposes a frozen,
 * typed `window.chord`; raw ipcRenderer never reaches the page.
 */
import type { EventChannel, EventPayload, InvokeChannel, InvokeRequest, InvokeResponse, ShellApi } from '@chord/ipc';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

function invoke<C extends InvokeChannel>(channel: C, request?: InvokeRequest<C>): Promise<InvokeResponse<C>> {
  return ipcRenderer.invoke(channel, request) as Promise<InvokeResponse<C>>;
}

function subscribe<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: EventPayload<C>) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api: ShellApi = {
  system: {
    info: () => invoke('system:info'),
    onChange: (listener) => subscribe('system:changed', listener),
  },
  tab: {
    current: () => invoke('tab:current'),
    onState: (listener) => subscribe('tab:state', listener),
  },
  nav: {
    command: (action) => invoke('nav:command', { action }),
  },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
