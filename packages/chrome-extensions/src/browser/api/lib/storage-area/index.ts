import { EventEmitter } from 'events'
import type { ExtensionEvent, ExtensionRouter } from '../../../router'

// Task types
interface ClearStorageAdapterTask {
  type: 'clear'
}
interface GetStorageAdapterTask {
  type: 'get'
  // If undefined, all keys are returned
  keys: string[] | undefined
}
interface RemoveStorageAdapterTask {
  type: 'remove'
  keys: string[]
}
interface SetStorageAdapterTask {
  type: 'set'
  items: Record<string, any>
}
type StorageAdapterTask =
  | ClearStorageAdapterTask
  | GetStorageAdapterTask
  | RemoveStorageAdapterTask
  | SetStorageAdapterTask

// Task result types
interface StorageAdapterTaskResult {
  // Returns the key-pairs that were cleared
  clear: Record<string, any>
  // Returns the selected key-pairs
  get: Record<string, any>
  // Returns the key and old values of the removed key-pairs
  remove: Record<string, any>
  // Returns the key and old values of the set key-pairs
  set: Record<string, any>
}

// Storage adapter type
export type StorageAdapter = <T extends StorageAdapterTask>(
  task: T,
) => Promise<StorageAdapterTaskResult[T['type']]>

// Bytes calculator
export type StorageItems = Record<string, any>
type StorageChanges = Record<string, chrome.storage.StorageChange>

const scheduleStorageTask =
  typeof setImmediate === 'function'
    ? (callback: () => void) => setImmediate(callback)
    : (callback: () => void) => setTimeout(callback, 0)

const calculateBytesInUse = (items: StorageItems) => {
  return Object.keys(items).reduce((acc, key) => {
    return acc + key.length + JSON.stringify(items[key]).length
  }, 0)
}

// Storage area class
export class StorageArea extends EventEmitter {
  private adapter: StorageAdapter
  private queuedChanges: StorageChanges[] = []
  private flushQueuedChangesScheduled = false

  constructor(adapter: StorageAdapter) {
    super()
    this.adapter = adapter
  }

  private flushQueuedChanges = () => {
    this.flushQueuedChangesScheduled = false
    const queuedChanges = this.queuedChanges
    this.queuedChanges = []

    for (const changes of queuedChanges) {
      this.emit('onChanged', changes)
    }
  }

  private enqueueChanges(changes: StorageChanges) {
    if (Object.keys(changes).length === 0) {
      return
    }

    this.queuedChanges.push(changes)

    if (this.flushQueuedChangesScheduled) {
      return
    }

    this.flushQueuedChangesScheduled = true
    scheduleStorageTask(this.flushQueuedChanges)
  }

  public async clear() {
    const result = await this.adapter({ type: 'clear' })
    const changes: StorageChanges = {}
    for (const [key, value] of Object.entries(result)) {
      changes[key] = { oldValue: value }
    }
    this.enqueueChanges(changes)
  }

  public async get(keys?: string | string[] | Record<string, any> | null) {
    // Convert the keys to an array of strings
    const targetKeys = []
    if (typeof keys === 'string') {
      targetKeys.push(keys)
    } else if (Array.isArray(keys)) {
      if (keys.length === 0) {
        return {}
      }
      targetKeys.push(...keys)
    } else if (keys && typeof keys === 'object') {
      if (Object.keys(keys).length === 0) {
        return {}
      }
      targetKeys.push(...Object.keys(keys))
    }

    if (targetKeys.length === 0) {
      return await this.adapter({ type: 'get', keys: undefined })
    }

    // Get the values from the adapter
    const result = await this.adapter({ type: 'get', keys: targetKeys })
    if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
      return { ...keys, ...result }
    }
    return result
  }

  // Gets an estimate of the bytes being used by the storage area
  public async getBytesInUse(keys?: string | string[] | null) {
    const data = await this.get(keys)
    return calculateBytesInUse(data)
  }

  public async getKeys() {
    const data = await this.get()
    return Object.keys(data)
  }

  public async remove(keys: string | string[]) {
    const targetKeys = []
    if (typeof keys === 'string') {
      targetKeys.push(keys)
    } else if (Array.isArray(keys)) {
      targetKeys.push(...keys)
    }

    if (targetKeys.length === 0) {
      return
    }

    const result = await this.adapter({ type: 'remove', keys: targetKeys })

    const changes: StorageChanges = {}
    for (const [key, value] of Object.entries(result)) {
      changes[key] = { oldValue: value }
    }
    this.enqueueChanges(changes)
  }

  public async set(items: Record<string, any>) {
    const result = await this.adapter({ type: 'set', items })

    const changes: StorageChanges = {}
    for (const [key, value] of Object.entries(result)) {
      changes[key] = { newValue: items[key], ...(value !== undefined && { oldValue: value }) }
    }
    this.enqueueChanges(changes)
  }

  public async setAccessLevel(_accessOptions: { accessLevel: chrome.storage.AccessLevel }) {
    // No-op
  }
}

export function registerStorageAreaHandlers(
  areaName: string,
  router: ExtensionRouter,
  getArea: (event: ExtensionEvent) => StorageArea,
) {
  const handle = router.apiHandler()
  const eventName = `storage.${areaName}.onChanged`
  const wiredAreas = new WeakMap<StorageArea, string>()

  const resolveArea = (event: ExtensionEvent) => {
    const area = getArea(event)
    const targetExtensionId = event.extension.id
    const wiredTargetExtensionId = wiredAreas.get(area)

    if (!wiredTargetExtensionId) {
      area.on('onChanged', (changes: StorageChanges) => {
        router.sendEvent(targetExtensionId, eventName, changes)
      })
      wiredAreas.set(area, targetExtensionId)
    } else if (wiredTargetExtensionId !== targetExtensionId) {
      throw new Error(
        `Storage area '${areaName}' cannot be shared between extensions: ` +
          `${wiredTargetExtensionId} !== ${targetExtensionId}`,
      )
    }
    return area
  }

  const storagePermission = { permission: 'storage' } as const
  handle(`storage.${areaName}.clear`, (event) => resolveArea(event).clear(), storagePermission)
  handle(
    `storage.${areaName}.get`,
    (event, keys) => resolveArea(event).get(keys),
    storagePermission,
  )
  handle(
    `storage.${areaName}.getBytesInUse`,
    (event, keys) => resolveArea(event).getBytesInUse(keys),
    storagePermission,
  )
  handle(`storage.${areaName}.getKeys`, (event) => resolveArea(event).getKeys(), storagePermission)
  handle(`storage.${areaName}.remove`, (event, keys) => resolveArea(event).remove(keys))
  handle(
    `storage.${areaName}.set`,
    (event, items) => resolveArea(event).set(items),
    storagePermission,
  )
  handle(
    `storage.${areaName}.setAccessLevel`,
    (event, accessOptions) => resolveArea(event).setAccessLevel(accessOptions),
    storagePermission,
  )
}
