import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { registerStorageAreaHandlers } from './lib/storage-area'
import { SessionStorageArea } from './lib/storage-area/session'

/**
 * Main-process implementation of chrome.storage.session and chrome.storage.local.
 *
 * Both storage areas are backed by the main process so that:
 * - Data is shared between all extension contexts (background, content scripts, popup)
 * - onChanged events are reliably broadcast to all contexts including MV3 service workers
 *
 * chrome.storage.session: in-memory, cleared when the extension is unloaded or the browser quits
 * chrome.storage.local: persisted to disk as JSON, survives browser restarts
 */
export class StorageAPI {
  private sessionAreas = new Map<string, SessionStorageArea>()

  constructor(private ctx: ExtensionContext) {
    registerStorageAreaHandlers('session', this.ctx.router, this.getSessionArea)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      const sessionArea = this.sessionAreas.get(extension.id)
      if (sessionArea) {
        sessionArea.resetCache()
        this.sessionAreas.delete(extension.id)
      }
    })
  }

  private getSessionArea = ({ extension }: ExtensionEvent) => {
    let area = this.sessionAreas.get(extension.id)
    if (!area) {
      area = new SessionStorageArea()
      this.sessionAreas.set(extension.id, area)
    }
    return area
  }
}
