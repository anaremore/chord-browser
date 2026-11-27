/**
 * Settings → Privacy → Proxy's rows for a proxy that can't be set (#325; the owner's pick, 2026-11-26): its pages wait,
 * never going direct, and Chord keeps trying. A chord's own proxy is named by its chord; the one for every chord, once.
 * And what a screen reader hears about them (Carbon's B2 on #331), by each row's key.
 */
import { proxied, type ProxySettings } from '@chord/core';
import type { ProxyStatus } from '@chord/ipc';

export interface ProxyFailingRow {
  /** 'all' for the proxy for every chord, else the chord's id: what the status region keys on. */
  key: string;
  /** What Try again tries: a profile's, or null (every failing one, for the proxy for every chord). */
  owner: string | null;
  /** For a chord's own proxy: the chord it sits under. */
  chordId: string | null;
  label: string;
  description: string;
}

/**
 * The rest of the sentence after "Pages wait until Chord can": an address or file Chromium won't take is the one case
 * where trying again won't help on its own (Carbon's SF5). The code shows only when it's one of Chromium's ERR_ codes.
 */
function waitText(reason: string): string {
  const code = /\bERR_[A-Z0-9_]+\b/.exec(reason)?.[0];
  if (code === 'ERR_INVALID_ARGUMENT') return `. Check the proxy’s address or its configuration file (${code}).`;
  return `, and Chord keeps trying${code ? ` (${code})` : ''}.`;
}

/** The proxy for every chord's row (null while it's in place), and each chord's own, by chord. */
export function proxyFailingRows(status: ProxyStatus | null, chords: readonly { id: string; name: string }[]): { all: ProxyFailingRow | null; own: Map<string, ProxyFailingRow> } {
  const own = new Map<string, ProxyFailingRow>();
  let all: ProxyFailingRow | null = null;
  for (const f of status?.failing ?? []) {
    if (!f.own) {
      all = { key: 'all', owner: null, chordId: null, label: 'Can’t use this proxy.', description: `Pages wait until Chord can${waitText(f.reason)}` };
      continue;
    }
    for (const chordId of f.chordIds) {
      const chord = chords.find((c) => c.id === chordId);
      if (!chord) continue;
      own.set(chordId, { key: chordId, owner: f.owner, chordId, label: `Can’t use ${chord.name}’s proxy.`, description: `Its pages wait until Chord can${waitText(f.reason)}` });
    }
  }
  return { all, own };
}

/** A row as the status region last saw it. */
export interface RowSeen {
  label: string;
  trying: boolean;
}

/**
 * What the status region says going from `before` to `after` (rows by key): a row that shows, its label, once; a try
 * that starts, '' (so the same words after it are said again); a try that ends still failing, "Still can't use …"; a
 * row gone, "… works again", only while that key still uses a proxy (turning it off isn't the proxy working). A label
 * that changes on its own (a rename) says nothing. null: leave what's there.
 */
export function proxyAnnouncement(
  before: ReadonlyMap<string, RowSeen>,
  after: ReadonlyMap<string, RowSeen>,
  stillUses: (key: string) => boolean,
  names: Readonly<Record<string, string>> = {},
): string | null {
  const said: string[] = [];
  let cleared = false;
  for (const [key, row] of after) {
    const was = before.get(key);
    if (!was) said.push(row.label);
    else if (!was.trying && row.trying) cleared = true;
    else if (was.trying && !row.trying) said.push(row.label.replace(/^Can’t/, 'Still can’t'));
  }
  for (const key of before.keys()) {
    if (after.has(key)) continue;
    // Turned off (or to the system's): not the proxy working, but what was said goes, so the same failure later is
    // said again (Carbon's SF-R2-2).
    if (!stillUses(key)) {
      cleared = true;
      continue;
    }
    if (key === 'all') said.push('The proxy works again.');
    else if (names[key]) said.push(`${names[key]}’s proxy works again.`);
  }
  if (said.length) return said.join(' ');
  return cleared ? '' : null;
}

/**
 * Whether a row's key still uses a proxy of its own setting (Carbon's SF-R2-2): 'all', while the proxy for every chord
 * is a server or a file; a chord, while its own is. The system's or none is turning it off, never "works again".
 */
export function rowStillUsesProxy(key: string, settings: { proxy: ProxySettings }, chords: readonly { id: string; proxy?: ProxySettings | null }[]): boolean {
  if (key === 'all') return proxied(settings.proxy);
  const chord = chords.find((c) => c.id === key);
  return Boolean(chord?.proxy && proxied(chord.proxy));
}
