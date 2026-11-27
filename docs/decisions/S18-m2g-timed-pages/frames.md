# Acting inside same-site frames (#210): design and threat checklist

Part of #209. **Status: PR 1 (read only) shipped in #320. PR 2 (click and hover) is #347, in review; Argon's design pass on it is folded in (*PR 2: Argon's design pass*, below). PR 3 (text, keys and choices) follows.** Argon cleared the design (2026-11-26) after its round-1 blockers; their changes are in *Argon's review: what changed*, and folded into the sections they touch.

## Outcome and Done when (#210)

An agent can read and act inside a frame of the same site (an embedded form), instead of seeing an empty box.
- The snapshot shows a same-site frame's contents with refs. Other-site frames still read `[contents not accessible: another site]`.
- A click or typing inside the frame passes the same checks as the page: the site card, risky steps, the Fetch hold, and input classified by `isAgentInput`.
- Fixtures: a same-site frame with a form, a nested frame, and a frame that navigates to another site mid-task (refused as stale).

Out of scope: other-site frames, `embed` and `object`.

## Where things are today

The snapshot runs in Chord's world (4400) of the **main frame** only.
- A frame is a node, `- iframe "Title"`, never entered (`snapshot.ts:471`).
- `[contents not accessible: another site]` is set when `contentDocument` can't be read (`:451`).

Every acting check assumes one document:
- **`act.ts`:** `point` clamps to the top viewport and hit-tests with the top `elementFromPoint`, and a hit on any frame is never the element's (`FRAMES`, `:354`). `hit` listens for the top window's `mousemove`. The focus checks start at the top `document.activeElement`. `riskOf` resolves addresses against the top `location`.
- **`deep.ts`:** the debugger's hit test rewrites any hit inside a child frame to the frame's owner element, so it says *covered* (`:209-216`). It keeps one Chord world per tab, the main frame's (`:121-182`).
- **The input guard:** in agent tabs every frame has the preload. A frame's guard (`installFrameGuard`) stops **every** trusted key and insertion while it's up, on the premise that agent input is only ever for the top document. `page.ts` talks to the main frame's guard only (`inPreload`). `pressSeen` counts the top window's mouseups.
- **Already right:**
  - **The Fetch hold:** covers every frame, same process or not (`sends.ts:5`).
  - **`isAgentInput`:** per tab, frame-blind, and needs no change.
  - **`values`:** already walks same-origin frames (`act.ts:296`).

## Decision 1: "same site" is same origin, for this slice

The snapshot's world can reach a frame's document only when it's of the **same origin** as the top page: `contentDocument` readable. That's what this slice opens:
- a frame at a same-origin address;
- `srcdoc` and `about:blank` frames, which inherit the top's origin;
- frames nested in those, at most 3 deep.

**Still `[contents not accessible: another site]`:**
- a frame of another subdomain of the same registrable site (`a.example.com` in `www.example.com`): `contentDocument` is null;
- a sandboxed frame without `allow-same-origin` (an opaque origin, never the same site: S18 :832);
- every other site.

**Why:** reaching a cross-origin frame needs per-frame script runs and per-frame worlds (`WebFrameMain`, or the debugger), a second design. Every frame this slice opens shares the top's origin, so the **site card, the risky-step cards and the Never sites stay the top's**: the frame can't be another site.

**Decided** (the owner, via the planner, 2026-11-26): same-origin first. This is an ordering call, not a scope cut. Frames of another origin on the same site, and sandboxed frames, are **#275**: per-frame worlds, with the site card, the risky cards and the Never sites deciding per frame.

**Why the top's site card covers a same-origin frame, and why that's safe:**
- The card asks *may the agent act on this site*, and the frames this slice opens are of **the top's own origin**: same scheme, host and port.
- Anything inside them is already that site's own code and content. The page could put the same form in its top document with the same powers, since a same-origin frame and its parent can reach into each other's documents and run each other's scripts.
- So the card the user answered for the top covers exactly what the frame can do.
- **Never sites:** a Never site can't be a frame of another origin's page here, since that frame is cross-origin, which this slice never reads. A Never site's own same-origin frames are never reached, because its top is never read.
- **What leaves the frame:** sends are held by their **destination**, not their frame (`sends.ts`), so a frame posting to another site still raises the card for that site, as the top's form would.
- **Where it stops being safe:** a frame of another origin, even one on the same site. A subdomain can be another party (a user-content host, a third party's CNAME), and there the top's card would be answering for someone else. That is why those frames wait for #275, where cards decide per frame.

## Decision 2: agent tabs only (decided, 2026-11-26)

Your own tabs (the assistant acting on a tab you have open) have no preload in their frames (`preload/page.ts:148`), so no guard there. There:
- the snapshot shows a same-origin frame's contents, read-only (no refs);
- an action on anything inside a frame stays refused, as now.

## The design

**Snapshot** (`snapshot.ts`):
- The walk enters a same-origin frame's `contentDocument.body` as the frame node's children, at the same depth rules, within the same scan, time and ref budgets.
- Each ref kept inside a frame records its **frame chain**: each `<iframe>` element on the way down and the document it held then, as WeakRefs.
- `wait_for` and the refind walk frames the same way, so a ref inside a frame can be found again inside the same frame.

**Staleness:**
- Every step checks the chain first: each recorded `<iframe>` is still connected, and its `contentDocument` is still the recorded document.
- A frame that navigated (to another site or not), was removed or was replaced makes the ref stale.
- This closes the gap where an element of a navigated-away document still says `isConnected`.

**Pointing** (`act.ts`):
- The element's rect is translated out frame by frame: each `<iframe>`'s rect, its border (`clientLeft`/`clientTop`) and its padding.
- Any frame on the chain with a CSS transform, or a zoom that isn't 1, is refused (*Chord can't place the pointer there*): fail closed, never a guessed point.
- The point is clamped to each frame's viewport and to the top's.

**The page's hit test:** the top `elementFromPoint` must land on the chain's first `<iframe>`. Inside it, that frame document's `elementFromPoint` at the local point must land on the next `<iframe>`, and so on down to the element.
- A frame put over the point that isn't on the chain is still *covered* (the cover named by its title), as now.
- `FRAMES` stays a refusal everywhere except "the recorded frame, at this level of the chain".

**The pointer's move:** awaited on the frame's own window (same origin, so reachable).

**The debugger's hit test** (`deep.ts`):
- `DOM.getNodeForLocation` already returns the node inside the child frame. Instead of rewriting it to the owner element, the climb checks each frame boundary against the ref's chain, then checks the node is the element or inside it.
- That node is resolved into the main frame's Chord world, the context deep.ts already keeps: Spike A showed it is the very element the ref holds.

**Focus, select, text and keys:** `deepFocus` starts from the element's own document's `activeElement`, and the top's `activeElement` must be the chain's first `<iframe>`. `select` uses the element's own document and window.

**The guard:**
- The frame holding the element arms the same rule as the top: input only for the marked element. Its guard already hears the mark's `CustomEvent`, since DOM events cross worlds.
- Every other frame, and the top, still stop everything while the guard is up.
- `unguard`, `keySeen` and `pressSeen` add up the counts from the frame that holds the element. Main asks that frame's guard through the debugger, in the frame's preload-world context (Spike B).

**Risk** (`riskOf`): addresses are resolved against the element's own document (`ownerDocument.baseURI`), and a form with no action posts to that document's URL. Same origin, so the same site, but the right path.

**read_tab by part, and boxes:** parts inside frames get no box ref in this slice: read-only through the snapshot, as now.

## Argon's review: what changed (2026-11-26)

### Before PR 1

**B1. Same origin by origins, not by a readable document.** A frame is entered only when `window.origin !== 'null'` and `iframe.contentWindow.origin === window.origin`, and its `contentDocument` is readable.
- `window.origin` is the tuple origin, which `document.domain` never changes. A subdomain that relaxed `document.domain` to the parent's stays *another site* (#275).
- An opaque top (a CSP `sandbox` page: `window.origin === 'null'`) never enters any frame, `srcdoc` and `about:blank` included.
- Each nested frame is compared with the top's origin, never only its parent's.

**B2. An editor frame is one field.** A frame whose document is an editor (`designMode === 'on'`, or its body or root element editable) is shown as the top's editor page is:
- one `textbox`, named by its labels (the iframe's title), `[empty]` or `[filled]`;
- never walked, so what's typed never reaches the outline;
- `wait_for`'s text search never looks inside it.

**B3. F8's plumbing, in PR 1.**
- `page.snapshot` takes `frameRefs`. It's true only for an outside agent's own tab: no lease (`!scope.act?.lease`) and `mayAct` clear. Elsewhere (the assistant in your tab, a tab shared with an agent), a frame's contents are read with **no** `key`: no ref inside any frame.
- `tools-act.ts` also refuses a frame ref whenever there's a lease, as a second line.
- F8's tests (unit and E2E) are in PR 1. The "outline flag" in the note was this flag, not #204's `outlineOnGo`.

**B4. A frame that isn't shown isn't entered.**
- A frame is entered only if the `<iframe>` itself is `shown` (at least a few pixels, not put off the page) as well as `visible`, and so is every frame on its chain. A 0×0 frame, or one at `left:-9999px`, is listed without contents.
- `shown(el)` and `visibleField` measure against the element's own window (`el.ownerDocument.defaultView`: its `innerWidth`, `innerHeight`, `scrollX` and `scrollY`), never the top's globals.

**B5. Staleness checks each document on the way.** One shared check (in `SNAPSHOT_LIB`, called by `act.ts` and all three places in `deep.ts`: `openDeep`, `CHECK_FN` and `open()`), for every link *i* of the chain:
- `frame_i.isConnected`;
- `frame_i.ownerDocument === doc_(i−1)` (the top's `document` first);
- `frame_i.contentDocument === doc_i`.

Then `el.isConnected && el.ownerDocument === lastDoc`, where `lastDoc` is the top's `document` for a ref with no chain. A live node moved (adopted) into a frame, out of one, or between frames is stale, and so is a frame moved into another document. `press_key` never calls `deep.hit()`, so `open()` checks it too.

**B6. Place and items stop at the frame; frames are part of a ref's identity.**
- The walk starts a new ancestor chain at each frame's document. `placeOf` and `itemsAt` are then within `el.ownerDocument`, as `refPath(el)` and `itemsOf(el)` climb, so a frame ref is never "changed" on its own path.
- The ref's frame chain (each frame's snapshot node index) is part of the twin signature and of the snapshot id (`sidOf`). Buttons alike in two sibling frames are never twins. A node adopted into another frame gets a new id.
- The refind looks only in the ref's own last document.
- F12's test removes Left's button and keeps Right's: Left's ref is changed, Right's is never touched. (In PR 1 every frame action is refused; the test checks the answer is *changed*, never *not yet* or *ambiguous*, and that nothing in Right is pressed.)

### Before PR 2

**B7. Pointing through frames.**
- The element's rect is clipped to each frame's viewport (`[0, innerWidth] × [0, innerHeight]` of each window) as it's translated out to the top.
- `hit` awaits the pointer's move on the element's own window and compares it with the **frame-local** point, translated back down the chain.
- The `±3 px` move-off for `no-move` goes in the direction that stays inside the frame.
- Refused (*Chord can't place the pointer there*):
  - any `transform`, `scale`, `rotate`, `perspective` or a zoom that isn't 1 (`currentCSSZoom`) on the element, on each `<iframe>` on its chain, or on **any of their ancestors** (climbing through shadow hosts);
  - zoom or transform on a parent `div` (they aren't inherited, so checking the iframe alone misses them).

### Before PR 3

**B8. One guard in every frame of an agent's tab.**
- Every frame, the top included, runs the same guard. While an action's guard is up (`chord:agentGuard`), it stops every trusted key and insertion and reports `page:agentGuardStopped`, until main arms that one frame (`arm(until, mark)`, through the action's debugger session in that frame's preload world, with `awaitPromise: true`). That frame then takes input only for the marked element.
- So focus stolen to the top or to another frame is stopped and reported (*moved*), never typed.
- `unguard` and `dropAgentGuard` disarm the target frame and drop the block in every frame.
- The target frame's `watchPress`, `pressSeen`, `guard`, `keySeen` and `unguard` are methods on the open `DeepSession`, never a second `withDebugger`, which would deadlock. The frame is identified by `DOM.describeNode` on the ref's checked chain, never by URL or title.
- A script-made `about:blank` frame that was never navigated: Spike B's follow-up checks whether it has the preload world. If not, typing and keys there are refused (fail closed).

### Should-fix and nit

**SF1. Watching frames** (PR 1 for `wait_for`, PR 2 for settling):
- `wait_for`'s observer watches each entered frame's document, as it does open shadow roots, so a change there wakes it at once.
- After an action on a frame ref, settling watches that frame's document too, and a navigation of that frame counts as the action's: the diff waits for its load.

**SF2. Focus through nested frames and shadow roots** (PR 3). `deepActive(doc)` climbs `activeElement` through open shadow roots. Focus is the element's only if:
- `deepActive(document)` is the chain's first `<iframe>`;
- `deepActive(doc_i)` is the next `<iframe>` at every link;
- `deepActive(lastDoc)` is the element;
- `lastDoc.hasFocus()`.

**SF3. Test gaps**, each now in the threat table:
- **F1 (PR 1):** a closed shadow root inside a frame, and an off-screen frame and a 0×0 frame.
- **F10 (PR 1):** a card form's fields in a frame are described as the top's are (the same `sensitiveField` and the same line).
- **F3 (PR 2):** a decoy frame over the **target frame**.
- **F4 (PR 2):** a CSS-zoomed frame, and a frame in a transformed or zoomed `div`.
- **F5 (PR 3):** focus stolen on `keydown` (for `press_key`) and on `beforeinput` (for `type`).

**N1. Frame realms.** `setValue`, `choose`, `riskOf` and `shapeOf` use the element's own window's prototypes (`el.ownerDocument.defaultView.HTMLInputElement.prototype`, and the rest), never the top's. Checks use `nodeType` and `localName`, never `instanceof` (Spike C).

## PR 1's review (#320, rounds 1 and 2: Fable and Neon)

**Fixed in PR 1:**
- **SF1:** frame refs only where nothing is against acting (`mayAct(node) === null`): a tab shared with an outside agent reads frames with no ref, as a tab of yours does.
- **SF2:** an editor frame's field is labelled by its frame's name, so a "Card number" or "Password" editor frame is that sensitive field, as at the top (no ref; said what it is). **PR 3:** the action's own field description (`said.field`) must do the same.
- **SF3:** each frame on a ref's chain records its name and the items it's in; a frame retitled in place, or moved into another item with `moveBefore` (its document kept), answers *changed*, never *not yet*.
- **N1, then NSF2 (Neon, superseding it):** a frame is a frame by its tag (`iframe` or `frame`), whatever role the page gives it, in the snapshot, `wait_for` and the chain check alike. A frameset's frames and a `role=presentation` iframe are read; a `role=button` iframe is a frame, never a button with a ref; a `role=region` iframe of another site still says *another site*. A frame's own children (its fallback, never rendered) are never walked or read.
- **N5:** a frame of the top's origin that isn't read says why: `[contents not read: not shown]` or `[contents not read: too deep]`, never left to look empty.
- **NSF1 (Neon):** `wait_for` treats an editor frame as the snapshot does: one textbox named as its frame, matched by that line alone. Its text, its non-editable islands and its direct text are never read or watched, and a chip inside it is no button to wait for.
- **NSF3 (Neon):** a document hidden at its root (its `html` or `body`: `hidden`, `aria-hidden="true"`, `inert`, or not shown by `display`, `visibility` or `opacity`) is never read, by the snapshot or `wait_for`. A frame's says `[contents not read: not shown]`; a top's reads as empty.
- **NSF4 (Neon):** tests that `shown()` is the frame's own: a fixed button past the frame's width gets no ref, one scrolled out of the frame's view still does, and `wait_for` never sees into a frame that isn't shown.
- **NN1 (Neon):** an editor frame's field counts toward what's looked at, and when the ref budget is full it's cut (`cut.refs`), never silently given no ref.
- **NN2 (Neon):** a find over the snapshot stops at a frame: a control in a frame is `in iframe "Payment"`, never in an item outside the frame.
- **NN3 (Neon):** the chain helper (one check shared by the snapshot's look and `deep.ts`) and the frame-realm prototypes (*N1. Frame realms* above) move to PR 2, where they're first used.
- **With #273 (rebased onto it):** a row's identity (`rowLabel`) never reads a frame's children (its fallback, never rendered), as NSF2 says; a frame ref keeps its row and its frames in its id and twin signature.
- **Round 2, S1 (Fable):** an editor frame's field is labelled by both its frame's name and its own label, so a "Notes" frame whose body is a "Card number" field, or an untitled frame whose body is a "Password", is that sensitive field (no ref). **PR 3:** the action's own field description (`said.field`) must use both too.
- **Round 2, S2 (Neon and Fable):** a frame's fallback is in no control's name either: `words()` (forms.ts) skips `iframe` and `frame`, inside a button, a label, a link, a heading, or an `aria-labelledby` target.
- **Round 2, S3 (Fable):** at the top, `aria-hidden` on `html` or `body` doesn't count as hidden: it hides nothing on screen, sites set it by mistake, and WebKit and Firefox ignore it there. `hidden`, `inert` and CSS still do. In a frame, `aria-hidden` at its root still means not shown (NSF3). At the top, the root check is now a second layer: the walk's own checks already skip a `hidden`, `inert` or CSS-hidden body, so reverting the top's root check alone changes no test.
- **N2:** the CSP-sandboxed top's fixture pins that those frames stay unread. Chord's world can't read their documents there, so it can't test the `'null'` guard itself. The `document.domain` fixture is what tests B1's origin check.

**Measured** (Fable, a 4-CPU slot; invariant 9):

| Page | Snapshot |
| --- | --- |
| A flat page | 43–52 ms |
| The same content in 300 frames | 85–115 ms |
| 1,500 frames | 166–175 ms, cut (the budgets hold) |
| 20 one-megabyte editor frames | 12–14 ms (an editor frame is never walked) |

With a frame mutating every millisecond, `wait_for`'s watching kept the page at 252 of 300 timer ticks.

## Limits (PR 1)

- **A frame hidden by an ancestor** (its own box shown, an ancestor `display: none` or `visibility: hidden` above the iframe) is entered: `shown()` checks the iframe, not every ancestor's style.
- **`-webkit-user-modify` text** (an editor by CSS alone, no `contenteditable`) is read. This predates frames: the top reads it too.
- **`allow-same-origin` sandboxed frames** are of the top's origin, so they're entered. Their text is page text, inside the untrusted envelope like the rest.
- **`read_tab`** (the page read, and parts) never reads frames' contents.
- **Frame-first starvation.** The walk takes frames in document order on the same budgets as the top, so a page that puts many frames before its own content can spend the budgets in them. The cut is reported (`cut.refs` or the node cut), never silent.
- **`wait_for` across a frame's navigation** isn't woken by the new document's changes until the next 1 s poll re-walks (the observer was on the old document).
- **`blob:` frames** read like `srcdoc` ones (same origin, entered). **PR 3** must check that the preload guard covers them before typing into one.
- **Depth past 40** is clamped by the core's find (`depthOf`), as at the top; with `FRAME_DEPTH` 3 a frame adds little, but a deep page inside a frame reaches the clamp sooner.
- **A frame moved within the same item** (a `moveBefore` reorder, its document kept) still answers *not yet*, not *changed*: the chain records the frame's name and items, not its position. PR 2 owes position.
- **A frame hidden at its root when `wait_for` first looks** isn't watched: un-hidden, it's met at the next 1 s poll, not at once.
- **`content-visibility: hidden` on a frame's body:** its direct text is read by the snapshot and `wait_for`; its elements are skipped. Likely the same at the top.
- **A frame that turns editor mid-wait** stays observed, but nothing in it is read.
- **A top hidden at its root** (`hidden`, `inert`, or CSS on its `html` or `body`) reads empty, with the note that it may still be loading; the agent calls again.
- **A body hidden by `visibility: hidden`** with a child set back to `visibility: visible` is still unread: the document is treated as hidden, the safe side.
- **PR 2 owes** the row check for a frame ref (#273's `rowChanged` and `rowEmpty`, within the frame's own document: `act.ts` answers *not yet* before it today), and the chain check in `deep.ts` (its hit test and its look: `openDeep`, `CHECK_FN`, `open()`) and the `tools-act` refusal of a frame ref under a lease (the snapshot already gives none).

## PR 2: Argon's design pass (#347, 2026-11-27)

Click and hover act on a frame ref; text, keys and choices stay *not yet* (PR 3). What the pass changed:
- **B1:** the act's first look answers `inFrame`, and `tools-act` refuses right after it, before any site or step card, for what PR 2 doesn't do (type, press_key, select_option) and for any frame ref in a tab of yours (B3, F8). `act.ts` still refuses focus, focused, select, choose, setValue and values in a frame.
- **B2:** the pointer's moves are watched on the element's own window (a frame's never reach the top's, and its coordinates are its own). `hit` asks again, after the move's handlers have run, whether anything is bent and whether the point is still the element's through the live chain. The off-and-back nudge for a second click stays inside the frame's visible box.
- **B3:** `deep.ts`' check climbs a hit out of other documents through each frame's element (a decoy frame says *frame "Decoy"*). A hit in a frame that can't be resolved into Chord's world (another site's, a sandboxed one) is named by its frame's element, out to the nearest that resolves: *covered*, never *couldn't check*. `hit` gives the top window's scroll.
- **B4:** `riskOf` reads addresses against the element's own document's base, and a form through its own window's prototypes.
- **B5:** a replaced node in a frame is looked for again in the frame's own document.
- **SF1:** an action's settle waits for any frame's navigation it started (the main frame's alone counts as navigated), and watches the readable frames of the page's own origin.
- **SF2:** each frame's viewport without its classic scrollbars, and its content box; the hit test top-down through each level, open shadow roots pierced; bent means a `transform`, `scale`, `rotate`, `translate`, `perspective`, `offset-path` or a zoom anywhere from the element up, through each frame and its ancestors.
- **SF3:** each frame on a chain records its name, items, unnamed row, place among its ancestors (`refPath`) and index among its sibling frames; any of them changed is *changed*.
- **Nits:** the deep session needs its ref, not its node (a node replaced since answers *replaced*, for the retry); an editor frame's ref has `row: ''`.

**Limits (PR 2):**
- **A right-to-left frame with a classic scrollbar on its left:** the frame's offsets don't include it; if the shift is wider than the element, both hit tests fail closed (*covered*).
- **A vertical writing mode** on a frame's root: coordinates stay the viewport's; scrolling may differ.
- **SVG filter displacement** moves pixels, not boxes: both hit tests agree on the layout box.
- **B4's base and realm** have no test that tells them apart from the top's: a frame of the page's own origin resolves a form's action the same either way in every fixture tried.

## Spikes (run 2026-11-26, Linux container, an agent's tab; a throwaway spec, not committed)

The probe page:
- `/top` holds a same-origin frame `/inner` (5 px border and 7 px padding, inside a 13 px padded box);
- `/inner` holds a nested `/nested`;
- `/top` also holds a `srcdoc` frame, an `about:blank` frame filled by the top's script, and a `sandbox="allow-scripts"` frame of the same address.

Chord's world (4400) in the top touched each frame's DOM and kept WeakRefs, as a snapshot would.

- **C. Process placement: holds.** `WebFrameMain.processId` is the same for the top, `/inner`, `/nested`, `about:srcdoc` and `about:blank`, all with the top's origin. The sandboxed frame has origin `null`, **another process**, and `contentDocument === null` from the top's world, so it stays *another site* by the existing check. The snapshot's WeakRefs into same-origin frames' documents work (`ownerDocument` is the frame's document). Elements are their frame's realm's (`instanceof f.contentWindow.Element`, not the top's `Element`), so checks must use `nodeType`/`localName`, never `instanceof` against the top's classes.
- **A. The debugger's context: the simplest option works.** `DOM.getNodeForLocation` at the translated point returns the inner button, with the child frame's `frameId`. `DOM.resolveNode` of that node into the **main frame's Chord world** (the context deep.ts already keeps) returns the very element the WeakRef holds (`this === __probe.deref()`): no per-frame contexts needed.
  - Each touched frame also gets its own Chord-world context, from which `top.__probe` is reachable (same world id, same origin).
  - Resolving into any other world (the page's own, Electron's preload world, Playwright's utility world) gives another wrapper, never the same object. The identity check can only pass in Chord's world, and a page script can't interpose.
  - So deep.ts keeps its one context. The change is the climb: instead of rewriting a child-frame hit to its owner element, it accepts a hit whose frames are exactly the ref's chain.
- **B. Main to a subframe's guard: the debugger.** Every frame has Electron's preload world ("Electron Isolated Context", world 999) as a debugger context, and `WebFrameMain` has no `executeJavaScriptInIsolatedWorld` (only `executeJavaScript`, the page's world, never used).
  - **Choice:** the frame holding the element is armed and read through `Runtime.evaluate` in **that frame's preload-world context**, through the action's debugger session (deep.ts, already open for every action). That's the same shape as `inPreload` for the top. The mark goes only from main to the preload world (never the page's), so "only main knows the mark" holds.
  - The frame's guard needs a small API there (`arm`/`disarm`/`seen`/`pressMark`), like the top's. Today `installFrameGuard` exposes none.
  - The context is identified by its frame id and Electron's world name. A page can't make an isolated world.
  - The IPC round trip (`chord:agentGuard` with a nonce) stays the fallback; it's asynchronous and needs a reply channel.
- **The translation:** the frame's rect, plus `clientLeft`/`clientTop`, plus computed padding, plus the element's rect in the frame. The top's `elementFromPoint` gave the frame; the frame's `elementFromPoint` at the local point gave the button; the debugger's hit test gave the same button.

**Nothing broke an assumption.** One addition to the design, from C: no `instanceof` across frames.

## Threat checklist

| # | Threat | Answer | Test (fixture) |
| --- | --- | --- | --- |
| F1 | A page reaches the agent with a control it wasn't shown, through a frame | Refs only for what the snapshot shows; a frame's contents are walked under the same rules (hidden, inert, `aria-hidden`, closed roots, budgets); a frame that isn't itself shown is never entered (B4); an editor frame is one field (B2) | `/frame-form`: hidden, `aria-hidden`, inert and a closed root's buttons have no ref. `/frame-hidden`: a 0×0 frame and an off-screen frame have no contents. `/frame-editor`: one textbox; its typed text is never in the outline |
| F2 | A frame navigates (to another site) between the snapshot and the act; or a node or frame is moved to another document | The chain's check, each link's document and owner (B5): stale, nothing done | `/frame-goes`: cross-site, same-site, and removed: each stale. `/frame-adopt`: a live top button moved into a frame, and a frame's button moved to the top: each refused, nothing pressed |
| F3 | A frame put over the point (a decoy, an ad) | Only the chain's own frames count at each level; any other frame is *covered* | PR 1: a same-origin decoy frame over a top button still covers it. PR 2: a decoy frame over the **target frame** is refused |
| F4 | The pointer lands somewhere else (a wrong translation) | Both hit tests must find the element at the point; the move is compared frame-locally; a transform or zoom on the element, a frame, or any ancestor is refused (B7) | PR 2: a frame in a padded, bordered, scrolled box acts; a transformed frame, a zoomed frame, and a frame in a transformed or zoomed `div` are refused |
| F5 | Typed text or a key lands in another frame or the top | One guard in every frame (B8): only the armed frame accepts, for its marked element; the rest stop everything and report it | PR 3: focus stolen to the top on `keydown` (press_key) and on `beforeinput` (type): the focus-moved refusal, nothing typed elsewhere |
| F6 | What the frame sends | Unchanged: the Fetch hold covers every frame; the card names the destination sites | The frame's form posts to another site: held, and the card asks |
| F7 | Risk judged from the wrong document | `riskOf` resolves against the element's own document | A frame's form with no action: the step's address is the frame's URL |
| F8 | The assistant, in your tab (or a tab shared with an agent), acts in a frame | `frameRefs` false there: a frame's contents with no ref; `tools-act.ts` refuses a frame ref under a lease (B3) | PR 1. Unit: the snapshot script gets `frameRefs` true only for an agent's own tab; a frame ref under a lease is refused. E2E (assistant-acting): your tab's frame contents are read, with no ref inside |
| F9 | A sandboxed, another-origin or opaque-top frame read | Entered only when the frame's origin equals the top's, which isn't `'null'` (B1) | `/frame-other`: sandboxed and another origin are unread. `/frame-opaque`: a CSP-sandboxed top with a `srcdoc` frame is unread |
| F10 | Passwords and card fields in a frame | `sensitiveField`, unchanged; a frame's field is described as the top's are | PR 1: `/frame-card`'s fields read as the same form's do at the top. PR 2: Pay now asks the risky card, as at the top |
| F11 | A huge frame (or many) | Counted in the same scan, time and ref budgets; at most 3 nested | A frame with 25,000 nodes: cut, and said so |
| F12 | Re-finding into another frame, or twins across frames | The refind looks only in the ref's own document; frames are part of a ref's identity (B6) | `/frame-twins`: Left's button removed, Right's kept: Left's ref is changed, never Right's button. `/frame-swallows`: a top ref moved into a frame is changed |

## Fixtures

All of them are in `agents-shared.ts` (and `/framed` in `assistant-acting.spec.ts`).

**PR 1:**
- `/frame-form`: a frame with a form, plus hidden, `aria-hidden`, inert and closed-root buttons, and a region.
- `/frame-nested`: four levels.
- `/frame-goes`: navigates on demand.
- `/frame-other`: a sandboxed frame, and another origin.
- `/frame-opaque`: a CSP-sandboxed top.
- `/frame-hidden`: a 0×0 frame and an off-screen frame.
- `/frame-editor`: an editable body, and `designMode`.
- `/frame-adopt`: live nodes moved in and out.
- `/frame-swallows`: a top button moved into a frame.
- `/frame-twins`: Left's button removable.
- `/frame-late`: draws when told.
- `/frame-huge`: 25,000 nodes.
- `/frame-card` and `/card-top`: the same card form in a frame and at the top.
- `/frame-decoy`: a decoy over a top button.

**PR 2:**
- `/frame-moved`: add a zoomed frame and a frame in a transformed or zoomed `div`.
- `/frame-decoy`: add a decoy over the target frame.
- `/frame-post`: posts to another site, and a form with no action.

**PR 3:**
- `/frame-steals`: steals focus on `keydown`, and on `beforeinput`.

## Size, and a proposed split

This touches `snapshot.ts`, `act.ts`, `deep.ts`, the guard (`preload/agent-guard.ts`, `page.ts`) and `tools-act.ts`. It's a large, risky change. Proposed as three PRs, each with its own review:
1. **Read:** the snapshot shows same-origin frames' contents with refs; every action on a frame ref is refused (*not yet*). Includes B1 to B6: the origin check, editor frames, `frameRefs`, shown frames and the element's own window, the chain check, and per-document place and identity. Also `wait_for` watching frames (SF1), and F1, F2, F8, F9, F10, F11 and F12.
2. **Click and hover:** pointing and both hit tests (Spike A, B7), settling (SF1), the frame realms (N1), and F3, F4, F6, F7 and F10's card.
3. **Text, keys and choices:** one guard in every frame (B8), focus through frames (SF2), select, and F5.

Spikes A, B and C have run (above); PR 2 uses A, and PR 3 uses B.
