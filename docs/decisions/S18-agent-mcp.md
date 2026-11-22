# S18: agents use Chord through Chord's own MCP server (M0 spike)

**Result: pass on Windows 11 with Claude Code 2.1.328 end to end.** Codex 0.160.1 connects, sends `initialize` and `tools/list`, but no live turn ran: the test account is at its usage limit until Dec 16, 2026. Linux sockets were checked in WSL (Ubuntu, Node 24, Electron 45.3.2). macOS and the Flatpak are planned for CI or checked by hand (below).

**Release builds:** on since 0.14.0 (2026-11-22): `AGENTS_RELEASED` (packages/core/src/agent-tools.ts) is true. For 0.13.1 (2026-11-21) Agents was hidden in packaged builds, while slice (e)'s consent fixes landed. With it false: a packaged Chord has no Settings → Agents, never serves the endpoint or writes its token file (even with `agentsEnabled` saved), and `chord mcp` answers every call as when Agents is off. Development and E2E builds keep all of it. The packaged smoke test's expectations follow it.

**Decision (for M1):**

- **Transport.** The running Chord serves a local endpoint and opens no port (D9). On Windows it's a named pipe with a random name; on macOS and Linux, a Unix socket in a new 0700 folder under `$XDG_RUNTIME_DIR` (Linux), the per-user `$TMPDIR` (macOS), or `$XDG_RUNTIME_DIR/app/$FLATPAK_ID/` (Flatpak). The name and a random 32-byte token go in `agent-endpoint.json` in the profile folder. A connection must send the token first. Until it does, Chord writes nothing, and it hangs up after 2 s.
- **`chord mcp`.** It's Chord's own executable, branching on argv as the first thing its main runs. There's no separate script: the RunAsNode fuse stays off, and Chord ships no other runtime. The branch is a stateless relay. It answers `initialize` and `tools/list` itself (the list ships with the build), and connects to Chord only on the first `tools/call`. An agent session that never uses Chord never reaches Chord, and Chord does nothing until a call arrives.
- **Chord not running.** `chord mcp` never starts Chord. A call answers *Chord isn't open. Ask the user to open Chord, then call this tool again.*, and the next call tries again, so the agent needn't restart.
- **Approvals** block inside `tools/call` for at most 45 s. After that the call answers *Waiting for the user…* and the card stays up, so a client's own timeout never fires (Codex's is 60 s).
- **The connect card** names the client by its self-reported `clientInfo.title`. It adds the program that started `chord mcp` as a hint, never as proof (§3).

## Evidence (2026-11-19, Windows 11 Pro 26300, Node 24.19.0, Electron 45.3.2)

The spike is `spikes/s18-agent-mcp/` (README there). It prints protocol shapes, tool traffic and the names of environment variables only. No credential file was opened. Real-client runs used a cheap model (`haiku`; Codex `gpt-6-luna`, low effort), an empty temp folder and a throwaway profile, all removed afterwards.

### 1. Transport

| Question | Seen |
|---|---|
| Can Chord's main serve a named pipe? | Yes, with `net.createServer().listen('\\\\.\\pipe\\chord-agent-<16 hex>')`, in plain Node and in Electron's main. |
| The pipe's default DACL (libuv passes no security attributes) | `O:<user> D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;;FR;;;WD)(A;;FR;;;AN)`: full control for SYSTEM, Administrators and the user; **read for Everyone and Anonymous**. Node can't change it. `readableAll`/`writableAll` only widen it. |
| What does Everyone's read grant allow? (`pipe-acl.ps1`) | It can open an instance (`FILE_GENERIC_READ`), but `WriteFile` fails with 5 (access denied), so it can never send the token. After 2.5 s it has 0 bytes, and the endpoint has hung up (109). Each client gets its own instance, so no one reads another's traffic. The worst it can do is hold instances open for 2 s each. |
| Can the DACL be tightened after `listen`? | Yes. The owner opens the pipe with `WRITE_DAC` and calls `SetSecurityInfo`, and later instances keep the new DACL (`D:P(A;;FA;;;SY)(A;;FA;;;<user>)`). That needs a Win32 call: the C# helper Chord already builds with Windows' csc (`build-window-owner.mjs`), or a native addon. **Not needed for M1** (above); a hardening follow-up. |
| Another user, read-only, through the endpoint file | The file inherits `%LOCALAPPDATA%`'s ACL. ⚠ On this machine, that ACL includes **`CodexSandboxUsers:(RX)`**, added by Codex's Windows sandbox. Commands Codex runs in its sandbox can read the token. They still can't write to the pipe (Everyone has read only), so **the pipe's owner-only write is the lock on Windows, and the token is the second one**. M1 must never pass `writableAll`. |
| Squatting the name | A second `listen` on the same name fails with `EADDRINUSE` (libuv uses `FILE_FLAG_FIRST_PIPE_INSTANCE`). The name is random per launch and lives only in the user's endpoint file. |
| Remote clients | libuv doesn't set `PIPE_REJECT_REMOTE_CLIENTS`. `\\localhost\pipe\…` connects, but SMB loopback reuses the local logon (a NETWORK deny ACE didn't block it either), so it shows nothing about a real remote client. A remote client would also need the user's SMB credentials and the token. **Check by hand** from a second machine. |
| Another session, same user | `\\.\pipe\` isn't per-session, so a process of the same user in another session can connect with the token. Same user, same trust: that's intended. |
| Linux socket, another user (WSL, `posix-check.sh`, `nobody` via `setpriv`) | The folder is `drwx------` and the socket `srwxr-xr-x`. `nobody` gets `EACCES` connecting, `EACCES` even with the folder opened to 755 (connecting needs write on the socket), and *Permission denied* reading the 0600 endpoint file. |
| A bad or missing token (Windows and Linux) | The endpoint sends nothing and closes. |
| Flatpak | Not run here. `flatpak/…yml`'s `chord.sh` already points `TMPDIR` at `$XDG_RUNTIME_DIR/app/$FLATPAK_ID` so that every instance finds the running one's singleton socket. The endpoint uses the same folder, so `flatpak run io.github.anaremore.chord-browser mcp` (a second sandbox instance) reaches it the same way. stdio passes through `flatpak run`. **Check by hand** (below). |
| Single-instance lock | The `mcp` branch never calls `requestSingleInstanceLock`. With the Electron host holding the lock, the bridge ran, and the host saw no `second-instance` event. The bridge also needs its own `userData`, because Electron writes `Local State` into it. Pointed at the real profile, it would race the running Chord's `Local State`. |
| Two Chords (`--user-data-dir`, or Chord and Chord Dev) | Each profile folder has its own lock and its own endpoint file, so `chord mcp` finds the one its profile path names: the default by default, `chord mcp --user-data-dir=<path>` for another. In-app profiles are one instance, so there's one endpoint (see the open question below). |

**As built (M1b, 2026-11-20): the window before the DACL is tightened.** Chord tightens the pipe's DACL with `window-owner.exe restrict-pipe` (SYSTEM and the user, the network denied) on the **first connection**, not when it starts listening: running the helper at launch would break the zero-cost rule (Agents on costs one pipe and one file at launch, nothing more). Until that first connection, the pipe has libuv's default DACL, which also gives Everyone and Anonymous *read*. The planning thread accepted this window (review 1 of #76) because:

- read access can open an instance but can't write to it (shown above), so it can never send the token;
- Chord writes nothing on a connection until a valid hello arrives, and hangs up after 2 s;
- the token is the real gate: 32 random bytes, in a 0600 file only the user can read, compared in constant time (`timingSafeEqual`), so a wrong guess says nothing about how close it was.

### 2. `chord mcp` as Chord's own executable

| Question | Seen |
|---|---|
| `ELECTRON_RUN_AS_NODE`? | Not an option: `electron-builder.config.ts` sets the `runAsNode` fuse to false, and should keep it (it's a well-known way to abuse a signed Electron app). |
| stdio in Electron's main | ⚠ On Windows, `process.stdin` is a stub that ends at once, but fd 0 is the client's pipe. `new net.Socket({ fd: 0 })` (or `fs.createReadStream(null, { fd: 0 })`) reads it. `process.stdout` is a `SyncWriteStream` and works. |
| A stray line | ⚠ Electron on Windows writes `\r\n` to stdout before any app code runs (even with `ELECTRON_NO_ATTACH_CONSOLE`). Claude Code 2.1.328, Codex 0.160.1 and the fake client all skip it. Linux doesn't write it. Keep a real-client check per release. |
| ESM main | `await app.whenReady()` at the top level of an ESM entry never resolves: Electron emits `ready` after the entry has evaluated. Use `.then`. |
| Start-up (to the `initialize` reply, Windows, 20 runs) | Electron bridge: **124 ms** median on a quiet machine (115–179), 198 ms while busy. Plain Node, for comparison: 67 ms quiet, 104 ms busy. Linux (WSL, `--ozone-platform=headless`): 123 ms warm. |
| Memory | By default: 3 processes (browser, GPU, network service), 169 MB working set, 54 MB private. With `disable-gpu disable-software-rasterizer in-process-gpu enable-features=NetworkServiceInProcess2 disable-gpu-shader-disk-cache`: **one process, 69 MB working set** (Node: 64 MB). |
| Disk | By default, 1.1 MB of GPU caches per launch. With the switches above, 9 KB (`Local State` and an empty Dawn cache). The branch's `userData` should be a fixed folder of its own, e.g. `<temp>/Chord MCP`. |
| Window, Dock, lock | No window and no `ready` handler. Never the lock (above). macOS should also call `app.dock.hide()` first thing (**macOS CI**, below). |
| Linux with no display (SSH, a headless box) | ⚠ Electron exits before any app code with *Missing X server or $DISPLAY*. `app.commandLine.appendSwitch('ozone-platform', 'headless')` is too late; **`--ozone-platform=headless` on argv works** (123 ms). So the Linux setup line passes it, or a launcher adds it for `mcp` (the Flatpak's `chord.sh` can). |
| The main bundle | The branch must run before Chord's main imports anything. M1 makes `main` a tiny entry that checks argv, then imports either the bridge or `index.js`. |
| Setup lines (Settings shows `app.getPath('exe')`, never a guess) | Windows (per-user NSIS, `oneClick`, `perMachine: false`): `Chord.exe mcp` under `%LOCALAPPDATA%\Programs\` (electron-builder's per-user default; not checked against an installed build), not `Program Files` as the mock drew it. macOS: `/Applications/Chord.app/Contents/MacOS/Chord mcp`. deb/rpm: `chord --ozone-platform=headless mcp`. AppImage: `$APPIMAGE`, which moves when the user moves the file. Flatpak: `flatpak run io.github.anaremore.chord-browser mcp` (its `command` is already `chord`). The Microsoft Store build (off by default) would need an app execution alias. |
| A separate native bridge instead? | It would avoid every ⚠ above and use a few MB, but it's one more signed binary per OS. Not built here. Revisit if the 69 MB per agent session matters: each Claude Code or Codex session starts its own bridge. |

### 3. Identifying the client

| | Claude Code 2.1.328 | Codex 0.160.1 |
|---|---|---|
| `initialize.clientInfo` | `{name: "claude-code", title: "Claude Code", version: "2.1.328", description, websiteUrl}` | `{name: "codex-mcp-client", title: "Codex", version: "0.160.1"}` |
| `protocolVersion` | `2025-11-25` | `2025-06-18` |
| Capabilities | `roots`, `elicitation` (form, url) | `elicitation`, `experimental.codex/auth-change` |
| The bridge's parent chain | `claude.exe` (`%USERPROFILE%\.local\bin\claude.exe`) ← the shell | `codex.exe` (inside the npm package's `vendor\…\bin`) ← `node.exe` (the npm shim) ← the shell |
| The bridge's cwd | The folder `claude` runs in (`CLAUDE_PROJECT_DIR` is also set) | The folder `codex` runs in |
| Environment the bridge gets | Everything the user's shell has | Only an allowlist (`APPDATA`, `LOCALAPPDATA`, `PATH`, `TEMP`, `USERPROFILE`…), so the bridge must find the profile from those alone, which it does |

- **The parent on each OS.** Windows: CIM gives the name and path, one PowerShell for the whole chain, **~1 s**, so Chord looks it up while the card shows, never inside a call. Another process's folder isn't available without native code, so the bridge sends its own cwd, which the client chose. Never read `CommandLine`: it can hold tokens. Linux: `/proc/<pid>/exe` and `/proc/<pid>/cwd` (use `exe`'s name, not `comm`: Node's is "MainThread"). macOS: `ps -o ppid=,comm=` and `lsof -d cwd` (**macOS CI**).
- **Spoofability.** All of it comes from the user's own processes: any program the user runs can start `chord mcp` with any `clientInfo`, from any folder, under any file name. It can even skip the bridge and talk to the endpoint with the token. So the card can honestly say only *"Claude Code" wants to use Chord* (in quotes, or "says it's") and *Started by claude.exe in <folder>*. It never shows a verified badge. *Always allow* is keyed on the reported name plus the parent's path, and Settings → Agents says it's a convenience, not a lock. What actually protects the user is that every new connection asks, that the agent works in its own tabs, and that the never-offered list holds.
- **Elicitation** (both clients offer it) is never used for approvals: the agent's own terminal isn't Chord's to trust, and an agent can answer for the user. Approvals live in Chord's window only.

### 4. Real clients (`real-clients.sh`)

| Question | Seen |
|---|---|
| `claude mcp add chord -- <exe> mcp …` | Works. It was run in project scope in the empty folder (it writes only that folder's `.mcp.json`) and removed with `claude mcp remove -s project chord`. Project scope shows *Pending approval* until `claude` is run there interactively. The setup line in Settings should use the default (local) or `-s user`. |
| One Claude turn, end to end (`--strict-mcp-config --mcp-config`, `--tools ""`, `haiku`) | `system/init` lists `chord` as `connected` with all 7 tools. The model called `open_tab` (a real page in a hidden window) and then `read_tab`, and answered *Example Domain*. **5.9 s** wall clock. |
| A 75 s approval | The call was held 75 s and completed normally (1 m 21 s turn). Claude Code didn't time out. |
| *Waiting* (card answered at 30 s, calls held 8 s) | The model retried once, then told the user to answer the card in Chord and said it would continue after. |
| *Denied* | The model stopped using Chord's tools and told the user (4.8 s). |
| `codex mcp add` | It has `--env` but no timeout option, and writes `~/.codex/config.toml`, so it wasn't run. The turn passed the server with `-c mcp_servers.chord.…` instead (nothing on disk). |
| Codex turn | It started the bridge, then sent `initialize`, `notifications/initialized` and `tools/list`. The turn then failed: usage limit (`gpt-6.1-sol`, the global default, is *not supported* for this plan; `gpt-6-luna` hit the limit). **Not yet verified:** a Codex tool call, and its 60 s `tool_timeout_sec` default (from Codex's docs and guides, not seen live). |

## 5. M1's tools

These are on top of the assistant's tool layer (`ASSISTANT_TOOLS`, its handlers, `pageResult`, `cleanPageText`, the never-readable list), reused, not forked. An agent sees only its own Agent chord's tabs and the tabs shared with it. `tab_id`s are opaque refs (`a1`, `s1`), never Chord's ids.

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `list_tabs` | none | `[{tab_id, title, site, shared, loading}]` | Its own tabs, plus tabs the user shared (`shared: true`). |
| `open_tab` | `url` (http/https, ≤ 2048) | `{tab_id, url, title}` after load (at most 30 s) | A new tab in its Agent chord, with the user's sign-ins. Never-readable sites (the user's *Never* list, Chord's pages) are refused. A sign-in page is returned as it is: the agent asks the user to sign in. |
| `read_tab` | `tab_id`, `start?`, `length?` (≤ 40,000) | `pageResult` JSON (`trust: "untrusted"`) | As the assistant's, PDFs included. |
| `tab_screenshot` | `tab_id` | an image | As the assistant's. |
| `read_form` | `tab_id` | fields, never their values | As the assistant's. On a shared tab too (read-only). |
| `page_diagnostics` | `tab_id` | console errors and failed requests | As the assistant's. |
| `close_tab` | `tab_id` | `Closed.` | Its own tabs only. |

- **Left out of M1:** `propose_fill` (it fills, so it's an action: M2), and `search_history` / `search_archive` (other chords' history is never offered). `read_selection` (a shared tab's selection) is cheap to add if wanted.
- **`read_shared_tab` isn't proposed.** Shared tabs come through `list_tabs` with `shared: true`, and every read tool takes their `tab_id`, so one set of tools covers both. If you'd rather the model have an obvious "the tab I shared" tool, it's `read_tab` on the newest shared tab and costs nothing to add.
- **Annotations:** `readOnlyHint: true` on the read tools, `openWorldHint: true` on all. The server's `instructions` say page text is untrusted data.
- **Never offered,** with no tool at all: passwords and the vault, cookies and storage, script, Settings, extensions, other chords' history.

### How approvals block, and what a refused call returns

A call that needs an answer waits on the card: the first call of a connection waits on the connect card, and in M2 the first action on a site and every risky step wait on theirs. If the card is answered within 45 s, the call simply continues. If not, it returns *waiting* and the card stays up. Every refusal is a normal result with `isError: true` and one sentence for the model, so it tells the user instead of retrying:

| Case | Text |
|---|---|
| Waiting | *Waiting for the user to allow this in Chord. Ask them to answer the card at the top of the Chord window, then call this tool again.* |
| Denied | *The user denied this connection in Chord. Stop using Chord's tools and tell the user.* |
| Stopped (Stop, Ctrl+. / ⌘.) | *The user stopped you in Chord. Don't call Chord's tools again until the user asks you to.* Calls in flight return it at once, and later calls keep returning it until the user lets the agent continue from the bar. |
| Paused (the user is typing in the agent's tab) | Calls on that tab wait, under the same 45 s rule, until the user leaves the tab. |
| Chord not open, or quit mid-call | *Chord isn't open. Ask the user to open Chord, then call this tool again.* |

## How it's tested without real clients

`spikes/s18-agent-mcp/selftest.mjs` runs the bridge (`mcp.mjs`) under the fake MCP client (`fake-client.mjs`) against a fake Chord (`fake-chord.mjs`). It covers eight paths: Chord not running and opening later, allowed, denied, waiting then allowed, a slow card within the limit, stopped, Chord quitting mid-call, and a bad or missing token. All eight pass on Windows. M1 moves this into `apps/desktop/test/unit/` (the endpoint, the relay, the gate, the refusals) on every CI OS, plus:

- a fixture client that replays Claude Code's and Codex's recorded `initialize` (above);
- one E2E per journey in the Linux container: connect, allow, `open_tab`, read, Stop; sharing a tab; denied;
- a packaged smoke test (`test:packaged`): `Chord mcp` answers `initialize` with no window, holds no lock, and passes the start-up and memory budgets below.

## Still to check (by hand or in CI)

- **macOS (CI, a `macos-26` unit job):** the socket under `$TMPDIR` (its `sun_path` length), the parent via `ps`/`lsof`, start-up and memory, and `app.dock.hide()` keeping the Dock icon away. **By hand:** a real `claude` with `/Applications/Chord.app/Contents/MacOS/Chord mcp`.
- **The Flatpak (by hand, on a Linux desktop with `flatpak/build.sh`'s build):** `flatpak run io.github.anaremore.chord-browser mcp` from the host's `claude` reaches the running Chord, and the socket lands in `$XDG_RUNTIME_DIR/app/io.github.anaremore.chord-browser/`. Also measure its start-up.
- **Codex, once the account has usage:** one tool call end to end, the *waiting* text after 45 s, and whether a call held over 60 s really times out.
- **Windows, a second machine:** a remote client on `\\<host>\pipe\…`. A second local account can't write to the pipe (shown with a read-only open), but a real other account is still worth one run.
- **Each release:** Electron's stray `\r\n` stays harmless to both clients.

## Questions for the planning thread

1. **Profiles.** Chord's in-app profiles share one instance. Should the Agent chord use the sign-ins of the window where the user allowed the connection (my suggestion), or always the default profile?
2. **Stop.** Is Stop "pause this agent until you let it continue" (as above, matching the bar's *Let Claude Code continue*), or "cancel this one call"?
3. **Tightening the pipe's DACL** with the existing C# helper: M1, or a later hardening slice?

## M2: settled so far

- **Who's calling (planner, 2026-11-21, from #81's review).** In M2 Chord finds the connecting process itself instead of trusting the hello's `parentPid`: `GetNamedPipeClientProcessId` on the pipe (through window-owner.exe, as `restrict-pipe` is), `SO_PEERCRED` on Linux's socket, `LOCAL_PEERPID` on macOS's. The parent chain, the card's *Started by* and *Always allow*'s program are then looked up from that PID. M1 keeps `hello.parentPid`, a hint like everything else on the card (§3).
- **Your hands, not a script's (planner, 2026-11-21, from #89's review).** M1 counts a key, a click or a typed address in an agent's tab within 15 s (`USER_MS`) as yours: a tab you take to a *Never* site becomes yours instead of closing. Once M2 acts on pages, check that the input it sends (`sendInputEvent`) never counts as the user's there.

## Antigravity (2026-11-21, before 0.14.0)

Settings → Agents adds Chord to Antigravity's MCP config itself (the owner's mock B; ARCHITECTURE.md §11.3). A Gemini review of the plan made claims about Antigravity; here is what was checked:

- **Config file:** `~/.gemini/config/mcp_config.json` on every OS, from Google's Antigravity MCP docs. Others name `~/.gemini/antigravity-cli/mcp_config.json` (Arm's install guide) or `~/.antigravity/mcp_config.json` (Flutter's). Chord writes Google's, or `~/.gemini/antigravity/mcp_config.json` when only that older one exists (the file the installed build already reads). `GEMINI_HOME`, when set, takes the place of `~/.gemini` (the review's claim; harmless either way).
- **JSONC and a BOM:** not confirmed against a real `agy`; handled anyway, since editing in place costs nothing when the file is plain JSON.
- **An empty file before any server (CLI 1.5.8):** from the brief, not confirmed here; a blank file is `{}`.
- **Its client name** (reportedly `antigravity-cli` from the CLI, `antigravity-client` from the app), **its process tree** (a `language_server_*` helper), and **whether it re-lists tools on `notifications/tools/list_changed`** (reportedly it caches tool schemas on disk): not checked. A real `agy` needs Google's installer and a signed-in Google account, which a quiet container run doesn't have; the owner hand-checks them. Meanwhile the card shows the name the client gives, as for any agent (no relabeling of an unverified name), and *Started by* passes a `language_server_*` helper only to the Antigravity app itself (its name and install layout on each OS, no `..`; on macOS the executable as `lsof` has it, links resolved). A child of Claude Code or Codex that calls itself so is named as itself, and gets a card. The layouts accepted are what VS Code forks ship: the helper in `resources/bin/` or the extension's `resources/app/extensions/antigravity/bin/` beside `antigravity` / `Antigravity.exe`, and on macOS inside `Antigravity.app`'s `Contents/Resources/`, its parent either the app or its extension host (`Contents/Frameworks/Antigravity Helper*.app`) with the app above it. **They still need the owner's hand check** against a real Antigravity on each OS: a layout that differs fails closed (the card names the helper, not Antigravity), never open. On macOS a process with no executable from `lsof` has no path, and the lookup stops there.
- **The limit that stays:** the parent is a hint, never an identity. A child of an allowed agent can always run `chord mcp` itself, and then its parent *is* that agent: Always allow lets it in, as it would the agent. Nor is a parent proof on Windows: a program can start `chord mcp` with a parent of its choosing (`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`, any process of the same user it can open), and the chain then names that one. And Chord's own executable counts as the bridge (its parent is who started it), so running it as a plain Node script would let a script pick its parent too; `ELECTRON_RUN_AS_NODE` does nothing to a packaged Chord (its RunAsNode fuse is off), but does to a development build's Electron. What protects the user is unchanged: an allowed agent works in its own tabs, sees a tab of yours only when you share it, and the never-offered list holds; M2's peer PID (above) narrows who can claim a parent, not this.

## M2a: as built (2026-11-22)

The first slice of M2 ("M2: plan"): who's calling, and your hands, not a script's. Behind `AGENT_ACTIONS_RELEASED` (core, false): a packaged build keeps M1's *Started by*, from the hello's word, until a release turns M2 on.

**What the spike found, and where the build differs from the plan:**

| Question | Seen |
|---|---|
| Can Chord hand window-owner.exe its handle to the pipe instance? (the plan's first route) | **No.** Node's `fd` for a pipe socket is -1 on Windows, server and client end alike (Node 24.19, Windows 11). |
| Another way to the client's PID on Windows? | **Yes:** `window-owner.exe pipe-clients <pipe> <Chord's PID>` reads the system's handle table (`NtQuerySystemInformation`, extended handle information), takes Chord's file handles (the type its own file handle has), copies each (`DuplicateHandle`, the same user's process), keeps the server ends of the agent pipe (`GetFileType`, `GetNamedPipeInfo`, its name by `GetFileInformationByHandleEx`) and prints their clients' PIDs (`GetNamedPipeClientProcessId`). The queries, which could block on a file with I/O pending, run at once, each on a thread of its own, and those not done in 250 ms are left behind. The same process gives each client's chain (a process snapshot, `QueryFullProcessImageNameW`, `GetProcessTimes`), so Windows needs no PowerShell for *Started by*. Found both of two clients, every run. |
| Which client is which connection's? | The helper can't say (it sees all instances). Each live connection's hello claims a bridge PID, first come, first served (`AgentService.claims`, from the hello on, so an idle relay that hasn't been looked up yet still holds its own). A connection's peer is its claimed PID when that's a client and the claim is its own; a PID another connection claimed first, or was given, is taken; else the one client nobody holds; else unknown. Weaker than Linux's and macOS's answer, but a process can no longer name an arbitrary parent, nor borrow a connected relay's identity: it must itself be connected to Chord's pipe. (Review 1 of #103.) |
| How long? (plan: ≤ 150 ms) | **104 to 163 ms** on Windows x64, wall clock, the helper's start (.NET) and the chain included; its own work 57 to 85 ms (the table 31 to 50, the scan 2 to 3, the queries 3 to 4, the chain 21 to 28; about 396,000 handles in the system). The first build marshalled each of the table's entries, twice: about 180 ms here, plus M1's PowerShell for the chain (about 1 s), and **3.6 s on CI's Windows arm64**, which failed its budget. Off any call's path (it runs while the card shows), but it delays the card's *Started by*. The units' budgets, cold, wall clock (`PEER_BUDGET_MS`): Windows 750 ms, Linux 500 ms, macOS 1.5 s; a failure prints what was seen and the helper's own timings. |
| Linux | `ss -xpnH` (iproute2): Chord's socket's inode (`/proc/self/fd/<fd>`), and the PID holding the socket whose peer that is (each row's last number before `users:`, so an address with spaces in it, on either end, can't mislead it). Its output format checked against a real `ss` in WSL (Ubuntu). No `ss` (the E2E container until now: iproute2 is added; a minimal system; the Flatpak, which can't see the host's processes anyway), unknown. |
| macOS | `lsof -nP -U -a -u <uid> -F pfdn`: Chord's socket's address, and the process whose socket points at it (`->0x…`). **Not run here** (no Mac): CI's macOS jobs run the real lookup (`agent-peer.test.ts`). |
| Unknown | The card says *Started in ~/code/app. Chord can’t tell which program started it.* and offers no Always allow (an allowance is kept by its program); **Allow once** is the filled pill. An Always pressed before the lookup ends, with no program found, lets it in once and keeps nothing (until review 1 of #103 it said *always* and kept nothing). |
| A reused PID (Windows) | Windows never reparents, so an exited parent's PID can be another process's by the lookup: an ancestor created after its child ends the chain. Linux and macOS give orphans to init (launchd), so their parent PIDs are never stale. The peer itself is alive and connected when it's looked up. |
| Does Chord see `sendInputEvent`'s events while the call runs? | **Yes, for clicks and keys:** `before-input-event`, `before-mouse-event` and `input-event` all fired inside the call, none after it returned (agents.spec, X11 and Wayland in the Linux container; every CI OS). So `isAgentInput` is a count of sends under way, with no queue to match. **The wheel** is seen inside too, but the scroll it starts arrives after the call returns: `gestureScrollBegin`, `gestureScrollUpdate`, `input-event`'s `mouseWheel` (once the page handled it) and `gestureScrollEnd`. None is a key or a button press, which is all the pause, `USER_MS`, the shortcuts and a pane's focus act on; history's scroll save hears the late `mouseWheel`, rightly. The journey checks the late ones stay so. |
| Can an agent's key run one of Chord's shortcuts? | **No, twice over.** `sendAgentInput` refuses, before anything is sent, any event off core's `agentInputAllowed` list (press_key's keys, Shift only with Tab; the left button, moves and the wheel; no modifier): nothing of the batch goes. And should one get past, `keyboard.ts` stops an agent key that's any Chord shortcut (`preventDefault`), so neither the page nor, unhandled, the ⋯ menu's accelerators get it; DevTools' F12 and Ctrl+Shift+I are stopped the same way. agents.spec sends Ctrl+W both ways: refused, then, sent unchecked, stopped; every tab stays. |
| Does input reach an agent tab that isn't on screen? | **Yes**, while one of the agent's calls runs (the tab is parked and painting, M1c): a click, a key, Enter and `insertText` all arrived, each `isTrusted: true`. The debugger fallback isn't needed. |

**Built:** `agents/peer.ts` (the lookup on each OS, and the choice), `window-owner.exe pipe-clients`, the service's *Started by* from the peer (the peer being Chord's own executable, its parent), `control/input.ts` (`sendAgentInput`, `isAgentInput`) with the pause, `USER_MS`, Chord's shortcuts, DevTools' keys and a split pane's focus (its click and its `focus`) all skipping the agent's input, core's `agentInputAllowed`, the card's *can't tell* state, and `AGENT_ACTIONS_RELEASED`. *Tests:* `agent-peer.test.ts` (the parsers and the choice as tables, and a real lookup against clients in their own processes, on every CI OS), `agent-input.test.ts` (the input allowed), cases in `agents.test.ts` for where *Started by* comes from and for claims, `agent-connect.test.ts` for a card that can't tell, and agents.spec journeys for the input (Ctrl+W included) and the card.
