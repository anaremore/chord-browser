/**
 * Chord Player's releases (ARCHITECTURE.md §14.4, §9): GitHub releases of
 * this repository tagged `player-v<version>`, apart from Chord's own `v*`
 * tags. Each holds, per OS and architecture, the player as a zip and a JSON
 * manifest, and the manifest's Ed25519 signature (`<manifest>.sig`) made with
 * Chord's update-signing key. Chord trusts a manifest only when the signature
 * checks out, then the zip only when its SHA-512 matches the manifest's.
 *
 * Pure: the packaging script writes manifests with `manifestFor`, Chord reads
 * them with `parseManifest`.
 */

export const PLAYER_TAG_PREFIX = 'player-v';

/** What Chord Player is built for. Linux arm64 isn't: no Widevine CDM there that S14 could test. */
export const PLAYER_TARGETS = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64'] as const;
export type PlayerTarget = (typeof PLAYER_TARGETS)[number];

export function targetFor(platform: string, arch: string): PlayerTarget | null {
  const key = `${platform}-${arch}`;
  return (PLAYER_TARGETS as readonly string[]).includes(key) ? (key as PlayerTarget) : null;
}

export const manifestName = (target: PlayerTarget): string => `chord-player-${target}.json`;
export const archiveName = (version: string, target: PlayerTarget): string => `chord-player-${version}-${target}.zip`;

/** Where the player's executable is inside its folder, per OS. Chord's own knowledge, never the manifest's. */
export function executableIn(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'Chord Player.exe';
  if (platform === 'darwin') return 'Chord Player.app/Contents/MacOS/Chord Player';
  return 'chord-player';
}

export interface PlayerManifest {
  name: 'chord-player';
  version: string;
  /** The control channel's protocol version it speaks (messages.ts). */
  protocol: number;
  /** The castLabs ECS build it runs on. */
  ecs: string;
  target: PlayerTarget;
  /** The zip's file name in the same release. */
  file: string;
  /** The zip's size in bytes, and the folder's once unpacked. */
  size: number;
  unpackedSize: number;
  /** The zip's SHA-512, base64. */
  sha512: string;
  /** castLabs VMP signature: `production` (EVS-signed), `development` (ECS's own), or `none` (Linux). */
  vmp: 'production' | 'development' | 'none';
}

export function manifestFor(fields: Omit<PlayerManifest, 'name'>): string {
  const manifest: PlayerManifest = { name: 'chord-player', ...fields };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** SemVer precedence, below zero when `a` is older. Unparsable sorts first. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  const p = x[4]?.split('.') ?? [];
  const q = y[4]?.split('.') ?? [];
  if (!p.length || !q.length) return q.length - p.length;
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    const s = p[i];
    const t = q[i];
    if (s === undefined || t === undefined) return s === undefined ? -1 : 1;
    if (s === t) continue;
    const sn = /^\d+$/.test(s);
    const tn = /^\d+$/.test(t);
    if (sn && tn) return Number(s) - Number(t);
    if (sn !== tn) return sn ? -1 : 1;
    return s < t ? -1 : 1;
  }
  return 0;
}

/** Limits on what a manifest may claim: the zip is about 125–160 MB, about 300–400 MB unpacked. */
const MAX_SIZE = 1024 ** 3;
const MAX_UNPACKED = 2 * 1024 ** 3;

/**
 * A manifest's fields, checked: for this target, a plain file name, sizes
 * within reason, a 64-byte SHA-512, and (when given) the version of the
 * release it came from, so an older signed manifest can't stand in for a
 * newer release. Null when anything's off. Its signature is checked before.
 */
export function parseManifest(text: string, expected: { target: PlayerTarget; version?: string }): PlayerManifest | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  const { version, protocol, ecs, target, file, size, unpackedSize, sha512, vmp } = m;
  if (m['name'] !== 'chord-player') return null;
  if (typeof version !== 'string' || !SEMVER.test(version) || (expected.version !== undefined && version !== expected.version)) return null;
  if (!Number.isInteger(protocol) || (protocol as number) < 1) return null;
  if (typeof ecs !== 'string' || !/^\d+\.\d+\.\d+(-[\w.]+)?\+wvcus$/.test(ecs)) return null;
  if (target !== expected.target) return null;
  if (typeof file !== 'string' || file !== archiveName(version, expected.target)) return null;
  if (!Number.isInteger(size) || (size as number) < 1024 * 1024 || (size as number) > MAX_SIZE) return null;
  if (!Number.isInteger(unpackedSize) || (unpackedSize as number) < (size as number) / 4 || (unpackedSize as number) > MAX_UNPACKED) return null;
  if (typeof sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sha512)) return null;
  if (vmp !== 'production' && vmp !== 'development' && vmp !== 'none') return null;
  return { name: 'chord-player', version, protocol: protocol as number, ecs, target: expected.target, file, size: size as number, unpackedSize: unpackedSize as number, sha512, vmp };
}

export interface PlayerRelease {
  version: string;
  tag: string;
}

/**
 * The newest Chord Player release in a GitHub `/releases` reply: a published
 * `player-v<semver>` tag. Pre-releases count only for someone already
 * running one (`current`), as for Chord itself.
 */
export function pickPlayerRelease(reply: unknown, current?: string | null): PlayerRelease | null {
  if (!Array.isArray(reply)) return null;
  const runningPre = Boolean(current && SEMVER.exec(current)?.[4]);
  let best: PlayerRelease | null = null;
  for (const item of reply as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object' || item['draft'] === true) continue;
    const tag = item['tag_name'];
    if (typeof tag !== 'string' || !tag.startsWith(PLAYER_TAG_PREFIX)) continue;
    const version = tag.slice(PLAYER_TAG_PREFIX.length);
    const parsed = SEMVER.exec(version);
    if (!parsed || (parsed[4] && !runningPre)) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    best = { version, tag };
  }
  return best;
}
