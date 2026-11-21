/**
 * Tab refs (docs/decisions/S18-agent-mcp.md §5): the opaque handles a model
 * uses for tabs ("t3" in the assistant, "a1"/"s1" for outside agents), never
 * Chord's ids, titles or addresses. One table per scope (a chat, a
 * connection). A ref is never reused within its table, even after its tab
 * closes, so a model's old ref can't come to mean another tab: it resolves as
 * closed instead.
 */

export type RefLookup<Id> = { ok: true; id: Id } | { ok: false; why: 'unknown' | 'closed' };

export class TabRefs<Id = string> {
  private readonly byRef = new Map<string, Id | null>();
  private readonly byId = new Map<Id, string>();
  private next = 1;
  /** Other prefixes' counters (an outside agent's shared tabs: `s1`…). */
  private readonly others = new Map<string, number>();

  /** `prefixFor`: another prefix for some tabs (an outside agent's: `s` for tabs the user shares), counted apart. */
  constructor(
    private readonly prefix = 't',
    private readonly prefixFor?: (id: Id) => string,
  ) {}

  /** The tab's ref, made the first time it's asked for. */
  refFor(id: Id): string {
    const known = this.byId.get(id);
    if (known !== undefined) return known;
    const prefix = this.prefixFor?.(id) ?? this.prefix;
    let ref: string;
    if (prefix === this.prefix) ref = `${prefix}${this.next++}`;
    else {
      const n = this.others.get(prefix) ?? 1;
      this.others.set(prefix, n + 1);
      ref = `${prefix}${n}`;
    }
    this.byRef.set(ref, id);
    this.byId.set(id, ref);
    return ref;
  }

  /** The tab is gone for this table, though it's still open (handed to the user): its ref now resolves as closed. */
  close(id: Id): void {
    const ref = this.byId.get(id);
    if (ref === undefined) return;
    this.byRef.set(ref, null);
    this.byId.delete(id);
  }

  /**
   * A ref from before (a saved chat's attachments): kept as it was, its tab or
   * null when that tab is gone (it then resolves as closed). New refs number
   * after it. A tab that already has a ref keeps its first one for new reads.
   */
  restore(ref: string, id: Id | null): void {
    if (!ref.startsWith(this.prefix)) return;
    const n = Number(ref.slice(this.prefix.length));
    if (!Number.isInteger(n) || n < 1) return;
    if (this.byRef.get(ref) == null) this.byRef.set(ref, id);
    if (id !== null && !this.byId.has(id)) this.byId.set(id, ref);
    if (n >= this.next) this.next = n + 1;
  }

  /** The tab a ref names, whether or not it's still open. */
  get(ref: string): Id | undefined {
    return this.byRef.get(ref) ?? undefined;
  }

  /** What a model's ref names now: its tab, or why not (a ref never made, or one whose tab closed). */
  resolve(ref: unknown, isOpen: (id: Id) => boolean): RefLookup<Id> {
    if (typeof ref !== 'string' || !this.byRef.has(ref)) return { ok: false, why: 'unknown' };
    const id = this.byRef.get(ref);
    if (id === null || id === undefined || !isOpen(id)) return { ok: false, why: 'closed' };
    return { ok: true, id };
  }

  /** Every ref with a tab, in the order they were made or restored. */
  *entries(): IterableIterator<[string, Id]> {
    for (const [ref, id] of this.byRef) if (id !== null) yield [ref, id];
  }
}
