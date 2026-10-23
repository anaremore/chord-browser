# S5: a tool-restricted Codex browse thread

**Result: partly verified on Windows 11 with codex-cli 0.160.1.** The restriction recipe starts, and threads with Chord's tools are accepted. The live-turn pass criteria are **not yet verified**: the test account hit Codex's usage limit (it resets Nov 16, 2026).

**Decision (provisional):** Duet runs `codex app-server` with every model-callable feature it can switch off switched off, web search disabled, the user's own MCP servers disabled by name, a read-only sandbox, and Chord's tools as `dynamicTools` in the `chord` namespace. Command and file-change approvals are declined without asking, and a tripwire stops any turn that produces an item outside browse mode (ARCHITECTURE.md §11.2).

## The recipe

```
codex app-server --disable shell_tool --disable unified_exec --disable view_image
                 --disable image_generation --disable multi_agent --disable apps
                 --disable plugins --disable tool_suggest --disable goals
                 --disable browser_use --disable computer_use --disable skill_search
                 --disable sleep_tool -c web_search="disabled"
```

Then `initialize` → `initialized` → `mcpServerStatus/list` (names only) → `model/list` → `thread/start {cwd: <empty folder>, sandbox: "read-only", approvalPolicy: "on-request", dynamicTools: [chord tools], config: {mcp_servers.<name>.enabled: false …}}` → `turn/start`.

## Evidence (2026-10-22, rechecked 2026-10-23)

The spike is `spikes/s10-duet/codex.mjs`. It prints protocol shapes only: the account's type and plan, never account details or tokens.

| Question | Seen |
|---|---|
| Do the flags exist? | `codex app-server --help` lists `--disable <FEATURE>` and `-c key=value`. `codex features list` shows all 13 features as *stable* and on by default, so each `--disable` is doing something. |
| Does the restricted server start and accept a browse thread? | Yes. `initialize`, `mcpServerStatus/list`, `model/list` and `thread/start` with the read-only sandbox and Chord's dynamic tools all succeed. |
| Model | The global default model was rejected for the test account's plan (*not supported*). Duet now uses the default from `model/list`, unless the user picks one. |
| A live turn | `turn/start` returned an `error` notification with `codexErrorInfo: usageLimitExceeded` and a reset time. Duet shows that as a usage limit with the reset time. |
| Signed in? | `codex login status` exits 0 when signed in, 1 when not. Chord never calls `getAuthStatus` (it can return the token). |
| How full is the context? (2026-10-23, from `codex app-server generate-ts`) | `thread/tokenUsage/updated {threadId, turnId, tokenUsage: {total, last, modelContextWindow: number \| null}}`, each breakdown `{totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}`. Duet's meter shows `last.totalTokens` of the window, and nothing when the window is null. Compaction is a `contextCompaction` item (`thread/compacted` is deprecated). Not seen live: the account is still at its usage limit. |

## Not yet verified (the pass criteria)

Run these once the account has usage again (or with another account), using the spike or Duet itself:

1. "Run `dir`", "edit a file" and "search the web" produce no `commandExecution`, `fileChange` that applies, `webSearch`, or written file. Any such item should trip the wire.
2. Chord's tools work end to end (`list_tabs`, `read_tab`).
3. An approval card left open for 5 minutes doesn't time the tool call out.
4. `thread/resume` after a relaunch keeps the restrictions (the features stay off, the user's MCP servers stay disabled).
5. Compare `approvalPolicy: "never"` (failures go back to the model) with `on-request` plus auto-decline; keep `on-request` unless `never` is clearly better.

## Known limits

- `apply_patch` has no switch (research §3.3); the read-only sandbox, the auto-decline and the tripwire contain it.
- The list of features is a denylist; a new default-on tool in a later Codex would be caught by the tripwire, not prevented. Duet records the tested version (0.160.1) and warns about older ones.
- ⚠ Duet's Codex chats may show in the user's own Codex history.

## How it's tested without the CLI

`apps/desktop/test/unit/fixtures/fake-codex.mjs` speaks the app-server protocol, including a dynamic tool call, a declined file change and an out-of-bounds command item; the adapter's unit tests check the tool round trip, the auto-decline, the tripwire and the usage-limit mapping.
