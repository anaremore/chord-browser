/** Display helpers for page addresses. */

/** `https://www.example.com/a` → `example.com`. */
export function displayHost(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}

/**
 * Stable hue per site for fallback favicons (DESIGN.md §7.4). Uses the host
 * minus `www.`; registrable-domain grouping arrives with the public suffix
 * list in M1.1.
 */
export function siteHue(host: string): number {
  let hash = 2166136261;
  for (let i = 0; i < host.length; i++) {
    hash ^= host.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

export function monogram(host: string, title: string): string {
  const source = host.split('.')[0] || title;
  return (source.trim()[0] ?? '•').toUpperCase();
}
