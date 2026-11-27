/**
 * The header's proxy sign (#331; the owner's yes to Carbon's SF4, 2026-11-26): while a chord's proxy is failing (its
 * own, or the one for every chord), the proxy icon in its header is a warning button that opens that proxy's settings,
 * as the toast's Settings does. Gone once it works.
 */
import type { ProxyFailingChord } from '@chord/ipc';

/** The sign for this chord: its button's name and what it opens (a chord's own, or null: the one for every chord). */
export function proxySign(failing: readonly ProxyFailingChord[], chord: { id: string; name: string }): { label: string; target: string | null } | null {
  const f = failing.find((x) => x.chordId === chord.id);
  if (!f) return null;
  return { label: `${chord.name}’s proxy isn’t working, Proxy settings`, target: f.own ? chord.id : null };
}
