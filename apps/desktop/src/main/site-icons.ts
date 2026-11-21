/**
 * Tabs with an icon, by site, for a tab arriving on a site Chord has no
 * icon kept for (TabManager.knownIcon). Kept up to date from the nodes'
 * buckets (ARCHITECTURE.md §6.1): a state's buckets are frozen, so only the
 * buckets that are new objects since the last look are read again, about
 * 140 nodes each at 35,000, never every node on every navigation.
 */
import { nodeOf, type BucketKey, type NodeBucket, type NodeBuckets, type NodeId, type TabNode } from '@chord/core';

/**
 * Buckets a navigation's look reads at most (about 0.1 ms each at 35,000
 * nodes): one or two changed between most looks; after a big change (an
 * import), the rest is read in slices on later turns.
 */
export const LOOK_BUCKETS = 4;
/** Buckets read in one turn of main when catching up in slices: a few ms at 35,000 nodes, 1 ms at 5,000. */
export const SLICE_BUCKETS = 16;

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

/**
 * What it holds between looks: each bucket as it was at the last one (one
 * old copy of the nodes at most, shared with the state wherever a bucket
 * hasn't changed since), and the tabs with an icon it found there.
 */
export class TabIconIndex {
  /** The nodes last read through, and each bucket as it was then. */
  private nodes: NodeBuckets | null = null;
  private readonly buckets = new Map<BucketKey, NodeBucket>();
  /** Tabs with an icon, by site. */
  private readonly bySite = new Map<string, Map<NodeId, TabNode>>();

  constructor(private readonly current: () => { readonly nodes: NodeBuckets }) {}

  /**
   * The tabs on `site` (an origin) with an icon, as the state has them now: caught up first, however much changed.
   * For exact reads (the tests); a navigation looks through `iconOn`, which never waits for every bucket.
   */
  tabsOn(site: string): Iterable<TabNode> {
    this.catchUp();
    return this.known(site);
  }

  /**
   * The tabs on `site` with an icon as far as the index has caught up: some
   * may have gone or changed since, and a new one may be missing. For a
   * look that mustn't wait (a navigation): `catchUp` with a limit first.
   */
  known(site: string): Iterable<TabNode> {
    return this.bySite.get(site)?.values() ?? [];
  }

  /**
   * Catch up `slice` buckets a turn of main (`next`: setImmediate), so
   * other work runs between slices, never one long pass. One run at a time:
   * asked again while it runs, it goes on catching up to the newest state.
   */
  catchUpInSlices(slice = SLICE_BUCKETS, next: (step: () => void) => void = setImmediate): void {
    if (this.slicing) return;
    this.slicing = true;
    const step = () => {
      if (this.catchUp(slice)) this.slicing = false;
      else next(step);
    };
    next(step);
  }
  private slicing = false;

  /** How many sites have a tab with an icon (for tests). */
  get size(): number {
    this.catchUp();
    return this.bySite.size;
  }

  /**
   * Read the buckets that changed since the last look, at most `buckets` of
   * them (the first time, every bucket counts as changed). True once caught
   * up with the state as it is now; false if more are left, for later turns.
   */
  catchUp(buckets = Infinity): boolean {
    const nodes = this.current().nodes;
    if (nodes === this.nodes) return true;
    let left = buckets;
    // A bucket gone from the nodes doesn't count toward the limit: the 256 are always there (core's nodes.ts), so none ever goes but in a test.
    for (const [key, before] of this.buckets) if (!(key in nodes)) this.reread(key, before, undefined);
    for (const key in nodes) {
      const bucket = nodes[key as BucketKey];
      const before = this.buckets.get(key as BucketKey);
      if (bucket === before) continue;
      if (left-- <= 0) return false;
      this.reread(key as BucketKey, before, bucket);
    }
    this.nodes = nodes;
    return true;
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

/**
 * A tab on `site` with an icon, for a navigation's look (TabManager.knownIcon): a few changed buckets read now, the
 * rest in slices after it. What the index has read so far can be stale, so a tab counts only while it is the
 * state's own node still: one closed since (a private window's, whose chord is gone and so would pass for the default
 * profile's) or changed since never lends its icon. `mine`: whether the tab is in the session that looks.
 */
export function iconOn(index: TabIconIndex, state: { readonly nodes: NodeBuckets }, site: string, mine: (node: TabNode) => boolean): TabNode | null {
  if (!index.catchUp(LOOK_BUCKETS)) index.catchUpInSlices();
  for (const node of index.known(site)) {
    if (!node.favicon || nodeOf(state, node.id) !== node || !mine(node)) continue;
    return node;
  }
  return null;
}
