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
 *
 * The guard while text and keys go in is the page preload's (preload/agent-guard.ts), so it's the window's first
 * listener; what a page hides in closed shadow roots is checked through the debugger (control/deep.ts).
 * - `point`: scrolled to the middle of the view (at once), and hit-tested at its middle, then at the middles of its
 *   quarters: the point to send the click to, in the page's CSS pixels, or what covers it (its role and name).
 * - `select`: a text field's contents selected (all of it), so the text `insertText` puts in replaces it.
 * - `choose`: a select's option by its label, set as the fill sets one (the native setter, then input and change).
 * - `settle`: resolves once the page has been quiet ACT_SETTLE_QUIET_MS, at most ACT_SETTLE_MS.
 *
 * Each action outlines its element in the agents' blue for a moment (the Web Animations API: nothing is added to the
 * page), shown and gone at once with reduced motion. Main never waits on a hung page: each call has its own limit.
 */
import { ACT_SETTLE_MS, ACT_SETTLE_QUIET_MS, SNAPSHOT_SCAN, type SnapshotField } from '@chord/core';
import type { WebContents } from 'electron';
import { pageCall } from '../page-call';
import { ASSISTANT_WORLD } from './extract';
import { SNAPSHOT_LIB } from './snapshot';

/** How long a step in the page may take: a busy page answers within it. */
const ACT_PAGE_MS = 3000;

export type ActOp =
  | { op: 'point'; highlight: boolean }
  | { op: 'hit'; x: number; y: number; onlyMove?: boolean }
  | { op: 'select' }
  | { op: 'setValue'; value: string }
  | { op: 'values'; mode: 'remember' | 'compare'; text?: string }
  | { op: 'focus' }
  | { op: 'focused'; guard?: string }
  | { op: 'choose'; option: string }
  | { op: 'describe'; option?: string; refind?: boolean };

/** What the page said. `point`'s x and y are the element's middle in the view, in CSS pixels; `editable`, whether it takes text. */
/** A form's field, as risk needs it (never its value): its description for sensitiveField, and whether it takes text. */
export type ActFormField = SnapshotField & { text: boolean };

/** What the step is, from the page (S18 M2d): main builds core's RiskElement from it (control-risk.ts). */
export interface ActRisk {
  tag: string;
  type: string;
  href: string;
  /** The link's whole address (its origin too), or empty. */
  hrefUrl: string;
  /** What it shows, when that isn't its name (an aria-label over other words): both count, and the card shows both. */
  text: string;
  multiline: boolean;
  submits: boolean;
  /** A link (or one it's inside) whose address couldn't be read: asks, as unknown. */
  hrefUnknown: boolean;
  /**
   * Its form as it would be sent: the submitter's own `formaction` and `formmethod` first; `url`, the whole address;
   * `search`, inside (or itself) `role=search`; its visible search fields and its hidden ones counted; `overflow`, more
   * fields than are listed (or an address that can't be read).
   */
  form: { method: string; search: boolean; searchFields: number; hidden: number; overflow: boolean; action: string; url: string; fields: ActFormField[] } | null;
}

export type ActAnswer =
  | { ok: true; role: string; name: string; x?: number; y?: number; editable?: boolean; select?: boolean; disabled?: boolean; choice?: string; field?: SnapshotField; focused?: boolean; scrollX?: number; scrollY?: number; risk?: ActRisk; changed?: boolean; has?: boolean; others?: number; refound?: boolean }
  | { ok: false; there?: boolean; why: 'stale' | 'changed' | 'covered' | 'no-move' | 'file' | 'bad-value' | 'no-values' | 'no-choice' | 'two-choices' | 'not-select' | 'no-answer' | 'replaced'; cover?: { role: string; name: string } };

/** How long `hit` waits for the page to see the pointer's move (it's sent with the page's next frame). */
const HIT_WAIT_MS = 250;
/**
 * Looking for a ref's node again (the owner's bug #2): at most this many elements, and this long, as the snapshot is
 * bounded (core's SNAPSHOT_SCAN and SNAPSHOT_SCAN_MS): past either, it isn't found.
 */
const REFIND_SCAN = SNAPSHOT_SCAN;
const REFIND_MS = 50;

function actScript(owner: string, token: string, key: number, op: ActOp): string {
  const args = { owner, token, key, hitWait: HIT_WAIT_MS, refindScan: REFIND_SCAN, refindMs: REFIND_MS, ...op };
  return String.raw`(async (args) => {
  ${SNAPSHOT_LIB}
  const read = globalThis.__chordSnapshots && globalThis.__chordSnapshots.get(args.owner);
  if (!read || read.token !== args.token) return { ok: false, why: 'stale' };
  const entry = read.keep[args.key];
  let el = entry && entry.ref.deref();
  // A node the page replaced (a table that redraws, the owner's bug #2): looked for again, once, in this document, by
  // its role, name, place and shape (snapshot.ts' refPath and refShape), shown. Exactly one: the ref is it from now on,
  // and every check below is on it. None, or more than one (two named alike in one place: bug #5), or past the budget:
  // changed, as before. A node that's still here but says something else is never looked for again.
  let refound = false;
  if (entry && (!el || !el.isConnected)) {
    // Only where the action asks (the review of #117): its first look, the look after a card, and the pointer's move.
    // Never once the element is checked and pointed at (the hit test, the step again, the focus, the text, a choice):
    // there a node replaced since is said so (replaced, when it could be found again), and the action starts over from
    // its pointer's move, which looks again (tools.ts; the owner's retest of #117).
    if (entry.path === undefined) return { ok: false, why: 'changed' };
    if (!(args.refind || args.op === 'point')) return { ok: false, why: 'replaced' };
    const started = performance.now();
    let looked = 0;
    let over = false;
    const found = [];
    // Depth first, as the snapshot walks: never into what it skips, what's hidden from assistive tech or not shown, at
    // most 4 shadow roots deep; the cheap checks (its tag, place and shape) before its name; the clock from the start.
    const visit = (parent, shadows) => {
      for (let c = parent.firstElementChild; c; c = c.nextElementSibling) {
        if (over || found.length > 1) return;
        looked++;
        if (looked > args.refindScan || (looked % 16 === 0 && performance.now() - started > args.refindMs)) { over = true; return; }
        if (SKIP.has(c.localName) || String(c.getAttribute('aria-hidden')).toLowerCase() === 'true' || !visible(c)) continue;
        if (refPath(c) === entry.path && refShape(c) === entry.shape) {
          const r = entry.role === 'generic' ? (!roleNow(c) && pointerGeneric(c) ? 'generic' : null) : roleNow(c);
          if (r === entry.role && nameOf(c, r) === entry.name && itemsOf(c) === entry.items && (isField(c) ? visibleField(c, typeOf(c)) : shown(c))) found.push(c);
        }
        if (c.shadowRoot && shadows < 4) visit(c.shadowRoot, shadows + 1);
        visit(c, shadows);
      }
    };
    visit(document.body || document.documentElement, 0);
    if (over || found.length !== 1) return { ok: false, why: 'changed' };
    el = found[0];
    refound = true;
  }
  if (!el || !el.isConnected) return { ok: false, why: 'changed' };
  // The same element as the snapshot described: its role and name now, and on screen. A clickable element by its look
  // (the snapshot's generic: no role, a pointer cursor its parent doesn't give it) is checked by that rule, without the
  // snapshot's other one (nothing keyed around it: this check doesn't walk from the top); the owner's retest of #117,
  // every generic ref was refused, its role compared with none.
  const role = entry.role === 'generic' && !roleNow(el) && pointerGeneric(el) ? 'generic' : roleNow(el);
  if (role !== entry.role || nameOf(el, role) !== entry.name) return { ok: false, why: 'changed' };
  // And in the same items (the owner, 2026-11-24): a node the page patched in place to be another table's Sit out, or
  // moved to another row, is another element, for every step and every ref (one found again or not).
  if (entry.items !== undefined && itemsOf(el) !== entry.items) return { ok: false, why: 'changed' };
  if (!(isField(el) ? visibleField(el, typeOf(el)) : shown(el))) return { ok: false, why: 'changed' };
  // One that opens a file picker now (the page made it one since): never acted on.
  if (opensFiles(el)) return { ok: false, why: 'file' };
  // Found again, and as the snapshot described it: the ref is this element from now on.
  if (refound) entry.ref = new WeakRef(el);
  const disabled = el.matches(':disabled') || String(el.getAttribute('aria-disabled')).toLowerCase() === 'true';
  const editable = el.isContentEditable || (el.localName === 'textarea' && !el.readOnly) || (el.localName === 'input' && !el.readOnly && TEXT_TYPES.has(String(el.type || '').toLowerCase()));
  const select = el.localName === 'select';
  // A field as it is now, for main's sensitiveField: a page can turn a field into a password field after the snapshot.
  const said = { role: entry.role, name: entry.name, ...(refound ? { refound: true } : {}), ...(isField(el) || TYPED.has(role) ? { field: fieldOf(el) } : {}) };
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
  // What the step is (S18 M2d), for core's classifyStep: the element, its link's address, its form and the form's fields
  // (each described as the snapshot describes a field: never a value). Only the page's structure: its words for a
  // button are the snapshot's name, already checked above.
  const riskOf = () => {
    // What a click on it acts on (#112 review 1): a label's control (a label for a submit button submits), else a
    // submit button or link it's inside (a span in a link goes where the link does), else itself.
    // (closestDeep and actTarget: snapshot.ts' SNAPSHOT_LIB, shared with the ref's shape.)
    const target = actTarget(el);
    const tag = target.localName;
    // The type the browser goes by (a button's invalid or missing type is submit), not the attribute as written.
    const type = tag === 'input' || tag === 'button' ? String(target.type || '').toLowerCase() : '';
    // Its form owner; a control in a shadow root has none, so the form around its host (it may submit it by script).
    const formOf = (target.form !== undefined ? target.form : null) || closestDeep(target, 'form');
    // A submit button submits only in a form (a button outside one, the default type or not, is a page's own button).
    const submits = Boolean(formOf) && ((tag === 'button' && type === 'submit') || (tag === 'input' && (type === 'submit' || type === 'image')));
    // An address's words; null when it can't be read (too long, not decodable): unknown, so it asks.
    const addressOf = (url) => {
      try {
        const u = new URL(url, location.href);
        if (u.href.length > 2048) return null;
        return clip(decodeURIComponent(u.pathname + ' ' + u.search), 2048);
      } catch {
        return null;
      }
    };
    // What it shows, when its name says otherwise (an aria-label over other words).
    // A button's words (an input button's are its value); never a field's value, which is what's typed in it.
    const buttonValue = target.localName === 'input' && ['submit', 'button', 'reset'].includes(String(target.type).toLowerCase()) ? target.value : '';
    const shownText = clip(String(target.innerText || buttonValue || el.innerText || ''), NAME_MAX);
    const text = shownText && shownText.toLowerCase() !== String(entry.name).toLowerCase() ? shownText : '';
    // A link, or a link it's inside.
    const link = closestDeep(el, 'a[href], area[href]');
    const linkWords = link ? addressOf(link.getAttribute('href')) : '';
    const multiline = target.localName === 'textarea' || (el.isContentEditable && el.localName !== 'input');
    let form = null;
    // A form's own properties, never what a field named action, method or elements puts in their place (clobbering).
    const formGet = (f, prop) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, prop).get.call(f);
    if (formOf) {
      const SKIPPED = new Set(['submit', 'button', 'reset', 'image', 'file']);
      const TEXTY = new Set(['text', 'email', 'search', 'url', 'tel', 'number', 'password', '']);
      const fields = [];
      let hidden = 0, searchFields = 0, overflow = false;
      for (const f of formGet(formOf, 'elements')) {
        if (!isField(f)) continue;
        const t = typeOf(f);
        if (SKIPPED.has(t)) continue;
        // Hidden fields go with it unseen: counted (a one-field GET form with one is no search), never listed.
        if (t === 'hidden') { hidden++; continue; }
        if (fields.length >= 50) { overflow = true; break; }
        const seen = visibleField(f, t);
        if (seen && t === 'search') searchFields++;
        fields.push({ ...fieldOf(f), text: seen && (f.localName === 'textarea' || (f.localName === 'input' && TEXTY.has(t))) });
      }
      // As it would be sent: a submit button's own formaction and formmethod win over its form's (a GET to a delete
      // address is no search).
      const own = submits && target.hasAttribute('formaction') ? target.formAction : '';
      const method = submits && target.hasAttribute('formmethod') && target.formMethod ? target.formMethod : formGet(formOf, 'method') || 'get';
      const url = own || formGet(formOf, 'action') || location.href;
      const action = addressOf(url);
      form = {
        method: String(method).toLowerCase(),
        search: Boolean(Element.prototype.closest.call(formOf, '[role=search]')),
        searchFields,
        hidden,
        // A form described only in part, or whose address can't be read, is never a search.
        overflow: overflow || action === null,
        action: action || '',
        url: clip(String(url), 2048),
        fields,
      };
    }
    // The link's whole address too (its origin: Neon's review 2 of #112), for the step's shape and what an allowed step lets go.
    const hrefUrl = link ? clip(String(link.href || ''), 2048) : '';
    // A link's own (not a label's control or a button inside one): the target is the element itself.
    return { tag: link && target === el ? 'a' : tag, type, href: linkWords || '', hrefUrl, hrefUnknown: Boolean(link) && linkWords === null, text, multiline, submits, form };
  };
  if (args.op === 'describe') {
    if (args.option === undefined) return { ok: true, ...said, disabled, editable, select, risk: riskOf() };
    if (!select) return { ok: false, why: 'not-select' };
    const index = optionIndex(args.option);
    if (index < 0) return noChoice(index);
    return { ok: true, ...said, disabled, editable, select, choice: clip(el.options[index].label || el.options[index].text, NAME_MAX) };
  }
  if (args.op === 'focus') { el.focus({ preventScroll: true }); return { ok: true, ...said, focused: deepFocus() === el }; }
  if (args.op === 'focused') {
    const focused = deepFocus() === el;
    // The guard's mark (agent-guard.ts): this element, and only while it has the focus, is the one input may reach.
    if (focused && typeof args.guard === 'string' && /^chord-guard-[0-9a-f]{32}$/.test(args.guard)) el.dispatchEvent(new CustomEvent(args.guard, { bubbles: true, composed: true }));
    return { ok: true, ...said, focused };
  }
  // setValue (#112, the owner's hand test): a field that isn't text (a time, a date, a color, a range) set to a value,
  // as the fill sets one (the native setter, then input and change); one the browser won't take (out of range, not its
  // format) is refused, and nothing is changed.
  if (args.op === 'setValue') {
    if (el.localName !== 'input') return { ok: false, why: 'changed' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const before = el.value;
    setter.call(el, String(args.value));
    if (el.value !== String(args.value)) {
      setter.call(el, before);
      return { ok: false, why: 'bad-value' };
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, ...said };
  }
  // values (#112): every field's value in the page, remembered before text goes in, then compared: whether this field
  // changed (or now holds the text), and how many others did. The values never leave the page; only the counts do.
  if (args.op === 'values') {
    const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);
    // Every field the text could have gone to: in the document, in its open shadow roots and its same-origin frames
    // (each walked as deepFocus walks the focus), and every editing host, plaintext-only ones too (#112 review 2).
    const fields = [];
    const walk = (root, depth) => {
      if (depth > 8) return;
      for (const f of root.querySelectorAll('*')) {
        if (f.shadowRoot) walk(f.shadowRoot, depth + 1);
        if (f.localName === 'iframe' || f.localName === 'frame') {
          let inner = null;
          try { inner = f.contentDocument; } catch { inner = null; }
          if (inner) walk(inner, depth + 1);
        }
        if (f.localName === 'input') { if (!SKIP_TYPES.has(String(f.type).toLowerCase())) fields.push(f); }
        else if (f.localName === 'textarea' || f.localName === 'select') fields.push(f);
        else if (f.isContentEditable && !(f.parentElement && f.parentElement.isContentEditable)) fields.push(f);
      }
    };
    walk(document, 0);
    const valueOf = (f) => (f.localName === 'input' || f.localName === 'textarea' || f.localName === 'select' ? String(f.value) : String(f.textContent));
    if (args.mode === 'remember') {
      globalThis.__chordValues = new Map(fields.map((f) => [f, valueOf(f)]));
      if (!globalThis.__chordValues.has(el)) globalThis.__chordValues.set(el, valueOf(el));
      return { ok: true, ...said };
    }
    const kept = globalThis.__chordValues;
    globalThis.__chordValues = null;
    if (!kept) return { ok: false, why: 'no-values' };
    let others = 0;
    for (const f of fields) if (f !== el && kept.has(f) && kept.get(f) !== valueOf(f)) others++;
    const now = valueOf(el);
    return { ok: true, ...said, changed: kept.get(el) !== now, has: typeof args.text === 'string' && args.text !== '' && now.includes(args.text), others };
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
  // button going down would send the move then, and its handlers would run after this test. A pointer that was at the
  // point already (a second click there) gets no move: "there" says so, and main moves it off and back, which the
  // page must see too ("onlyMove": just the move seen, no test). The moves are watched from point on (the watch stays
  // until a test passes), so one that arrives before this script runs is seen too.
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
    // Replaced while the move was awaited (a page that re-renders): said so, and the action starts over (tools.ts).
    if (!el.isConnected) return { ok: false, why: entry.path !== undefined ? 'replaced' : 'changed' };
    if (!arrived) {
      const was = moved && moved.before;
      return { ok: false, why: 'no-move', ...(was && near(was) ? { there: true } : {}) };
    }
    if (args.onlyMove) return { ok: true, ...said };
    const hit = deepest(args.x, args.y);
    if (!ours(hit)) return { ok: false, why: 'covered', cover: coverOf(hit) };
    if (moved) { removeEventListener('mousemove', moved.listen, true); globalThis.__chordMoved = null; }
    // Where the page is scrolled to: the debugger's hit test takes the document's coordinates.
    return { ok: true, ...said, scrollX, scrollY };
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
        addEventListener('mousemove', (e) => { if (e.isTrusted) pointer.at = { clientX: e.clientX, clientY: e.clientY }; }, true);
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
