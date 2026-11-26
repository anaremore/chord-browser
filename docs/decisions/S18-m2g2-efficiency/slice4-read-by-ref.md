# S18 M2g-2, slice 4: one part of a page by its ref (`read_tab` with `ref`, read-only container refs), #207

The plan's item 4: an agent reads one section of a long page by naming it, instead of reading the whole page in ranges.

## Done when (#207)

- The snapshot gives read-only container refs (`c12`, never `e12`) for regions, articles, sections, landmarks and tables, in their own table, never rebinding an element ref.
- `read_tab(ref)` reads that container's shown text by the same visibility rules as `extract.ts` (tested both ways), capped, with `start` for more.
- Every acting tool refuses a `c` ref, by its pattern and again at run time.
- It never reads fields' values, editing hosts, ARIA textboxes (`textbox`, `searchbox`, `combobox`, whatever the tag) or frames' insides.
- It re-verifies the element before reading (role and name as the snapshot gave them, same document, same `page_id`, scope and Never-site checks before and after). A change means refused as stale, never read.
- The 50-section journey (outline, then `read_tab(ref)`) costs at least 50% less than reading in ranges, measured.

## How

- **Sections are regions.** A `<section>` named by `aria-label` or `aria-labelledby` has the role `region` (as ARIA maps it, and as the outline's items already read it). So a named section shows in the outline, and gets a ref.
- **Container refs.** Where the scope reads parts (outside agents: `scope.boxes`):
  - the snapshot gives each region, article, main, navigation, complementary, banner, contentinfo, search, form and table a `c` ref, numbered by the element's own page id (stable from one snapshot to the next, as element refs are);
  - the page keeps each such part by a WeakRef in its read, with the role and name the outline gave it (snapshot.ts: `boxes`), as it keeps the elements it acts on;
  - core keeps them in their own table on `ElementRefs` (`issueBoxes`, `resolveBox`), never an element ref's: an `e` ref never resolves as a part, nor a `c` ref as an element.
  - The assistant gets none: its outline is as it was.
- **`read_tab` with `ref`** (agents' schema: `^c[1-9][0-9]{0,8}$`):
  - resolves the ref in the table, on the page the tab is on now: another page's is stale, one never given is unknown;
  - in the page (snapshot.ts: `boxTextScript`) finds the part again from the agent's snapshot, and checks it as an action checks its element: still in the document, shown, its role and name as the outline gave them. Anything else is stale;
  - reads its text by the page read's own walk (extract.ts: `TEXT_LIB`, which `EXTRACT_SCRIPT` now uses too), strict: never an editing host's contents, nor an ARIA text field's, whatever its tag, on top of fields' values and frames, which neither ever reads;
  - refuses a page that's all editor (designMode, an editable body: #145's B-3), and a part that is one;
  - under `read_tab`'s rules: its card, the scope's `readable`, Never sites before the read and after it (on the read's own address), Settings' Nothing (`blockedNow`), Stop, and a page that went to another document as it was read (stale);
  - answers as `read_tab` does (untrusted, capped, in ranges with `start` and `length`, the agent's default), with which part it is (`part`: its ref, role and name).
- **Read-only.** Every acting tool refuses a `c` ref at run time with its own words, before anything is described, pointed at or pressed; `batch` refuses it before step 1. Their schemas' `ref` pattern (`^e…`) already refuses it.
- **The shared walk.** The page read now leaves out `inert` subtrees too, as the snapshot always has, so the two walks' rules are one (the threat checklist's set: `display`, `visibility`, `opacity`, `hidden`, `inert`).

## Rule 1, for parts

A part's ref enters the table only with a line that shows it: the outline's lines, and (for a `find`'s later ranges) its whole outline's. A collapsed run's parts never do.

A part read by its ref is never more than `read_tab` reads of the whole page, under the same rules, so a part's ref the agent wasn't shown (a later range's) could only ever read what the page read gives it. It's never acted on.

## Threat checklist

The plan's lines (threat-checklist.md, *`read_tab(ref)`: one element's text*):

- **Container refs are read-only:**
  - the `c` scheme is refused by every acting tool, by its schema pattern and again at run time;
  - *Tests:* control.test (each of click, type, press_key, select_option, hover, and `batch`, given a `c` ref: refused in their words, nothing described or pressed); agents.spec (`click` with a part's ref: refused, the page's button never pressed).
- **Sensitive content:**
  - never a field's value, an editing host's contents, or an ARIA textbox's (`role=textbox`, `searchbox`, `combobox`), whatever its tag;
  - *Test:* agents.spec, a section holding each, and a frame: none of their text is in the part's read.
  - A page whose body is editable, or in `designMode`, is refused (#145's B-3). *Test:* agents.spec (`designMode` on: refused in Chord's words); control.test (the editor answer).
- **Hidden text:**
  - the same visibility rules as `extract.ts` (one walk): `display`, `visibility`, `opacity`, `hidden`, `inert`;
  - *Test:* agents.spec, parity both ways: each hidden text is absent from the part's read and the page's, and the shown text present in both.
- **Frames:** never a frame's inside, same-origin or not. *Test:* agents.spec (a `srcdoc` frame's words are absent).
- **Re-verified before reading:**
  - its role and name as the snapshot gave them, in this document, on the tab's page now; `read_tab`'s scope; Never sites before and after, on the read's address. Changed means refused as stale.
  - *Tests:* agents.spec (the section renamed after the snapshot: stale); control.test (a ref never given; the part changed in the page; the page gone to another document since the snapshot, or as it was read; the site made Never since; a read from a Never address; Settings' Nothing as it was read).
- **What it returns:** untrusted page content, capped, with ranges, with the element's role and name. *Tests:* control.test (the envelope, `part`, a range); agents.spec.
- **No page string in Chord's sentence:** its refusals are Chord's words alone (`PART_REFUSALS`), never the part's name.

## Measured

The token eval's *reading one section of 50* (Linux container, X11): see the PR. The outline as the tab opens, the section found by its words (`find`, no text), then the section by its ref: 3 calls, against 4 reading in ranges.

The tool definitions grow 30 tokens (outside agents: the `ref` and its words); `tool-words.test.ts`'s budget rises with that reason.

## Also

- #205's 75% is measured on `/article50-plain`, the page as it was then. With its sections now regions, `/article50`'s fifty sections collapse as rows alike, so its full outline is smaller to begin with.
