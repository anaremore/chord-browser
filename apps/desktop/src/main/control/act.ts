/**
 * Acting on a page, the page's side (S18 M2c; core's control-act.ts has the rules, tools.ts the tool). A script in the
 * isolated world (4400), as the snapshot's, finds a ref's element in its owner's latest snapshot (control/snapshot.ts)
 * and checks it again before anything is sent: still connected, still shown, still the role and name the snapshot gave
 * it (SNAPSHOT_LIB, the same rules). Then, by what's asked:
 *
 * - `describe`: what it is (disabled, takes text, a select), and the role and name the snapshot gave it.
 * - `focus`: focused, for a key pressed in it; `focused`: whether it has the focus now (through open shadow roots).
 *   Text and keys go wherever the focus is, so main asks this right before each, and a page that moved the focus (a
 *   mousedown handler sending it to a password field) gets nothing. Every answer carries the field as it is now, which
 *   main checks with core's sensitiveField, as the snapshot did.
 * - `hit`: just before the button goes down, the point is still the element's: the press is sent only then. It waits
 *   for the page to see the pointer's move first (Blink sends a move with the next frame, and its mouseover and
 *   mouseenter handlers, which can put something over the point, run then), at most HIT_WAIT_MS. A hit on a frame (an
 *   iframe, an embed, a fenced frame) is never the element's, even one inside it.
 * - `guard` and `unguard`: while text and keys go in, a key or an insertion that would land anywhere but the element
 *   (the page moved the focus between main's check and the input) is stopped in the page, and `unguard` says so. Input
 *   and scripts reach the page by different ways, so `unguard` waits for the input's last event (the key's keyup, the
 *   text's beforeinput) to have been seen, at most GUARD_WAIT_MS, before it takes the guard down.
 * - `point`: scrolled to the middle of the view (at once), and hit-tested at its middle, then at the middles of its
 *   quarters: the point to send the click to, in the page's CSS pixels, or what covers it (its role and name).
 * - `select`: a text field's contents selected (all of it), so the text `insertText` puts in replaces it.
 * - `choose`: a select's option by its label, set as the fill sets one (the native setter, then input and change).
 * - `settle`: resolves once the page has been quiet ACT_SETTLE_QUIET_MS, at most ACT_SETTLE_MS.
 *
 * Each action outlines its element in the agents' blue for a moment (the Web Animations API: nothing is added to the
 * page), shown and gone at once with reduced motion. Main never waits on a hung page: each call has its own limit.
 */
import { ACT_SETTLE_MS, ACT_SETTLE_QUIET_MS, type SnapshotField } from '@chord/core';
import type { WebContents } from 'electron';
import { pageCall } from '../page-call';
import { ASSISTANT_WORLD } from './extract';
import { SNAPSHOT_LIB } from './snapshot';

/** How long a step in the page may take: a busy page answers within it. */
const ACT_PAGE_MS = 3000;

export type ActOp =
  | { op: 'point'; highlight: boolean }
  | { op: 'hit'; x: number; y: number }
  | { op: 'select' }
  | { op: 'focus' }
  | { op: 'focused' }
  | { op: 'guard'; until: 'keyup' | 'beforeinput' }
  | { op: 'unguard' }
  | { op: 'choose'; option: string }
  | { op: 'describe'; option?: string };

/** What the page said. `point`'s x and y are the element's middle in the view, in CSS pixels; `editable`, whether it takes text. */
export type ActAnswer =
  | { ok: true; role: string; name: string; x?: number; y?: number; editable?: boolean; select?: boolean; disabled?: boolean; choice?: string; field?: SnapshotField; focused?: boolean; moved?: boolean; lost?: boolean }
  | { ok: false; why: 'stale' | 'changed' | 'covered' | 'no-move' | 'no-choice' | 'two-choices' | 'not-select' | 'no-answer'; cover?: { role: string; name: string } };

/** How long `hit` waits for the page to see the pointer's move (it's sent with the page's next frame). */
const HIT_WAIT_MS = 250;
/** How long `unguard` waits for the input's last event. */
const GUARD_WAIT_MS = 250;

function actScript(owner: string, token: string, key: number, op: ActOp): string {
  const args = { owner, token, key, hitWait: HIT_WAIT_MS, guardWait: GUARD_WAIT_MS, ...op };
  return String.raw`(async (args) => {
  ${SNAPSHOT_LIB}
  const read = globalThis.__chordSnapshots && globalThis.__chordSnapshots.get(args.owner);
  if (!read || read.token !== args.token) return { ok: false, why: 'stale' };
  const entry = read.keep[args.key];
  const el = entry && entry.ref.deref();
  if (!el || !el.isConnected) return { ok: false, why: 'changed' };
  // The same element as the snapshot described: its role and name now, and on screen.
  const role = roleNow(el);
  if (role !== entry.role || nameOf(el, role) !== entry.name) return { ok: false, why: 'changed' };
  if (!(isField(el) ? visibleField(el, typeOf(el)) : shown(el))) return { ok: false, why: 'changed' };
  const disabled = el.matches(':disabled') || String(el.getAttribute('aria-disabled')).toLowerCase() === 'true';
  const editable = el.isContentEditable || (el.localName === 'textarea' && !el.readOnly) || (el.localName === 'input' && !el.readOnly && TEXT_TYPES.has(String(el.type || '').toLowerCase()));
  const select = el.localName === 'select';
  // A field as it is now, for main's sensitiveField: a page can turn a field into a password field after the snapshot.
  const said = { role: entry.role, name: entry.name, ...(isField(el) || TYPED.has(role) ? { field: fieldOf(el) } : {}) };
  // What has the focus now, through open shadow roots: text and keys go to it, so it must be this element.
  const deepFocus = () => {
    let f = document.activeElement;
    while (f && f.shadowRoot && f.shadowRoot.activeElement) f = f.shadowRoot.activeElement;
    return f;
  };
  // A choice by the page's own label, whole (clipped only to show it): matched before anything is asked, so only the
  // page's words are ever shown. Never a disabled one (itself or its group) nor a hidden one; two with the label, none.
  const norm = (text) => String(text).replace(/\s+/g, ' ').trim();
  const optionIndex = (want) => {
    const label = norm(want);
    const found = [];
    [...el.options].forEach((o, i) => {
      if (o.matches(':disabled') || o.hidden || (o.parentElement && o.parentElement.localName === 'optgroup' && o.parentElement.hidden)) return;
      if (norm(o.label || o.text) === label) found.push(i);
    });
    return found.length === 1 ? found[0] : found.length ? -2 : -1;
  };
  const noChoice = (index) => ({ ok: false, why: index === -2 ? 'two-choices' : 'no-choice' });
  if (args.op === 'describe') {
    if (args.option === undefined) return { ok: true, ...said, disabled, editable, select };
    if (!select) return { ok: false, why: 'not-select' };
    const index = optionIndex(args.option);
    if (index < 0) return noChoice(index);
    return { ok: true, ...said, disabled, editable, select, choice: clip(el.options[index].label || el.options[index].text, NAME_MAX) };
  }
  if (args.op === 'focus') { el.focus({ preventScroll: true }); return { ok: true, ...said, focused: deepFocus() === el }; }
  if (args.op === 'focused') return { ok: true, ...said, focused: deepFocus() === el };
  // guard: a key or an insertion bound anywhere but the element is stopped before the page's own handlers see it
  // (capture, on the window), though not before a capture listener the page put on the window earlier, which runs
  // first. Taken off by unguard once the input's last event was seen, or by itself after 5 s.
  const GUARDED = ['keydown', 'keypress', 'keyup', 'beforeinput'];
  const unwatch = (guard) => {
    for (const type of GUARDED) removeEventListener(type, guard.stop, true);
    clearTimeout(guard.timer);
    if (globalThis.__chordGuard === guard) globalThis.__chordGuard = null;
  };
  if (args.op === 'unguard') {
    const guard = globalThis.__chordGuard;
    if (!guard) return { ok: true, ...said, moved: false };
    if (!guard.done) await new Promise((done) => { guard.finished = done; setTimeout(done, args.guardWait); });
    await new Promise((done) => setTimeout(done, 0));
    unwatch(guard);
    // The input's last event never came here: the focus went where this document doesn't see (into a frame), and some
    // of the input may have gone there. (Not where the focus is now: a field may move it on, as split date fields do.)
    return { ok: true, ...said, moved: guard.moved, lost: !guard.done };
  }
  if (args.op === 'guard') {
    if (globalThis.__chordGuard) unwatch(globalThis.__chordGuard);
    const guard = { until: args.until, moved: false, done: false, finished: null, timer: 0, stop: (e) => {
      if (!e.isTrusted) return;
      if (e.type === args.until) { guard.done = true; if (guard.finished) guard.finished(); }
      if (e.type === 'keyup' || deepFocus() === el) return;
      guard.moved = true;
      e.preventDefault();
      e.stopImmediatePropagation();
    } };
    for (const type of GUARDED) addEventListener(type, guard.stop, true);
    guard.timer = setTimeout(() => unwatch(guard), 5000);
    globalThis.__chordGuard = guard;
    return { ok: true, ...said };
  }
  if (args.op === 'select') {
    el.focus({ preventScroll: true });
    if (isField(el)) el.select();
    else { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    return { ok: true, ...said };
  }
  if (args.op === 'choose') {
    if (!select) return { ok: false, why: 'not-select' };
    const index = optionIndex(args.option);
    if (index < 0) return noChoice(index);
    if (el.selectedIndex !== index) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(el, index);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, ...said, choice: clip(el.options[index].label || el.options[index].text, NAME_MAX) };
  }
  const within = (hit) => {
    for (let n = hit; n; n = n.parentNode || n.host) if (n === el) return true;
    return false;
  };
  const deepest = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
    return hit;
  };
  // A hit on a frame (another document, maybe another site's) is never the element's, even inside it.
  const FRAMES = new Set(['iframe', 'frame', 'embed', 'object', 'fencedframe']);
  const ours = (hit) => hit && within(hit) && !FRAMES.has(hit.localName);
  // What covers it, by its nearest named ancestor with a role.
  const coverOf = (cover) => {
    for (let n = cover; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
      if (FRAMES.has(n.localName)) return { role: 'frame', name: clip(n.getAttribute('title') || '', NAME_MAX) };
      const r2 = roleNow(n);
      if (r2) return { role: r2, name: nameOf(n, r2) };
    }
    return { role: cover ? cover.localName : 'element', name: '' };
  };
  // hit: just before the button goes down, the point is still the element's (nothing moved over it since point). The
  // pointer's move first: the page sees it with its next frame, after main sent it, and its mouseover and mouseenter
  // handlers run before the move's own listeners, so once the move is seen here (and its dispatch over: a task later),
  // whatever they put over the point is there to be hit. It fails closed: a move never seen (a tab that draws no
  // frames, a page listener that swallows moves, a move into a frame, whose document gets it) gets no press, as the
  // button going down would send the move then, and its handlers would run after this test. Unless the pointer was at
  // that point already (a second click there) and the last move seen there was over this very node: no move is sent
  // then, and nothing new is under the pointer for handlers to run on. Anything else there now (the page put another
  // element at the point, whose mouseenter the press would set off) gets no press.
  if (args.op === 'hit') {
    const near = (e) => Math.abs(e.clientX - args.x) <= 2 && Math.abs(e.clientY - args.y) <= 2;
    const moved = globalThis.__chordMoved;
    let arrived = Boolean(moved && moved.seen && near(moved.seen));
    if (!arrived) {
      arrived = await new Promise((done) => {
        const timer = setTimeout(() => finish(false), args.hitWait);
        function seen(e) { if (e.isTrusted && near(e)) finish(true); }
        function finish(saw) { clearTimeout(timer); removeEventListener('mousemove', seen, true); done(saw); }
        addEventListener('mousemove', seen, true);
      });
    }
    await new Promise((done) => setTimeout(done, 0));
    if (moved) { removeEventListener('mousemove', moved.listen, true); globalThis.__chordMoved = null; }
    const hit = deepest(args.x, args.y);
    if (!ours(hit)) return { ok: false, why: 'covered', cover: coverOf(hit) };
    const before = moved && moved.before;
    if (!arrived && !(before && near(before) && before.target && before.target.deref() === hit)) return { ok: false, why: 'no-move' };
    return { ok: true, ...said };
  }
  // point: to the middle of the view, then the hit test at its middle and its quarters' middles.
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const left = Math.max(r.left, 0), top = Math.max(r.top, 0), right = Math.min(r.right, innerWidth), bottom = Math.min(r.bottom, innerHeight);
  if (right - left < 1 || bottom - top < 1) return { ok: false, why: 'changed' };
  const w = right - left, h = bottom - top;
  const points = [[left + w / 2, top + h / 2], [left + w / 4, top + h / 4], [left + (3 * w) / 4, top + h / 4], [left + w / 4, top + (3 * h) / 4], [left + (3 * w) / 4, top + (3 * h) / 4]];
  let cover = null;
  for (const [x, y] of points) {
    const hit = deepest(x, y);
    if (ours(hit)) {
      // From here, the pointer's move is watched for: main sends it next, and hit waits for the page to see it.
      const was = globalThis.__chordMoved;
      if (was) removeEventListener('mousemove', was.listen, true);
      // Where the pointer was last seen, before this action's move (kept by a listener that stays once an agent acts).
      if (!globalThis.__chordPointer) {
        const pointer = (globalThis.__chordPointer = { at: null });
        // And what it was over: the deepest node there, through open shadow roots, as hit's test finds it.
        addEventListener('mousemove', (e) => { if (e.isTrusted) pointer.at = { clientX: e.clientX, clientY: e.clientY, target: new WeakRef(e.composedPath()[0] || e.target) }; }, true);
      }
      const watch = { seen: null, before: globalThis.__chordPointer.at, listen: (e) => { if (e.isTrusted) watch.seen = { clientX: e.clientX, clientY: e.clientY }; } };
      addEventListener('mousemove', watch.listen, true);
      globalThis.__chordMoved = watch;
      setTimeout(() => { if (globalThis.__chordMoved === watch) { removeEventListener('mousemove', watch.listen, true); globalThis.__chordMoved = null; } }, 5000);
      if (args.highlight) {
        const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches;
        const ring = '0 0 0 3px oklch(0.55 0.12 250 / 0.9), 0 0 0 7px oklch(0.55 0.12 250 / 0.18)';
        el.animate(quiet ? [{ boxShadow: ring }, { boxShadow: ring }] : [{ boxShadow: ring, offset: 0 }, { boxShadow: ring, offset: 0.7 }, { boxShadow: 'none', offset: 1 }], { duration: 1200 });
      }
      return { ok: true, ...said, x, y, disabled, editable, select };
    }
    if (!cover && hit) cover = hit;
  }
  return { ok: false, why: 'covered', cover: coverOf(cover) };
})(${JSON.stringify(args)})`;
}

const SETTLE_SCRIPT = String.raw`new Promise((done) => {
  let timer = setTimeout(finish, ${ACT_SETTLE_QUIET_MS});
  const cap = setTimeout(finish, ${ACT_SETTLE_MS});
  const watch = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, ${ACT_SETTLE_QUIET_MS}); });
  watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  function finish() { watch.disconnect(); clearTimeout(timer); clearTimeout(cap); done(true); }
})`;

/** Ask the page to do one step for an action on `key` of `owner`'s latest snapshot `token`. */
export async function actOnPage(contents: WebContents, owner: string, token: string, key: number, op: ActOp): Promise<ActAnswer> {
  if (contents.isDestroyed()) return { ok: false, why: 'changed' };
  const answer = (await pageCall(contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: actScript(owner, token, key, op) }]), null, ACT_PAGE_MS)) as ActAnswer | null;
  if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') return { ok: false, why: 'no-answer' };
  return answer;
}

/** Resolves once the page has been quiet a moment (or at once if it went). */
export async function settle(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return;
  await pageCall(contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: SETTLE_SCRIPT }]), null, ACT_SETTLE_MS + 500);
}
