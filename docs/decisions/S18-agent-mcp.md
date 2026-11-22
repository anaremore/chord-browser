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

## M2: plan (acting on pages)

*Planning thread, 2026-11-21; approved by the owner 2026-11-22 with the mock `mocks/agents-s18-m2.html` (outside the repo, as M1's was), answers at the end. The owner's decisions above and in the brief (elements, not pixels; the three approvals; Stop and pause; the never-offered list; one shared control layer; peer PID) are settled.*

Outside agents and the assistant gain **click, type and press a key** on a page, plus a few cheap neighbors. They act on elements from an accessibility snapshot, never on pixel positions. Each tool goes through the shared control layer (`main/control/`), so the assistant and outside agents get the same tools, the same gate and the same cards, each in its own place.

### Tools and schemas

All new tools are in core's `CONTROL_TOOLS` with a gate level (`ControlTier`, which already has `act` and `risky`). Every action takes `tab_id` and a `ref` from that tab's latest snapshot. None takes a coordinate, a selector or script.

| Tool | Args | Returns | Level |
|---|---|---|---|
| `snapshot` | `tab_id`, `start?` | The page as an accessibility outline (below), untrusted JSON: `{source: "web_snapshot", tab_id, page_id, snapshot, url, title, range, content}` | `read` (as `read_tab`) |
| `click` | `tab_id`, `ref` | What happened (below) | `act`, or `risky` by what the element is |
| `type` | `tab_id`, `ref`, `text` (≤ 5,000), `replace?` (default true), `submit?` (default false) | What happened | `act`; `risky` with `submit` when the submit is |
| `press_key` | `tab_id`, `key` (one of the list below) | What happened | `act`, or `risky` by the key and what has focus |
| `select_option` | `tab_id`, `ref`, `option` (a choice's label, as the snapshot gave it) | What happened | `act` |
| `hover` | `tab_id`, `ref` | What happened | `act` |
| `navigate` | `tab_id`, `url` (http/https, ≤ 2,048) | `{tab_id, page_id, url, title}` after load (at most 30 s, as `open_tab`) | none (as `open_tab`): its own tabs only |
| `back` | `tab_id` | The same | none: its own tabs only |

- **`snapshot` is a new tool, not an extended `read_tab`.** `read_tab` stays the cheap way to read an article. A snapshot is a different shape (an outline with refs), and a model that only reads shouldn't pay for refs. `read_tab`'s description points to `snapshot` for acting.
- **`select_option` and `hover` are nearly free.** `select_option` reuses the fill's select writer (`forms.ts`: set the index from the isolated world, then `input` and `change`), because a native `<select>`'s popup is a separate widget that trusted input can't drive reliably. `hover` is `click`'s path without the button. Both are in.
- **`navigate` and `back` are cheap** (`loadURL` and `navigationHistory.goBack()`). They follow `open_tab`'s rules: the *Never* list, http(s) only, and the agent's own tabs. They need no site card, since going to an address is what `open_tab` already does. `forward` is left out (no one asked; trivial to add).
- **What an action returns:** `{ok: true, page_id, navigated, url, title, notes?}`. `navigated` says the page id changed, so the agent knows its refs are stale; `notes` carries what M1 already holds for the next result (a dialog, a popup, a download). It waits for the page to settle: a navigation's load (at most 10 s, then `loading: true`), otherwise up to 500 ms for the page to stop changing (a `MutationObserver` in the isolated world, quiet for 100 ms). Each result ends with *Call snapshot again before using refs from before.* when `navigated` is true. Actions don't return a fresh snapshot (it costs up to 40,000 characters a turn); the agent calls `snapshot` when it needs one.
- **The assistant** gets the same eight tools (below, *The assistant's side*). Annotations: `readOnlyHint: false` and `destructiveHint: true` on `click`, `type` and `press_key`; `destructiveHint: false` on `hover`, `select_option`, `navigate` and `back`.

**`press_key`'s keys:** `Enter`, `Tab`, `Shift+Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`. Nothing else: no letters (they'd be a web app's shortcuts: Gmail's `#` deletes), no Ctrl, Alt, ⌘ or function keys, so an agent can never press one of Chord's or the OS's shortcuts (Ctrl+W, Ctrl+L, Ctrl+., F12). Text goes through `type`.

### The snapshot and its refs

**What it is.** The main frame's accessibility outline, in the indented text form Playwright MCP made familiar:

```
- banner
  - link "Home" [ref=e1]
  - searchbox "Search orders" [ref=e2]
- main
  - heading "Your orders" [level=1]
  - list
    - listitem
      - link "Order #1043 · Nov 12" [ref=e3]
      - button "Start a return" [ref=e4]
  - checkbox "Gift receipt" [ref=e5] [checked]
  - textbox "Password" [password: sign in yourself]
```

- **Built in the isolated world (4400)**, as forms and the extractor are, by one plain-JavaScript script: roles from the element (`role`, else the implicit role of the tag and type), names from `aria-labelledby`, `aria-label`, labels, `alt`, `title`, then text, as the read script already does. Open shadow roots are walked; frames are listed by title, not entered (as forms; same-site frames are a later slice).
- **Not the debugger's accessibility tree** (`Accessibility.getFullAXTree`). It's Chromium's real tree, but it needs the debugger attached (one client at a time with screenshots and diagnostics, `debugger-queue.ts`), it's slow on big pages (hundreds of milliseconds and megabytes of JSON), and its node ids can't be held against a page that changes. The isolated world keeps each ref's element by a `WeakRef`, out of the page's reach, exactly as the fill keeps fields.
- **Only what can be acted on gets a ref:** links, buttons, text fields, text areas, contenteditable, checkboxes, radios, selects, switches, tabs, menu items, options, `summary`, and any element whose computed `cursor` is `pointer` and has no ref'd ancestor (sites' clickable `div`s). Headings, lists, landmarks and plain text are there for orientation, without refs. Hidden elements are left out by forms' `shown()` rule.
- **States, never values.** Each ref says `[checked]`, `[selected]`, `[expanded]`, `[pressed]`, `[disabled]`, `[required]`, and a select's current choice by label. Text fields never show what's in them (forms' rule: the page can hold your data), only `[empty]` or `[filled]`. A password or one-time-code field (forms' `classifyField`, *sensitive*) has no ref and says *sign in yourself*.
- **Bounded:** at most 20,000 elements looked at and 150 ms of looking, at most 2,000 refs, names cut to 120 characters, the outline in ranges of 40,000 characters (`start`, as `read_tab`). Past a bound, a note says what was left out.

**Refs.**
- **Format:** `e<n>`, counted per tab and never reused in that tab (as form fields' `f<n>`), so an old ref is never taken for another element. The call names the tab too: `{tab_id: "a1", ref: "e14"}`.
- **Lifetime:** a ref is good only from the tab's **latest snapshot**, on the same page (`page_id`). A new snapshot, a main-frame navigation (the page id changes), or the tab closing makes every older ref stale.
- **At each action** the ref is checked again, from the element as it is now: still connected, still shown, still the same role and name as the snapshot said. Any no, and nothing is sent.
- **Refusals,** one sentence each, `isError`:

| Case | Text |
|---|---|
| A ref never made in this tab | *There's no element e99 in that tab. Call snapshot for the page's elements.* |
| From an older snapshot, or the page moved on | *That ref is from an earlier snapshot. Call snapshot again, then use its refs.* |
| The element changed or went | *That element changed since the snapshot (it's gone, hidden, or now says something else). Call snapshot again.* |
| Covered (the hit test) | *Something is covering that element: dialog "Cookie settings" (e31). Deal with it first, or call snapshot again.* |
| Disabled | *That element is disabled.* |
| `type` into what isn't editable | *That element doesn't take text.* |

### How an action is sent

**Trusted input through `webContents.sendInputEvent`, at the element's center after scrolling it into view and a hit test.** In detail:

1. **Resolve** the ref in the isolated world and check it (above).
2. **Scroll it into view** (`scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'})`) and read its box, clipped to the viewport.
3. **Hit-test** at the box's center: `elementFromPoint` (through open shadow roots) must be the element or inside it. If not, try the centers of the box's other visible quarters, then refuse as *covered*, naming the cover's role and name (and its ref, if it has one).
4. **Send:** the point in the view's coordinates (CSS px × the zoom factor, `webContents.getZoomFactor()`); `mouseMove`, `mouseDown`, `mouseUp` with `clickCount: 1`. `type` clicks to focus, selects what's there when `replace`, then `webContents.insertText(text)`, which arrives as one trusted text insertion (`beforeinput` and `input` fire), handles any language without an IME, and is no keystroke, so no page shortcut fires. `press_key` sends `keyDown` (with `char` where the key has one) and `keyUp`.
5. **Show it** (below), then wait for the page to settle.

**Why not the alternatives:**
- **Events dispatched from the isolated world** (`el.click()`, synthetic `KeyboardEvent`s) are `isTrusted: false`. Many sites ignore them (and they should), and they skip the browser's own behavior (focus, default actions, user activation for popups and clipboard).
- **The debugger's `Input.dispatchMouseEvent`** is trusted too, but holds the debugger (one client at a time) for every action. It's the **fallback** if the spike (M2a) finds that `sendInputEvent` doesn't reach a parked, hidden agent tab on some OS. Never exposed to the agent either way: raw CDP stays never offered.

**Your hands, not a script's (from #89's review).** `sendInputEvent` goes through the same path as your keys and clicks, so Chord's `before-input-event` and `before-mouse-event` see it. Three listeners must tell them apart: the pause (a key in an agent's tab pauses it), `USER_MS` (an agent tab you take to a *Never* site becomes yours), and shortcuts (`keyboard.ts`). Main marks each event it sends: a per-WebContents queue of what it's about to send (type, key or button), taken off as each handler sees it. An event at the head of the queue is the agent's; anything else is yours. The spike checks whether the handlers run synchronously inside `sendInputEvent` (then a simple *sending now* flag is enough) on Windows and Linux. *Unit test:* the three handlers with a fake WebContents, for both kinds of input.

### What counts as risky

Every action is classified **before it's sent**, in core (`control-risk.ts`, a pure function over a description the isolated world gives: the element's role, tag, type, name, its form's method, its form's fields' kinds). One of: `act` (asks once per site), `risky` (asks every time) with a **why** (*submit*, *pay*, *send*, *delete*, *sign out*, *sign up*), or `refused`. Generous on purpose: a step that asks needlessly costs a click; one that doesn't ask costs much more. Words are matched as whole words, case-insensitively, in US English first (other languages fall back on the structure: form submits and payment fields need no words).

| The action | Class | Why |
|---|---|---|
| Click a link (`a[href]`) whose name has no risky word | act | Following a link is reading. |
| Click a link or button named *Pay*, *Buy*, *Purchase*, *Place order*, *Checkout*, *Complete order*, *Donate*, *Subscribe*, *Upgrade*, *Book*, *Reserve*, *Confirm purchase* | risky · pay | |
| … named *Send*, *Post*, *Publish*, *Reply*, *Comment*, *Share*, *Invite*, *Tweet*, *Submit* | risky · send / submit | |
| … named *Delete*, *Remove*, *Trash*, *Discard*, *Erase*, *Cancel subscription*, *Close account*, *Unsubscribe*, *Revoke* | risky · delete | |
| … named *Sign out*, *Log out* | risky · sign out | The agent's tabs share your sign-ins: signing out there signs you out. |
| … named *Sign up*, *Create account*, *Register*, *Accept*, *Agree* | risky · sign up | It makes an account or a promise in your name. |
| Click a submit button (`button` in a form with no `type`, `type=submit`, `input[type=submit|image]`) | risky · submit, or the stronger why its form or name gives | |
| … where the form is a **search**: method GET and inside `role=search`, or with a `type=search` field, or with one text field and no others | act | Searching is reading. |
| … where the form has a payment field (`autocomplete` `cc-*`, `transaction-amount`, or forms' payment words) | risky · pay | |
| … where the form has a password field | risky · sign in | Agents never type passwords, so you typed it. |
| `type` with `submit: true` | As clicking the form's submit button (above); a field in no form: risky · send | Enter after text is how chat boxes send. |
| `press_key Enter` in a form's text field | As its form's submit (above) | Enter submits a form. |
| `press_key Enter` in a text area or contenteditable | risky · send | Chat apps send on Enter. Newlines go in `type`'s text instead. |
| `press_key Enter` or `Space` on a button or link | As clicking it | |
| `press_key Delete` or `Backspace` outside an editable field | risky · delete | Web apps delete on these keys. |
| Other keys, and `Delete`/`Backspace` in a text field | act | |
| `type` into a text field, `select_option`, `hover`, checking a checkbox or radio | act | Nothing leaves the page until a submit. |
| `type` into a password, one-time-code or payment-card field (forms' *sensitive*) | refused | *Chord never lets agents type passwords, codes or card numbers. Ask the user to fill it.* |
| Click a file field (`input[type=file]`) | refused | *Agents can't pick files.* |
| An element inside a frame | refused (no ref) | Frames aren't entered in M2. |
| Anything on a *Never* site, a Chord page, or a private window | refused | As reading. |

*Unit test:* this table as `control-risk.test.ts`'s cases (each row, plus words in the middle of other words, names in other cases, a search form with a password field, a submit button outside any form).

### The cards

Both are the gate's cards (`site` and `step`, which `control-gate.ts` already has). For outside agents they show where the connect card does: the window used last, in its popover, centered at the top, never taking the keyboard, with `promptInputDelay`. For the assistant they're inline in the chat (below). Text from the page (an element's name) is quoted, cut to 60 characters, and goes through `plain()`. **The agent's own words never appear on a card**: the card says what Chord sees the agent doing, not what the agent says it's doing, since a page can steer the agent's words.

**The site card** (the first action on each site, by its registrable domain with the Public Suffix List and private suffixes on, `loginSite`, as sharing does):
- ✳ *Let Claude Code click and type on shop.example?*
- *It wants to click “Start a return”.* (the first action, in Chord's words: *click “…”*, *type in “…”*, *press Enter in “…”*, *choose an option in “…”*, *point at “…”*)
- *It still asks before it submits, pays, sends or deletes anything.*
- **Deny** (quiet word) · **Allow for now** (outlined pill) · **Always on this site** (filled accent pill). × is Deny.
- **Allow for now** lasts while the agent stays connected (the assistant: this chat).
- **Always on this site** keeps the site with the agent's allowance (`AgentAllowance.actSites`, at most 100, least recently used dropped). It's offered only to an agent you always allow; one you let in once sees **Allow for now** alone. Settings → Agents lists the sites under the agent, each with Remove.
- **Deny** refuses this action and the agent's other actions on the site until it reconnects, so a page can't make it ask again and again. The agent hears *The user didn't let you act on shop.example. Don't act there again unless the user asks you to.*

**The risky-step card** (every time, never remembered: `grantAfter('step', …)` already returns null):
- ✳ *Place the order on shop.example?* The title is the why: *Submit this form*, *Place the order* (pay), *Send this* (send), *Delete this* (delete), *Sign out* (sign out), *Create an account* (sign up), *Sign in* (a form with a password).
- *Claude Code is about to click “Place order”.*
- For a form: what goes with it, by field label, for up to 6 fields (*Name, Email, Address and 2 more*), never values. The values are in the page: **Show me**.
- **Show me** (quiet word): shows the agent's tab in this window and outlines the element, card still up. · **Don't** (outlined pill) · **Allow** (filled pill; with `danger`'s color for *delete* and *pay*). × is Don't.
- The agent hears *The user said no to this step. Don't try it another way; ask the user what to do.* on Don't.

**What *waiting* means for each.** Unchanged from M1: a call waits on its card for 45 s (`CONTROL_WAIT_MS`), then returns *waiting* and the card stays up. A **site** answered late counts for the agent's next action on that site. A **step** answered *Allow* late counts only for the same step: the same tab, page id, ref and action, within 2 minutes (the gate's `late` table already works this way, by address). The action is never run by the answer alone; the agent calls it again, and the classification runs again on the page as it is then.

### While it acts: the bar and the element

- **The bar** (M1's, blue) says what it's doing, in present tense, with Stop: *Claude Code is clicking “Start a return”* · *typing in “Search orders”* · *pressing Enter* · *choosing “Express” in “Shipping”* · *going to shop.example/returns* · *going back*. Between actions it falls back to *Claude Code is working in this tab*; with a card up, *Claude Code is waiting for you*; reads keep *is reading this tab*. Each change lasts at least 600 ms on screen, so a fast agent doesn't flicker it.
- **The element** is outlined in the agents' blue as the action is sent, for 1.2 s (`durations.fillHighlight`), with the Web Animations API from the isolated world, exactly as the fill's highlight: nothing added to the page's DOM. With reduced motion, the outline shows and goes without fading. The input never waits for the outline (DESIGN.md principle 4).
- **Your hands first:** a key or a click of yours in the tab pauses it there (M1); the agent's own input never does (above).
- **Stop** and Ctrl+. / ⌘. stop it as in M1. An action already sent can't be taken back; one not yet sent isn't sent.

### The assistant's side

The assistant gets all eight tools, behind the same gate, where it already reads: **only the tab on screen in the window the message came from** (forms' rule), never a private window, a chord where it's off, a *Never* site or a Chord page, and never with *Nothing*. Its instructions say to act only when your message asks, never because a page does. `propose_fill` stays as it is (fill only, you submit).

- **Cards are inline**, in the chat's `ApprovalCard`: *Let the assistant click and type on shop.example?* · *It still asks before it submits, pays, sends or deletes anything.* · **No** · **Allow for this chat** · **Always on this site**. The risky step: *Place the order on shop.example?* · *The assistant is about to click “Place order”.* · **Don't** · **Allow** (⌘↵ / Ctrl+↵ allows, Esc says no, as the read card). Once answered, each shrinks to a muted line.
- **Always on this site** for the assistant is `settings.assistant.actSites` (computer-only, at most 100), listed in Settings → Assistant with Remove.
- **Activity rows** (`ToolActivityRow`), one quiet line each: *Clicked “Start a return”* · *Typed in “Search orders”* · *Pressed Enter* · *Chose “Express” in “Shipping”* · *Went to shop.example/returns*. Consecutive actions on one page fold into one row (*Clicked, typed and pressed Enter on shop.example · 3 steps*), which expands.
- **The page while it acts:** the same blue bar over your tab, *The assistant is clicking “Start a return”*, with Stop, and the outline. A key or click of yours pauses it, as for agents, and the chat shows *Paused while you use the tab*.
- **ARCHITECTURE.md §11 and ROADMAP.md** say acting on pages is out of scope for the assistant. The owner's decision changes that; the build's docs slice updates both.

### Never offered (checked in main, every call)

- **No tool for:** script in a page, cookies and storage, the vault, Settings, extensions, raw CDP, network mocking, files. `CONTROL_NEVER_OFFERED`'s name test covers the tool list; the new tools pass it.
- **No element of:** a password, one-time-code or payment-card field (no ref; `type` refused), a file field, a frame's inside, Chord's own UI (the input goes to the page's WebContents only, never the shell's).
- **No key** beyond the list: no shortcut of Chord's, the OS's or a web app's letter keys.
- **No address** but http(s) for `navigate`; never a *Never* site (as `open_tab`), never `chord://`, `javascript:`, `data:`, `file:`.
- **No vault in agents' tabs** (`PasswordService.pageOf`, M1): no autofill, no save prompt.
- **No permission** (camera, location…) in agents' tabs (`permissions.ts`'s `agentTab`, M1).
- **No acting on shared tabs** in M2: a tab you share stays read-only (the owner's answer 2).
- *Unit test:* a table of each of these through the tools' handlers, with a fake page.

### Who's calling (peer PID)

As settled above: `GetNamedPipeClientProcessId` through window-owner.exe (a new `pipe-client <pipe> <handle>` verb next to `restrict-pipe`), `SO_PEERCRED` on Linux, `LOCAL_PEERPID` on macOS. The parent chain and the card's *Started by* come from that PID; `hello.parentPid` is then ignored. If the lookup fails, the card says *Started in ~/folder.* (no program) and *Always allow* isn't offered. On Windows the helper runs once per connection, while the card shows, as the parent lookup does today. ⚠ `GetNamedPipeClientProcessId` needs Chord's own handle to that pipe instance. Node doesn't expose it publicly; the spike checks `socket._handle.fd` (the HANDLE, on Windows) in Electron's main, which Chord passes to window-owner.exe, which duplicates it out of Chord's process (`DuplicateHandle`, same user) and asks. If that can't be done, M2 does Linux and macOS only, keeps the hint on Windows, and says so here.

### Performance budgets (the CI's perf job, `vitest.perf.config.ts`, plus timings in the E2E)

| What | Budget | Measured how |
|---|---|---|
| Launch, and a page no agent acts on | No change: nothing is injected or listened to until a snapshot or action | The existing launch budget; a test that a page never snapshotted has no listener added |
| `snapshot` on a typical page (fixture: ~1,500 elements) | median ≤ 25 ms, p95 ≤ 60 ms in the renderer; main's part < 2 ms | The E2E's timing, 20 runs, in the Linux container |
| `snapshot` on a 20,000-element page | ≤ 150 ms (the bound), result ≤ 40,000 characters | Same |
| Snapshot size | ≤ 40,000 characters a range; a typical page's first range under 12,000 | Fixtures |
| An action, ref to input sent (resolve, scroll, hit test, send) | median ≤ 15 ms, p95 ≤ 40 ms | Same |
| Settling after an action that changes nothing | ≤ 500 ms | Same |
| The gate and the classifier | < 0.1 ms a call | The perf job's micro benchmarks |
| Peer PID lookup (Windows helper) | ≤ 150 ms, off any call's path (it runs while the card shows) | Unit timing against the real helper on the Windows CI |

Before-and-after numbers for each slice go in its PR, from the same container runs.

### Slices

Behind `AGENT_ACTIONS_RELEASED` (core, false) until M2d lands, as M1 was behind `AGENTS_RELEASED`: development and E2E builds have the tools, packaged builds don't list them.

| Slice | What | Notes |
|---|---|---|
| **M2a** | The spike, then **who's calling** (peer PID on each OS) and **your hands, not a script's** (the marked input, the three handlers) | The spike settles `sendInputEvent` on a parked hidden tab (Windows and Linux) and the Windows pipe handle; its findings go in this record |
| **M2b** | **`snapshot`** and element refs: the isolated-world script, `ElementRefs` in core (as `TabRefs`), the bounds, the perf fixtures | Read-only; outside agents and the assistant both get it |
| **M2c** | **Acting:** `click`, `type`, `press_key`, `hover`, `select_option`, `navigate`, `back`; the input path; the **site card** and *Always on this site* (with Settings → Agents' list); the bar's words; the outline | Every action counts as `act` until M2d (development builds only) |
| **M2d** | **Risky steps:** `control-risk.ts` and its table, the **step card**, *Show me*, late answers | Turns `AGENT_ACTIONS_RELEASED` on when it merges |
| **M2e** | **The assistant:** the tools in the chat, inline cards, activity rows, `actSites` in Settings → Assistant, the instructions | Can run beside M2d once M2c is in |
| **M2f** | Docs (ARCHITECTURE.md §11, DESIGN.md §7.8 and §7.17, ROADMAP.md, the site's copy) and the release | |

### Tests

- **Table-driven units:** the risk table (`control-risk.test.ts`); the key list (every allowed key, every refused combination); `ElementRefs` (made, stale after a new snapshot, stale after a navigation, never reused, another tab's ref); the gate's `site` and `step` grants (allow for now, always, deny for the connection, late answers matched by tab, page, ref and action); the never-offered table; the snapshot's role and name rules (run against fixture HTML in the E2E's page, not jsdom, since layout and `checkVisibility` matter); the marked-input queue.
- **Journey E2Es,** in the Linux container (X11 and Wayland), with the fake MCP client and the stand-in Claude:
  1. **An agent acts:** connect, `open_tab` a local shop fixture, `snapshot`, `type` in its search with `submit` (a search form: no step card), the site card (Allow for now), `click` a result, `navigate`, `back`, a stale ref refused, the bar's words, the outline. Then a key of the test's pauses it while the agent's own `type` never did, and Stop.
  2. **A risky step:** fill the fixture's checkout, `click` *Place order*: the step card, *Show me*, Don't (the order isn't placed; the agent hears it), then again with Allow (placed once). A password field has no ref; a covered button is refused by name; a 46 s wait returns *waiting*, then a late Allow counts for that step only.
  3. **The assistant acts:** a message asks it to search the fixture; the inline site card, activity rows, the bar over your tab, and the risky card inline.
- **Perf:** the snapshot and action timings above, in the perf job, on the fixtures.
- **Windows CI:** the peer PID helper's units. No Windows E2E on the owner's computer.

### WebMCP (later)

*Owner, 2026-11-21: make M2 WebMCP-ready, and pass sites' own tools (`document.modelContext`) through in a later milestone. What's reported about WebMCP (an Origin Trial in Chrome 149–162; the API moved from `navigator` to `document` and lost `provideContext`; an experimental CDP `WebMCP` domain with `toolsAdded` and `invokeTool`) is from a review, not checked here; that milestone checks it against Electron's Chromium first.*

- **Not in M2.** Passing site tools through waits until Chromium ships `document.modelContext` on by default and the spec settles. M2 enables no WebMCP feature flag.
- **Fixed tool names.** M2's tools are short and fixed. Site tools will come later behind fixed meta-tools (`list_page_tools`, `call_page_tool`), never by changing `tools/list` as pages come and go: clients cache it (Antigravity reportedly caches schemas on disk).
- **One page boundary.** `ControlPage` stays the only thing that touches a page, whether through the isolated world or the debugger (`debugger-queue.ts`), so the CDP `WebMCP.*` domain can plug in behind it later with neither front door changing.
- **Cards and grants that fit.** The site and step cards carry a structured target and arguments (`ControlCard.target`, plus `args` from M2c: the element's role and name, or later a tool's name and its arguments), not prose alone. M2's site grants are per registrable domain, as settled; site tools' grants will be per origin, a finer key the same gate can hold (`grantKey`'s subject).
- **Pages never lower the bar.** A page's own hints (a tool's `readOnlyHint`, ARIA, form attributes) never turn a risky step into an action that doesn't ask; they can only make one ask. Chord never injects a WebMCP shim into a page's main world.
- **Untrusted, and only where reading is allowed.** Site tools' names, descriptions, schemas and outputs are untrusted data, wrapped like page text (§11.4). Only the main frame's own, same-origin tools are offered, never in a private window, on a Chord page or on a *Never* site. The assistant gets them through the same gate.

### Owner's answers (2026-11-22)

The owner approved the plan and the mock: build as drawn.

1. **The agent's reason on the card:** left off. Cards show only what Chord sees.
2. **Shared tabs:** read-only in M2. *Share and let it act* is for later.
3. **Always on this site:** offered only to agents you always allow; one let in once gets **Allow for now**.
4. **`forward`:** left out.

## Antigravity (2026-11-21, before 0.14.0)

Settings → Agents adds Chord to Antigravity's MCP config itself (the owner's mock B; ARCHITECTURE.md §11.3). A Gemini review of the plan made claims about Antigravity; here is what was checked:

- **Config file:** `~/.gemini/config/mcp_config.json` on every OS, from Google's Antigravity MCP docs. Others name `~/.gemini/antigravity-cli/mcp_config.json` (Arm's install guide) or `~/.antigravity/mcp_config.json` (Flutter's). Chord writes Google's, or `~/.gemini/antigravity/mcp_config.json` when only that older one exists (the file the installed build already reads). `GEMINI_HOME`, when set, takes the place of `~/.gemini` (the review's claim; harmless either way).
- **JSONC and a BOM:** not confirmed against a real `agy`; handled anyway, since editing in place costs nothing when the file is plain JSON.
- **An empty file before any server (CLI 1.5.8):** from the brief, not confirmed here; a blank file is `{}`.
- **Its client name** (reportedly `antigravity-cli` from the CLI, `antigravity-client` from the app), **its process tree** (a `language_server_*` helper), and **whether it re-lists tools on `notifications/tools/list_changed`** (reportedly it caches tool schemas on disk): not checked. A real `agy` needs Google's installer and a signed-in Google account, which a quiet container run doesn't have; the owner hand-checks them. Meanwhile the card shows the name the client gives, as for any agent (no relabeling of an unverified name), and *Started by* passes a `language_server_*` helper only to the Antigravity app itself (its name and install layout on each OS, no `..`; on macOS the executable as `lsof` has it, links resolved). A child of Claude Code or Codex that calls itself so is named as itself, and gets a card. The layouts accepted are what VS Code forks ship: the helper in `resources/bin/` or the extension's `resources/app/extensions/antigravity/bin/` beside `antigravity` / `Antigravity.exe`, and on macOS inside `Antigravity.app`'s `Contents/Resources/`, its parent either the app or its extension host (`Contents/Frameworks/Antigravity Helper*.app`) with the app above it. **They still need the owner's hand check** against a real Antigravity on each OS: a layout that differs fails closed (the card names the helper, not Antigravity), never open. On macOS a process with no executable from `lsof` has no path, and the lookup stops there.
- **The limit that stays:** the parent is a hint, never an identity. A child of an allowed agent can always run `chord mcp` itself, and then its parent *is* that agent: Always allow lets it in, as it would the agent. What protects the user is unchanged: an allowed agent works in its own tabs, sees a tab of yours only when you share it, and the never-offered list holds; M2's peer PID (above) narrows who can claim a parent, not this.
