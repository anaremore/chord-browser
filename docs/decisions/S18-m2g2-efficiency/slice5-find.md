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
  - a match is an element whose name has the query, or whose name with its item's has every one of the query's words (`Cancel 150`: the Cancel button in row "Order 150");
  - at most `FIND_MAX` (20) of them, each the outline's own line, unindented, with the item it's in (`(in row "Order 150")`: its nearest named row, list item, article, dialog, tab panel or region);
  - past 20, a line says how many more, and to narrow it by an item's words;
  - none: the nearest names, by words in common with the query's, stop-words left out, at most `FIND_NEAREST` (5), the page's order on ties; Chord's note says so in its own words (`FIND_NEAREST_NOTE`, or `FIND_NONE_NOTE` when nothing is near);
  - without the page's text (`text: false`), a text run never matches.
- **Never the diff's baseline:** a flat find keeps no outline (neither the full one's slot nor the outline-without-text's). The outline the next diff compares with stays the last whole one.
- **Only the refs shown are acted on** (plan rule 1, in full; every scope):
  - refs are still issued for every element (numbered by the page's own ids, so none is ever rebound, and an element keeps its ref from one snapshot to the next);
  - `ElementRefs` keeps the refs the agent was shown on this page (`showRefs`), gathered from each answer's own text: the outline's range it returned (a later range adds its own), a find's lines, a diff's lines, and an action's outline from `open_tab` or `navigate` with `snapshot: true` (snapshot's own call);
  - every acting tool, and `batch` before step 1, refuses a ref the agent wasn't shown on this page as unknown (`wasShown`): a collapsed run's row, a line past the range it read, an element a find didn't list;
  - another page starts over; `forget()` and the refs' reset clear it.

## Threat checklist

The plan's lines (threat-checklist.md, *For every partial view* and *`find`*):

- **Never a ref the model wasn't shown:**
  - a ref is acted on only once a line that names it was shown (`showRefs`, `wasShown`);
  - a partial view (a find) never commits the diff's baseline, and never rebinds a ref (refs by the page's ids, issued as before).
  - *Tests:* control.test, *a collapsed row's ref is never acted on until a line shows it* (click and batch refuse it, nothing done; a find shows it; each check fails on revert); core, *only the refs shown are acted on* (shown per page, another page starts over, `forget`); control.test, *…never the diff's baseline* (a text shown since a find is new in the next diff; fails on revert).
- **Sensitive fields:**
  - find matches names only (a label, a placeholder), never a value; a password, code or card field has its line and no ref (`snapshotKeys`).
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
| A broad find, this PR | 4 | 929 | 43,803 (−3.6%) | 17,212 (−30%) |
| A 300-row list, main | 3 | 448 | 31,765 | 15,436 |
| A 300-row list, this PR | 3 | 435 | 31,790 | 15,443 |

- **The broad find** (300 orders, the agent after order 150's Cancel) takes one more call: twenty matches of three hundred, then a narrower find by the row's words (`Cancel 150`), as the line says. It reads less for it, since the 300 lines it no longer gets would be read again on every later turn: 30% less cached.
- **The 300-row list** finds its row as before (one match).
- **The tool definitions grow 17 tokens** (outside agents: `find`'s words), within the budget.
