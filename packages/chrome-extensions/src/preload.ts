import { webFrame } from 'electron'
import { injectExtensionAPIs } from './renderer'

let injectInMainWorld = false

// Only load within extension page context
if (process.type === 'service-worker' || location.href.startsWith('chrome-extension://')) {
  injectInMainWorld = true
}

// Create injector function & inject into main world if needed
const injectInIsolatedWorld = injectExtensionAPIs(injectInMainWorld)

// Scan for extensions isolated worlds and inject into them
// Requires Electron 41+ (TBD)
if (injectInIsolatedWorld && webFrame && 'getIsolatedWorlds' in webFrame) {
  const injectIntoExtensionIsolatedWorld = (worldId: number) => {
    const EXTENSION_WORLD_START = 1 << 20
    const EXTENSION_WORLD_END = 1 << 29
    if (worldId < EXTENSION_WORLD_START || worldId >= EXTENSION_WORLD_END) {
      return
    }
    injectInIsolatedWorld(worldId)
  }

  // @ts-ignore - APIs may not be available yet
  console.log('isolated worlds', webFrame.getIsolatedWorlds())
  // @ts-ignore - APIs may not be available yet
  for (const worldId of webFrame.getIsolatedWorlds()) {
    console.log('injecting into isolated world (initial scan)', worldId)
    injectIntoExtensionIsolatedWorld(worldId)
  }

  // Inject into new isolated worlds as they are created (before the script is executed)
  // @ts-ignore - APIs may not be available yet
  webFrame.on('isolated-world-created', (worldId) => {
    console.log('injecting into isolated world (new world created)', worldId)
    injectIntoExtensionIsolatedWorld(worldId)
  })
}

// This is for debugging purposes only (TODO: remove)
// @ts-expect-error globalThis is not typed
globalThis.printIsolatedWorlds = () => {
  // @ts-ignore - APIs may not be available yet
  const worldIds = webFrame.getIsolatedWorlds()
  console.log('isolated worlds', worldIds)
  for (const worldId of worldIds) {
    const extensionIdPromise = webFrame
      .executeJavaScriptInIsolatedWorld(worldId, [{ code: 'chrome?.runtime?.id' }])
      .then((result) => result)
      .catch(() => null)

    extensionIdPromise.then((id: string | null | undefined) => {
      if (id) {
        console.log('extension id in world', worldId, id)
      } else {
        console.log('no extension id in world', worldId)
      }
    })
  }
}
