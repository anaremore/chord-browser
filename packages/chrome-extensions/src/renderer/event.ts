import { ipcRenderer } from 'electron'

const formatIpcName = (name: string) => `crx-${name}`

const listenerMap = new Map<string, Map<Function, (...args: any[]) => void>>()

export const addExtensionListener = (extensionId: string, name: string, callback: Function) => {
  let listeners = listenerMap.get(name)
  if (!listeners) {
    listeners = new Map()
    listenerMap.set(name, listeners)
  }

  if (listeners.has(callback)) {
    return
  }

  if (listeners.size === 0) {
    // TODO: should these IPCs be batched in a microtask?
    ipcRenderer.send('crx-add-listener', extensionId, name)
  }

  const wrappedCallback = function (_event: Electron.IpcRendererEvent, ...args: any[]) {
    if (process.env.NODE_ENV === 'development') {
      console.log(name, '(result)', ...args)
    }
    callback(...args)
  }

  listeners.set(callback, wrappedCallback)
  ipcRenderer.addListener(formatIpcName(name), wrappedCallback)
}

export const removeExtensionListener = (extensionId: string, name: string, callback: any) => {
  const listeners = listenerMap.get(name)
  if (!listeners) {
    return
  }

  const wrappedCallback = listeners.get(callback)
  if (!wrappedCallback) {
    return
  }

  ipcRenderer.removeListener(formatIpcName(name), wrappedCallback)
  listeners.delete(callback)

  if (listeners.size === 0) {
    listenerMap.delete(name)
    ipcRenderer.send('crx-remove-listener', extensionId, name)
  }
}
