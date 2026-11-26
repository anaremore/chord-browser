# S18 M2g-2, slice 3a: the page at once (`snapshot: true` on `open_tab` and `navigate`), #204

The plan's item 3, its first win: an agent that opens or goes to a page gets the page's outline in the same answer, so its first look isn't a turn of its own.

## Done when (#204, with the adjustment commented there)

- `open_tab` and `navigate` take `snapshot: true` and return the page's outline in the same result, with the same read, caps, envelope and refs as `snapshot`.
- A page that draws itself after it loads gets #154's first look before the outline.
- Refs: the same refs as `snapshot` issues; the tab's untrusted envelope is intact. (The issue said *only lines shown enter the agent's table*. That isn't so for rows a long run collapses, or an outline cut at its cap: `snapshot` issues refs for them too. That limit predates this slice and was recorded in #145's round 2; the role, name and items check at act time still guards against a wrong target. Fixing it is #208's.)
- Journeys: one call fewer on every journey whose first look after `open_tab` or `navigate` is a snapshot (eight of the ten: the bot hand, the timed table, the form, the page that draws itself, the 300-row list, both action-effect journeys and the broad find); no success lost on any. *Reading one section of 50* reads with `read_tab`, and *a picture of the view* takes `tab_screenshot`: neither looks at an outline, so `snapshot: true` can't save them a call.
- Unit tests (a table over page states) and an agents E2E journey.
- The assistant, which has `navigate` and no `open_tab`: `navigate`'s `snapshot: true`, behind its own flag.

## How

- **One read, the same one.** The outline is `snapshot`'s own call (`snapshotTool`), run on the tab once the action has answered, as `wait_for`'s `snapshot` already does. Every rule `snapshot` keeps is kept because it's the same code, not a copy:
  - the scope's `readable`;
  - its card, when the scope asks one;
  - Never sites, checked before the load, after it, and after the read, on the read's own address;
  - sensitive fields with no ref (`snapshotKeys`);
  - #154's first look, for a page that draws itself;
  - the caps and ranges, and the refs the tab's latest.
- **The answer.**
  - It's `snapshot`'s envelope, unchanged (`source: web_snapshot`, `trust: untrusted`, its origin, address, ranges and refs).
  - The action's own words come under the tool's name (`open_tab` or `navigate`), less what the envelope already says (the tab, the page, its address and title).
  - `navigate`'s *call snapshot again* note goes: the outline is there.
- **No outline:**
  - The action still happened, so its result stands, never an error. It says why in `no_outline`, in Chord's own words (`snapshot`'s refusal), never a page's.
  - A page still loading when the action answered gets no outline, and says so. No second wait: `open_tab`'s 30 s is the limit, as today.
- **Without the parameter,** both answer exactly as today.
- **Where it's offered.**
  - Outside agents: `open_tab` and `navigate`, in builds with M2's tools (`snapshot` exists only there).
  - The assistant: `navigate` only, while `ASSISTANT_GO_OUTLINE_RELEASED` is off: in development builds, not in packaged ones until it's released. The scope says it too (`outlineOnGo`), so a list that didn't offer it can't be called with it.

## Threat checklist

The plan's line (threat-checklist.md, *The outline-only snapshot and `snapshot: true`*), and the planner's: the outline returned for a page opened or navigated obeys every read gate `snapshot` does.

- **Never-read sites:**
  - Checked on the page the tab landed on.
  - An outline from a Never site is never returned, and nothing of it is kept.
  - *Tests* (control.test, agent-chords.test):
    - `navigate` with `snapshot: true` whose read comes back from a Never address gives no outline, no ref and no outline kept, and says why.
    - `open_tab` whose read does the same, or whose page goes to a Never site as it's read: as `open_tab` landing there (round 1 of #232, B1): its held notes dropped, the tab closed, the Never refusal (`isError`), and nothing of the site, then or later.
    - `open_tab` with `snapshot: true` that lands on a Never site closes the tab, as without it.
- **Private windows, and a tab the scope can't read:**
  - The scope's `readable` and `blockedNow`, at the read: `snapshot`'s own call, so its tests are these.
  - An agent's `open_tab` and `navigate` are in its own tabs, never in a private window.
- **Sensitive fields:**
  - `snapshotKeys`, as `snapshot`: a password, code or card field has its line, with no ref.
  - *Tests:* such a field in the outline from `navigate` and from `open_tab`, with no ref (unit). The `/snap` page's password and code fields after `navigate` with `snapshot: true`, and what's in its fields never shown (E2E).
- **The untrusted envelope:**
  - The outline is `snapshotResult`'s, unchanged.
  - The action's words go under a name of their own, never into `content`.
  - *Tests:* the answer's `trust` is `untrusted`, `source` is `web_snapshot`, and the action's words are under `navigate` or `open_tab`, less the envelope's (unit and E2E).
- **Refs:**
  - The same refs as `snapshot` issues (its own call).
  - Not *only the lines shown*: rows a long run collapses, and an outline cut at its cap, get refs the agent wasn't shown. The limit predates this slice (#145's round 2), and the act-time check of role, name and items guards against a wrong target. It moves to #208's *Done when*.
  - *Tests:* a ref from the outline returned resolves (unit), and acts (E2E: *Join table* after `open_tab`, *Start a return* after `navigate`).
- **The first look (#154):**
  - Bounded as it is today (`FIRST_LOOK_MS`).
  - *Test:* `open_tab` with `snapshot: true` of a page that draws itself 600 ms after it loads gives its button (E2E).
- **No page string in Chord's sentence:**
  - `no_outline` is `snapshot`'s refusal, Chord's words.
  - *Test:* for a page titled with Chord-like words, `no_outline` is the refusal's sentence alone (unit).
- **No second wait:**
  - A page still loading when the action answered gets no outline.
  - *Test:* it's said, and nothing is read (unit).

## Measured

The token eval, before and after, in the PR. The tool definitions grow (the parameter and its words, on both tools), and `tool-words.test.ts`'s budget rises in this PR with that measured reason: a call saved is a whole turn of definitions and context.
