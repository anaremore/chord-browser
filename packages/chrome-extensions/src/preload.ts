// Modified by Chord contributors, 2026-10-22: no debug logging into web pages' consoles, and no printIsolatedWorlds debug global. See CHORD-CHANGES.md in this package.
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
  for (const worldId of webFrame.getIsolatedWorlds()) {
    injectIntoExtensionIsolatedWorld(worldId)
  }

  // Inject into new isolated worlds as they are created (before the script is executed)
  // @ts-ignore - APIs may not be available yet
  webFrame.on('isolated-world-created', (worldId) => {
    injectIntoExtensionIsolatedWorld(worldId)
  })
}
