/**
 * What the user meant, for the sync simulation's invariants (S15 §13): every
 * change you made to a synced thing, field by field, with when you made it
 * (and, when a computer joins, what it brings, at its rows' times, as joining
 * does). The latest of each field is what every computer should end up with;
 * nothing should be gone that no one deleted; and sync should never put an
 * older value in place of a newer one, nor take what's only on one computer
 * without a toast and an Undo.
 */
import {
  defaultFields,
  localChordFields,
  localFavoriteFields,
  localNodeFields,
  localRouteFields,
  localSettingFields,
  localThemeFields,
  same,
  type Command,
  type Settings,
  type State,
  type SyncValues,
} from '@chord/core';

export type Things = Map<string, SyncValues>;

/** A state as sync keeps it: each synced thing (`type\nid`) with its fields, as the stamping hook projects them. */
export function synced(state: State): Things {
  const out: Things = new Map();
  for (const chord of Object.values(state.chords)) {
    if (chord.private) continue;
    const set = localChordFields(chord);
    if (set) out.set(`chord\n${chord.id}`, set);
  }
  for (const node of Object.values(state.nodes)) {
    const chord = state.chords[node.chordId];
    if (!chord || chord.private) continue;
    const set = localNodeFields(node, null);
    if (set) out.set(`${node.kind}\n${node.id}`, set);
  }
  for (const favorite of Object.values(state.favorites)) out.set(`favorite\n${favorite.id}`, localFavoriteFields(favorite, null));
  // A route whatever its chord: one to a chord that went stays, waiting for it (deleting a chord here keeps its routes).
  for (const route of Object.values(state.linkRoutes)) out.set(`route\n${route.host}`, localRouteFields(route));
  for (const theme of state.settings.themes) out.set(`theme\n${theme.id}`, localThemeFields(theme));
  const settings: SyncValues = {};
  for (const key of Object.keys(state.settings) as (keyof Settings)[]) Object.assign(settings, localSettingFields(key, state.settings[key], 'linux') ?? {});
  out.set('settings\nsettings', settings);
  return out;
}

interface Edit {
  at: number;
  value: unknown;
  by: string;
  /** When chord-data stamped it (the write it went in was of changes made up to then): what tells it's still in the outbox. */
  stamped?: number;
  /** Still in its computer's outbox when sync went off there: they go when it's on again (S15 §8), not before. */
  parked?: boolean;
  /**
   * Its computer's log was put back to an old version while it was off: what
   * it wrote may be gone from the folder, with no one there to write it again.
   * Either way is right.
   */
  uncertain?: boolean;
  /** Made while its computer joined, before the choice: stamped as the join ends, or not (`settleWindow`). */
  window?: boolean;
}

export class Model {
  /** By thing, by field: every edit, in the order made. */
  private readonly edits = new Map<string, Map<string, Edit[]>>();
  /** When each value a person typed was first made, and last put back: what tells a revert. */
  private readonly made = new Map<string, { first: number; last: number }>();
  /** In a join's window, by computer, thing and field: what it was before the window (null: not there). */
  private readonly windowBases = new Map<string, { value: unknown } | null>();
  readonly violations: string[] = [];
  /** SIM_WATCH: what the model drops of a thing, and why. */
  note: (line: string) => void = () => undefined;
  private dropped(why: string, key: string, field: string, e: Edit): void {
    const watch = process.env['SIM_WATCH'];
    if (watch && key.includes(watch)) this.note(`model drops ${e.by}'s ${field}=${JSON.stringify(e.value)}@${e.at} of ${key.replace('\n', ' ')} (${why})`);
  }
  readonly counts = { edits: 0, joins: 0, reverts: 0, phantoms: 0 };

  /** Values typed with sync off, and when first: never sync's as such, but one put back into sync later is as old as that. */
  private readonly typedOff = new Map<string, number>();

  /** When a value a person typed was made, and last put back (`back`: an Undo, pinned again, made again), for I4. */
  private madeAt(value: unknown, at: number, back = false): void {
    if (typeof value !== 'string' || !value.startsWith('~')) return;
    const made = this.made.get(value);
    const first = back ? (made?.first ?? this.typedOff.get(value) ?? at) : Math.min(at, made?.first ?? at);
    this.made.set(value, { first, last: Math.max(at, made?.last ?? at) });
  }

  /** A change made with sync off: the values typed in it, as of then (I4, should one be put back into sync). */
  typed(at: number, before: State, after: State): void {
    const was = synced(before);
    for (const [key, b] of synced(after)) {
      const a = was.get(key);
      for (const [field, value] of Object.entries(b)) {
        if (typeof value !== 'string' || !value.startsWith('~') || (a && same(a[field], value))) continue;
        this.typedOff.set(value, Math.min(at, this.typedOff.get(value) ?? at));
      }
    }
  }

  private edit(key: string, field: string, at: number, value: unknown, by: string, flags: Partial<Pick<Edit, 'window' | 'uncertain' | 'stamped'>> = {}, back = false): void {
    let fields = this.edits.get(key);
    if (!fields) this.edits.set(key, (fields = new Map()));
    let list = fields.get(field);
    if (!list) fields.set(field, (list = []));
    list.push({ at, value, by, ...flags });
    this.madeAt(value, at, back);
  }

  /**
   * A change you made on `by`, while it syncs: what changed, field by field.
   * `window`: made while `by` joins, before the choice: held until the join
   * ends (`settleWindow`).
   */
  user(by: string, at: number, before: State, after: State, window = false): void {
    const was = synced(before);
    const now = synced(after);
    for (const key of new Set([...was.keys(), ...now.keys()])) {
      const a = was.get(key);
      const b = now.get(key);
      if (a && !b) {
        this.edit(key, 'deleted', at, true, by, window ? { window } : {});
        // In a join's window: each field as it was before it, for a bringing back in it to be compared with.
        if (window) for (const [field, value] of Object.entries(a)) if (!this.windowBases.has(`${by}\n${key}\n${field}`)) this.windowBases.set(`${by}\n${key}\n${field}`, { value });
        this.counts.edits++;
        continue;
      }
      if (!b) continue;
      // Brought back (an Undo, pinned again): every field, as of now. Its write takes out those as chord-data last wrote
      // them before it went (`was`: the sim's `wrote`, as the write lands, calls `unchanged` for them).
      const base = a;
      if (!a) this.edit(key, 'deleted', at, false, by, window ? { window } : {});
      for (const [field, value] of Object.entries(b)) {
        if (base && field in base && same(base[field], value)) continue;
        // In a join's window: what it was before the window, which the join's end compares with (`noteBases`).
        const k = `${by}\n${key}\n${field}`;
        if (window && !this.windowBases.has(k)) this.windowBases.set(k, a && field in a ? { value: a[field] } : null);
        this.edit(key, field, at, value, by, window ? { window } : {}, !a);
        this.counts.edits++;
      }
    }
  }

  /**
   * `by`'s join ended: what it changed in the join's window is stamped where
   * `keep` says (the join's mode decides: *Use the synced setup* stamps
   * nothing of the chords that make way), and the rest never goes. `null`:
   * the join started over, and what it noted is gone (its rows join again).
   */
  settleWindow(by: string, keep: ((key: string) => boolean) | null): void {
    for (const [key, fields] of this.edits) {
      for (const [field, list] of fields) {
        // Left as it was before the window (changed, and changed back): no change, and none is stamped.
        const last = list.findLast((e) => e.by === by && e.window);
        const before = this.windowBases.get(`${by}\n${key}\n${field}`);
        const unchanged = last !== undefined && before !== undefined && before !== null && same(before.value, last.value);
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i]!;
          if (e.by !== by || !e.window) continue;
          if (keep?.(key) && !unchanged) delete e.window;
          else {
            this.dropped(unchanged ? 'window, unchanged' : 'window', key, field, e);
            list.splice(i, 1);
          }
        }
      }
    }
    for (const k of [...this.windowBases.keys()]) if (k.startsWith(`${by}\n`)) this.windowBases.delete(k);
  }

  /**
   * A computer joining (or setting up): its things, each at its row's time, as
   * joining stamps them. `maybe`: one waiting here for what it's in (a route
   * to a chord that isn't here), which joins only if that comes back.
   */
  joined(by: string, rows: { key: string; set: SyncValues; at: number; maybe?: boolean }[], settingsAtZero: boolean, partly = false): void {
    this.counts.joins++;
    const defaults = defaultFields('linux');
    for (const { key, set, at, maybe: one } of rows) {
      // `partly`: a join refused partway (a full disk), its parts in already kept: any of these may be in the copy.
      const maybe = partly || one;
      if (key === 'settings\nsettings') {
        for (const [field, value] of Object.entries(set)) this.edit(key, field, settingsAtZero || (defaults.has(field) && same(defaults.get(field), value)) ? 0 : at, value, by, { stamped: -1, ...(partly ? { uncertain: true } : {}) });
        continue;
      }
      this.edit(key, 'deleted', at, false, by, { stamped: -1, ...(maybe ? { uncertain: true } : {}) });
      for (const [field, value] of Object.entries(set)) this.edit(key, field, at, value, by, { stamped: -1, ...(maybe ? { uncertain: true } : {}) });
    }
  }

  /**
   * A crash on `by`: what it changed and never wrote is gone with it. `keys`
   * says which things (`type\nid`, or a prefix), `since` when each was last written.
   */
  lost(by: string, unwritten: { match: (key: string, field: string) => boolean; since: number }[]): number {
    let n = 0;
    for (const [key, fields] of this.edits) {
      for (const [field, list] of fields) {
        for (const { match, since } of unwritten) {
          if (!match(key, field)) continue;
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i]!.by === by && list[i]!.at > since) {
              this.dropped('unwritten', key, field, list[i]!);
              list.splice(i, 1);
              n++;
            }
          }
        }
      }
    }
    return n;
  }

  /** A write of `by`'s, stamped while sync was on: the changes in it (made up to `upTo`) are stamped as of then. */
  stamp(by: string, match: (key: string, field: string) => boolean, upTo: number): void {
    for (const [key, fields] of this.edits) {
      for (const [field, list] of fields) {
        if (!match(key, field)) continue;
        for (const e of list) if (e.by === by && e.stamped === undefined && e.at <= upTo) e.stamped = upTo;
      }
    }
  }

  /**
   * A write of `by`'s (stamped as of `upTo`) left a field as `by` last wrote
   * it: whatever it went through meanwhile (changed and changed back before
   * the write), it's no change, and sync stamps none.
   */
  unchanged(by: string, key: string, field: string, upTo: number): void {
    const list = this.edits.get(key)?.get(field);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.by !== by || list[i]!.stamped !== upTo || list[i]!.window) continue;
      this.dropped('unchanged', key, field, list[i]!);
      list.splice(i, 1);
    }
  }

  /** A write of `by`'s (stamped as of `upTo`) took a thing away: what else it changed of it then (brought back, edited) never goes. */
  goneInWrite(by: string, key: string, upTo: number): void {
    for (const field of this.edits.get(key)?.keys() ?? []) if (field !== 'deleted') this.unchanged(by, key, field, upTo);
  }

  /**
   * Sync went off on `by` with these still in its outbox (each thing, `type\nid`,
   * with its oldest stamp there): what was stamped since waits there. What
   * went before (written to the folder) doesn't.
   */
  park(by: string, waiting: ReadonlyMap<string, number>): void {
    for (const [key, since] of waiting) {
      const fields = this.edits.get(key);
      if (!fields) continue;
      for (const list of fields.values()) for (const e of list) if (e.by === by && e.stamped !== undefined && e.stamped >= since) e.parked = true;
    }
  }

  /** `by`'s log put back to an old version with `by` off: whatever it wrote may or may not be in the folder. */
  doubt(by: string): void {
    for (const fields of this.edits.values()) for (const list of fields.values()) for (const e of list) if (e.by === by) e.uncertain = true;
  }

  /** On again on `by`: what waited goes now. */
  unpark(by: string): void {
    for (const fields of this.edits.values()) for (const list of fields.values()) for (const e of list) if (e.by === by) e.parked = false;
  }

  /** A field's changes, said: who, when, what (and whether waiting). */
  history(key: string, field: string): string {
    return (this.edits.get(key)?.get(field) ?? []).map((e) => `${e.by}@${new Date(e.at).toISOString().slice(11, 23)}=${JSON.stringify(e.value)}${e.parked ? '(waiting)' : ''}${e.uncertain ? '(log put back)' : ''}${e.window ? '(joining)' : ''}`).join(' ');
  }

  /**
   * What a field may be: its latest edit's value (either, when two at the
   * latest moment differ), or a later one still in an outbox when sync went
   * off there: that may have reached the folder all the same (an outbox lets a
   * change go only once the folder answers, and turning off waits for that only
   * so long). Null: nothing but such waiting changes, so nothing expected yet.
   */
  private acceptable(list: Edit[], held: (e: Edit) => boolean): unknown[] | null {
    let best: Edit[] = [];
    for (const e of list) {
      if (held(e)) continue;
      if (best.length === 0 || e.at > best[0]!.at) best = [e];
      else if (e.at === best[0]!.at) best.push(e);
    }
    if (best.length === 0) return null;
    const values = best.map((e) => e.value);
    for (const e of list) if (held(e) && e.at >= best[0]!.at) values.push(e.value);
    return values;
  }

  /**
   * Each thing anyone made or changed: whether it should be there, and the
   * values each field may have. `stuck`: computers showing a problem, each with
   * what's still in its outbox (thing, oldest stamp there): what they changed
   * and haven't written to the folder may not have reached anyone yet.
   */
  expected(stuck: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map()): Map<string, { live: 'yes' | 'no' | 'either'; fields: Map<string, unknown[] | null> }> {
    const out = new Map<string, { live: 'yes' | 'no' | 'either'; fields: Map<string, unknown[] | null> }>();
    for (const [key, fields] of this.edits) {
      const held = (e: Edit): boolean => {
        if (e.parked || e.uncertain || e.window) return true;
        const outbox = stuck.get(e.by);
        if (!outbox) return false;
        const since = outbox.get(key);
        return e.stamped === undefined || (since !== undefined && e.stamped >= since);
      };
      // Nothing of it that isn't waiting somewhere: not expected anywhere yet.
      if ([...fields.values()].every((list) => list.every(held))) continue;
      const deleted = fields.get('deleted');
      // Its comings and goings all held (waiting, or a log put back): there, or as any of them left it.
      // Made by a change whose log was put back (uncertain): maybe never made, anywhere.
      const gone = (deleted ? this.acceptable(deleted, held) : null) ?? [false, ...(deleted ?? []).map((e) => e.value), ...((deleted ?? []).some((e) => e.uncertain) ? [true] : [])];
      const values = new Map<string, unknown[] | null>();
      for (const [field, list] of fields) if (field !== 'deleted') values.set(field, this.acceptable(list, held));
      const live = gone.every((g) => g === true) ? 'no' : gone.every((g) => g !== true) ? 'yes' : 'either';
      out.set(key, { live, fields: values });
    }
    return out;
  }

  /**
   * Sync's change on one computer: nothing it puts in place is older than
   * what it replaces (I4), and nothing only this computer has is taken without
   * an Undo (I5).
   */
  applied(by: string, command: Command, before: State, after: State, reverts = true): void {
    const was = synced(before);
    const now = synced(after);
    for (const [key, b] of reverts ? now : []) {
      const a = was.get(key);
      if (!a) continue;
      for (const [field, value] of Object.entries(b)) {
        const old = a[field];
        if (typeof value !== 'string' || typeof old !== 'string' || value === old) continue;
        // Older for sure: the new value was last made before the old one was first made.
        const newAt = this.made.get(value)?.last;
        const oldAt = this.made.get(old)?.first;
        if (newAt !== undefined && oldAt !== undefined && newAt < oldAt) {
          this.counts.reverts++;
          this.violations.push(`I4 revert on ${by} (${command.t}): ${key.replace('\n', ' ')} ${field} "${old}" (made at ${oldAt}) replaced by older "${value}" (made at ${newAt})`);
        }
      }
    }
    // Today tabs: only this computer's. Gone from the state, moved or not, without being in sync's Undo: lost.
    const kept = new Set(after.syncUndo.flatMap((entry) => [...entry.nodes.map((n) => n.id), ...(entry.moved ?? []).map((n) => n.id)]));
    for (const node of Object.values(before.nodes)) {
      if (node.kind !== 'tab' || node.section !== 'today' || after.nodes[node.id] || kept.has(node.id)) continue;
      this.violations.push(`I5 a Today tab (${node.id}) on ${by} went with ${command.t}, with no Undo`);
    }
  }
}
