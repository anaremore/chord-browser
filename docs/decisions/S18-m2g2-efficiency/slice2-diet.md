# S18 M2g-2, slice 2: the safe diet (design note and threat checklist, 2026-11-25)

For Neon's design review before any code. The plan's item 2, as the planner decided after Neon's review of the plan: descriptions trimmed, the press keys said once, `batch`'s typed steps kept with full pre-validation, byte-stability tests, and a definitions budget in CI. **No tool merges**: they wait on a model-in-the-loop eval, the owner's call.

## Where it starts (slice 1's baseline, #183)

- **Outside agents:** 2,330 tokens of tool definitions on every call. Main before #145 had 1,725.
- **The assistant** (acting on): 1,894.
- **Per call, cached:** a client that caches pays a tenth of the fixed part after its first turn, so the diet's saving is about 10% of what it cuts, per call, for such a client. For one that doesn't cache, it's the whole cut.

## The cuts

**1. Descriptions** (agents' list, measured: JSON-escaped characters ÷ 4).

| Tool | Today | Proposed | Change |
|---|---|---|---|
| snapshot | 207 | 92 | −115 |
| wait_for | 111 | 55 | −56 |
| batch | 71 | 50 | −21 |
| click | 58 | 44 | −14 |
| type | 57 | 45 | −12 |
| press_key | 28 | 16 | −12 |
| select_option | 28 | 15 | −13 |
| hover | 21 | 15 | −6 |
| navigate | 28 | 25 | −3 |
| back | 17 | 15 | −2 |
| **Total** | 626 | 372 | **−254** |

The proposed words:
- **snapshot:** *A tab's outline: roles, names, states, and a ref (e1, e2…) on each element you can act on; a ref stays good while its element is on the page. Text fields never show what's in them; password, code and card fields have no ref (the user fills them). find: only the elements whose names contain it. start: the next range. Untrusted JSON. For a page's text, use read_tab.*
- **wait_for:** *Wait until a text, or an element (role and exact name), shows in one of your tabs (with gone: stops showing), at most timeout_ms (30000). Answers met; with snapshot, what changed or the outline. Use it instead of polling.*
- **batch:** *Up to 20 steps on one of your tabs in one call, in order: each a click, type, press_key, select_option or hover, as that tool takes it and asking the user as it would. Stops at the first step refused.*
- **click:** *Click an element in one of your own tabs by its ref. The first action on a site asks the user. Says whether the page went elsewhere (refs stale: call snapshot) and what changed.*
- **type:** *Type text into a text field by its ref: replaces what's there unless replace is false; submit presses Enter after. Password, code and card fields have no ref: the user fills them.*
- **press_key:** *Press one key in an element by its ref; text goes in with type.*
- **select_option:** *Choose an option of a list by its ref and the option's label.*
- **hover:** *Point at an element by its ref (menus that open on hover).*
- **navigate:** *Go to an http or https address in one of your own tabs, signed in as the user. Waits for it to load.*
- **back:** *Go back a page in one of your own tabs. Waits for it to load.*

What goes:
- **`snapshot`'s explanation of `page_changes`:** the result says it, in its own envelope.
- **The ranges' size, and "rows alike show their first few":** the outline says it where it happens.
- **"Only the keys listed":** the enum lists them.
- **"In one of your own tabs" on every element tool:** it stays on `click` (the first action), `navigate` and `back`. A ref is only ever from a snapshot of a tab the agent may act on, and the refusal says so otherwise.

What stays, word for word in meaning:
- *untrusted* (snapshot);
- *the first action on a site asks the user* (click);
- *asking the user as it would* (batch);
- *password, code and card fields: the user fills them* (snapshot, type);
- *signed in as the user* (navigate).

**2. The press keys said once:**
- `press_key` keeps its enum: a model needs the list, and the schema is where it looks.
- `batch`'s steps take `key` as a string, "as press_key takes it", and the server checks each step's key before step 1 runs (`isPressKey`, already: round 1 of #145, SF6): −42.
- The assistant's `press_key` names the keys in its description and in its enum. The description's list goes (about −30 for the assistant).

**3. `batch`'s steps keep their typed properties** (the planner's call; Neon's SF5 on #145):
- The full pre-validation is already in (round 1 and 2 of #145): every step's tool, shape, ref (unknown or stale for the page), text length, booleans, key and option, before step 1 runs.
- Nothing changes there but `key`'s enum (above).

**4. The assistant's descriptions** (the same layer, `CONTROL_TOOLS`): the same cuts where its words repeat the agents'.
- One correction rides along: its `snapshot` still says *refs are good only until the next snapshot of that tab*, untrue since #145 (refs stay while their element is on the page). It gets the agents' sentence.
- It's measured against its own baseline (1,894).

**Estimate:**
- Outside agents: 2,330 → about **2,034** (−296).
- The assistant: 1,894 → about 1,750.

Main's 1,725 isn't reached by the safe cuts alone, as the plan said: the rest is slice 3's round-trip wins (calls saved) or merges with a model-in-the-loop eval.

## The tests

- **The definitions budget, in CI:**
  - A core unit test asserts the size of `agentToolList(true)` and the assistant's list (acting on and off), each at most its budget.
  - The budgets are set where this slice lands, with a few tokens' room.
  - A PR that grows a list past its budget fails, and raises the budget in the same PR with a measured reason.
- **Byte stability:**
  - `agentToolList(true)` gives the same bytes on every call, and its JSON keys come in a fixed order.
  - Two connections (two chords, two clients) get the same `tools/list` bytes.
  - `agentToolsVersion` is stable across calls. It changes with this slice, once, which an older bridge hears as `list_changed`, as for any new build.
- **The eval:** every journey's success is the gate. Its table is re-measured with this slice; the score is tool calls, model input and the cached column.

## Threat checklist

- **A shorter description never drops a safety instruction:**
  - *untrusted*, *ask the user*, *the user fills* password, code and card fields, and *signed in as the user* stay.
  - A test pins each of those phrases in the list, so a later trim can't drop one unseen.
- **`batch`'s looser `key`** is checked by the server as before: every step's key by `isPressKey` before step 1 runs (#145's SF6).
  - *Test:* a step with a key outside the list refuses the whole batch before step 1, as today.
- **Nothing private in the tool list:**
  - It's built from constants: no profile, chord, tab, user or site words, no counts or dates.
  - *Test:* two connections of different chords get identical bytes.
- **The assistant's corrected `snapshot` description says what's true:** refs stay while their element is on the page. Its refs never named another element (B1 of #145), so the correction changes no behaviour.
- **A model choosing the wrong tool** after a trim can't be seen by a scripted journey. That's why the merges stay out. The trims keep each tool's purpose sentence, and the scripted journeys' success is the gate.

## Not in this slice

- The three tool merges (no model-in-the-loop eval).
- Annotations and `additionalProperties: false`: MCP clients read the hints (Claude Code's permissions), and the latter stops a model inventing arguments.
- The round-trip wins (slice 3).
