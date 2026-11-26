# Controls that load late, and look-alikes (#211)

Part of #209, acting on real pages: an agent clicks the right control when the page draws it late, and when two controls look alike it's told how to choose, never guessed.

## Done when (#211)

- A control that appears after the first look is found by `wait_for` or `find`, and acts once it is there.
- Two controls with the same role and name are told apart (by the item they're in), and a bare name that matches several is refused with how to choose, never guessed.
- Fixtures for both, journey-tested on one CPU (`--slow`) so a race shows.
- Re-finding after a redraw (the #117 budgets journey) still passes.

## What was there, and what this adds

Most of it was there:
- **No tool acts by a bare name:** every action names one element by its ref. Targeting by role and name was dropped from the timed-pages plan (its slice c).
- **Late controls:** `wait_for` (role and exact name, or a text) waits for one. With `snapshot: true` it answers with what changed, the new control's ref on its line (shown, so it's the agent's to act on: #208).
- **Telling look-alikes apart:**
  - the outline puts each where it is, under its item;
  - a flat find (#208) gives each with its item: `(in region "Draft B")`, and an unnamed row's label from its contents;
  - a find by the item's words names the one meant.
- **Never a guess:** re-finding a redrawn ref (#117) looks for exactly one element of the same role, name, items, place and shape. More than one is refused; so was a ref whose snapshot had a twin (its re-find data dropped).

What this adds: **that refusal says what it is and how to choose.** It was *That element changed since the snapshot*, which reads as gone.

### Look-alikes: one cause, one answer

- **Twins in the snapshot** (two or more alike among its own refs, cut short or not): each is marked, and keeps its place and shape.
  - Redrawn, and looked for (the first look, the pointer's move): never acted on. The page is scanned for them: one or more still there gives *ambiguous*; none gives *changed* (no look-alike left).
  - Redrawn at a later check (the hit test, the debugger's hit test and its look, a key's or a field's check): *ambiguous* at once, never looked for again.
- **More than one alike** when a unique ref is found again (the page drew another just like it): *ambiguous*.
- **After input went in** (a key's keydown, a press, a value set): a look-alike's refusal becomes `INPUT_REDRAWN`, *it may or may not have worked; call snapshot and check before doing it again*. It never says "nothing was done": a comment box that sends on Enter and then redraws must not be sent to twice.
- **A key:** a look-alike in the element's place after its keydown is *the page redrew that element while the key went in* (`KEY_REDRAWN`), as a node gone is: never said done. Before anything went in, it's tried again as a node gone is, and its check finds it again or refuses. Both decide on the reason (`redrawn()`), not one refusal's words.

### The words

`ACT_REFUSALS.ambiguous`, for a client with the flat find (agents; the assistant once it ships): *The page redrew that element, and it has a look-alike (the same name, in the same place), so which one you meant can't be told and nothing was done. Call snapshot (with find: the words of its row or item) and use the ref of the one you mean. If it's refused the same way again, the page keeps redrawing them: tell the user instead of trying again.*

`ACT_REFUSALS.ambiguousPlain`, for one without it (the packaged assistant: its find can't name a row by its words): the same, with *Call snapshot and use the ref of the one you mean.*

The last sentence is the way out. Rows that say the same thing, which a page keeps redrawing, can't be told apart: a find gives a new ref, and it's refused again. The agent stops and tells the user, never loops.

### Since #268

Unnamed rows are now told apart by what they say: their first heading, their text, pictures' alt text and links' labels, on the way up to the nearest named item (`wrong-row.md`).
- Rows that say different things are no longer twins: each ref is found again in its own row.
- Rows that say the same are still twins, refused as ambiguous.
- A row that says nothing but its control is never found again once redrawn (*rowEmpty*), whatever its name. The cost: one extra snapshot after a redraw.

## Threat checklist

- **Never a guess between look-alikes:** exactly one match acts, as before (#117). Two or more are refused, and nothing is pressed. Twins in the snapshot are never acted on once redrawn, even if one is found.
  - *Tests:* agents-refind.spec:
    - unnamed list items that say different things, redrawn every 100 ms: since #268 told apart, so B's ref deletes B;
    - unnamed list items that say the same, in a snapshot cut short (more on the page than it reads): refused, nothing deleted;
    - one at the first look, the test drawing a second (refused, nothing deleted);
    - twins redrawn as the pointer arrives (refused, nothing clicked);
    - a Delete of two (since #268: Row one's ref, its row gone, is changed); both gone (changed).
  - *Tests:* control.test: the words with and without the flat find; nothing pressed; the debugger's look says so; a batch stops there.
- **Input that went in, then a look-alike:** never "nothing was done".
  - *Test:* control.test: Enter in a field, then a look-alike at its check; typed text, then a look-alike where it went; a value set, the same: each `INPUT_REDRAWN`.
- **A key on a look-alike redrawn after its keydown:** never said done.
  - *Test:* control.test: Enter, the element gone or a look-alike in its place after the keydown: `KEY_REDRAWN`, its keydown and keyup once.
- **A decoy beside a button** (the page draws a twin to make the agent refuse): it only stops the agent, as a covering element does (#117's line). The refusal tells it to stop after a second try.
- **The words:** Chord's alone, no page string.
- **Late controls:** read under `wait_for`'s rules (its scope, Never sites, one wait at a time, its bound); the ref acts only once shown (#208). `wait_for` by role and name judges a field as the snapshot does (a visually hidden checkbox counts when its label shows).
  - *Tests:* agents-refind.spec: a button drawn 1.5 s after load: not in the first look; `wait_for` with `snapshot: true` gives its ref; the click joins. A visually hidden checkbox drawn late: `wait_for` met.
- **Look-alikes told apart:** a find by the item's words names one; its ref acts on that one, found again after the redraw.
  - *Test:* agents-refind.spec: two Delete buttons in named sections, redrawn every 100 ms: `find: "Delete Draft B"`, click: B deleted, A not.

## Measured

- The journey on one CPU at 0.35, five repeats (`--slow`): all passed.
- The #117 journeys (the game's redraws, the budgets) pass as before. Their look-alike cases (the twin Bet buttons; a Delete of two; a twin drawn between tries or after the snapshot) now get the ambiguous refusal, where they got *changed*.
- Cost: a twin keeps its place and shape (two strings it had before the snapshot's finish dropped them). A twin's scan stops at the first match.
