/** Shared by every preload: typed invoke and subscribe over the IPC contract. */
import type { EventChannel, EventPayload, InvokeChannel, InvokeRequest, InvokeResponse } from '@chord/ipc';
import { ipcRenderer, type IpcRendererEvent } from 'electron';

export function invoke<C extends InvokeChannel>(channel: C, request?: InvokeRequest<C>): Promise<InvokeResponse<C>> {
  return ipcRenderer.invoke(channel, request) as Promise<InvokeResponse<C>>;
}

export function subscribe<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: EventPayload<C>) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

export const systemApi = {
  info: () => invoke('system:info'),
  onChange: (listener: (info: EventPayload<'system:changed'>) => void) => subscribe('system:changed', listener),
};

export const downloadsApi = {
  run: (id: string, action: InvokeRequest<'download:action'>['action']) => invoke('download:action', { id, action }),
  openFolder: () => invoke('downloads:openFolder'),
};

export const stateApi = {
  snapshot: () => invoke('state:snapshot'),
  onPatch: (listener: (event: EventPayload<'state:patch'>) => void) => subscribe('state:patch', listener),
  dispatch: (command: InvokeRequest<'cmd:dispatch'>) => invoke('cmd:dispatch', command),
};
