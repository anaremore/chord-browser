# S19: Antigravity as the assistant's third app (spike)

**Result: no-go for now, look again later (owner, 2026-11-22).** `agy acp` 1.5.14 can be driven from Chord and handed Chord's tools, and its file and command tools can be held behind Chord's answers. But it can't be made browse-only: its web search, timers and subagents run without asking whatever the settings, and nothing removes them. The assistant's promise (it chats and reads what you let it, ARCHITECTURE.md §11) wouldn't hold. Antigravity keeps using Chord the way it already can, as an outside agent (S18, Settings → Agents → *Add to Antigravity*). Revisit when `agy acp` can drop built-in tools (below, *When to look again*).

Nothing ships from this. The prototype isn't on main: it lives in `spikes/s19-antigravity/` (README there) on the branch `spike/antigravity-assistant` (draft #101, closed), outside the app and every build.

## What was decided before the spike (owner, 2026-11-21)

- Spike first.
- **API key or Enterprise sign-in only.** Antigravity's FAQ: *"Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service … To use a third-party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key."* Its headless answer adds that wrapping `agy` in other apps *"is not supported under consumer plans"* ([FAQ](https://antigravity.google/docs/faq)). So the assistant would offer Antigravity only with a Gemini API key, Gemini Enterprise (`oauth-business`) or Agent Platform, say so, and never use a personal (`oauth-personal`) Google sign-in.

## How it was tested (2026-11-22)

- **The real agy, in a throwaway Linux container** (`node:24-bookworm-slim` under Docker, nothing on the Windows desktop): Linux x64 **agy 1.5.14**, from Google's release channel (the manifest T3 Code reads), its SHA-512 checked. Its archive is 101 MB; the one executable inside is 261 MB.
- **A private home for every run:** `--gemini-dir <private> --app-data-dir antigravity-acp`, `GEMINI_HOME=<private>`, an empty working folder, and a `HOME` whose `~/.gemini` held planted spies: a global `mcp_config.json` server, `hooks.json`, a `GEMINI.md` rule and a CLI `settings.json` with `toolPermission: "always-proceed"`.
- **A key from the owner** (through a secret card, as a mounted file, never printed): it signed in, but its project has no prepaid credits (*Error 402 … prepayment credits are depleted*), so **no real model turn ran**.
- **A stand-in model instead.** agy sends its model requests to `GOOGLE_GEMINI_BASE_URL`, so a small local server (`fake-gemini.mjs`) answered as Gemini. It logged what agy declared (tools, system prompt) and replied with a script of tool calls: Chord's two tools first, then a file write, a command, reads inside and outside the folder, a web search, a workflow, subagents, a timer, a question. agy did the rest for real: permission requests, tools, files. Chord's tools were a stand-in MCP server (`stand-in-chord.mjs`: `list_tabs`, `read_page`) passed in `session/new`.
- **T3 Code** (github.com/pingdotgg/t3code, MIT) drives `agy acp` and was read for its approach: the private `GEMINI_HOME`, the two directory flags, the variables it drops, the release channel. Ideas only; no code was copied.
- **Google's docs:** [settings](https://antigravity.google/docs/settings.md), [permissions](https://antigravity.google/docs/permissions?tab=cli), [FAQ](https://antigravity.google/docs/faq), [CLI reference](https://antigravity.google/docs/cli/reference), [ACP](https://antigravity.google/docs/cli/acp).

The 14-case self-test replays two recorded streams from the prototype against the policy: `node spikes/s19-antigravity/selftest.mjs` on that branch.

## The risks

### 1. Browse-only lockdown (the top risk): **confirmed, partly mitigated**

| Claim | Verdict | Evidence |
|---|---|---|
| No flag turns off the built-in tools | **Confirmed** | `agy acp --help` has `--sandbox`, `--dangerously-skip-permissions`, `--include-default-customizations`, `--disable-telemetry` and the directory flags; nothing for tools. Google's settings reference has no such key. The binary does contain `disableBuiltInTools`, `disabledTools` and `excludeTools`, but in the private `settings.json` none changed anything: agy still declared the same **18 tools** to the model. |
| What the model gets | Seen | `read_file`, `write_file`, `edit_file`, `run_command`, `run_workflow` (Python), `search_web`, `schedule`, `invoke_subagent`, `define_subagent`, `manage_subagents`, `send_message`, `swarm`, `manage_task`, `ask_question`, `list_resources`, `read_resource`, and Chord's as `mcp_chord_list_tabs`, `mcp_chord_read_page`. Slash commands include `/browser` (*Invoke a browser agent for web tasks*), `/schedule` and `/goal`. |
| It reads the global `~/.gemini` MCP servers, hooks, rules and settings | **Refuted, with a private home** | With `--gemini-dir` and `GEMINI_HOME` pointing at a Chord-owned folder: the global MCP spy never started; the global hook never ran, though tools did; the global `GEMINI.md` was in no request; the global `always-proceed` was ignored (commands still asked). A `GEMINI.md` and `.agents/mcp_config.json` in the working folder's parent weren't loaded either (no `.git` above it). agy still installs its own built-in skills and enables its `swarm` plugin inside the private home (1.5 MB in all). One file lands outside it: `$HOME/.config/antigravity/plugin-secrets.json` (*file-based secret storage*, for plugins). |
| 1.5.7+ defaults to auto, editing and running with no permission request | **Refuted for an API key** | `session/new` offers only `default`, `accept-edits` and `plan`, current `default`. Google's docs: auto is the default *where available* (needs its sandbox; not for business or enterprise accounts). |
| …but `default` doesn't ask for everything | **New, confirmed** | In `default`, `write_file` into the working folder **ran without a permission request** (the file was there afterwards), and `read_file` of `$HOME/.gemini/GEMINI.md`, outside the folder, also ran without one. A command, a workflow and a read of `/etc/hostname` did ask. |
| Settings can make it ask | **Confirmed** | `toolPermission: "strict"` in the private `settings.json`: every write, edit, read and command asked, and Chord's *Deny* stopped each one (no file written, nothing run). `permissions.deny` rules on their own changed nothing (the workspace write still went through), so they aren't relied on. |
| What still runs without asking, whatever the settings | **Confirmed** | `search_web` (a Google search through the model's own endpoint), `schedule` (*Tool is running as a background task*), `define_subagent` and `invoke_subagent` (a subagent starts; its writes still ask under `strict`), `ask_question` (agy answered it with the user's next queued message), `manage_task`. Under `default`, a subagent's write wouldn't ask either. |
| A tripwire can stop them | **Only after they start** | As Codex's: any tool call that isn't Chord's sends `session/cancel`. It ends the turn (`stopReason: "cancelled"`), but agy reports a tool call as it starts it: `search_web` **completed after the cancel** (`fixtures/search.jsonl`). The search has already left the machine by then. |

**So:** with a private home, `toolPermission: "strict"`, no `fs` or `terminal` offered, every non-Chord permission request rejected, and a tripwire, nothing in the spike wrote a file, ran a command or read outside its folder. What can't be stopped: a web search the model decides on, a timer that later starts a turn nobody sent, and subagents that spend the user's quota. Claude Code gets `--tools ""`; Codex can't drop `apply_patch` but its read-only sandbox contains it. agy's search goes to Google, outside every *Never* site and scope rule Chord keeps, and Chord can't refuse it first. That's the no-go.

### 2. Approvals: **confirmed workable**

- Each call of a Chord tool arrives as `session/request_permission` with `toolCall.name: "mcp_chord_<tool>"` and two options, `allow` (`allow_once`) and `deny` (`reject_once`). It names no server: agy prefixes the name. With a private home, Chord's is the only MCP server, so `mcp_chord_` plus a tool Chord offered is unambiguous. Chord answers *allow once* (never *always*: a grant agy keeps is one Chord can't see), and the call then goes through Chord's own gate, which shows its cards where its rules say so. Everything else is *deny* (`policy.mjs`, `permissionAnswer`).
- A `permissions.allow` rule for `mcp(chord/*)` didn't stop agy from asking; answering in Chord is enough.
- **Lazy tool loading** (`call_mcp_tool`, schemas cached on disk, so `read_file` would be needed): **refuted** for 1.5.14. With 2, 12 and 62 tools on Chord's server, every one was declared to the model directly, schemas inline.
- agy adds a required `toolSummary` argument to each MCP tool's schema and strips it before the call reaches Chord; descriptions gain *This is a tool from the chord MCP server.*
- **Not checked:** how long agy waits on a `tools/call` while Chord's card is up. S18's 45-second *waiting* answer would cover it.

### 3. The bridge: **confirmed, needs a variant of `chord mcp`**

- **stdio only.** 1.5.14's `initialize` advertises no `mcpCapabilities` (T3 Code's fixture from an older agy had `http` and `sse`). Anything else would need a port, which Chord never opens (D9). So each session would start an MCP subprocess.
- agy starts it during `session/new` (54 ms to the reply, warm) and sends `server/discover`, `initialize` (`clientInfo.name: "antigravity-client"`, protocol `2025-11-25`), `tools/list` and `roots/list_changed`, before any message.
- ⚠ **The key reaches the subprocess.** Signed in through `authenticate`'s `_meta.apiKey`, agy still puts `GEMINI_API_KEY` into the environment of the MCP server it starts. Chord's relay never logs its environment; it must stay that way.
- **`chord mcp` as it is doesn't fit.** It reaches Chord only while Agents is on, through the agent endpoint, as a `ControlAgent` with the connect card and an Agent chord of its own. The assistant needs the chat's scope (`main/assistant/scope.ts`), its attached tabs and its cards in the panel. What would fit: `chord mcp --assistant`, with a one-use token for that chat in `mcpServers[].env` (never argv, where `CommandLine` shows it), Chord serving the endpoint while such a chat is live, and the hello routed to `AssistantService`'s `onTool` instead of the agents' gate.
- **Cost per chat:** agy itself was **211 MB** resident after `session/new` (Linux), plus the relay (S18's budgets: 67–73 MB on Windows, 124–129 MB on Linux). Claude Code and Codex serve Chord's tools in-process.

### 4. Two-provider assumptions: **confirmed**

A third provider touches:

- **core:** `AssistantProvider`, `ASSISTANT_PROVIDERS`, `ASSISTANT_PROVIDER_NAMES`, `contextLabel`, `AssistantImageMaking` and the instructions (`assistant.ts`); the saved setting's check (`restore.ts`); `model.ts`.
- **data:** `assistant_thread.provider` has `CHECK (provider IN ('claude','codex'))` (migration 9, and again in 14's rebuild): a migration that rebuilds the table. A `.chorddata` with an Antigravity chat, imported into an older Chord, fails that check: its import needs a fallback.
- **ipc:** two `z.enum(['claude', 'codex'])` (`packages/ipc/src/index.ts`).
- **main:** `errorCopy` (name, sign-in command); `detect.ts` (`MIN_VERSION`, `TESTED_VERSION`, shims, the development overrides, the sign-in check and `openSignIn`, WSL); `launch.ts` (`bins`); `service.ts`: two `provider === 'claude' ? ClaudeSession : CodexSession`, the *Switched to …* divider, the not-installed copy, the Codex-only idle drop, and **`deleteProviderCopy`, which treats every non-Claude provider as Codex**. Antigravity has no delete call (its sessions offer `resume`, `close`, `load` and `list`), so Chord would delete `brain/<id>/`, `conversations/<id>…` and the `implicit/` record by exact id inside its private home.
- **renderer:** `MODELS` and the setup link in `Assistant.tsx`, the provider choices (`['claude', 'codex']`), `AssistantSettings.tsx`.
- **The session:** an ACP adapter beside `claude.ts` and `codex.ts`. The pieces map well: `agent_message_chunk` to text, `usage_update {used, size}` to the context meter, `configOptions` (model, thinking level) to the model menu, `session/cancel` to Stop, `session/resume` or `session/load` to resume.

### 5. Detection and auth: **partly confirmed, one unknown**

- **Where agy lives:** Google's channel ships `agy.exe` (one file) on Windows and a tarball holding `antigravity` on macOS and Linux (T3 Code's installer; `--help` says *Usage of antigravity*). The brief's paths, `%LOCALAPPDATA%\agy\bin\agy.exe` and `~/.local/bin/agy`, weren't seen: this PC's `PATH` lists `%LOCALAPPDATA%\agy\bin`, but the folder isn't there. **To check by hand** with Google's installer on each OS.
- **Reading the user's sign-in method:** not needed, and not doable without reading credentials. Chord would own the private home, so the method is the one Chord asks for: `authenticate` with `gemini-api-key` (or later `oauth-business` / `agent-platform`), never `oauth-personal`, and no `session/new` unless that succeeded.
- **No silent fallback, in a clean home:** with no `authenticate`, `session/new` answers `-32000 Authentication required`, **even with `GEMINI_API_KEY` set** (it isn't read on its own). With no key, `authenticate` says *GEMINI_API_KEY is not set; pass an API key in _meta.apiKey…*. The log names the method used (`ACP authenticate: methodId="gemini-api-key" meta=map[apiKey:<redacted>]`).
- **The keyring: unknown.** The container has no OS keyring, so the brief's claim (agy falls back to a cached keyring login when the key is missing) couldn't be tried. T3 Code's notes say 1.5 keeps Google sign-ins in **one keyring entry for every profile** and ignores `AGY_ACP_FORCE_FILE_STORAGE`. If so, a private home doesn't separate an Enterprise sign-in from a personal one already in the keyring, and Chord couldn't prove which account `oauth-business` uses. **Hand check** on a desktop with a personal login cached. Until then, an API key would be the only method offered.
- ⚠ **A key is a credential Chord would handle.** §11.1 says Chord never reads or stores credentials. Every method the policy allows needs one: a key (or Enterprise's project and location). Passing the user's own `GEMINI_API_KEY` from their environment, without storing it, is the smallest change; keeping one in `safeStorage` is a bigger one. Either is the owner's call, and a change to §11.1.

## Also seen

- **agy opens ports.** Each `agy acp` starts a language server on loopback, *listening on random port … for HTTPS (gRPC)* and another for HTTP, before sign-in. They're agy's, not Chord's, but Chord would be what starts them.
- **A side request with your words:** before each turn, agy sends the message alone to a small model (`gemini-3.1-flash-lite-preview`, 661-character instructions), apparently for a title.
- **Slash commands:** a message that starts with `/browser`, `/schedule` or `/goal` would run agy's command. Chord would have to keep a user's message from starting with `/`. Not tried.
- **Start-up:** `initialize` in about 100 ms and `session/new` in 54 ms, warm, in the container. No large unpacking into the temp folder was seen on Linux (T3 Code reports about 1 GB per launch somewhere; not here).
- **Disk:** the private home was 1.5 MB after a session.

## When to look again

Any one of these would change the answer, and the prototype on `spike/antigravity-assistant` re-checks it in a minute (`container-run.sh`):

- `agy acp` gains a tool allowlist (a flag, a setting that works, or a `session/new` field), so that `search_web`, `schedule`, subagents and `run_workflow` aren't declared at all.
- Or a setting that makes those ask, so Chord's *deny* comes first.

## If it's a go then: slices

1. **M1, the plumbing:** the third provider through core, data (the table rebuild, the import fallback), ipc, Settings and the panel; detection on each OS; a private home per Chord profile (`userData/assistant/antigravity/`); the lockdown (`policy.mjs`'s settings, variables, permission answers and tripwire, a timer or anything else outside a turn ending the process); API key only, from the user's environment.
2. **M2, Chord's tools:** `chord mcp --assistant` with the per-chat token, the endpoint's lifetime, and the relay's budgets.
3. **M3, the rest of a chat:** resume, delete-really-deletes in the private home, the context meter from `usage_update`, models and thinking level from `configOptions`, errors (a 402 like the spike's: *Your Gemini API project is out of credits*).
4. **M4, Enterprise:** after the keyring hand check.

Tests need no credentials: units replay recorded streams (as `selftest.mjs` does), and the Linux container runs the real agy against the stand-in model, which also makes a CI job possible.

**UI that would need a mock first:** the Setup card for Antigravity (*Use a Gemini API key*, and why a Google account isn't offered, in Google's terms); where the key comes from (the variable, or a field); the provider and model chip (*Antigravity · Gemini 3.1 Pro*); the tripwire's copy (*Antigravity started a web search, which the assistant doesn't do, so Chord stopped the reply.*); and the out-of-credits error.
