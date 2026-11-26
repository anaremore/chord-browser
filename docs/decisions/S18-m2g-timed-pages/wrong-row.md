# A stale ref never acts on another row (#268)

Found by Fable reviewing #267: these cases predate it, in #117's refind. In each one, an agent's old ref acted on a **different** row, with no refusal. Round 1 of #273 (Fable and Carbon) found more ways in; they're folded in below.

## Done when (#268)

- The refind compares the element's item identity: its name, or, for an unnamed row, its derived label as shown at snapshot time. A mismatch is refused (changed or ambiguous) and never acted on.
- Each of the four cases is a fixture, with a test that fails today.
- In-place patches are caught at act time, not only on a refind.

## The cases, and what each did before

| Case | Before | Now |
| --- | --- | --- |
| Ids by position (A removed, B takes `act-0`) | A's ref re-found as B's button: *done, refound*, B cancelled | changed, nothing cancelled |
| The only row replaced by another | re-found as B's: B cancelled | changed |
| A row's text patched in place (index keys: the same nodes) | no refind at all: B cancelled | *the row says something else now*, at the step's own check |
| The same, after a later snapshot of the agent's (an action's diff, a find) | the old ref given to the patched node: the ref shown in B's row cancelled C | the patched node gets a new ref; the old one is refused |
| Cut snapshots (over 2,000 refs or 20,000 nodes) | twins unmarked | fixed in #267 round 1 (`shapesOk`): twins in a cut snapshot are refused as ambiguous |

## The design

**Identity.** A ref's identity was its role, name, items, place and shape. Items are its **named** rows, list items, articles, dialogs, tab panels and regions; an unnamed one said nothing. Now each kept ref also records its **row**: what the unnamed items it's in say, on the way up, nearest first.
- At most 3 unnamed items, stopping at the first named one (its items say it), within the same 64 ancestors `itemsOf` climbs.
- So an inner item that says nothing, or one that says what every row says (a "Details" link), never hides the row around it: the item above it reads the row's own words. The cases where it still can are under Limits.

**Which level reads what** (rounds 3 and 4 of #273):
- The **nearest** item reads everything it holds, items nested in it included: a row's own words may be in a nested `<section>`, a card body, a nested list or table.
- The items **above** it never read into a **row** nested in them (`li`, `tr`, `role=row`, `role=listitem`): a list's rows and a table's are their own, never their container's, so a row going never changes the others' keys.
- They do read nested sections, articles and divs (round 4: the planner's call, Fable's option 2). The row's own words may be in one, with the control in a sibling that says what every row says ("Details", "Actions", "This can't be undone").
- Until an inner level has found words (the nearest says nothing), the item above reads all it holds, nested rows included. Once one has, the items further up skip nested rows again (round 4, Carbon: a shared section around the list never reads every row again, so a row going never changes the others' keys).

**What an item says** (`rowLabel`), from the item's own open shadow root (a web-component row) and its children:
- its first heading that says something, its words on a budget of their own, and looked for past the point where the text's characters run out (round 2 of #273). It still shares the 100 counted nodes; then the rest of its words: its text, pictures' `alt` and links' `aria-label`, in order, through open shadow roots (every row can share a heading);
- never a control's words (a button, a field, an option, a `summary`), an editor's (what's typed: `contenteditable`, but not `contenteditable="false"`), or a ticker's (`role=timer`, `role=progressbar`, `aria-live`, `<progress>`, `<meter>`; `<time>` counts);
- never hidden, inert or `aria-hidden` content, or `script`, `style` and the snapshot's other skipped tags;
- a heading's own words are read the same way: an icon's `<title>`, a style or a script inside a heading never count.

**Bounds:**
- at most 100 nodes that count: kept elements and text that isn't only spaces, so pretty-printed whitespace never uses it up;
- 240 raw characters, clipped once;
- past 60 characters, the rest is kept as a short hash, so rows alike in their first 60 differ (never shown).

**Cheap, and the same both times.** It is read from tags and attributes only, with no computed style or computed role, and it is the same function at snapshot time and at every step, so the two always agree.
- It's taken during the snapshot's walk (eager: never moved into `finish()`), so it's the row as the agent was shown it.
- It's cached per item, once per snapshot.

**Checks:**
- **Every step** (`act.ts`, beside the items check): a node whose row now says something else is refused with its own words (*rowChanged*): *the row it's in says something else now, so it may be another row's*. The words end with the way out: *if it's refused the same way again, the row keeps changing (a timer, a live count): tell the user*.
- **After input went in** (a key, a press, a value), the same is *it may or may not have worked; call snapshot and check* (`INPUT_REDRAWN`), never "nothing was done" (a row with a character counter).
- **The refind:** a candidate must be in the same row.
- **A row whose nearest item says nothing but its control** is never found again once redrawn (*rowEmpty*), whatever its name, and whatever an item above it says: a group's words (a count, a heading) tell groups apart, never the rows in them (the planner's call, round 2 of #273; the nearest item, round 3). Nothing of its own tells it from another row's control:
  - ids by position;
  - a lone row replaced by another;
  - a same-named row drawn first;
  - (an exemption by a unique name was tried, and dropped: rows off screen or in a closed `<details>`, which a snapshot never holds, make "unique" unknowable).

  Its words say to take a new snapshot and use the ref at once. That snapshot shows the agent the row as it is now, and the ref acts on a page that holds still; if it's refused again, tell the user. **The cost:** one extra snapshot after a redraw on such rows (*Pick apples*, *Fold here*, *Show cards*).
- **Found again only in a row that says something else** (ids by position, a row replaced, a ticker that replaces its row's nodes, twins among them): *rowChanged*, with its way out, never just *changed*.
- **Twins** (#211): the row is part of the signature. Unnamed rows that say different things are no longer twins; each ref is found again in its own row. Rows that say the same are still twins, refused as ambiguous.
- **A later snapshot** (an action's diff, a find): a kept node's snapshot id includes its row, so a node patched into another row gets a new ref. The old ref resolves to its own snapshot, and the step's check refuses it.
- **A late Allow:** the step's shape (`stepShape`) includes the row, so a card answered late for Order A never runs on the same ref's node once it's in Order B's row.

## Limits

- **A row whose own unmarked words tick** (a countdown in plain text, a live price) is refused with *rowChanged* once they change. That fails closed, and the words tell the agent to stop and tell the user after a second try. Digit masking was considered and rejected: it would let *Order 12* pass for *Order 13*. An inbox's "2 min ago" costs at most one refusal at a minute's turn.
- **A row whose nearest item says nothing but its control:** one extra snapshot after a redraw (above). On a page that redraws it faster than an agent's round trip, it can't be acted on by ref, and the agent says so.
  - Patched in place, with nothing shown changing (only data the page keeps, like a `data-` attribute): it's the same node, and nothing the agent was shown tells it changed. It acts, as on the same row.
- **A group's own words in its rows' keys:** a count in a section's words ("30 open") sits in every row's key below it, so when it changes, every row there is refused once (*rowChanged*). That fails closed; `aria-live` on the count avoids it.
- **A link's `aria-label` replaces its contents:** rows whose links share a label ("Open order") aren't told apart by them.
- **The heading's look:** its words have their own character budget, but it shares the 100 counted nodes. A heading past the 100th node isn't read.
- **A row's details in a nested list or table beside the control** (`<li><ul><li>Order A</li></ul> <section><a>Details</a> <button>`): the items above skip nested rows, so the row's words there aren't read, and rows that differ only there aren't told apart (round 4: the two shapes Fable's option 2 leaves).
- **Until an inner level has found words, the item above reads everything, sibling rows included**, so it fails closed more often. Thirty `<li>Order N <div role=row><button>` rows in an unnamed section all change their keys when one goes, and a ticking sibling refuses them each time: one refusal per change.

- **Words a row's identity never reads** (round 2 of #273, Fable's N3): a row told apart from another only by one of these isn't told apart, so a patch in place, or ids by position, can still act on the other row's control. The page's words for the row (its text, its heading, a picture's alt, a link's label) are what's read.
  - a field's value (what's typed is never read);
  - an editable cell's words (`contenteditable`: what's typed);
  - a row title that is itself a control: a button, a `<summary>`;
  - words inside an `aria-live` region (the planner's S1 call: a ticker's).
- **Words past the reach:** a row whose only difference is past its 100th counted node, or its 240th character, isn't told apart.

## Threat checklist

- **Acting on the wrong row** (the bug): refused, never acted on, at every step, on every refind, and after a later snapshot.
  - *Tests,* agents-refind.spec:
    - The #268 test: ids by position, a row replaced, a row patched in place; rows with no ids, reordered (it cancels A). Each failed before the fix and cancelled Order B.
    - *a later snapshot never rebinds*: the agent's own action's diff, and a find, after a patch in place.
    - *what a row says, case by case*: an inner item (with and without a shared link), an unnamed section, an open shadow root, pictures, a link's `aria-label`, rows alike in their first 60 characters, 45 empty spans first, 60 hidden characters first, an icon-only heading. All refused.
  - *Test,* control.test: a late Allow is for the row it was asked in.
- **A row whose words change on their own:** refused, then *tell the user*; marked tickers never count.
  - *Tests:* the timers test: `role=timer` and `aria-live` rows act after a second's ticking, and an unmarked one is refused with *rowChanged*. The case table: a progress bar moving on still acts.
- **Typing:** what's typed is never the row's words.
  - *Tests:* the case table: a `contenteditable`, and an editable cell, typed into twice, then the row's button acts. A row with a character counter: *it may or may not have worked*, never *changed*.
- **Deep rows:** a button 60 or 70 divs inside its row acts, every time (the 64 bound is the same both ways).
- **A row that says nothing:**
  - *rowEmpty*, whatever its name; then a new snapshot's ref acts.
  - *Tests:* the case table: same-named buttons with ids by position; a lone row redrawn; a same-named row drawn first or after: each refused, nothing cancelled. The #117 narrowed test: Fold here and Show cards are refused, then act from a fresh snapshot. agents-spa: the re-keyed *Pick apples* may be refused as *rowEmpty*.
- **Look-alikes:** rows that say the same stay twins and are refused as ambiguous (#211).
  - *Tests:* `/twins-cut`; `/twin-later`; `/twins-plain` (rows that say different things: told apart).
- **The words:** Chord's own, no page string.

## Measured

See the PR: `/rows-300` and `/noisy` interleaved against main, after round 3.
