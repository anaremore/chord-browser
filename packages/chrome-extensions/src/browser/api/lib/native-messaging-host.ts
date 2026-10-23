// Modified by Chord contributors, 2026-10-22: byte-length framing and reassembly of split or joined messages (native-messaging-frames.ts). See CHORD-CHANGES.md in this package.
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import debug from 'debug'
import { ExtensionSender, IpcEvent } from '../../router'
import { readRegistryKey } from './winreg'
import { encodeNativeMessage, NativeMessageReader } from './native-messaging-frames'

const d = debug('electron-chrome-extensions:nativeMessaging')

interface NativeConfig {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

function isValidConfig(config: any): config is NativeConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    typeof config.name === 'string' &&
    typeof config.description === 'string' &&
    typeof config.path === 'string' &&
    config.type === 'stdio' &&
    Array.isArray(config.allowed_origins)
  )
}

async function getConfigSearchPaths(application: string) {
  const appJson = `${application}.json`
  let searchPaths: string[]
  switch (process.platform) {
    case 'darwin':
      searchPaths = [
        path.join('/Library/Google/Chrome/NativeMessagingHosts', appJson),
        // Also look under Chrome's directory since some apps only install their
        // config there
        path.join(
          os.homedir(),
          'Library',
          'Application Support',
          'Google/Chrome/NativeMessagingHosts',
          appJson,
        ),
        path.join(app.getPath('userData'), 'NativeMessagingHosts', appJson),
      ]
      break
    case 'linux':
      searchPaths = [
        path.join('/etc/opt/chrome/native-messaging-hosts/', appJson),
        path.join(os.homedir(), '.config/google-chrome/NativeMessagingHosts/', appJson),
        path.join(app.getPath('userData'), 'NativeMessagingHosts', appJson),
      ]
      break
    case 'win32': {
      searchPaths = (
        await Promise.allSettled([
          readRegistryKey('HKLM', `Software\\Google\\Chrome\\NativeMessagingHosts\\${application}`),
          readRegistryKey('HKCU', `Software\\Google\\Chrome\\NativeMessagingHosts\\${application}`),
        ])
      )
        .map((result) => (result.status === 'fulfilled' ? result.value : undefined))
        .filter(Boolean) as string[]
      break
    }
    default:
      throw new Error('Unsupported platform')
  }
  return searchPaths
}

async function readNativeMessagingHostConfig(
  application: string,
): Promise<NativeConfig | undefined> {
  const searchPaths = await getConfigSearchPaths(application)
  d('searching', searchPaths)
  for (const filePath of searchPaths) {
    try {
      const data = await fs.readFile(filePath)
      const config = JSON.parse(data.toString())
      if (isValidConfig(config)) {
        d('read config in %s', filePath, config)
        return config
      } else {
        d('%s contained invalid config', filePath, config)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        d('unable to read %s', filePath)
      } else {
        d('unknown error', error)
      }
      continue
    }
  }
}
export class NativeMessagingHost {
  private process?: ReturnType<typeof spawn>
  private sender?: ExtensionSender
  private connectionId: string
  private connected: boolean = false
  private pending?: any[]
  private keepAlive: boolean
  private resolveResponse?: (message: any) => void
  private reader = new NativeMessageReader()

  ready?: Promise<void>

  constructor(
    extensionId: string,
    sender: ExtensionSender,
    connectionId: string,
    application: string,
    keepAlive: boolean = true,
  ) {
    this.keepAlive = keepAlive
    this.sender = sender
    if (keepAlive) {
      this.sender.ipc.on(`crx-native-msg-${connectionId}`, this.receiveExtensionMessage)
    }
    this.connectionId = connectionId
    this.ready = this.launch(application, extensionId)
  }

  destroy() {
    this.connected = false
    if (this.process) {
      this.process.kill()
      this.process = undefined
    }
    if (this.keepAlive && this.sender) {
      this.sender.ipc.off(`crx-native-msg-${this.connectionId}`, this.receiveExtensionMessage)
      this.sender.send(`crx-native-msg-${this.connectionId}-disconnect`)
    }
    this.sender = undefined
  }

  private async launch(application: string, extensionId: string) {
    const config = await readNativeMessagingHostConfig(application)
    if (!config) {
      d('launch: unable to find %s for %s', application, extensionId)
      this.destroy()
      return
    }

    const extensionUrl = `chrome-extension://${extensionId}/`
    if (!config.allowed_origins?.includes(extensionUrl)) {
      d('launch: %s not in allowed origins', extensionId)
      this.destroy()
      return
    }

    let isFile = false
    try {
      const stat = await fs.stat(config.path)
      isFile = stat.isFile()
    } catch (error) {
      d('launch: unable to find %s', config.path, error)
    }

    if (!isFile) {
      this.destroy()
      return
    }

    d('launch: spawning %s for %s', config.path, extensionId)
    this.process = spawn(config.path, [extensionUrl], {
      shell: false,
    })

    this.process.stdout!.on('data', this.receive)
    this.process.stderr!.on('data', (data) => {
      d('stderr: %s', data.toString())
    })
    this.process.on('error', (err) => {
      d('error: %s', err)
      this.destroy()
    })
    this.process.on('exit', (code) => {
      d('exited %d', code)
      this.destroy()
    })

    this.connected = true

    if (this.pending && this.pending.length > 0) {
      d('sending %d pending messages', this.pending.length)
      this.pending.forEach((msg) => this.send(msg))
      this.pending = []
    }
  }

  private receiveExtensionMessage = (_event: IpcEvent, message: any) => {
    this.send(message)
  }

  private send(json: any) {
    d('send', json)

    if (!this.connected) {
      const pending = this.pending || (this.pending = [])
      pending.push(json)
      d('send: pending')
      return
    }

    // Chord: the length is in bytes, not characters.
    this.process!.stdin!.write(encodeNativeMessage(json))
  }

  // Chord: stdout chunks don't line up with messages; a reader reassembles them.
  private receive = (data: Buffer) => {
    let messages: unknown[]
    try {
      messages = this.reader.push(data)
    } catch (error) {
      d('receive: bad message, disconnecting: %s', error)
      this.destroy()
      return
    }
    for (const message of messages) {
      d('receive: %s', message)
      if (this.keepAlive && this.sender) {
        this.sender.send(`crx-native-msg-${this.connectionId}`, message)
      } else {
        this.resolveResponse?.(message)
      }
    }
  }

  sendAndReceive(message: any) {
    this.send(message)
    return new Promise((resolve) => {
      this.resolveResponse = resolve
    })
  }
}
