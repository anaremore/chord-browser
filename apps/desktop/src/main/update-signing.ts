/**
 * Signed update manifests (ARCHITECTURE.md §14.4). electron-builder writes a
 * manifest per installer (`latest*.yml`: the version, file names and sha512
 * hashes); the release workflow signs each one with Ed25519 and uploads the
 * signature beside it as `<manifest>.sig`. Chord trusts a manifest only when
 * that signature checks out against the public key it ships with. Then
 * electron-updater checks the downloaded installer against the manifest's
 * sha512, so the installer is covered too.
 *
 * Pure (no Electron), so it's unit-tested.
 */
import { createPublicKey, verify } from 'node:crypto';

/** Where a release's files are downloaded from. */
export const RELEASE_DOWNLOADS = 'https://github.com/anaremore/chord-browser/releases/download/';

/**
 * The manifest for this build, or null where Chord can't install updates
 * itself: macOS (no Mac updater yet, docs/releasing/signing.md) and anything else.
 * Linux names are electron-builder's own; Windows builds of each architecture
 * are made on their own runners, so the release workflow renames their
 * `latest.yml` to keep them apart.
 */
export function manifestFor(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) return `latest-win-${arch}.yml`;
  if (platform === 'linux' && arch === 'x64') return 'latest-linux.yml';
  if (platform === 'linux' && arch === 'arm64') return 'latest-linux-arm64.yml';
  return null;
}

export const signatureFile = (manifest: string): string => `${manifest}.sig`;

/** A release's download folder, for its tag. */
export function downloadsFor(tag: string, base = RELEASE_DOWNLOADS): string {
  return `${base.replace(/\/?$/, '/')}${encodeURIComponent(tag)}/`;
}

/**
 * Whether `signature` (base64, as the release workflow writes it) is a valid
 * Ed25519 signature of exactly these manifest bytes by `publicKeyPem`.
 * Anything malformed, including an empty key, is simply not valid.
 */
export function verifyManifest(manifest: Uint8Array | string, signature: string, publicKeyPem: string): boolean {
  if (!publicKeyPem.trim() || !signature.trim()) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const bytes = typeof manifest === 'string' ? Buffer.from(manifest, 'utf8') : Buffer.from(manifest);
    return verify(null, bytes, key, Buffer.from(signature.trim(), 'base64'));
  } catch {
    return false;
  }
}
