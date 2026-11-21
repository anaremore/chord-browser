/**
 * Tabs with an icon, by site, for a tab arriving on a site Chord has no
 * icon kept for (TabManager.knownIcon). Kept up to date from the nodes'
 * buckets (ARCHITECTURE.md §6.1): a state's buckets are frozen, so only the
 * buckets that are new objects since the last look are read again, about
 * 140 nodes each at 35,000, never every node on every navigation.
 */
import type { BucketKey, NodeBucket, NodeBuckets, NodeId, TabNode } from '@chord/core';

/**
 * A tab's site as the index keys it: its address up to its path (an
 * origin, as Chromium writes addresses). Null for anything that isn't a
 * web page. No URL parse: this runs once per tab that changed.
 */
export function tabSite(url: string): string | null {
  const from = url.startsWith('https://') ? 8 : url.startsWith('http://') ? 7 : /^https?:\/\//i.test(url) ? url.indexOf('//') + 2 : -1;
  if (from < 0) return null;
  let end = from;
  while (end < url.length) {
    const c = url.charCodeAt(end);
    // '/', '?', '#'
    if (c === 47 || c === 63 || c === 35) break;
    end++;
  }
  return end > from ? url.slice(0, end) : null;
}

export class TabIconIndex {
  /** The nodes last read, and each bucket as it was then. */
  private nodes: NodeBuckets | null = null;
  private readonly buckets = new Map<BucketKey, NodeBucket>();
  /** Tabs with an icon, by site. */
  private readonly bySite = new Map<string, Map<NodeId, TabNode>>();

  constructor(private readonly current: () => { readonly nodes: NodeBuckets }) {}

  /** The tabs on `site` (an origin) with an icon, as the state has them now. */
  tabsOn(site: string): Iterable<TabNode> {
    this.catchUp();
    return this.bySite.get(site)?.values() ?? [];
  }

  /** Catch up now: the first time, a pass over every tab. */
  warm(): void {
    this.catchUp();
  }

  /** How many sites have a tab with an icon (for tests). */
  get size(): number {
    this.catchUp();
    return this.bySite.size;
  }

  private catchUp(): void {
    const nodes = this.current().nodes;
    if (nodes === this.nodes) return;
    this.nodes = nodes;
    for (const [key, before] of this.buckets) if (!(key in nodes)) this.reread(key, before, undefined);
    for (const key in nodes) {
      const bucket = nodes[key as BucketKey];
      const before = this.buckets.get(key as BucketKey);
      if (bucket !== before) this.reread(key as BucketKey, before, bucket);
    }
  }

  /** One bucket changed: what left it or changed goes, what came or changed comes. */
  private reread(key: BucketKey, before: NodeBucket | undefined, now: NodeBucket | undefined): void {
    if (before) for (const id in before) if (now?.[id] !== before[id]) this.drop(before[id]!);
    if (now) for (const id in now) if (before?.[id] !== now[id]) this.add(now[id]!);
    if (now) this.buckets.set(key, now);
    else this.buckets.delete(key);
  }

  private add(node: TabNode | NodeBucket[NodeId]): void {
    if (node.kind !== 'tab' || !node.favicon) return;
    const site = tabSite(node.url);
    if (!site) return;
    let tabs = this.bySite.get(site);
    if (!tabs) this.bySite.set(site, (tabs = new Map()));
    tabs.set(node.id, node);
  }

  private drop(node: NodeBucket[NodeId]): void {
    if (node.kind !== 'tab' || !node.favicon) return;
    const site = tabSite(node.url);
    const tabs = site ? this.bySite.get(site) : undefined;
    if (!tabs || tabs.get(node.id) !== node) return;
    tabs.delete(node.id);
    if (tabs.size === 0) this.bySite.delete(site!);
  }
}
