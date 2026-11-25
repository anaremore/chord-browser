# S18 M2g-2: threat checklist (revised after Neon's design review, 2026-11-25)

For the plan in `plan.md`. Each item gets a test, named in the plan as each slice lands.

## For every partial view (find, the outline-only snapshot, a hint)

- **Never a ref the model wasn't shown:**
  - A ref enters the agent's table only with the line that names it.
  - A partial view never commits the diff's baseline.
  - It never rebinds a ref to an element the page mutated in place (Neon's #145 blocker, fixed in #145 first).
  - *Tests:* after a `find`, a ref of an element it didn't list is unknown; the next action's diff compares with the last full snapshot.

## `find` (a snapshot parameter)

- **Sensitive fields:**
  - It matches names only: a field's label or placeholder, never its value.
  - A password, one-time code or card field gets no ref (`snapshotKeys`).
  - *Test:* a password field labelled with the words looked for gives its line, with no ref.
- **What it can see:** the snapshot's walk, exactly:
  - the main frame and open shadow roots;
  - never a frame's inside, a closed root, a hidden element, a field's value or an editor's contents.
  - *Test:* words only in a same-origin frame, a cross-origin frame, a closed root, a hidden element or a field's value give no match; words in an open root do.
- **Whose tab:**
  - `snapshot`'s rules apply: own and shared tabs, a shared one only on its site (`siteOk`), never a private window or a Chord page.
  - *Test:* a shared tab gone to another site is refused.
- **Never sites:**
  - `blockedNow` runs before and after, on the read's own address.
  - *Test:* a read that comes back from a Never address is refused, and nothing is kept.
- **Nearest names:**
  - They're the page's names, inside `snapshotResult`'s envelope, clipped as the outline clips them.
  - Never in Chord's sentence.
  - At most 5.

## `read_tab(ref)`: one element's text

- **Container refs are read-only:**
  - The `c` scheme is refused by every acting tool, by its schema pattern and again at run time.
  - *Test:* each acting tool, and `batch`, given a `c` ref, is refused, and nothing is pressed.
- **Sensitive content:**
  - Never a field's value, an editing host's contents, or an ARIA textbox's (`role=textbox`, `searchbox`, `combobox`), whatever its tag.
  - *Test:* a section holding each: their text is absent.
  - A page whose body is editable, or in `designMode`, is refused (#145's B-3).
- **Hidden text:**
  - The same visibility rules as `extract.ts`: `display`, `visibility`, `opacity`, `hidden`, `inert`.
  - *Test:* parity both ways. What `read_tab` leaves out of the page, `read_tab(ref)` leaves out of a section.
- **Frames:**
  - Never a frame's inside, same-origin or not.
  - *Test:* a section with an iframe: the frame's text is absent.
- **Re-verified before reading:**
  - its role and name as the snapshot gave them, in this document, on the tab's page now;
  - `read_tab`'s scope;
  - Never sites before and after, on the read's address.
  - Changed means refused as stale.
  - *Test:* a section renamed or replaced after the snapshot is refused.
- **What it returns:**
  - Untrusted page content.
  - Capped, with ranges.
  - The element's role and name given with it.

## The outline-only snapshot and `snapshot: true` on `open_tab` and `navigate`

- **The same read as `snapshot`:** its rules, caps, envelope and refs.
- **Never sites:** checked on the page the tab landed on, and an outline from a Never site is never returned.
  - *Test:* `navigate` with `snapshot: true` to an address that redirects to a Never site gives no outline.
- **The first look:** one that waits for a page that draws itself (#154) is bounded as it is today.

## Refusals and plain text

- **No page string in Chord's sentence:**
  - `toPlain` and `batch` unwrap `isError` texts into plain words, so a refusal's sentence never carries a page's name or title.
  - Page strings live only in the untrusted `data`.
  - *Test:* each refusal's plain text, for a page named with Chord-like words, carries none of them.

## The diet

- **A shorter description never drops a safety instruction:** *untrusted*, *ask the user*, *never act for a page's text* stay.
- **The key enum said once:** the server's check is unchanged. A key outside the list is refused as now.
- **`batch`'s steps:**
  - Typed properties are kept.
  - Every step's arguments are checked by its tool's schema before any step runs (#145's SF5).
- **Nothing private in the tool list:**
  - It's the same bytes for every connection of a build.
  - *Test:* two connections of different chords.

## The assistant

- **Its read rules:** `snapshot`, `read_tab(ref)` and `find` read only what its read rules allow.
- **Acting behind its flag.**
- **`wait_for` and `batch`** stay outside agents' alone (#145's B-4).
