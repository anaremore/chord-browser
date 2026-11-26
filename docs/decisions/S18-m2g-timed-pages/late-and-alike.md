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
- **Never a guess:** re-finding a redrawn ref (#117) looks for exactly one element of the same role, name, items, place and shape. More than one is refused; so is a ref whose snapshot had a twin (its re-find data dropped).

What this adds: **that refusal says what it is and how to choose.** It was *That element changed since the snapshot*, which reads as gone. Now there are two cases:
- **twins in the snapshot**, one of which the page redrew (the snapshot marks each twin);
- **more than one alike** when it's found again (the page drew another just like it).

Both are refused with `ACT_REFUSALS.ambiguous`: *The page redrew that element, and it has a look-alike (the same name, in the same place), so which one you meant can't be told and nothing was done. Call snapshot, or find with the words of the row or item it's in, and use the ref of the one you mean.*

## Threat checklist

- **Never a guess between look-alikes:** exactly one match acts, as before (#117). Two or more are refused, and nothing is pressed.
  - *Tests:* agents-refind.spec: twins in unnamed list items, redrawn every 100 ms (refused, nothing deleted); one at the first look and two alike later (refused, nothing deleted); each path fails with its refusal reverted. control.test: the refusal's words, nothing pressed.
- **A decoy beside a button** (the page draws a twin to make the agent refuse): it only stops the agent, as a covering element does (#117's line).
- **The words:** Chord's alone, no page string.
- **Late controls:** read under `wait_for`'s rules (its scope, Never sites, one wait at a time, its bound); the ref acts only once shown (#208).
  - *Test:* agents-refind.spec: a button drawn 1.5 s after load: not in the first look; `wait_for` with `snapshot: true` gives its ref; the click joins.
- **Look-alikes told apart:** a find by the item's words names one; its ref acts on that one, found again after the redraw.
  - *Test:* agents-refind.spec: two Delete buttons in named sections, redrawn every 100 ms: `find: "Delete Draft B"`, click: B deleted, A not.

## Measured

- The journey on one CPU at 0.35, five repeats (`--slow`): 5 passed.
- The #117 journeys (the game's redraws, the budgets) pass as before. Their look-alike cases (the twin Bet buttons; a Delete of two; a twin drawn between tries or after the snapshot) now get the ambiguous refusal, where they got *changed*.
