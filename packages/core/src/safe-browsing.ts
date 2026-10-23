/**
 * Safe Browsing (ARCHITECTURE.md §14.5, decision D7): what a warning says.
 * Google's terms for the Safe Browsing API shape every line here
 * (developers.google.com/safe-browsing/v4/usage-limits): a warning never says
 * a page is certainly unsafe, links to Google's page about the threat, and
 * credits Google with "Advisory provided by Google". Before protection is on,
 * Chord says it isn't perfect: it can miss a site, and flag one by mistake.
 */

/** The threats Chord warns about: Google's SOCIAL_ENGINEERING, MALWARE and UNWANTED_SOFTWARE. */
export type ThreatKind = 'phishing' | 'malware' | 'unwanted';

/** A page, or a frame inside it, that's on one of Google's lists (a tab's `live.threat`). */
export interface PageThreat {
  kind: ThreatKind;
  /** The page's address: where "Visit anyway" goes. */
  url: string;
  /** The frame inside the page that's on the list, when it's a frame and not the page itself. */
  frameUrl: string | null;
}

/** Shown beside the switch in Settings → Privacy, on first run's step, and on the offer to turn it on. */
export const SAFE_BROWSING_NOTICE =
  'Chord checks the addresses you visit against Google’s lists on this computer. Only when one matches does it send Google a short partial fingerprint of the address, never the address itself. Google sees your IP address when Chord fetches the lists or asks about a match. Protection isn’t perfect: a dangerous site can be missed, and a safe one can be flagged by mistake.';

/** The attribution every warning carries, linked to Google's advisory. */
export const SAFE_BROWSING_ADVISORY = { label: 'Advisory provided by Google', url: 'https://developers.google.com/safe-browsing/v4/advisory' } as const;

/**
 * Google's own pages about each threat, for "Learn more": the ones its terms
 * link to, at the addresses they now redirect to (checked 2026-10-23).
 */
export const THREAT_LEARN_MORE: Record<ThreatKind, { label: string; url: string }> = {
  phishing: { label: 'Learn more about phishing', url: 'https://developers.google.com/search/docs/monitor-debug/security/social-engineering' },
  malware: { label: 'Learn more about malware', url: 'https://developers.google.com/search/docs/monitor-debug/security/malware' },
  unwanted: { label: 'Learn more about unwanted software', url: 'https://www.google.com/about/unwanted-software-policy.html' },
};

export interface ThreatCopy {
  title: string;
  body: string;
}

/** What the frame says instead of a page on a list. `host`: the page's (or the frame's) site. Always hedged. */
export function describeThreat(threat: Pick<PageThreat, 'kind' | 'frameUrl'>, host: string, frameHost: string | null = null): ThreatCopy {
  const site = host || 'This site';
  const where = threat.frameUrl ? `Part of this page comes from ${frameHost || 'a site'}, which` : site;
  switch (threat.kind) {
    case 'phishing':
      return {
        title: 'This site may be trying to trick you.',
        body: `${where} is on Google’s list of suspected phishing sites. Sites like this pretend to be someone you trust to get your passwords, card numbers or other details.`,
      };
    case 'malware':
      return {
        title: 'This site may harm your computer.',
        body: `${where} is on Google’s list of sites suspected of spreading malware: software that can steal your information or damage your files.`,
      };
    case 'unwanted':
      return {
        title: 'This site may try to install unwanted software.',
        body: `${where} is on Google’s list of sites suspected of offering programs that change your browser or computer without asking.`,
      };
  }
}

/** The downloads panel's line for a file Chord is holding. */
export function describeHeldDownload(kind: ThreatKind): string {
  switch (kind) {
    case 'malware':
      return 'This file may be malware. Chord paused it.';
    case 'unwanted':
      return 'This file may be unwanted software. Chord paused it.';
    case 'phishing':
      return 'This file comes from a suspected phishing site. Chord paused it.';
  }
}
