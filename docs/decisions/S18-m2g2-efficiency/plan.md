# S18 M2g-2: efficiency (plan, 2026-11-25)

The owner agreed to more efficiency work after M2g-1 (#145). This plan is docs-only until #145 merges, and Neon reviews its design first. The threat check is in `threat-checklist.md`.

## The rule for every item

The same eval journeys as #145 (`agents.spec`'s *token eval*), with the same estimate of what the model reads (#145's plan, *Is it worth it?*).
- **Success is the gate:** no item lands if any journey's success drops.
- **The score:** tool calls, model input (est.) and Chord's wall time, per journey. The table gives BEFORE (#145 merged) and AFTER for each item.
- **An item that pays off on no journey is dropped,** and the plan says so, as #145 did with screenshots by exception and by role and name.

## Where it starts (#145 at `e8e922a`, X11)

| Journey | Calls | Model input (est.) |
|---|---|---|
| Bot game, one hand | 6 | 64,632 |
| Timed table, two turns | 5 | 53,223 |
| A 20-field form | 3 | 32,538 |
| A page that draws itself | 3 | 31,415 |
| A 300-row list | 4 | 42,628 |
| A picture of the view | 2 | 21,814 |

**The tool definitions:**
- Outside agents: 2,330 tokens, against main's 1,725.
- The assistant: 1,909 tokens, with acting on.
- By tool (agents' list, in tokens: whole / description / schema):

| Tool | Whole | Description | Schema |
|---|---|---|---|
| snapshot | 285 | 207 | 51 |
| batch | 285 | 71 | 182 |
| wait_for | 236 | 111 | 98 |
| type | 159 | 57 | 70 |
| press_key | 150 | 28 | 89 |
| click | 133 | 58 | 43 |
| read_tab | 118 | 40 | 52 |
| select_option | 118 | 28 | 56 |
| navigate | 101 | 28 | 40 |
| open_tab | 100 | 42 | 31 |
| hover | 97 | 22 | 43 |
| page_diagnostics | 83 | 27 | 28 |
| read_selection | 82 | 28 | 26 |
| list_tabs | 80 | 34 | 19 |
| tab_screenshot | 80 | 24 | 28 |
| read_form | 78 | 23 | 28 |
| back | 77 | 17 | 28 |
| close_tab | 71 | 16 | 28 |

Each tool also costs about 25 tokens of name and annotations whatever it says, so merging two tools saves more than trimming one.

## New journeys

Two journeys are added first, measured on #145 as their BEFORE:
- **Reading one section:** a long article (50 sections), and the answer is in section 37. Today an agent reads the page with `read_tab` in ranges, or snapshots it.
- **A control the page redrew:** a table that replaces its buttons between turns. The agent's ref is refused as changed, and today it calls snapshot again to get the new one.

## 1. `find`

**Today:** `snapshot` takes `find` (#145). It gives the outline's lines whose names contain the words, with what they're in and their refs, and stays out of the outline's ranges (#145's N-3).

**The design:**
- It stays a parameter of `snapshot`, not a tool of its own: a new tool costs about 25 tokens on every call before it says anything.
- It gains `role` (an outline role, to narrow it: `button` for the button named *Act 150*, not its row).
- Its answer is the matching elements alone, one line each (`- button "Act 150" [ref=e301] in row "Order 150"`), at most 20. Past that, a count and "narrow it".
- No match says so, with the nearest names (item 5).
- What it reads is exactly the snapshot's walk. Hidden elements, fields' values and frames' insides are never walked, and sensitive fields never get a ref.
- It never refuses an ambiguous name, unlike by role and name: it lists both, and the agent chooses by ref.

**Target:** the 300-row list from 4 calls to 3. The agent's first look can be a `find` when it knows what it's looking for. Its model input should fall by at least 20%.

## 2. `read_text` (as `read_tab`'s `ref`)

**The design:**
- `read_tab` takes `ref` (an element from the tab's latest snapshot: a region, an article, a section, a table) and gives that element's text alone, capped at 4,000 characters, with `start` for more. It's not a new tool, for the same reason as `find`.
- It reads what shows: the element's shown text, as `snapshot` names elements. It skips:
  - text hidden by CSS (`display`, `visibility`, `opacity`), and `hidden` or `inert` subtrees;
  - fields' values and editors' contents (what's typed);
  - frames' insides;
  - scripts and styles.
- It's untrusted page content in the result's envelope, as `read_tab` is.
- A ref from another page or tab is refused as stale, as the actions refuse it.

**Target:** the reading journey in 3 calls (open, a snapshot that shows the sections, then `read_tab` with the section's ref). Its model input should be at least 50% below reading the page in ranges.

## 3. Cache-friendly output

**What prompt caching needs:**
- The cache covers a request's prefix: system prompt, tool definitions, then the turns so far. A turn already in the history never changes.
- So a timestamp *inside a result* doesn't break the cache. What breaks it is a tool list that differs between requests, or a `tools/list_changed` mid-session.
- The design is about those two, plus deterministic results, so that equal pages give equal bytes for tests.

**The design:**
- **The tool list is byte-stable for a connection:**
  - built from constants, with keys in a fixed order;
  - nothing in it that varies: no counts, dates, versions or per-connection words;
  - the same for every connection of a build with the same flags.
- **`tools/list_changed` only when the list really changed:** a bridge from another build (connection.ts already compares fingerprints).
- **Results:**
  - Each is built with keys in a fixed order.
  - Each keeps what the agent needs (`page_id`, `retrieved_at` stay: they say what a result is of).
  - None carries a per-call id or counter that the agent doesn't use.
- **Tests:**
  - Two `tools/list`s, and two connections, give identical bytes.
  - The definition sizes are asserted with a budget: the CI check the owner asked for, here for definitions.
  - Two snapshots of an unchanged page give the same outline bytes.

**Target:** the eval gets a column with caching modelled. The fixed part (definitions and system prompt) is read at a tenth of its cost after the first turn, as Anthropic's cache reads are. It's reported next to the uncached estimate, so a change that only helps uncached clients shows as such.

## 4. The tool-list diet

**Target:** outside agents' definitions **at or below main's 1,725 tokens**, from 2,330, with every journey's success kept.

**The candidates** (each measured; each dropped if a journey fails):
- **Descriptions:**
  - `snapshot`'s is 207 tokens: it explains ranges, `find`, sensitive fields and staleness. Cut to what a model needs to choose it and call it right, about 80.
  - `wait_for`'s is 111: about 50.
  - `batch`'s is 71: about 35.
  - Rules the server enforces anyway (refusals say why) don't need repeating in a description.
- **`batch`'s step schema** (182 tokens) repeats every element tool's parameters. It becomes `{ tool, ref }` plus "the rest as that tool takes it", checked at run time as now: about 60.
- **Merges** (about 25 tokens a tool, plus a description each):
  - `press_key` into `type` as `key`;
  - `back` into `navigate` (`back: true`);
  - `read_selection` into `read_tab` (`selection: true`).
  - Each merge keeps the refusals and cards of the tool it replaces.
- **`press_key`'s key list** (89 tokens of schema): an enum the server checks anyway. Described once, about 20.

**Estimate:** descriptions −220, batch −120, merges −250, the key list −60: about −650, to about 1,680.

**The gate:** a model choosing the right tool can't be checked by a scripted journey. A merged or trimmed tool that a model misuses fails silently in a scripted eval. That needs **a model-in-the-loop eval**: a real agent (Claude Code, Codex) on these fixtures, success counted over several runs. It costs model usage, so it's **the owner's call**. Without it, the diet goes in as far as the scripted journeys and a review of each description can show, and the plan says so.

## 5. Refusals that carry the next step

**The design:**
- **A changed element** (`ACT_REFUSALS.changed`: the page replaced it, and it couldn't be found again under #117's rules):
  - The refusal reads the page again (a diff's read, in its slot) and finds the elements with the same role, name and items.
  - If exactly one is found, it says its new ref: *That element changed: it's now e412 (button "Call" in region "Table 3"). Act on e412 if it's the one.*
  - Nothing is ever acted on in its place. The agent acts again, and every check and card runs again.
  - None or several: *Call snapshot*, as now.
- **`find` with no match:** the nearest names (by words in common), at most 5, with their refs.
- **A stale ref after a navigation:** the result already says the page changed. It adds the new page's title and `page_id`, so a `snapshot` (or a `find`) is the obvious next call.

**Target:** the redraw journey one call shorter. The refusal names the new ref, so no snapshot.

**The risk:** a refusal that names a ref is the page's content in Chord's refusal. It goes in the result's untrusted envelope (`data`), never in Chord's own words, and the name is clipped as the outline clips it.

## 6. The same for the assistant (behind its acting flag)

- `find` and `read_tab`'s `ref`: the same as for agents, under the assistant's rules: the tab on screen, and what it may read.
- The diet: the same merges and descriptions. Target: the assistant's list at or below its size on main (to be measured first).
- Refusals with the next step: the same.
- `wait_for` and `batch` stay outside agents' alone (#145's B-4; the assistant works with the user watching).
- The diff after an action: already the assistant's too (#145's `done()`). Checked by its own eval turn.

## Slices

Each is its own PR of about 1.5k lines or less, measured against the table, in this order:
1. **The new journeys and the cached column** (measurement only).
2. **`find` and `read_tab`'s `ref`.**
3. **Refusals with the next step.**
4. **The tool-list diet:** descriptions and `batch`'s schema first; the merges only with the model-in-the-loop eval, or as far as the scripted journeys can show.
5. **Cache stability tests and the definitions budget in CI.**
6. **The assistant's turn of 2, 3 and 4.**

## For the owner

- **The model-in-the-loop eval:** it gates the diet's merges. It costs model usage per run.
- **The definitions budget in CI:** proposed at the diet's result (1,725 tokens for agents), failing a PR that grows it without a measured reason.
