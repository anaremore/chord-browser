/**
 * Settings → Privacy → Proxy's rows for a proxy that can't be set (#325; the owner's pick, 2026-11-26): its pages wait,
 * never going direct, and Chord keeps trying. A chord's own proxy is named by its chord; the one for every chord, once.
 */
import type { ProxyStatus } from '@chord/ipc';

export interface ProxyFailingRow {
  /** What Try again tries: a profile's, or null (every failing one, for the proxy for every chord). */
  owner: string | null;
  /** For a chord's own proxy: the chord it sits under. */
  chordId: string | null;
  label: string;
  description: string;
}

/** Chromium's words for why, as a sentence. */
const why = (reason: string) => (reason ? ` Chromium said ${reason.replace(/\.$/, '')}.` : '');

/** The proxy for every chord's row (null while it's in place), and each chord's own, by chord. */
export function proxyFailingRows(status: ProxyStatus | null, chords: readonly { id: string; name: string }[]): { all: ProxyFailingRow | null; own: Map<string, ProxyFailingRow> } {
  const own = new Map<string, ProxyFailingRow>();
  let all: ProxyFailingRow | null = null;
  for (const f of status?.failing ?? []) {
    if (!f.own) {
      all = { owner: null, chordId: null, label: 'Can’t use this proxy.', description: `Pages wait until Chord can, and Chord keeps trying.${why(f.reason)}` };
      continue;
    }
    for (const chordId of f.chordIds) {
      const chord = chords.find((c) => c.id === chordId);
      if (!chord) continue;
      own.set(chordId, { owner: f.owner, chordId, label: `Can’t use ${chord.name}’s proxy.`, description: `Its pages wait until Chord can, and Chord keeps trying.${why(f.reason)}` });
    }
  }
  return { all, own };
}
