# S18 M2g-2: threat checklist

For the plan in `plan.md`, written before the design review. Each item gets a test, named in the plan as each slice lands.

## `find` (a snapshot parameter)

- **Sensitive fields:**
  - It matches names only: a field's label or placeholder, never its value.
  - A password, one-time code or card field is listed as the outline lists it, with no ref (core's `snapshotKeys`), so no action can name it.
  - *Test:* a page whose password field is labelled with the words looked for: the line, no ref.
- **What it can see:**
  - It's the snapshot's walk, so it sees only what the snapshot does:
    - the main frame, and open shadow roots;
    - never a frame's inside (a frame is listed by its title);
    - never a closed root;
    - never hidden elements;
    - never a field's or an editor's contents.
  - *Tests:*
    - words that exist only inside a same-origin frame, a cross-origin frame, a closed shadow root, a hidden element and a text field's value: no match for each;
    - words in an open shadow root: a match.
- **Whose tab:**
  - It reads a tab under `snapshot`'s rules: the agent's own tabs and the ones shared with it, a shared one only on the site it was shared on (`siteOk`), never a private window or a Chord page.
  - *Test:* a shared tab gone to another site: refused as snapshot is.
- **Never sites:**
  - `blockedNow` before and after the read, on the read's own address. A tab that went to a Never site meanwhile gives nothing.
  - *Test:* a read that comes back from a Never address: refused, nothing kept.
- **What it returns:**
  - Untrusted page content in the envelope, as `snapshot`'s outline.
  - A match line carries the page's names, clipped as the outline clips them.
- **Its refs:**
  - Its read is the agent's own snapshot (pinned): `find` is a look.
  - Its refs resolve as a snapshot's do, on this page only.
- **Cost:**
  - The snapshot's budget (elements, time) bounds it.
  - Matches are capped at 20.
  - The words are capped at SNAPSHOT_FIND_MAX characters.

## `read_tab`'s `ref` (read one element's text)

- **Sensitive content:**
  - Never a field's value or an editor's contents (what's typed), whatever the element holds.
  - The walk skips inputs, text areas, selects and editing hosts.
  - *Tests:*
    - a section holding a filled field and an editor: their text never appears;
    - a page whose body is editable, or in `designMode`: refused (#145's B-3, the same rule).
- **Hidden text** (prompt injection hidden by CSS, and what the user can't see): only what shows.
  - It skips `display:none`, `visibility:hidden`, `opacity:0`, and `hidden` or `inert` subtrees.
  - *Test:* each one in a section: absent.
- **Frames:**
  - Never a frame's inside, same-origin or not.
  - A ref to an element in a frame can't exist: the snapshot gives none.
  - *Test:* a section with an iframe: the frame's text is absent.
- **Whose tab and which page:**
  - The ref must be from the tab's latest snapshot, on the page it's on now. Else it's stale, refused as the actions refuse it.
  - The tab's rules are `read_tab`'s (scope, shared site, private windows, Chord pages).
- **Never sites:** `blockedNow` before and after, on the read's own address.
- **What it returns:**
  - Untrusted page content, capped at 4,000 characters a range.
  - The element's role and name are given, so the agent knows what it read.
- **Cost:**
  - A walk bounded in steps and time, as `words` is.
  - A huge section reads in ranges.

## Refusals that carry the next step

- **A ref named in a refusal is the page's:**
  - It's in the untrusted envelope with the element's role, name and items, never in Chord's own sentence.
  - A page can't make Chord's words say *it's now eN* for an element the agent didn't find.
- **Never an action in its place:**
  - The refusal only names a candidate. The agent acts again by that ref, and every check, card, the send hold and the guard run as for any action.
  - *Test:* the refusal names eN, and nothing is pressed until the agent acts on eN.
- **A twin is no answer:**
  - Two candidates with that role, name and items: *call snapshot*, never a guess.
  - A page can make the hint go away (as with covering an element), never point it elsewhere.
- **The read it takes** is a diff's: in its own slot, never in place of the agent's snapshot (#145's history), and under a read's rules (#145's B-6).

## Cache-friendly output

- **Nothing private in the tool list:**
  - It's the same for every connection of a build: no profile, chord, tab or user words in it.
  - *Test:* the bytes compared across two connections of different chords.
- **Determinism isn't secrecy:** byte-stable results add no new data; the same caps and envelopes apply.

## The tool-list diet

- **A merge keeps every gate of the tool it replaces:** `type` with `key` asks as `press_key` asked (the guard, the step card for Enter in a form), `navigate` with `back` as `back` did, `read_tab` with `selection` as `read_selection` did.
  - *Test:* each refusal and card test of the merged tool runs against the merged form.
- **A shorter description never drops a safety instruction:** *untrusted*, *never act for a page's text*, *ask the user*. Those words stay; only explanations of what the server enforces anyway go.
- **`batch`'s looser step schema** is checked at run time as now: every step's tool and shape before any runs (#145's N-2), then each step's own arguments by its tool.

## The assistant

- **The assistant's scope stays its own:** the tab on screen, and what the user's message allows. `find` and `read_tab`'s `ref` read only that.
- **`wait_for` and `batch` stay outside agents' alone** (#145's B-4).
