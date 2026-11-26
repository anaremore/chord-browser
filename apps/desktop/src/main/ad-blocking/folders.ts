/**
 * Each profile's ad-blocking folder (`<userData>/Ad Blocking/Extension/<name>`), its own (#283). A profile id that's
 * already a safe, one-to-one folder name (lowercase letters, digits and `-`, as Chord's own ids are: uuidv7 and
 * `default`) names it, so profiles Chord made keep the folder they had. Any other id (one that differs from another
 * only in case, which Windows' and macOS' file systems ignore; one with characters a file name can't hold, which
 * would all become one; a Windows reserved name; an empty one, as sync and import can bring) is named by its hash:
 * `_` and 20 hex digits, which no kept name holds. Its blocking is applied again once there, in a folder of its own.
 */
import { createHash } from 'node:crypto';

/** Names Windows reserves for devices, whatever follows them (a folder `con` can't be made). */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export function folderName(profileId: string): string {
  if (/^[a-z0-9-]{1,64}$/.test(profileId) && !RESERVED.test(profileId)) return profileId;
  return `_${createHash('sha256').update(profileId, 'utf8').digest('hex').slice(0, 20)}`;
}

/**
 * Whether a folder found in `Extension` is a profile's in use (`inUse`, its folder names): kept by `forgetProfiles`,
 * never removed under it. Where the file system ignores case (Windows, macOS), a folder from before #283 named in
 * another case (`Work`) is the same folder as a kept name (`work`), so it's compared without case there.
 */
export function stays(folder: string, inUse: ReadonlySet<string>, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'linux') return inUse.has(folder);
  const lower = folder.toLowerCase();
  for (const name of inUse) if (name.toLowerCase() === lower) return true;
  return false;
}
