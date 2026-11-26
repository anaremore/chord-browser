# M2d's follow-ups (#115): design and threat checklist

Follow-ups from the S18 M2d final security pass (#112), under its stop rule: none blocks M2d. **Status: revised after Argon's design review (2026-11-26, *revise first*); its blockers go back to Argon before code.** Nothing here is built yet. #210 comes first in order. The review's changes are in *Argon's review: what changed*, and the threat table is updated.

Each item below was checked against main on 2026-11-26.

## 1. Favicons in agent tabs: open

**Today:** `TabManager.loadFavicon` (`tabs.ts:652`) fetches the page's icon with `contents.session.fetch(url)`:
- it uses the tab's session, so it sends its cookies, `SameSite=Lax` and `Strict` included;
- it's outside the Fetch hold, since main's own fetch isn't the page's;
- it never asks `isNeverReadable`.

In an agent's tab, the page names the icon's address. That makes a request with the agent session's cookies to any address the page chooses: a send no card ever asks about, which can also ping a Never site.

**Design:** in an agent's tab (`agentPage`), the icon is fetched with **no credentials** (`credentials: 'omit'`, and no cookies), and only when it is **the page's own origin**. Another origin's icon, or a Never site's, is never fetched (the tab shows the default icon); `data:` icons are unchanged. Your own tabs are unchanged.

**Spike (run 2026-11-26, container, an agent tab's session with a `Lax` and a `Strict` cookie set): it does.** The default fetch, `same-origin` and `include` each sent `sid=lax; strict=yes`; `credentials: 'omit'` sent no cookie.

## 2. `giveBackFocus` (`control/page.ts:420`): open

**Today:** after an action, the focus goes back to `before.page` if nothing else took it. It never checks that `before.page` is still **shown**. If you switched tabs during the action (in the same window), the page that had the focus may be hidden now, and a hidden page with the keyboard's focus takes your typing unseen.

**Design:** `focusToGiveBack` also requires `before.page` to be a visible pane of that window now, as `window.ts` checks for its own focus moves. Otherwise the focus goes to the shown page, or nowhere. It stays a pure function, with a unit test.

## 3. `window.print()` in an agent tab: PR 2 (#115)

**Today:** nothing stops it. The page's `window.print()` (any frame's) opens the native print dialog for a tab you can't see: a window that isn't the agent's, outside every card. It also blocks the page (and the debugger's commands to it time out: `user-watch.ts:12`).

**Design:** in an agent's tab, `print` is refused and reported to the agent as held (`page:agentHeld`, kind `print`): *The page tried to print; Chord doesn't print for agents.* This is the same path as a dialog or a file picker it held.

**Spike (run 2026-11-26, container; a fresh agent tab per case; nothing armed but the stub):**
- **Baseline:** `window.print()` in an agent tab blocks its renderer (Chord's world stops answering): the dialog is up.
- **The stub:** the debugger's `Page.addScriptToEvaluateOnNewDocument` (`runImmediately`) puts a non-configurable `window.print` and a wrapped `Document.prototype.execCommand` (refusing `print`, any case) into **every new document**, fresh `about:blank` frames included. Each case left the renderer answering:
  - `window.print()`;
  - `delete window.print`, then printing (it's non-configurable);
  - `Window.prototype.print` (there is none);
  - a script-made blank frame's `print()`, and that `print` called on the top;
  - a `srcdoc` frame's `print()`;
  - `document.execCommand('print')`, also as `'PRINT'`, after `delete`, from a fresh frame's document, and that frame's `execCommand` called on the top;
  - `execCommand('copy')` still works.
- **Without `execCommand`'s wrapper**, `document.execCommand('print')` opens the dialog: a bypass, so the wrapper is needed.
- **Another site's frame** (its own process) calling `print()`: the top's renderer kept answering even without the stub, so the probe can't tell whether a dialog opened there. The design covers it anyway: the hold already auto-attaches every out-of-process frame before it runs (`pickers.ts`), and the same script is added on each of those sessions. A probe on the frame's own process is needed before PR 2.
- **The preload alternative** (world 999 rewriting the page's world) wasn't taken: a script-made `about:blank` frame gets no preload before the page can reach it, while the debugger's script reached it in every case above.

**Design, from the spike:** the hold (`pickers.ts`), when it arms a tab or auto-attaches a frame's session, adds the stub as a new-document script before the page runs. The stub reports each attempt through a `Runtime.addBinding` (rate-limited) as `page:agentHeld`, kind `print`. *(Superseded by Argon's B3: the stub reports through a cancelable event the preload passes on, never `Runtime.addBinding`, which `deep.ts`' `Runtime.disable` drops.)*

## 4. E2E: a keepalive POST held by a card, then the tab closed: open (the test)

**Today:** round 4 of #112 tests a page closed by the agent sending nothing on its way out (`agents-acting.spec.ts:804`), with no card up. Not tested: a send already **held** with its card showing, then the tab closed (by you, or the agent). Chromium must never resume a paused request when the debugger detaches, and the card must go.

**Result against main (run 2026-11-26, container): it passes.** With the Send data card up for a `keepalive` POST to another site, closing the tab (the agent's `close_tab`, and your row's ×) sent nothing in the 2 s after; the card went, and the click answered *The user said no to this step*. So item 4 is a test only. **Design:** add it as a regression test:
- a page whose button sends a `keepalive` POST to another site;
- the agent clicks it, and the Send data card shows;
- the tab is closed (both ways, the agent's `close_tab` and the user's);
- then wait 1.5 s: nothing arrived, and the card is gone.

If something arrives, that's a bug in the hold's teardown (`sends.ts`): fail the request (`Fetch.failRequest`) on close, before detaching.

## 5. Reloading a crashed agent tab: PR 2 (#115), part 1 not needed on Electron 45

**Today:** an agent's tab is never reloaded on its own after a crash (`tabs.ts:538`). It shows "This page stopped", its hold is lost, and acting there is refused. But a reload **you** start (its Reload button, or the menu) loads the page first: the hold is armed again only at `did-finish-load` (`pickers.ts:295`). What the page sends while it loads goes out unheld, with the agent's session.

**Design:** reloading an agent's tab whose hold is lost goes through the hold: arm first, then load, the same as a new agent tab (`framesReady`: the page loads once its hold is on). In practice:
- `TabManager`'s reload, for an agent's tab with `pickersLost`, awaits the arm before `contents.reload()`;
- any other path that loads in it (back, forward, the address bar) goes the same way, or is refused while the hold is down.

## Argon's review: what changed (2026-11-26)

### PR 1

**B1. A favicon that redirects.** In an agent's tab:
- **Which icon:** the first candidate that is `data:` or the page's own origin, so an earlier icon of another origin never shadows a good one.
- **The fetch:** `session.fetch(url, { credentials: 'omit', redirect: 'error' })`. A redirect anywhere, the page's own origin included, fails, and the tab keeps the default icon.
- **Never sites:** checked for the page before the fetch, and again for the tab's address after it (the tab may have gone on meanwhile).

**B2. The focus never stays on the hidden agent's tab.** `focusToGiveBack` takes whether `before.page` is still shown in its window, and the window's shown page now (its active tab's contents, or the shell), as `window.ts`'s `keepFocusOffParked` does. The answer:

| `before.page` | `now.page` | The focus goes to |
| --- | --- | --- |
| still shown | nothing, or the agent's tab | `before.page` (as now) |
| no longer shown | the agent's tab | the window's shown page, never left on the agent's tab |
| no longer shown | nothing | the window's shown page |
| any | a page of yours | left there |

"Shown" means the window's visible panes (`AppWindow`), never `contentView.children`, which holds parked and hidden views too.

**SF1. A held send when its tab goes.**
- **Order on close:** `TabManager.destroy(nodeId)` fails what the hold holds (`failHeld(contents)`) **before** it closes the page, while the debugger is still attached. Today the store's subscriber destroys the view first, so `AgentChords.letGo` finds no page.
- **Detach or crash:** `sends.ts` listens for the debugger's `detach` and `render-process-gone`. On a crash, what's held fails and the cards come down. On a detach nothing can be failed any more (Chromium resumes what it paused for a detaching client: Opus showed the keepalive POST arriving), so the cards come down and a late answer counts for nothing.
- **The invariant (#322):** Chord never calls `debugger.detach()` while `holding(contents)`; `failHeld` comes first. Every detach in main is of Chord's own attachment (behind `mine`), and the lease's `turnOff` runs only after `failHeld` or `unholdSends`. `invariants.test.ts` enforces both.
- **The item 4 tests** (E2E) cover both cards: in an action (the click's page sends at once; #322, Opus's N1) and between actions (a page's own timer sends after the action answered). Each is closed by the agent and by you. Both pass without the fixes too (Chromium drops a closing tab's keepalive POST), so they're regression guards; the unit tests pin the fixes.

### PR 1's review (#322, round 1: Neon and Opus)

**Fixed:**
- **B1:** a page of yours closed during the action is never "still shown": the focus goes to the page the window shows. What's shown is read after the action, with the focus (`shownFor`).
- **B2:** the favicon path takes the page's kind as `wire()` latched it, never the tab's now (a kept or closing tab), and a page no longer the tab's fetches nothing and dispatches nothing.
- **B3 (Neon) and S1 (Opus):** the unit tests pin SF1. The fake debugger's detach is real (no command reaches the page after it). The card's signal aborts, a late *Allow* lets nothing go, and the crash (`render-process-gone`) is tested between actions and during an action. The detach invariant above is new, and `giveUp` (user-watch.ts) now fails what's held before its detach.
- **SF1 (Neon) and S2 (Opus):** `window-shown` uses `shownHere`'s rule, now the pure `shownIn`: the shell, a pane on screen and not hidden, the command bar while open, Peek on screen, a docked DevTools; never a parked or hidden pane. The cards count only while you own them (`cardsOwner === 'you'`), the menu never. The page it gives the focus to is `giveFloatingFocusBack`'s. The window unregisters when it closes; pages are read through `pageOf`.
- **SF2:** an agent's page closed, or gone on to a Never site, by the time its icon comes back keeps none.
- **SF3:** quitting (`AgentChords.dispose`) ends *Allow until done* and fails what each agent's tab holds, at once.
- **Nits:** `/^data:/i`; the invariants audit's favicon line; the destroy-order test checks the page `failHeld` gets; an E2E check that the own-origin icon fetch carries no Cookie; `loadFavicon` unit tests with a stubbed `session.fetch` (Opus's N2).
- **Not here (Opus's P1, pre-existing):** your own tabs' favicon fetch carries your cookies; the planner files it as its own issue.

**Limits (PR 1):**
- **Same-origin, credential-less GETs.** An agent's page can still make Chord fetch an icon of its own origin, with no cookies, as its own GETs go today (the GET model).
- **A favicon event racing a navigation to another site.** The pick uses the address when the event fires; the result is kept only if the page is still on that site, and never on a Never site.
- **Windows that aren't an AppWindow** (none registered): the focus goes back as before #115.

### PR 2

**B3. The print stub, built so a page can't get around it** (`PAGE_LACKS`, `agent-scripts.ts`, which the hold already adds to every new document of an agent's tab before its scripts run):
- **Intrinsics:** captured when the stub installs, before the page runs: `Reflect.apply`, `Object.defineProperty`, `String`, `String.prototype.toLowerCase`, and the original `execCommand`.
- **`window.print`:** non-writable, non-configurable.
- **`Document.prototype.execCommand`:**
  - also non-writable and non-configurable;
  - it turns its first argument into a string **once**, through the captured intrinsics;
  - it refuses `print` (any case), and passes that same coerced string, never the raw argument, to the original with the rest. A `toString` that answers *copy*, then *print*, can't slip past.
- **Reporting:** through the preload, which already runs in every frame of an agent's tab and reports dialogs and file pickers over `page:agentHeld` (with `senderFrame`). The stub fires a `CustomEvent` that the preload's world listens for and passes on, rate-limited. An unnavigated script-made `about:blank` frame, with no preload, falls back to its parent's.
  - Not `Runtime.addBinding`: `deep.ts`'s `Runtime.disable` drops bindings.
  - `'print'` is added to `AgentHeld` and `heldFromFrame`.
- **Workers** have no `print` or `document`: nothing to do there (a comment says so).

**What PR 2 found:** another site's frame (its own process) printing blocks its own renderer without the stub; with it, that renderer answers, and the agent hears that a frame from that origin tried to print. The stub reaches it through the hold's script on each auto-attached frame session.

**B4. A crashed agent's tab, reloaded.** There are three parts.

**What PR 2 found (Electron 45.5.0, the container):** part 1's gap doesn't happen. The hold's debugger session survives the renderer crash (`debugger.isAttached()` is still true 200 ms after your Reload), and its new-document scripts carry over to the reloaded page: its first inline script already finds no `SharedWorker` or `serviceWorker`, and `print` non-configurable. The agent's own `navigate` on its crashed tab is refused before anything loads, and nothing the new page would send reaches the server. So part 1 isn't built; two E2Es (agents-m2d.spec) guard both paths, and fail if either regresses. Part 2 is #333's (#326): it routes the remaining direct loads through `TabManager`'s gate and lists every direct load outside tabs.ts with its reason. Part 3 holds as it is: after your Reload the agent hears that you're using the tab. The agent's refusal on a crashed tab now says so (`ACT_REFUSALS.crashed`), never that a DevTools window may be busy.
1. **Arm before the load.** A crashed renderer can't take the renderer-side commands, so a reload of a crashed agent's tab:
   - arms the browser-side hold first (`Target.setAutoAttach`, `Fetch.enable`);
   - starts the navigation;
   - while its main-frame `Document` request is paused (the new renderer exists by then), runs the renderer-side part (`Network.setBypassServiceWorker`, `PAGE_LACKS` as a new-document script, `Page.setInterceptFileChooserDialog`);
   - then lets the request go.
2. **Every load goes through `TabManager`.** Reload, hard reload, back, forward and the address bar, from the sidebar, the menus, the context menu, devtools, *Try again*, `site.reload`, search by image, Safe Browsing's guard and the agent's own `navigate` and `back`. None calls `contents.reload()` or `loadURL()` on an agent's tab directly, so none can skip the arming. A guard test lists the direct calls.
3. **Whose sends, after you reload** (the planner's call):
   - Your *Try again*, or your reload of a crashed agent's tab you're looking at, is a **take-over**, the same as any navigation you start there: the agent is paused, and the tab is yours from here (`takeOver`, `'user'`).
   - The hold still arms before the load (part 1), so nothing goes out as the agent's, and what the page holds (a dialog, a file picker) is held as before.
   - `AgentChords.whose()`: once the new document has committed (`leaving.committed`), its requests are no longer the outgoing page's (`'none'`, dropped). They're whoever's the tab now is: yours after a take-over, the agent's otherwise.

## Threat checklist

| # | Threat | Answer | Test |
| --- | --- | --- | --- |
| M1 | An agent's page makes Chord send its session's cookies to an address it picks (the favicon), or a redirect does | Agent tabs: the first `data:` or own-origin icon, no credentials, no redirects, Never checked before and after | Unit: no fetch for another origin's or a Never site's icon; an own-origin icon after another origin's is the one fetched; the fetch has `credentials: 'omit'` and `redirect: 'error'`. E2E: a `localhost` icon never reached; an own-origin icon that redirects to `localhost`: the redirect never followed |
| M2 | Your typing goes to a hidden page after an action, or stays on the hidden agent's tab | Back only to a page still shown; else the window's shown page, never the agent's tab | Unit: `focusToGiveBack`'s table, each row |
| M3 | A print dialog opens for an agent's hidden tab | The stub in every new document: `print` and `execCommand` non-configurable accessors (a setter that ignores: a page's own wrapping never throws), the command coerced once; reported through the preload | E2E (agents-m2d): `print()` from the page, after `delete`, a script-made frame's (and that one called on the top), a `srcdoc` frame's, another site's frame's; `execCommand('print')`, `'PRINT'`, after `delete`, a fresh frame's (and on the top), a `toString` that changes; a page that wraps either in strict code; a print 1.2 s after the action answered. Each: the renderer answers, the page goes on, and the agent hears it. `execCommand('copy')` still works; the wrapper keeps native's shape (one argument; a Symbol throws) |
| M4 | A held send resumes when its tab closes, or its debugger lets go | Failed before the page closes; and on detach or crash, the cards answered no | E2E: a card in an action (the click's page sends at once) and one between actions, each with the tab closed by the agent and by you: nothing arrives, the card goes (regression guards). Unit: `destroy` fails held before it closes; a detach and a crash, between actions and in an action; quitting |
| M5 | A crashed agent tab's reload loads before it's held | Not built on Electron 45.5.0: the hold's debugger session and its new-document scripts survive the crash (see B4). The agent's actions on a crashed tab are refused, said as a tab that stopped working (`crashed`, or `crashedAfter` once input went in); every load goes through `TabManager`'s gate (#333) | E2E (agents-m2d): an agent's tab crashed (`forcefullyCrashRenderer`), then your Reload: the new page's first script finds the hold's script in place, and the agent hears you're using the tab. The agent's `navigate` on its crashed tab: refused, nothing sent. Unit (control.test): a crash before the press says nothing was done; after the click, after typed text, or once a load started, that the step may have gone in |

## Size

Five small items. Proposed as two PRs:
1. Items 1, 2 and 4: favicons, the focus check, and the keepalive test.
2. Items 3 and 5: print and the crash reload. Both need a spike first, and both touch the hold's arming.
