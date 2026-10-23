/** The hover preview's door to main: it only draws the card it's sent and reports its size (ARCHITECTURE.md §8). */
import type { PreviewApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { invoke, subscribe, systemApi } from './bridge';

const api: PreviewApi = {
  system: systemApi,
  preview: {
    onCard: (listener) => subscribe('preview:card', listener),
    size: (width, height) => invoke('preview:size', { width, height }),
  },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
