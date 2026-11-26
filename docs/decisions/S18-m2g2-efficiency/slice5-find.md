# S18 M2g-2, slice 5: `find`, flat, with the nearest names; and only the refs shown acted on (#208)

The plan's items 5 and 6: an agent finds a control on a big page without a full snapshot, and when nothing matches, it's told the nearest names. With it, plan rule 1 in full: only the lines shown enter the agent's table.

## Done when (#208)

- `find` returns at most 20 matches, one flat line each, with the item each is in.
- With no match, it returns the nearest names (words in common, stop-words left out), inside the untrusted envelope; no page string appears in Chord's own sentence.
- A find never commits a baseline for the diff and never rebinds a ref; only the lines shown enter the agent's table (plan rule 1).
- Rows a long run collapses, and an outline cut at its cap, get no refs: only the lines shown enter the agent's table, for `snapshot` and for `open_tab` and `navigate` with `snapshot: true` (from round 1 of #232; a limit since #145's round 2).
- Measured on the broad-find journey and the 300-row list (numbers in the PR); no journey's success drops.
- The assistant gets the same behavior behind its own flag.

## How

- **A flat find** (core: `snapshotOutline`'s `flat`, `flatFind`), where the scope asks for it (`scope.findFlat`: outside agents with M2's tools; the assistant behind `ASSISTANT_FLAT_FIND_RELEASED`, development builds until it's released):
  - a match is a named element whose own name has the whole query in it (any case, its spaces left out too: `signin` finds "Sign in"; round 2 of #263), or whose own name and its item's have every word of the query: a word with a digit only as a whole word (`Cancel 150` never finds order 1500), any other inside its own name (`Canc` finds Cancel) or as a whole word of its item's;
  - ranked: every word its own (as whole words) first, then some, then its item's alone, the page's order within each; capped first, and only the lines shown are built;
  - at most `FIND_MAX` (20) of them, each the outline's own line, unindented, with the item it's in (`(in row "Order 150")`): its nearest row, list item, article, dialog, tab panel or region, by its name, else (unnamed, the common case: a plain `tr`, `li`, `article`) a label from its own contents: its first heading's name, else its texts (with the page's text) and link names in the page's order, joined and clipped to 60 characters (`(in row "Order 150 Jane Doe Details")`), looking at 40 of its nodes at most (rounds 1 and 2 of #263);
  - past 20, a line says how many more, and (when the matches have items) to narrow it by an item's words;
  - none: the nearest names, by words in common with the query's in their own names and their items', stop-words left out, at most `FIND_NEAREST` (5), the page's order on ties (`Refund 150` finds order 150's); Chord's note says so in its own words (`FIND_NEAREST_NOTE`, or `FIND_NONE_NOTE` when nothing is near);
  - without the page's text (`text: false`), a text run never matches.
- **Never the diff's baseline:** a flat find keeps no outline (neither the full one's slot nor the outline-without-text's), builds no whole outline, gives only its own lines' part refs, and is read unpinned (never taking the agent's full snapshot's place in the page). The outline the next diff compares with stays the last whole one, and a diff's notes after it say *call snapshot without find* (round 1 of #263).
- **A find of nothing but spaces** is no find (round 1 of #263); a no-match find on a read cut short keeps the cut note.
- **Only the refs shown are acted on** (plan rule 1, in full; every scope):
  - refs are still issued for every element (numbered by the page's own ids, so none is ever rebound, and an element keeps its ref from one snapshot to the next);
  - `ElementRefs` keeps the refs the agent was shown on this page (`showRefs`), **structurally, never read out of the text** (round 1 of #263: a page's own words could write any ref): each outline line's own element and offset (`lineRefs`), those within the range the answer returned (`snapshotRange`, `refsInRange`; a later range adds its own, from the kept outline's), a find's lines, and a diff's new and changed lines by their ids (`snapshotLinesWithRefs`, `snapshotDiffShown`: never a gone line's);
  - every acting tool, and `batch` before step 1, refuses a ref the agent wasn't shown on this page (`wasShown`; `ELEMENT_REFUSALS.notShown`, which says a snapshot or a find shows it): a collapsed run's row, a line past the range it read, an element a find didn't list;
  - another page starts over; `forget()` and the refs' reset clear it.

## Threat checklist

The plan's lines (threat-checklist.md, *For every partial view* and *`find`*):

- **Never a ref the model wasn't shown:**
  - a ref is acted on only once a line that names it was shown (`showRefs`, `wasShown`);
  - a partial view (a find) never commits the diff's baseline, and never rebinds a ref (refs by the page's ids, issued as before).
  - *Tests:* control.test, *a collapsed row's ref is never acted on until a line shows it* (click and batch refuse it, nothing done; a find shows it; each check fails on revert); core, *only the refs shown are acted on* (shown per page, another page starts over, `forget`); control.test, *…never the diff's baseline* (a text shown since a find is new in the next diff; fails on revert).
- **Sensitive fields:**
  - find matches names only (a label, a placeholder), never a value; a password, code or card field has its line and no ref (`snapshotKeys`).
  - *Test:* control.test, *a flat find of a password field: its line, never a ref, never its value*.
- **What it can see:** the snapshot's walk, exactly (find filters the same read).
- **Whose tab, Never sites:** `snapshot`'s rules (`find` is its parameter, through its read).
- **Nearest names:**
  - they're the page's names, inside `snapshotResult`'s envelope, clipped as the outline clips them;
  - never in Chord's sentence (the notes are Chord's words alone);
  - at most 5.
  - *Tests:* core (nearest by words in common, stop-words left out, at most 5; none near, nothing); control.test (the notes, the names in the content).

## Measured

The token eval (Linux container, X11), fresh main (`186cbf9`) against this branch:

| Journey | Calls | Result tokens | Model input (est.) | Cached (est.) |
|---|---|---|---|---|
| A broad find, main | 3 | 7,254 | 45,416 | 24,628 |
| A broad find, this PR | 4 | 929 | 43,811 (−3.5%) | 17,215 (−30%) |
| A broad find, plain rows, main | 2 | 5,843 | fails (the tree find never says which row is order 150) | |
| A broad find, plain rows, this PR | 4 | 915 | 43,744 | 17,192 |
| A 300-row list, main | 3 | 448 | 31,765 | 15,436 |
| A 300-row list, this PR | 3 | 435 | 31,790 | 15,443 |

- **The broad find** (300 orders, the agent after order 150's Cancel) takes one more call: twenty matches of three hundred, then a narrower find by the row's words (`Cancel 150`), as the line says. It reads less for it, since the 300 lines it no longer gets would be read again on every later turn: 30% less cached.
- **The 300-row list** finds its row as before (one match).
- **The tool definitions grow 17 tokens** (outside agents: `find`'s words), within the budget.

## Limits

- **Refs counted as shown when Stop lands after a diff was built:** the diff's refs are shown as it's built; Stop after that drops the answer, not those refs.
- **A flat find's `c` refs go stale after 4 diffs:** its read is unpinned, so the page keeps it among a diff's last 4 (`SNAPSHOT_HISTORY`).
- **`c` refs aren't held to *shown*:** they're read-only, and a part's read is never more than the page read (#207).
- **Past `SNAPSHOT_MAX_REFS` (2,000) keyed elements**, a match has no ref (the snapshot's own cap).
