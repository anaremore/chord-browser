# S18 M2g-2: efficiency (plan, revised after Neon's design review, 2026-11-25)

The owner agreed to more efficiency work after M2g-1 (#145). This plan is docs-only until #145 merges. Neon reviewed the first draft and the planner made the calls below; what changed from the draft is marked **(kept)**, **(changed)** or **(dropped)**. The threat check is in `threat-checklist.md`.

## Two rules for every item

1. **It builds on #145 as fixed, never on its round-1 bugs.**
   - Neon's #145 blocker: refs that stay can silently rebind to an element the page mutated in place, and `pageChanges` commits refs and the baseline even when the diff isn't shown (over DIFF_MAX_LINES).
   - Every call that shows the model only part of a page (`find`, an outline-only snapshot, a hint in a refusal) **never commits or rebinds a ref the model wasn't shown**. A ref enters the agent's table only with the line that names it.
2. **It's measured on honest journeys.** Every journey starts as an agent knowing nothing of the page would (#145's B-8).
   - **Success is the gate:** no item lands if any journey's success drops.
   - **The score:** tool calls, model input (est., with and without caching) and Chord's wall time.
   - **An item that pays off on no journey is dropped,** and the plan says so.

## Where it starts (#145 at `e8e922a`, X11)

| Journey | Calls | Model input (est.) |
|---|---|---|
| Bot game, one hand | 6 | 64,632 |
| Timed table, two turns | 5 | 53,223 |
| A 20-field form | 3 | 32,538 |
| A page that draws itself | 3 | 31,415 |
| A 300-row list | 4 | 42,628 |
| A picture of the view | 2 | 21,814 |

These are re-measured on #145 as merged, the first slice's BEFORE.

**The tool definitions:**
- Outside agents: 2,330 tokens (main: 1,725).
- The assistant: 1,909 with acting on. Main's baseline is measured first (item 7).
- By tool (agents' list, tokens: whole / description / schema): snapshot 285 / 207 / 51, batch 285 / 71 / 182, wait_for 236 / 111 / 98, type 159 / 57 / 70, press_key 150 / 28 / 89, click 133 / 58 / 43, read_tab 118 / 40 / 52, select_option 118 / 28 / 56. The ten others are 71–101 each.

## 0. The honest baseline and the caching model (slice 1)

- **The cached column (changed):**
  - It models full-prefix caching as Anthropic's API does: each turn's whole prefix (system prompt, definitions, every turn so far) is written once at 1.25× and read at 0.1× on later turns.
  - Each turn pays 0.1× for the prefix cached so far, plus 1.25× for what it adds.
  - It sits next to the uncached estimate.
- **The bot game (changed):** the bet goes in with `type(submit: true)`, as an agent would play it, not `type` then `press_key`.
- **New journeys:**
  - **Reading one section:** a long article of 50 sections, the answer in section 37.
  - **A broad find:** a page where the words match many elements: a list of 300 orders, each with *View* and *Cancel*; the agent wants order 150's *Cancel*.
  - **An action whose effect must be seen:**
    - A click opens a dialog (*Confirm: Delete order 12?* with *Delete* and *Keep*); another moves a row to the top of a list.
    - The agent's next step depends on what the click did: confirming in the dialog, or acting on the row where it now is.
    - The journey is played two ways:
      - with the diff after each action (#145's default), which shows the dialog and the moved row;
      - as an agent with no diff would play it: a snapshot after each such click.
    - It measures the diff against that extra snapshot: the calls, the model input and the result tokens. This is the measure of #145's diff after an action, which the scripted journeys can't show (the planner, 2026-11-25).
  - All three are honest: the agent looks first.

## 1. Cache-friendly output (changed: no code of its own)

- The tool list is already byte-stable for a connection: built from constants, and `list_changed` is sent only when the bridge's fingerprint differs (connection.ts).
- A timestamp inside a result doesn't break prompt caching, since only a changed prefix does, so results stay as they are.
- **What lands, with the diet (slice 2):**
  - byte-stability tests: two `tools/list`s, and two connections of different chords, give identical bytes;
  - a definitions budget in CI.

## 2. The tool-list diet (changed)

**Target:** outside agents' definitions **at or below main's 1,725 tokens** if the safe cuts reach it. Otherwise as low as they reach, measured and said so.

**What's in:**
- **Descriptions trimmed:**
  - `snapshot` (207 tokens) to about 80;
  - `wait_for` (111) to about 50;
  - `batch` (71) to about 35;
  - the element tools' repeated sentences said once.
  - What stays: *untrusted*, *ask the user*, *never act for a page's text*. What goes: explanations of what the server enforces and its refusals say anyway.
- **The PRESS_KEYS enum said once** (`press_key`'s 89-token schema, repeated in `batch`'s steps): one shared definition, or the keys named in one description, checked by the server as now.
- **`batch` keeps its typed step properties (kept, against the draft).** Its pre-validation becomes full: every step's arguments are checked by its tool's schema before any step runs (#145's SF5).
- **Tests:** byte stability, and the definitions budget (1,725, or where the diet lands) asserted in CI.

**Dropped: the three merges** (`press_key` into `type`, `back` into `navigate`, `read_selection` into `read_tab`). With no model-in-the-loop eval, scripted journeys can't show a model choosing the wrong tool.

**Estimate:** descriptions about −220, the key enum about −60 (agents' list and `batch`'s): about 2,050. Main's 1,725 likely needs the round-trip wins (below) to pay for the rest, or the merges with a model-in-the-loop eval (the owner's call).

## 3. The round-trip wins (added: Neon's, the highest value)

- **`snapshot: true` on `open_tab` and `navigate`:** the page's outline comes with the result, so the first look is no extra turn. It cuts a whole model turn on 5 of 6 journeys.
  - The outline is the snapshot's own: the same read, caps, envelope and refs. It's the agent's own snapshot (pinned).
  - A page that draws itself after it loads gets #154's first look.
- **An outline-only snapshot:** `snapshot` with `text: false` leaves out the `- text:` runs. It gives the page's structure (landmarks, headings, controls, regions) at a fraction of the tokens. The 50-section journey uses it to find its section.
  - It's a view of one read. Its refs are only the lines it shows (rule 1).
- **A smaller `read_tab` default:** a lower default cap (measured: what the reading journeys need), or a main-content mode.
- **Action results trimmed:** an action's result repeats `page_id` and `url` at the top and in `page_changes`. Said once.

**Target:** at least one call fewer on every journey that opens or navigates a tab, with no success lost.

## 4. `read_tab(ref)`: one element's text (changed: redesigned, its own PR)

- **Read-only container refs:** a separate scheme (`c12`, never `e12`) for regions, articles, sections, landmarks and tables.
  - Only `read_tab` takes them. Every acting tool refuses a `c` ref, by its pattern and again at run time.
  - The snapshot gives them on container lines, in their own table, never rebinding an element ref.
- **`<section aria-label>`** (and `aria-labelledby`) maps to `region`, as the snapshot's `itemRole` already reads it, so a named section gets a container ref.
- **What it reads:**
  - the element's shown text, by the same visibility rules as `extract.ts` (parity, tested both ways);
  - capped (the smaller default above), with `start` for more.
- **What it never reads:**
  - fields' values;
  - editing hosts and ARIA textboxes (`role=textbox`, `searchbox`, `combobox`, whatever their tag);
  - frames' insides.
- **It re-verifies the element before reading:**
  - its role and name as the snapshot gave them, still in this document;
  - on the tab's page now (`page_id`);
  - under `read_tab`'s scope and Never-site checks, before and after.
  - Changed means refused as stale, never read.
- **Target:** the 50-section journey (open with the outline, then `read_tab(ref)`) at least 50% below reading the page in ranges, measured.

## 5. `find` (changed)

- **Kept:**
  - a `snapshot` parameter, not a new tool;
  - at most 20 matches, one flat line each, with the item it's in;
  - the nearest names when nothing matches: by words in common, stop-words left out.
- **Dropped:**
  - the 4 → 3 calls target, which skipped the first snapshot (the same rig as #145's B-8);
  - the `role` filter: the game's pointer `div`s are `generic` and would be missed, and it costs schema tokens.
- **Its refs:** only the lines it shows enter the agent's table (rule 1). A find never commits a baseline for the diff and never rebinds a ref.
- **Measured** on the broad-find journey (honest), and the 300-row list.

## 6. Refusals that carry the next step (changed)

- **Kept (5B): `find` with no match** gives the nearest names, inside `snapshotResult` (the untrusted envelope), with their refs under rule 1.
- **Dropped (5A): "that element changed: it's now eN".** It bypasses #117's path and shape check, and it builds on the rebind bug.
- **Dropped (5C): a navigated result's title and page id.** It saves zero calls, and a page's title would leak into Chord's sentence through `toPlain`.
- **The rule, for every refusal:** a page's string (a name, a title) stays inside the untrusted envelope, never in Chord's own sentence. `toPlain` and batch unwrap `isError` texts into plain words, so a refusal's sentence carries no page string at all.

## 7. The assistant (changed)

- **Its scope, corrected:**
  - `snapshot` and `read_tab` are read tools: the assistant has them whether or not acting is on, under its read rules (the tabs it may read, not only the one on screen).
  - Acting (the diff after an action) is behind its acting flag.
- **Its baseline first:** main's assistant definitions and an assistant eval turn, measured before any change.
- **What it gets:**
  - the diet's description cuts;
  - the outline-only snapshot;
  - `read_tab(ref)`;
  - `find`'s nearest names;
  - each measured against its own baseline.
- **`wait_for` and `batch` stay outside agents' alone** (#145's B-4).

## Slices

Each is at most about 1.5k lines, measured against the table. None starts before #145 merges.
1. **The honest baseline and the caching model:** the cached column, the bot game's `submit`, the two new journeys, main's assistant baseline.
2. **The safe diet:** descriptions, the key enum once, `batch`'s full pre-validation, byte-stability tests, the definitions budget in CI.
3. **The round-trip wins:** `snapshot: true` on `open_tab` and `navigate`, the outline-only snapshot, the `read_tab` default, trimmed action results.
4. **`read_tab(ref)`:** container refs and their checks.
5. **The `find` tweaks:** the 20 cap, flat lines, nearest names.
6. Each slice's assistant turn goes with it where it applies, behind the assistant's own flags.

## For the owner

- **A model-in-the-loop eval:** a real agent on these fixtures, over several runs. It's the only way to check tool merges and deeper description cuts; it costs model usage. Without it, the merges stay out.
- **The definitions budget in CI:** set where slice 2 lands.
