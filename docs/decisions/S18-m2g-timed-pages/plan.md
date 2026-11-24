# S18 M2g-1: fast enough for timed pages (plan, 2026-11-24)

Part of S18 (agents act on pages; the earlier slices are in `../S18-agent-mcp.md`). The threat checklist is in `threat-checklist.md`; Neon reviews the design before code.

The owner, on a real-time online table (main plus #117): the agent played a full hand at a bot table, but at a live table it was too slow for the action timer, so it was auto-folded and then unseated. Each move took a snapshot, a click and screenshots, several seconds in all, and a click sometimes still hit a re-render. The agent itself suggested the changes below. #143 (a tool call times out on the client while a card waits) is the same layer and goes in this slice.

**Measure first.** For snapshot, click and type on the redraw fixtures (`/table`, `/game`, `/moves`): p50 and p95 of each step inside Chord (from the tool call arriving to its answer), split by phase (lookup, describe, card, point, hit, deep checks, press, settle), plus the round trip through the relay as an agent sees it. Measured before any change and after each, in the Linux container (X11 and Wayland). Where the seconds go decides the order of the work below.

**What changes (to be settled with Neon's review):**
1. *Target by role and name.* `click`, `type`, `press_key`, `select_option` and `hover` take `{ role, name }` instead of a `ref`, resolved when the action runs. The page is walked as the snapshot walks it (the same rules for what's shown and what counts as acted on), and the element must be the only one with that role and that name. Optionally `within` names an item (a row, region or dialog by its role and name). Then it's an element like a ref's, and every check after is the same: the site card, the step classified from what's found, the step card for a risky step, the step checked again before input, the hit test and the guard.
2. *`wait_for`.* It returns when a text, or an element with a role and name (and `within`), appears or disappears in the tab's page, or when its timeout runs out (at most 30 s; default 10 s). It answers only yes or no and how long it took, never page content.
3. *A compact snapshot with each action's result.* Optional (`snapshot: true` on an action), it's the page's outline after the action has settled, bounded (refs and characters) and cut the same way `snapshot` is, so the next step needs no extra call.
4. *#143, card waits.* A tool call waiting on a card answers before the client's timeout: *Waiting for the user to approve on Chord's card. Try the same step again in a moment.* The card stays up, and the user's Allow is kept for that exact step (the late Allow `stepKey`), so the retry goes straight through, once. Where a client sends a `progressToken`, Chord sends MCP progress notifications to keep the call alive instead.

## #143: what the clients do (looked up 2026-11-24, to check in slice (a))

- **Codex:** each MCP tool call times out after `tool_timeout_sec`, 60 s by default, per server in `config.toml`.
- **Antigravity:** 3 minutes a tool call by default (and 5 to connect), per server with `timeoutSeconds`.
- **Claude Code:**
  - No total limit by default (`MCP_TOOL_TIMEOUT`, about 28 hours; a per-server `timeout` overrides it). Progress notifications don't extend it.
  - An idle limit: no answer and no progress notification for 30 minutes on stdio (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`).
  - A call still running after 2 minutes moves to a background task (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). Its transcript names it *MCP task … (server/tool)*, the words the owner saw.
  - A report against one release (2.1.148) has stdio tool calls failing after about 1 s.
- **Chord:** a card waits 45 s (`CONTROL_WAIT_MS`), then answers *Waiting for the user to allow this in Chord…*. A late Allow counts for that same step once (M2d). Chord's server doesn't declare MCP tasks.
- **So:**
  - Codex and Antigravity should never time out on a card. What the owner saw in Claude Code needs a reproduction first: the owner's Claude Code version, and whether the call was backgrounded or failed outright.
  - The fix to test:
    - Answer *waiting* well before every client's limit, about 20 s.
    - Send progress notifications every few seconds while a card is up, when the call carries a `progressToken`.
    - Keep the late Allow for the retry.

## Slices

**PRs (each about 1.5k lines or less, pushed early):** (a) measurement and #143; (b) target by role and name; (c) `wait_for`; (d) the snapshot with a result. The order after (a) is decided by what the measurement shows.

## Checklist to tests

**Checklist to tests** (filled in as each slice lands):

| Checklist item | Test |
|---|---|
| Duplicates refuse | |
| `within` and items | |
| Swap between resolving and the press | |
| Step classified from the element | |
| Sensitive fields never matched | |
| Resolving walk budget | |
| `wait_for`: same readability as `read_tab` | |
| `wait_for`: one at a time, 30 s, Stop and navigation | |
| `wait_for`: throttled checks on a page mutating every frame | |
| Snapshot with a result: caps, untrusted, refs replaced, none after navigating | |
| #143: answered before the client's timeout, the retry runs once, nothing twice | |
