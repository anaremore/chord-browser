# S18 M2g-1: fast enough for timed pages (plan, 2026-11-24)

Part of S18 (agents act on pages; the earlier slices are in `../S18-agent-mcp.md`). The threat checklist is in `threat-checklist.md`; Neon reviews the design before code.

The owner, on a real-time online table (main plus #117): the agent played a full hand at a bot table, but at a live table it was too slow for the action timer, so it was auto-folded and then unseated. Each move took a snapshot, a click and screenshots, several seconds in all, and a click sometimes still hit a re-render. The agent itself suggested the changes below. #143 (a tool call times out on the client while a card waits) is the same layer and goes in this slice.

**Measure first.** For snapshot, click and type on the redraw fixtures (`/table`, `/game`, `/moves`): p50 and p95 of each step inside Chord (from the tool call arriving to its answer), split by phase (lookup, describe, card, point, hit, deep checks, press, settle), plus the round trip through the relay as an agent sees it. Measured before any change and after each, in the Linux container (X11 and Wayland). Where the seconds go decides the order of the work below.

**What changes (to be settled with Neon's review):**
1. *Target by role and name.* `click`, `type`, `press_key`, `select_option` and `hover` take `{ role, name }` instead of a `ref`, resolved when the action runs. The page is walked as the snapshot walks it (the same rules for what's shown and what counts as acted on), and the element must be the only one with that role and that name. Optionally `within` names an item (a row, region or dialog by its role and name). Then it's an element like a ref's, and every check after is the same: the site card, the step classified from what's found, the step card for a risky step, the step checked again before input, the hit test and the guard.
2. *`wait_for`.* It returns when a text, or an element with a role and name (and `within`), appears or disappears in the tab's page, or when its timeout runs out (at most 30 s; default 10 s). It answers only yes or no and how long it took, never page content.
3. *A compact snapshot with each action's result.* Optional (`snapshot: true` on an action), it's the page's outline after the action has settled, bounded (refs and characters) and cut the same way `snapshot` is, so the next step needs no extra call.
4. *#143, card waits.* A tool call waiting on a card answers before the client's timeout: *Waiting for the user to approve on Chord's card. Try the same step again in a moment.* The card stays up, and the user's Allow is kept for that exact step (the late Allow `stepKey`), so the retry goes straight through, once. Where a client sends a `progressToken`, Chord sends MCP progress notifications to keep the call alive instead.

## Acceptance: as effective, for as few tokens (the owner, 2026-11-24)

The owner asked how agents can control Chord just as well while costing as few tokens as possible. This is the same work as being fast enough for a timed page: every extra call is another model turn, and the model re-reads its whole context each turn.

- **The gate is effectiveness:** every eval journey succeeds as often as before. No token cut lands if any journey's success drops.
- **The score is tokens and wall time:** total result tokens, tool calls, and seconds, for each journey.
- **Measured first:**
  - Each tool result's size (bytes, and tokens at about 4 characters each) is kept per step, next to its phases (`control/phases.ts`).
  - The eval journeys, each on a fixture: the bot game's hand, the timed table, a 20-field form, a page that draws itself after it loads, and a 300-row list. For each one: success, tool calls, result tokens, wall time.
  - Their table goes in this record before and after each change.
  - CI gets a budget on result tokens per journey (tokens are deterministic; ms on shared runners aren't).
- **What's tried, each measured against the table:**
  1. *A diff after an action* (default for click, type and press): what changed since the agent's last snapshot (nodes added, removed, changed, with refs kept), not a whole outline.
  2. *`wait_for`* (built: slice b), returning the outline (and then a diff) when its condition is met: no polling, no sleeps.
  3. *Smaller snapshots:*
     - a scope (a subtree by ref, or interactive elements only);
     - repeated rows collapsed (*row × 300, first 5 shown*, with a cursor for more);
     - terse lines (role, name, ref, state);
     - no page text unless asked, and capped when it is.
  4. *Screenshots by exception:* an element or region, downscaled, JPEG or WebP. The tool's description says a snapshot is cheaper and usually enough. Measured in tokens per screenshot, before and after.
  5. *Fewer calls:* an optional batch of steps in one call (type then Enter, or several fields), returning one diff. Every step keeps every gate (cards, the send hold, the guard), and the batch stops at the first refusal.
  6. *The tool list's cost:* its descriptions go with every request, so they're measured and trimmed to the least that keeps every journey's success.

### The token eval: baseline (2026-11-24, before any cut)

agents.spec's *the token eval* plays each journey through the relay, counting every result's content as the model gets it (tokens at about 4 characters each). Linux container, X11:

| Journey | Success | Tool calls | Result tokens | Wall (s) |
|---|---|---|---|---|
| Bot game, one hand (Call, a bet of 20 with Enter, Raise) | yes | 8 | 790 | 4.5 |
| Timed table, two turns (wait_for with snapshot, then Call) | yes | 5 | 476 | 3.7 |
| A 20-field form | yes | 22 | 1,610 | 5.5 |
| A page that draws itself after it loads | yes | 5 | 371 | 1.1 |
| A 300-row list (click row 150) | yes | 3 | 10,291 | 0.4 |
| The tool list (sent with every request) | | | 1,962 | |

Where the tokens go:
- One snapshot of a 300-row list is about 10,000 tokens: collapse repeated rows, and scope.
- The tool list's 1,962 tokens go with every request, so a 10-call journey pays it 10 times: trim it.
- A 20-field form takes 22 calls: batch steps.

**After the first cuts** (same journeys, every one still succeeding):

| Journey | Tool calls | Result tokens | Change |
|---|---|---|---|
| Bot game, one hand | 8 | 817 | (diffs after actions next) |
| Timed table, two turns | 5 | 476 | wait_for (slice b) already |
| A 20-field form | 3 (+1 batch that stops at a bad ref, checked) | 736 | **batch**: 22 → 3 calls |
| A page that draws itself | 5 | 371 | (#154's first look, once on main) |
| A 300-row list | 4 | 484 | **rows collapsed, find**: 10,291 → 484 tokens |
| The tool list | | 2,290 | +328 for batch and find |

- **Rows collapsed, and `find`:** past 8 rows alike (the same roles and shape), the outline shows the first 5 and says how many more. `find` gives only the elements named so, with what they're in and their refs, which stay good.
- **`batch`:** up to 20 element steps on one tab in one call, each through the same layer as its own call (every check, card, the send hold and the guard). It stops at the first refusal, saying which step and what went before it, and gives one compact answer.
- **The tool list is now the largest fixed cost** (2,290 tokens with every request). Trimming its descriptions needs a gate that a scripted journey can't give: whether a model still picks the right tool. That needs a model-in-the-loop eval (a real agent on these fixtures), which costs model usage: the owner's call.

**After the diff** (every journey still succeeding):

| Journey | Tool calls | Result tokens |
|---|---|---|
| Bot game, one hand | 8 → **6** (one snapshot, then the diffs) | 790 → 789 |
| Timed table, two turns | 5 | 476 → 500 |
| A 20-field form | 4 | 736 → 997 (its last step's diff lists the 20 fields filled) |
| A page that draws itself | 3 | 214 |
| A 300-row list | 4 | 490 |

- **Refs that stay:** the page keeps its own id for each element, per agent (a WeakMap in Chord's world). A ref is made from it, numbered above every ref the tab had on pages before, so an element still there keeps its ref and an old ref never names another page's element. A replaced element gets a new one.
- **The diff after an action** (the default for click, type, press_key, select_option and hover; a batch's at its last step): what changed since the agent's last snapshot of the page, as outline lines, new (+), changed as they are now (~), gone (-), inside the result's untrusted envelope. Past 60 lines, it says to call snapshot. With no snapshot of the page to compare with, none. `wait_for` with `snapshot` gives a diff too, when there's one to compare with.
- **What the agent saw stays good:** a diff takes a snapshot, so the page and the tab's refs keep the agent's own last snapshot (pinned until its next) and the last 4 a diff took. A ref from any of them names its element there, and one the page replaced is found again from there, under #117's rules. A ref from before the agent's next snapshot of its own, or from before a navigation, is stale, as before.
- *Tests:*
  - core control-snapshot.test: refs that stay; a replaced element's ref; another page's ids; the diff's +, ~ and -; which snapshots are kept.
  - control.test: the diff in an action's result; a navigation makes refs stale.
  - agents.spec: the eval and every journey.

The connection also logs each result's size (`result <tool> <chars> ~<tokens>`), and `agentResultSizes` reads them per tool.

## After Neon's design review (2026-11-24, through 7c4e271)

Each claim checked against the code; what was decided, and where Neon's reading was off.

- **B1, a step card retried after *waiting*:** confirmed. Step cards never joined (`cardKey` adds a counter), so a retry opened a second card while the first stayed up, and the first card's late Allow stayed usable. Late entries were also deleted before their address was checked.
  - **Fixed in slice (a):**
    - A retry joins the step's card still up when no call waits on it (`openSteps`). Two calls waiting at once still get a card each, so one Allow runs one action.
    - Any action that runs on a tab spends that tab's unspent step late-Allows (`dropLateSteps`, from tools.ts).
    - A late Allow asked from another address is kept for its own page, not lost.
  - *Tests:* control.test, *a step's retry after waiting joins its card…* and *…is spent when another action runs on its tab…*. Both failed on the old gate.
- **B2, the card budget:**
  - *Send data cards:* confirmed. A Send data card asked late in a call got the 5 s floor and then dropped what the page sent. Send data cards now take `scope.sendWaitMs`, the full 45 s, never the call's budget. *Test:* control.test, *a Send data card waits its own full wait…*.
  - *The floor:* "blows past the 50 s cap" was 5 s past, still under Codex's 60. The floor is 1 s now.
  - *Repro with a real client (Claude Code 2.1.331, headless `-p`, a stdio server that answers after 70 s or 130 s):*
    - Both calls completed, at 70 s and 130 s; the client never cancelled.
    - It sends a `progressToken` on every `tools/call`, and a `server/discover` request before `initialize`.
    - So a single 45 s card doesn't fail headless Claude Code.
    - What the owner saw (*MCP task … failed*) is the interactive session's 2-minute background move, or a client bug there. It isn't reproduced yet; the owner's interactive version and transcript line are needed for that.
  - *The decision:*
    - Progress notifications stay: the real client asks for them, and they count as activity.
    - The 50 s budget stays for connection, site and step cards. A risky first action on a new site chains a site card and a step card (90 s), past Codex's documented 60 s default. That's not reproduced in Codex yet, and it's on the measurement list.
- **B3, name spoofing (`aria-label`):** agreed. Name targeting accepts an element only when its name is what the user sees: its own visible text, a visible `<label>`'s text, or a button's value.
  - A name from `aria-label`, `aria-labelledby` or `title` refuses (*use snapshot and a ref*).
  - Exact match only, never empty.
  - The role allowlist: button, link, checkbox, radio, switch, tab, menuitem, option, combobox, listbox, textbox, searchbox, spinbutton, slider, and **generic**. The game's controls are pointer `div`s, so generic is included; its name is always its own text.
- **B4, name-resolved targets:** agreed.
  - They live in their own slot (per agent and tab, one target at a time) and never replace the snapshot's refs.
  - The step key becomes a JSON tuple (delimiter-safe), binding the target's item chain, place, visible text and `stepShape`.
  - The walk finds every match (no first-match shortcut) and refuses at its cap. A `within` that matches more than one item refuses.
  - Sensitive fields and file inputs are refused for every acting tool, as with refs. *Checked:* describe's sensitive-field refusal already applies to every tool (tools.ts), and file openers never get a ref (`opensFiles`). Name targeting uses the same checks.
- **B5, `wait_for`:** agreed on all of it.
  - The check is throttled by a timer: `max(150 ms, 4× the last walk)`. One wait per agent at a time.
  - The client's cancel reaches the tool: `notifications/cancelled` aborts the call. *Confirmed:* connection.ts's `cancel` signal never reached `runControlTool`, so this fix is needed for any long tool.
  - Cancel, Stop, the tab taken or a navigation tear down the page's observer.
  - The text match uses SNAPSHOT_LIB's visibility rules and never reads fields.
  - A cut walk never proves `disappear`.
  - `blockedNow` is checked before, during (each wake) and after.
  - Scope: outside agents only (not the assistant); its own tabs and shared tabs, under `read_tab`'s rules. While it waits, the bar says *“Codex is waiting on this page”*.
- **B6, the snapshot after an action:** agreed.
  - It comes in its own untrusted envelope, apart from Chord's status.
  - A diff is only of the redacted outline, never across page IDs or origins.
  - It's bounded, falling back to a compact snapshot.
  - Its refs are issued normally (the tab's latest snapshot), and a compact slice of them is returned.
  - Order changed: **`wait_for` with `snapshot: true` comes first.** It saves a whole model turn per move; a snapshot after a click comes after.
- **The waits after each action (should-change):** confirmed. After each action Chord sleeps `NAVIGATION_START_MS` (150 ms) for a navigation to start, then waits for the page to be quiet for 100 ms, at most `ACT_SETTLE_MS` (500 ms). A table that redraws never goes quiet: 650 ms an action. The repeat-click hit wait (`HIT_WAIT_MS`, 250 ms) adds more. To measure first, then: start the navigation wait and the settle together, end the settle at a quiet frame, not 100 ms of no mutations, and end the hit wait on the move being seen, not the timer.
- **`tab_screenshot`:** measure the PNG encode and its size; consider JPEG or a smaller scale; check whether SVG or canvas game cards force screenshots, where the outline shows nothing.
- **Progress hygiene (S4):** done in slice (a). A beat names a card only when it's this call's (its tab's, or the agent-wide connection card). The token must be a string of at most 256 characters or a finite number, or no beats are sent. Beats stop on the client's cancel. *Tests:* agent-chords.test, *progress names a card only when it's this call's…*; agents.test, *progress reaches the client through the relay…*.
- **`pushState` against a real navigation (S3):** `wait_for` and the snapshot treat a same-document navigation as the same page (page ID), with its own test.

**Required measurements before slices b–d** (Neon's §4):
- The real-client repro: Claude Code headless done above; interactive, and Codex, still to do.
- A per-phase latency breakdown on the redraw fixtures, p50 and p95.
- `wait_for`'s CPU cost and wake-up latency on a page mutating every frame.
- An end-to-end move budget against a 15 s turn clock: snapshot, the agent's thinking (not ours), an action, its settle, and the next state.

## Measured (slice a, 2026-11-24)

The owner's preview (main plus #117) played a full hand at a bot table. At a live table with a shot clock it was folded: each move took several seconds, and the agent polled with `Start-Sleep 10` in a shell between turns, having no way to wait for its turn.

**The acceptance journey:** agents.spec's *a timed table…* has a fixture with a 15 s shot clock. Your turn comes after the others' (3 s); the action controls are pointer `div`s re-rendered every 100 ms, shown only on your turn; out of time, you're folded. It plays five turns as an agent does today (a snapshot every 500 ms until the controls show, then Call) and reports where each move's time goes, from `control/phases.ts` (laps kept only with the E2E hooks on, read by `agentPhaseTimes`). With `wait_for` (slice b), the same journey waits instead of polling, with no sleeps.

**Chord's share of a move** (Linux container, X11, medians):

| | Before | After the settle change |
|---|---|---|
| Snapshot | 4 ms | 4 ms |
| Click | 279 ms | 179 ms |
| …its look, point, debugger and checks | 2, 4, 1, 20 ms | the same |
| …the settle after it | 251 ms | 151 ms |
| Turn start to Chord's click done (no model thinking) | 570 ms | 369 ms |

- *Where the seconds go:* not in Chord. A move costs Chord about 0.2 s. The rest of the clock is the agent's own turns: a model round trip for each snapshot it polls with, the thinking, and a shell sleep between. `wait_for` with `snapshot: true` takes the polling out: one call returns when it's the agent's turn, with the outline.
- *The settle change:* the page's quiet is now waited for alongside the 150 ms wait for a navigation to start, not after it: 100 ms off every action.
- *Still to measure:* the agent's real round trip through Claude Code and Codex (the model's own time, separate from Chord's), `wait_for`'s CPU cost and how fast it wakes, and `tab_screenshot`.

## Slice (b): wait_for (built, 2026-11-24)

- **The tool:** `wait_for` waits for a text, or an element by its role and exact name, to show in the tab (or, with `gone`, to stop showing), for at most `timeout_ms` (30 s; 10 s by default). It answers `met` and `waited_ms`, and with `snapshot` true, the tab's outline and refs as `snapshot` gives them. It's for outside agents only; the assistant isn't offered it.
- **How it looks:** with the snapshot's rules (`waitScript`, SNAPSHOT_LIB): only what's shown, open shadow roots, never what's typed in a field, at most SNAPSHOT_SCAN nodes. It looks once, then again as the page changes, at most once each max(150 ms, 4 × the last look's time), by a timer. A look that was cut short never proves something gone, and the result says so.
- **How it ends:**
  - The page side runs in 1 s chunks (`WAIT_CHUNK_MS`). Between them, Stop, the client's cancel, the user taking the tab, the tab closing, or the page going elsewhere (`navigated: true`) end it.
  - The page's observer lasts one chunk at most.
  - One wait per agent at a time.
- **The client's cancel reaches every tool:** `runControlTool` takes the call's `cancelled` signal (connection.ts), as Stop does (B5).
- **Measured** on the timed table (X11, 3 turns each way):

  | | Polling (today) | wait_for |
  |---|---|---|
  | Tool calls per move | 8 | 2 |
  | Turn start to Chord's click done, median | 494 ms | 347 ms |

  Each tool call is a model round trip for a real agent (seconds), so the calls saved are what matters. `wait_for` wakes about 150 ms after the turn starts (the throttle's floor).
- *Tests:*
  - control.test, *wait_for (S18 M2g-1)*: its arguments; met, with the outline and refs; not met by the timeout; a cut look; one at a time; Stop and the client's cancel; a navigation mid-wait.
  - agents.spec, *a timed table*: polling, then `wait_for` with no sleeps, each move under 3 s of Chord's time; a text that comes and goes.
- *Still to do* for slice (b):
  - The bar's *is waiting on this page* wording.
  - Its CPU cost on a page that changes every frame.
  - `pushState` against a real navigation (S3).

## #143: what the clients do (looked up 2026-11-24, to check in slice (a))

- **Codex:** each MCP tool call times out after `tool_timeout_sec`, 60 s by default, per server in `config.toml`.
- **Antigravity:** 3 minutes a tool call by default (and 5 to connect), per server with `timeoutSeconds`.
- **Claude Code:**
  - No total limit by default (`MCP_TOOL_TIMEOUT`, about 28 hours; a per-server `timeout` overrides it). Progress notifications don't extend it.
  - An idle limit: no answer and no progress notification for 30 minutes on stdio (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`).
  - A call still running after 2 minutes moves to a background task (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). Its transcript names it *MCP task … (server/tool)*, the words the owner saw.
  - A report against one release (2.1.148) has stdio tool calls failing after about 1 s.
- **Chord:** a card waits 45 s (`CONTROL_WAIT_MS`), then answers *Waiting for the user to allow this in Chord…*. A late Allow counts for that same step once (M2d). Chord's server doesn't declare MCP tasks.
- **So:**
  - Codex and Antigravity should never time out on a card. What the owner saw in Claude Code needs a reproduction first: the owner's Claude Code version, and whether the call was backgrounded or failed outright.
  - The fix to test:
    - Answer *waiting* well before every client's limit, about 20 s.
    - Send progress notifications every few seconds while a card is up, when the call carries a `progressToken`.
    - Keep the late Allow for the retry.

## Slices

**PRs (each about 1.5k lines or less, pushed early):** (a) #143 and B1 (this PR), then the measurements; (b) `wait_for` with `snapshot: true`; (c) target by role and name; (d) the waits after each action, and the snapshot with a result. The order after (a) can change with what the measurement shows.

## Checklist to tests

**Checklist to tests** (filled in as each slice lands):

| Checklist item | Test |
|---|---|
| Duplicates refuse | |
| `within` and items | |
| Swap between resolving and the press | |
| Step classified from the element | |
| Sensitive fields never matched | |
| Resolving walk budget | |
| `wait_for`: same readability as `read_tab` | |
| `wait_for`: one at a time, 30 s, Stop and navigation | |
| `wait_for`: throttled checks on a page mutating every frame | |
| Snapshot with a result: caps, untrusted, refs replaced, none after navigating | |
| #143: answered before the client's timeout, the retry runs once, nothing twice | Progress while a card waits: agent-chords.test, *a call that asked for progress hears it…* (beats with the token, counting up, saying a card waits; none after the answer; none without a token). One call's cards wait 50 s in all (`CALL_WAIT_MS`): agent-chords.test, *one call waits on its cards 50 s in all…* (a step card after a 40 s connection card answers waiting by 50 s; it waited 85 s before). The short-timeout client and the retry: to come. |
