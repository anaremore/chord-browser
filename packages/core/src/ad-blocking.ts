/**
 * Ad and tracker blocking (ARCHITECTURE.md §9, decision D5): what fetching
 * the lists tells their host, and which sites blocking is off for. It's on by
 * default; the lists aren't Google's, so Google-free mode leaves it on.
 */
import { hostOf, routeHost, siteOf } from './links';
import { isPrivateProfile, type State } from './model';

/** Shown beside the switch in Settings → Privacy: what blocking does on this computer, and what the lists' host sees. */
export const AD_BLOCKING_NOTICE =
  'Chord checks what pages load against EasyList and EasyPrivacy, two public lists it keeps on this computer; nothing about the pages you visit is sent anywhere. About every four days it downloads fresh copies from easylist.to, which sees your IP address and when, as any site you visit would.';

/** How many sites blocking can be off for. */
export const MAX_OFF_SITES = 1000;

/** The site an address or a typed name belongs to, as blocking is turned off for it (`news.example.co.uk` → `example.co.uk`); null if it isn't one. */
export function blockingSite(input: string): string | null {
  const host = hostOf(input) ?? routeHost(input);
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
  return siteOf(host);
}

/** Whether blocking is off for the page at this address: its site, or a site it's a subdomain of, is in the list. */
export function isBlockingOff(url: string, offSites: readonly string[]): boolean {
  const host = hostOf(url);
  if (!host || offSites.length === 0) return false;
  return offSites.some((site) => host === site || host.endsWith(`.${site}`));
}

/** The sites blocking is off for in a profile's pages: Settings' list, plus a private window's own. */
export function blockingOffSites(state: State, profileId: string): readonly string[] {
  const saved = state.settings.adBlocking.offSites;
  if (!isPrivateProfile(profileId)) return saved;
  const own = Object.values(state.chords).find((c) => c.private && c.profileId === profileId)?.blockingOff;
  return own?.length ? [...saved, ...own] : saved;
}

/** A list of sites as saved: each one normalized, no repeats, at most MAX_OFF_SITES. */
export function cleanOffSites(sites: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const site of sites) {
    const clean = typeof site === 'string' && site.length <= 300 ? blockingSite(site) : null;
    if (clean) out.add(clean);
    if (out.size >= MAX_OFF_SITES) break;
  }
  return [...out];
}
