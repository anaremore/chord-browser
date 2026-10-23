import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

type StoredPermissions = {
  permissions: chrome.runtime.ManifestPermissions[]
  explicitOrigins: string[]
  scriptableOrigins: string[]
  declaredPermissions: chrome.runtime.ManifestPermissions[]
  declaredExplicitOrigins: string[]
  declaredScriptableOrigins: string[]
}

const explicitOriginRegexp = /^(\*|http|https|file|ftp):\/\/([^/]*)(?:\/.*)?$/
const matchPatternRegexp = /^(\*|http|https|file|ftp):\/\/([^/]*)(\/.*)?$/

const unique = <T>(values: T[]) => [...new Set(values)]

const escapePattern = (pattern: string) => pattern.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')

const isOriginPermission = (permission: string) =>
  permission === '<all_urls>' || explicitOriginRegexp.test(permission)

const parseMatchPattern = (pattern: string) => {
  if (pattern === '<all_urls>') {
    return { allUrls: true as const }
  }

  const match = pattern.match(matchPatternRegexp)
  if (!match) return

  const [, scheme, host, path = '/'] = match
  return { scheme, host, path }
}

const normalizeExplicitOrigin = (pattern: string) => {
  const parsedPattern = parseMatchPattern(pattern)
  if (!parsedPattern) return
  if ('allUrls' in parsedPattern) return pattern

  return `${parsedPattern.scheme}://${parsedPattern.host}/*`
}

const schemeContains = (granted: string, requested: string) =>
  granted === requested || (granted === '*' && ['http', 'https'].includes(requested))

const hostContains = (granted: string, requested: string) => {
  if (granted === '*' || granted === requested) return true

  if (!granted.startsWith('*.')) return false

  const suffix = granted.slice(2)
  if (requested.startsWith('*.')) {
    const requestedSuffix = requested.slice(2)
    return requestedSuffix === suffix || requestedSuffix.endsWith(`.${suffix}`)
  }

  return requested === suffix || requested.endsWith(`.${suffix}`)
}

const stripTrailingWildcard = (path: string) => (path.endsWith('*') ? path.slice(0, -1) : path)

const matchesGlob = (pattern: string, test: string) => {
  const regexp = new RegExp(`^${pattern.split('*').map(escapePattern).join('.*')}$`)
  return regexp.test(test)
}

const pathContains = (granted: string, requested: string) => {
  const requestedPath = stripTrailingWildcard(requested)

  // Chromium treats `/foo/*` as covering `/foo` for URL pattern containment.
  if (
    granted.length === requestedPath.length + 2 &&
    granted.startsWith(requestedPath) &&
    granted.endsWith('/*')
  ) {
    return true
  }

  return matchesGlob(granted, requestedPath)
}

const explicitOriginContains = (granted: string, requested: string) => {
  if (granted === requested || granted === '<all_urls>') return true

  const grantedPattern = parseMatchPattern(granted)
  const requestedPattern = parseMatchPattern(requested)
  if (!grantedPattern || !requestedPattern) return false

  if ('allUrls' in grantedPattern) return true
  if ('allUrls' in requestedPattern) return false

  return (
    schemeContains(grantedPattern.scheme, requestedPattern.scheme) &&
    hostContains(grantedPattern.host, requestedPattern.host)
  )
}

const scriptableOriginContains = (granted: string, requested: string) => {
  if (granted === requested || granted === '<all_urls>') return true

  const grantedPattern = parseMatchPattern(granted)
  const requestedPattern = parseMatchPattern(requested)
  if (!grantedPattern || !requestedPattern) return false

  if ('allUrls' in grantedPattern) return true
  if ('allUrls' in requestedPattern) return false

  return (
    schemeContains(grantedPattern.scheme, requestedPattern.scheme) &&
    hostContains(grantedPattern.host, requestedPattern.host) &&
    pathContains(grantedPattern.path, requestedPattern.path)
  )
}

const getRequiredExplicitOrigins = (manifest: chrome.runtime.Manifest) => [
  ...(manifest.host_permissions || []),
  ...((manifest.permissions || []).filter(isOriginPermission) as string[]),
]

const getOptionalExplicitOrigins = (manifest: chrome.runtime.Manifest) => [
  ...(manifest.optional_host_permissions || []),
  ...((manifest.optional_permissions || []).filter(isOriginPermission) as string[]),
]

const normalizeOrigins = (origins: string[]) =>
  unique(origins.map((origin) => normalizeExplicitOrigin(origin)).filter(Boolean) as string[])

const filterPermissions = (permissions: string[]) =>
  permissions.filter(
    (permission): permission is chrome.runtime.ManifestPermissions =>
      !isOriginPermission(permission),
  )

const getManifestPermissions = (manifest: chrome.runtime.Manifest): StoredPermissions => {
  const requiredPermissions = manifest.permissions || []
  const optionalPermissions = manifest.optional_permissions || []
  const scriptableOrigins = unique(
    (manifest.content_scripts || []).flatMap((script) => script.matches || []),
  )

  return {
    permissions: filterPermissions(requiredPermissions),
    explicitOrigins: normalizeOrigins(getRequiredExplicitOrigins(manifest)),
    scriptableOrigins,
    declaredPermissions: unique([
      ...filterPermissions(requiredPermissions),
      ...filterPermissions(optionalPermissions),
    ]),
    declaredExplicitOrigins: normalizeOrigins([
      ...getRequiredExplicitOrigins(manifest),
      ...getOptionalExplicitOrigins(manifest),
    ]),
    declaredScriptableOrigins: scriptableOrigins,
  }
}

const getAllOrigins = (permissions: StoredPermissions) =>
  unique([...permissions.explicitOrigins, ...permissions.scriptableOrigins])

const hasOriginAccess = (permissions: StoredPermissions, origin: string) => {
  const requiresExplicitOrigin = permissions.declaredExplicitOrigins.some((declaredOrigin) =>
    explicitOriginContains(declaredOrigin, origin),
  )
  const requiresScriptableOrigin = permissions.declaredScriptableOrigins.some((declaredOrigin) =>
    scriptableOriginContains(declaredOrigin, origin),
  )

  if (!requiresExplicitOrigin && !requiresScriptableOrigin) {
    return false
  }

  const hasExplicitOrigin = !requiresExplicitOrigin
    ? true
    : permissions.explicitOrigins.some((grantedOrigin) =>
        explicitOriginContains(grantedOrigin, origin),
      )
  const hasScriptableOrigin = !requiresScriptableOrigin
    ? true
    : permissions.scriptableOrigins.some((grantedOrigin) =>
        scriptableOriginContains(grantedOrigin, origin),
      )

  return hasExplicitOrigin && hasScriptableOrigin
}

/**
 * This is a very basic implementation of the permissions API. Likely
 * more work will be needed to integrate with the native permissions.
 */
export class PermissionsAPI {
  private permissionMap = new Map</* extensionId */ string, StoredPermissions>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('permissions.contains', this.contains)
    handle('permissions.getAll', this.getAll)
    handle('permissions.remove', this.remove)
    handle('permissions.request', this.request)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.getAllExtensions().forEach((ext) => this.processExtension(ext))

    sessionExtensions.on('extension-loaded', (_event, extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.permissionMap.delete(extension.id)
    })
  }

  private processExtension(extension: Electron.Extension) {
    const manifest: chrome.runtime.Manifest = extension.manifest
    this.permissionMap.set(extension.id, getManifestPermissions(manifest))
  }

  private contains = (
    { extension }: ExtensionEvent,
    permissions: chrome.permissions.Permissions,
  ) => {
    const currentPermissions = this.permissionMap.get(extension.id)!
    const hasPermissions = permissions.permissions
      ? permissions.permissions.every((permission) =>
          currentPermissions.permissions.includes(permission),
        )
      : true
    const hasOrigins = permissions.origins
      ? permissions.origins.every((origin) => hasOriginAccess(currentPermissions, origin))
      : true
    return hasPermissions && hasOrigins
  }

  private getAll = ({ extension }: ExtensionEvent) => {
    const permissions = this.permissionMap.get(extension.id)!
    return {
      permissions: permissions.permissions,
      origins: getAllOrigins(permissions),
    }
  }

  private remove = ({ extension }: ExtensionEvent, permissions: chrome.permissions.Permissions) => {
    // TODO
    return true
  }

  private request = async (
    { extension }: ExtensionEvent,
    request: chrome.permissions.Permissions,
  ) => {
    const permissions = this.permissionMap.get(extension.id)!
    const declaredPermissions = new Set(permissions.declaredPermissions)

    if (request.permissions && !request.permissions.every((p) => declaredPermissions.has(p))) {
      throw new Error('Permissions request includes undeclared permission')
    }

    if (
      request.origins &&
      !request.origins.every((origin) =>
        permissions.declaredExplicitOrigins.some((declaredOrigin) =>
          explicitOriginContains(declaredOrigin, origin),
        ),
      )
    ) {
      throw new Error('Permissions request includes undeclared origin')
    }

    const granted = await this.ctx.store.requestPermissions(extension, request)
    if (!granted) return false

    if (request.origins) {
      for (const origin of request.origins) {
        const normalizedOrigin = normalizeExplicitOrigin(origin)
        if (
          normalizedOrigin &&
          !permissions.explicitOrigins.some((grantedOrigin) =>
            explicitOriginContains(grantedOrigin, normalizedOrigin),
          )
        ) {
          permissions.explicitOrigins.push(normalizedOrigin)
        }
      }
    }
    if (request.permissions) {
      for (const permission of request.permissions) {
        if (!permissions.permissions.includes(permission)) {
          permissions.permissions.push(permission)
        }
      }
    }
    return true
  }
}
