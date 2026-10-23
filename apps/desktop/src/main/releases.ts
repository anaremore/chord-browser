/**
 * Which GitHub release, if any, is newer than the running Chord (ARCHITECTURE.md
 * §14.4, the notify-only update check). Pure, so it's unit-tested; updates.ts
 * does the asking.
 *
 * Versions compare by SemVer 2.0 precedence. Drafts never count. A SemVer
 * pre-release (`0.3.0-beta.1`) only counts for someone already running one.
 * GitHub's own "pre-release" flag is ignored: early previews carry it, and
 * their users should still hear about the next one.
 */

/** Where release pages live; anything else in a reply is ignored, since the toast opens it. */
export const RELEASES_PAGE = 'https://github.com/anaremore/chord-browser/releases/';

export interface Release {
  version: string;
  name: string;
  url: string;
}

interface Version {
  core: [number, number, number];
  pre: string[];
}

export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

/** SemVer precedence: below zero when `a` is older than `b`. Unparsable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  // A pre-release comes before its release.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The newest release in a GitHub `/releases` reply that's newer than `current`, or null. */
export function newerRelease(reply: unknown, current: string): Release | null {
  if (!Array.isArray(reply)) return null;
  const mine = parseVersion(current);
  const runningPreRelease = (mine?.pre.length ?? 0) > 0;
  let best: Release | null = null;
  for (const item of reply as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object' || item['draft'] === true) continue;
    const tag = item['tag_name'];
    const url = item['html_url'];
    if (typeof tag !== 'string' || typeof url !== 'string' || !url.startsWith(RELEASES_PAGE)) continue;
    const version = parseVersion(tag);
    if (!version || (version.pre.length > 0 && !runningPreRelease)) continue;
    const plain = tag.trim().replace(/^v/, '');
    if (compareVersions(plain, current) <= 0) continue;
    if (best && compareVersions(plain, best.version) <= 0) continue;
    const name = typeof item['name'] === 'string' && item['name'].trim() ? item['name'].trim() : `Chord ${plain}`;
    best = { version: plain, name, url };
  }
  return best;
}
