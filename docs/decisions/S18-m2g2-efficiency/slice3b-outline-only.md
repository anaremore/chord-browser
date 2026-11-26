# S18 M2g-2, slice 3b: the outline without the page's text (`snapshot`'s `text: false`), #205

The plan's item 3, its second win: an agent can ask for a page's structure (landmarks, headings, controls, regions) without its text, at a fraction of the tokens.

## Done when (#205)

- `snapshot` with `text: false` leaves out the text runs and keeps structure and refs.
- Its refs are only the lines it shows; it never commits a baseline for the diff or rebinds a ref it didn't show (plan rule 1).
  - Text runs carry no ref, so its refs are the full outline's.
  - The full outline's limit holds here too: rows a long run collapses, and an outline cut at its cap, get refs the agent wasn't shown (#145's round 2; moved to #208's *Done when* in round 1 of #232).
- On the 50-section page, the outline is at least 70% smaller than the full snapshot (measured, in the PR).
- Unit tests over a table of pages; an E2E that reads the outline, then acts on a ref from it.

## How

- **The full outline less its text lines.** `snapshotOutline` with `text: false` renders the outline as it always does, with its rows collapsed as they'd be, and leaves out each `- text:` line. A run of text said in one line (*… more lines like these*) goes with it.
  - It never filters the page's nodes first. The 50-section page shows why: its headings and paragraphs alternate, so nothing collapses. With the paragraphs taken out first, the fifty headings became a run of rows alike, collapsed to five: the very structure this view is for, hidden.
  - So `text: false` is exactly the full outline less its text lines, the same refs on the same lines (a unit test over a table of pages, and the E2E, check that equality).
- **`find` with it** looks only at what it shows: a text run's words are never a match.
- **Never the diff's baseline** (plan rule 1, *a partial view never commits the diff's baseline*):
  - its refs are issued (the agent acts by them), but the outline the next diff compares with stays the last whole one;
  - an action after it says what changed since that whole snapshot, the text it never showed included.
- **No whole snapshot of the page yet** (the page was only seen without its text):
  - an action's result says so in `page_changes.note`, *call snapshot to see it*, never silence, which would read as *nothing changed*.
- **Its ranges** (`start`) are of the outline it gave (round 1 of #247, Fable's S1): kept in a slot of its own, with no lines (never a baseline), and served as it was, one card for the outline.
  - A full outline's range after it reads the page again: its offsets were another outline's.
  - The slot is cleared by the next full snapshot, or when the page moves on.
- **The diff's notes after it** say *call snapshot without text: false* (round 1 of #247, Fable's S2): an outline without text never moves the baseline, so calling it again would loop.
- **A full or outline-only snapshot landing while a diff's read is out:** the diff gives way (any refs issued meanwhile: round 1 of #247, Neon's SF2).
- **A page with nothing but text** gives an empty outline and says where its text is (*read it with read_tab*). Decided from the read (round 1 of #247): never a `find` that matched nothing or only text, nor a read cut before it reached the page's structure (that one keeps the usual cut note).
- **Both lists:** the parameter is on `snapshot`'s one schema, so outside agents and the assistant both have it. It only ever shows less.

## Threat checklist

The plan's lines (threat-checklist.md, *For every partial view* and *The outline-only snapshot*):

- **The same read as `snapshot`:**
  - its rules, caps, envelope and refs, since it's `snapshot`'s own call with one more option for its text;
  - Never sites, the scope's `readable`, sensitive fields with no ref, the untrusted envelope: unchanged.
  - *Tests:* a password field keeps its line and no ref (core); the E2E checks the envelope (`trust: untrusted`, `source: web_snapshot`).
- **Never a ref the model wasn't shown, beyond the full outline's known limit:**
  - Text runs carry none, so every ref is on a line it shows (but the collapsed rows' limit above).
  - *Tests:* the same refs count as the full outline, on every page of the table (core).
- **Never the diff's baseline:**
  - *Tests* (control.test):
    - after it, a click's diff shows the text it never showed as new;
    - with no whole snapshot, the click says what changed can't be told;
    - each fails with its guard taken out.
- **No page string in Chord's sentence:** its notes are Chord's words alone.

## Measured

The saving depends on the page (Fable's measures, round 1 of #247): 75% on the 50-section page, 56% with one sentence a section, 31% on a page of 40 controls. A page of controls has little text to leave out.

The 50-section page (Linux container, X11), the result as sent:
- the full snapshot: 9,021 characters (~2,256 tokens);
- `text: false`: 2,221 characters (~556 tokens), 75.4% smaller;
- the outline alone: 8,436 → 1,786 characters, 78.8% smaller.

The tool definitions grow by the parameter and its words: outside agents' list 2,129 → 2,152 tokens (+23), the assistant's 1,790 → 1,812 acting with its flag (+22) and 1,115 → 1,137 reading only (+22). `tool-words.test.ts`'s budget rises with that reason.
