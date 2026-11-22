/**
 * Acting on a page, the page's side (S18 M2c; core's control-act.ts has the rules, tools.ts the tool). A script in the
 * isolated world (4400), as the snapshot's, finds a ref's element in its owner's latest snapshot (control/snapshot.ts)
 * and checks it again before anything is sent: still connected, still shown, still the role and name the snapshot gave
 * it (SNAPSHOT_LIB, the same rules). Then, by what's asked:
 *
 * - `describe`: what it is (disabled, takes text, a select), and the role and name the snapshot gave it.
 * - `focus`: focused, for a key pressed in it.
 * - `point`: scrolled to the middle of the view (at once), and hit-tested at its middle, then at the middles of its
 *   quarters: the point to send the click to, in the page's CSS pixels, or what covers it (its role and name).
 * - `select`: a text field's contents selected (all of it), so the text `insertText` puts in replaces it.
 * - `choose`: a select's option by its label, set as the fill sets one (the native setter, then input and change).
 * - `settle`: resolves once the page has been quiet ACT_SETTLE_QUIET_MS, at most ACT_SETTLE_MS.
 *
 * Each action outlines its element in the agents' blue for a moment (the Web Animations API: nothing is added to the
 * page), shown and gone at once with reduced motion. Main never waits on a hung page: each call has its own limit.
 */
import { ACT_SETTLE_MS, ACT_SETTLE_QUIET_MS } from '@chord/core';
import type { WebContents } from 'electron';
import { pageCall } from '../page-call';
import { ASSISTANT_WORLD } from './extract';
import { SNAPSHOT_LIB } from './snapshot';

/** How long a step in the page may take: a busy page answers within it. */
const ACT_PAGE_MS = 3000;

export type ActOp = { op: 'point'; highlight: boolean } | { op: 'select' } | { op: 'focus' } | { op: 'choose'; option: string } | { op: 'describe' };

/** What the page said. `point`'s x and y are the element's middle in the view, in CSS pixels; `editable`, whether it takes text. */
export type ActAnswer =
  | { ok: true; role: string; name: string; x?: number; y?: number; editable?: boolean; select?: boolean; disabled?: boolean; choice?: string }
  | { ok: false; why: 'stale' | 'changed' | 'covered' | 'no-choice' | 'not-select' | 'no-answer'; cover?: { role: string; name: string } };

function actScript(owner: string, token: string, key: number, op: ActOp): string {
  const args = { owner, token, key, ...op };
  return String.raw`((args) => {
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
  const said = { role: entry.role, name: entry.name };
  if (args.op === 'describe') return { ok: true, ...said, disabled, editable, select };
  if (args.op === 'focus') { el.focus({ preventScroll: true }); return { ok: true, ...said }; }
  if (args.op === 'select') {
    el.focus({ preventScroll: true });
    if (isField(el)) el.select();
    else { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    return { ok: true, ...said };
  }
  if (args.op === 'choose') {
    if (!select) return { ok: false, why: 'not-select' };
    const want = String(args.option).replace(/\s+/g, ' ').trim();
    const index = [...el.options].findIndex((o) => !o.disabled && clip(o.label || o.text, NAME_MAX) === want);
    if (index < 0) return { ok: false, why: 'no-choice' };
    if (el.selectedIndex !== index) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(el, index);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, ...said, choice: want };
  }
  // point: to the middle of the view, then the hit test at its middle and its quarters' middles.
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const left = Math.max(r.left, 0), top = Math.max(r.top, 0), right = Math.min(r.right, innerWidth), bottom = Math.min(r.bottom, innerHeight);
  if (right - left < 1 || bottom - top < 1) return { ok: false, why: 'changed' };
  const within = (hit) => {
    for (let n = hit; n; n = n.parentNode || n.host) if (n === el) return true;
    return false;
  };
  const deepest = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
    return hit;
  };
  const w = right - left, h = bottom - top;
  const points = [[left + w / 2, top + h / 2], [left + w / 4, top + h / 4], [left + (3 * w) / 4, top + h / 4], [left + w / 4, top + (3 * h) / 4], [left + (3 * w) / 4, top + (3 * h) / 4]];
  let cover = null;
  for (const [x, y] of points) {
    const hit = deepest(x, y);
    if (hit && within(hit)) {
      if (args.highlight) {
        const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches;
        const ring = '0 0 0 3px oklch(0.55 0.12 250 / 0.9), 0 0 0 7px oklch(0.55 0.12 250 / 0.18)';
        el.animate(quiet ? [{ boxShadow: ring }, { boxShadow: ring }] : [{ boxShadow: ring, offset: 0 }, { boxShadow: ring, offset: 0.7 }, { boxShadow: 'none', offset: 1 }], { duration: 1200 });
      }
      return { ok: true, ...said, x, y, disabled, editable, select };
    }
    if (!cover && hit) cover = hit;
  }
  // What covers it, by its nearest named ancestor with a role.
  for (let n = cover; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
    const r2 = roleNow(n);
    if (r2) return { ok: false, why: 'covered', cover: { role: r2, name: nameOf(n, r2) } };
  }
  return { ok: false, why: 'covered', cover: { role: cover ? cover.localName : 'element', name: '' } };
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
