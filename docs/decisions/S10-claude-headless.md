# S10: Claude Code headless, with Chord's tools in-process

**Result: pass on Windows 11 with Claude Code 2.1.309.** macOS and Linux follow the same protocol and are checked by hand.

**Decision:** Duet spawns the user's unmodified `claude` binary, one process per active chat, speaking stream-json on stdio. Chord's tools are an MCP server declared in the `initialize` control request and served on the same control channel. Chord ships no Anthropic code and no helper binary, and opens no port (ARCHITECTURE.md §11.2, D9). Stop uses the `interrupt` control request (D10).

## Evidence (2026-10-22, Windows 11, `claude` 2.1.309 native install)

The spike is `spikes/s10-duet/claude.mjs` (session, tools, interrupt) and `auth.mjs` (sign-in state). It prints message types and tool traffic only and never opens a credential file. Each run used a cheap model and an empty working folder.

| Question | Seen |
|---|---|
| Do the browse-mode flags exist in this version? | All of them: `--restricted`, `--tools ""`, `--disable-slash-commands`, `--strict-mcp-config`, `--allowedTools`, `--permission-prompts none`, `--system-prompt-snapshot off`, `--session-id`, `--resume`, `--include-partial-messages`. `--append-system-prompt-file` works but is hidden from `--help` (it is documented). Rechecked 2026-10-23 with `claude --help`. |
| Can Chord's tools be served without argv, a port or a helper? | Yes. `initialize` with `sdkMcpServers: ["chord"]` makes the CLI send `tools/list` and `tools/call` to Chord as `mcp_message` control requests; Chord replies with `control_response`. `system/init` lists the tools as `mcp__chord__<name>`. |
| Does a slow tool (an approval card) time out? | No. A tool answered after **75 s** completed normally. |
| Can a reply be stopped on Windows without signals? | Yes. `system/init.capabilities` includes `interrupt_receipt_v1`; an `interrupt` control request ends the turn with a `result` whose `subtype` is `error_during_execution` (`terminal_reason: aborted_streaming`), and the process stays usable for the next message. |
| What happens on a bad `--resume`? | The CLI prints *No conversation found with session ID: …* on stderr and exits 1 before `system/init`. Duet treats that as "resume failed" and continues from a summary. |
| Where does the CLI keep the session? | `<config>/projects/<cwd with non-alphanumerics as dashes>/<session>.jsonl`. With Chord's own empty folder as cwd, the project folder is Chord's alone, so deleting a chat deletes exactly that file (and a `<session>/` folder if present). |
| Signed in? | `claude auth status` exits 0 when signed in; Chord reads only `authMethod` from its JSON (to say *Using your API key* when that is what pays). |
| Built-in tools reachable? | No: with `--tools ""` the model sees only `mcp__chord__*`, and `--permission-prompts none` denies anything else. |
| How full is the context? (2026-10-23) | Each `result` carries `usage` with `iterations` (one per request in the turn: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`) and `modelUsage[<model>]` with `contextWindow` (1,000,000 for `claude-haiku-5-5`) and `maxOutputTokens`. `system/init.model` names the model. Duet's context meter uses these (ARCHITECTURE.md §11.2). |
| Inside WSL? (2026-10-23) | `wsl.exe -e` passes every argument through unchanged, the empty `--tools ""` included. The protocol, tools, resume and deleting the session file work through it (checked with the fake CLI inside Ubuntu 22.04; this computer's WSL has only Claude Code 1.0.34, too old for browse mode). |

## How it's tested without the CLI

`apps/desktop/test/e2e/fake-claude.mjs` speaks the same protocol (control channel, tools, interrupt, session files under `CLAUDE_CONFIG_DIR`, the bad-resume exit). The adapter's unit tests and Duet's E2E run against it, so CI needs no sign-in or network.

## Still to check (by hand)

- macOS and Linux with a real sign-in: the same flags, Stop, and a relaunch that resumes the chat.
- An older CLI without `interrupt_receipt_v1`: Stop should kill the process and the next message should resume.
- `ANTHROPIC_API_KEY` set in the user's environment: Setup should say *Using your API key*.
