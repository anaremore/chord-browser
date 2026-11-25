# S18 M2g-2, slice 1: the honest baseline (2026-11-25)

Measurement only, no product code. It's the BEFORE every later M2g-2 slice is measured against, taken on main at #145's merge (`6fc459e`) with the plan's new journeys (`plan.md`, slice 1).

## How it's measured

agents.spec's *token eval* plays each journey through the relay, as an agent would with this build's tools. Every journey looks first. Each result's content is counted (about 4 characters a token; a picture by its pixels). Two estimates of what the model reads:
- **Model input (est.):** each tool call is a model turn that sends the tool definitions, a fixed 8,000 tokens of system prompt and history, and every result so far.
- **Cached (est.), new:** the same with full-prefix prompt caching, as Anthropic's API prices it.
  - Each turn's prompt is the turn before's, read from the cache at 0.1×, plus what's new, written to it at 1.25×.
  - The first turn writes it all.
  - Fixed costs (definitions, system prompt) fall to a tenth after the first turn, so this column shows what a change saves a client that caches.

## Outside agents (Linux container, X11; Wayland gives the same counts)

| Journey | Success | Tool calls | Result tokens | Tool definitions | Model input (est.) | Cached (est.) | Wall (s) |
|---|---|---|---|---|---|---|---|
| Bot game, one hand | yes | 6 | 859 | 2,330 | 64,632 | 19,331 | 4.3 |
| Timed table, two turns | yes | 6 | 612 | 2,330 | 63,907 | 18,974 | 4.9 |
| A 20-field form | yes | 3 | 974 | 2,330 | 32,538 | 16,253 | 4.1 |
| A page that draws itself | yes | 3 | 232 | 2,330 | 31,415 | 15,288 | 0.9 |
| A 300-row list | yes | 4 | 486 | 2,330 | 42,611 | 16,700 | 0.3 |
| **Reading one section of 50** | yes | 3 | 14,615 | 2,330 | 55,850 | 34,272 | 0.1 |
| **An action's effect, seen in the diff** | yes | 6 | 847 | 2,330 | 65,164 | 19,370 | 3.4 |
| **An action's effect, seen by a snapshot (no diff)** | yes | 8 | 1,303 | 2,330 | 88,669 | 22,245 | 3.4 |
| **A broad find (300 orders, each with Cancel)** | yes | 4 | 7,303 | 2,330 | 56,265 | 25,904 | 0.3 |
| A picture of the view | yes | 2 | 1,109 | 2,330 | 21,814 | 15,336 | 0.1 |

The new journeys are in bold.

- **Reading one section of 50:**
  - A 50-section article with the answer in section 37, past `read_tab`'s first range (40,000 characters).
  - The agent reads ranges until it finds it: two reads, 14,615 result tokens. It's the most expensive journey per call, and slices 3 (an outline-only snapshot, a smaller default) and 4 (`read_tab(ref)`) are measured against it.
- **An action's effect** (a click opens a confirm dialog; another shows a row's details): the agent's next step needs what the click did.
  - With #145's diff after an action, it acts on the refs the diff gives: 6 calls.
  - Played as an agent with no diff (a snapshot after each such click, the diff left out of the count): 8 calls.
  - **The diff saves 2 calls, and reads 26% less (65,164 against 88,669), or 13% less with caching (19,370 against 22,245).**
  - This is the measure the planner asked for when keeping the diff on by default (#145): the scripted hand never needs to look again, this journey does.
- **A broad find:**
  - 300 orders, each with *View* and *Cancel*. The outline shows 5 rows and how many more.
  - `find` "Cancel" returns all 300 matches with their rows: 7,303 result tokens.
  - Slice 5's cap (20 matches, flat lines, nearest names) is measured against it.

## The assistant (main's baseline)

Measured through the assistant's own tool path (assistant-acting.spec, with the fake Claude Code's `Act:` turn), the same estimate. Linux container, X11 and Wayland alike:

| Journey | Tool calls | Result tokens | Tool definitions | Model input (est.) |
|---|---|---|---|---|
| A look and a click on the table (cards already allowed for the chat) | 2 | 167 | 1,894 | 20,056 |

The assistant's list (acting on) is 1,894 tokens of definitions, against outside agents' 2,330: it has no `open_tab`, `close_tab`, `batch` or `wait_for`, and has `search_history`, `search_archive` and `propose_fill`. Slice 2's diet is measured against both.

## What it changes

- agents.spec:
  - the cached column;
  - an option to count a result as a build with no diff would have sent it;
  - the four new journeys and their fixtures.
- fake-claude: its `Act:` turn records its tool list's size and each result's whole size (`acting-sizes.jsonl`).
- assistant-acting.spec: the assistant's metered turn.
- No product code.
