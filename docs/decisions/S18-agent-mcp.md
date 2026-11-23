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
- **The limit that stays:** the parent is a hint, never an identity. A child of an allowed agent can always run `chord mcp` itself, and then its parent *is* that agent: Always allow lets it in, as it would the agent. Nor is a parent proof on Windows: a program can start `chord mcp` with a parent of its choosing (`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`, any process of the same user it can open), and the chain then names that one. And Chord's own executable counts as the bridge (its parent is who started it), so running it as a plain Node script would let a script pick its parent too; `ELECTRON_RUN_AS_NODE` does nothing to a packaged Chord (its RunAsNode fuse is off), but does to a development build's Electron. What protects the user is unchanged: an allowed agent works in its own tabs, sees a tab of yours only when you share it, and the never-offered list holds; M2's peer PID (above) narrows who can claim a parent, not this.

## M2a: as built (2026-11-22)

The first slice of M2 ("M2: plan"): who's calling, and your hands, not a script's. Behind `AGENT_ACTIONS_RELEASED` (core, false): a packaged build keeps M1's *Started by*, from the hello's word, until a release turns M2 on.

**What the spike found, and where the build differs from the plan:**

| Question | Seen |
|---|---|
| Can Chord hand window-owner.exe its handle to the pipe instance? (the plan's first route) | **No.** Node's `fd` for a pipe socket is -1 on Windows, server and client end alike (Node 24.19, Windows 11). |
| Another way to the client's PID on Windows? | **Yes:** `window-owner.exe pipe-clients <pipe> <Chord's PID>` reads the system's handle table (`NtQuerySystemInformation`, extended handle information), takes Chord's file handles (the type its own file handle has), copies each (`DuplicateHandle`, the same user's process), keeps the server ends of the agent pipe (`GetFileType`, `GetNamedPipeInfo`, its name by `GetFileInformationByHandleEx`) and prints their clients' PIDs (`GetNamedPipeClientProcessId`). The queries, which could block on a file with I/O pending, run at once, each on a thread of its own, and those not done in 250 ms are left behind. The same process gives each client's chain (a process snapshot, `QueryFullProcessImageNameW`, `GetProcessTimes`), so Windows needs no PowerShell for *Started by*. Found both of two clients, every run. |
| Which client is which connection's? | The helper can't say (it sees all instances). Each live connection's hello claims a bridge PID (`AgentService.claims`, from the hello on, so an idle relay that hasn't been looked up yet still holds its own). A PID claimed by two live connections is **contested**: neither gets it, and both can't tell, with no fallback, checked before the lookup and again after it (a claim contested while it looked, as when the real relay's hello lands meanwhile, gives unknown). So a process with the token that hellos as a new relay before the relay's own hello does gets nothing, and neither does the relay. Otherwise a connection's peer is its claimed PID when that's a client and the claim is its alone; any PID claimed by others, or given to them, is taken; else, only when the helper's list is complete, the one client nobody holds; else unknown. The list is complete when no query was left behind (`stuck`) and no file past its cap of 8,192 (counted after taking only files: `truncated`) went unlooked-at, and none was `skipped` (a file that couldn't be copied, or whose query failed before it could say whether it was one of the pipe's; review 4 of #103); otherwise a client may be missing, and the only free client seen could be a connected relay whose hello hasn't come yet, so only a connection's own verified claim names its peer (review 3 of #103). A relay that reconnects with the same PID before Chord has seen its old connection close contests itself and can't tell, once. Weaker than Linux's and macOS's answer, but a process can no longer name an arbitrary parent, nor borrow a relay's identity: it must itself be connected to Chord's pipe. (Reviews 1 and 2 of #103.) |
| How long? (plan: ≤ 150 ms) | **A lookup, as the card waits on it: 104 to 163 ms** on Windows x64 here, wall clock, the chain included (the helper's own work 57 to 85 ms: the table 31 to 50, the scan 2 to 3, the queries 3 to 4, the chain 21 to 28; about 396,000 handles in the system), **582, 606 and 1,271 ms on CI's Windows arm64** over two runs (its own work 456 ms in one, 286 ms of it waiting out the 250 ms deadline for one query stuck on a file with I/O pending, never one of the pipe's own server ends, which never block; 600 to 1,300 ms while the card shows is acceptable). Stopping early once the expected clients answered was tried and reverted (4adc1ee). **The helper's first start is apart:** about 3 s on a fresh arm64 runner (the first .NET program there). Chord pays it on the first connection's `restrict-pipe` (M1b), which every connection's code waits for before its card, so the lookup always runs a warm helper. The first build marshalled each of the table's entries, twice, and queried the files one by one: about 180 ms here, plus M1's PowerShell for the chain (about 1 s), and 3.6 s on arm64. Starting the lookup at the hello wouldn't help (the relay's hello comes with its first call, and the card with it), nor would warming the helper when Agents turns on (Agents on costs one pipe and one file at launch, nothing more), and .NET Framework has no ReadyToRun (ngen needs an administrator at install). The units' budgets (`PEER_BUDGET_MS`): a lookup within 400 ms on Windows x64 (about 2.5 times the worst seen, 163 ms), 1.9 s on Windows arm64 (about 1.5 times the worst seen on that noisy runner), 500 ms on Linux, 1.5 s on macOS, and the helper's first start within 6 s (`PEER_COLD_MS`, a ceiling); a failure prints what was seen and the helper's own timings. |
| Linux | `ss -xpnH` (iproute2): Chord's socket's inode (`/proc/self/fd/<fd>`), and the PID holding the socket whose peer that is (each row's last number before `users:`, so an address with spaces in it, on either end, can't mislead it). Its output format checked against a real `ss` in WSL (Ubuntu). No `ss` (the E2E container until now: iproute2 is added; a minimal system; the Flatpak, which can't see the host's processes anyway), unknown. |
| macOS | `lsof -nP -U -a -u <uid> -F pfdn`: Chord's socket's address, and the process whose socket points at it (`->0x…`). **Not run here** (no Mac): CI's macOS jobs run the real lookup (`agent-peer.test.ts`). |
| Unknown | The card says *Started in ~/code/app. Chord can’t tell which program started it.* and offers no Always allow (an allowance is kept by its program); **Allow once** is the filled pill. An Always pressed before the lookup ends, with no program found, lets it in once and keeps nothing (until review 1 of #103 it said *always* and kept nothing). |
| A reused PID (Windows) | Windows never reparents, so an exited parent's PID can be another process's by the lookup: an ancestor created after its child ends the chain. Linux and macOS give orphans to init (launchd), so their parent PIDs are never stale. The peer itself is alive and connected when it's looked up. |
| Does Chord see `sendInputEvent`'s events while the call runs? | **Yes, for clicks and keys:** `before-input-event`, `before-mouse-event` and `input-event` all fired inside the call, none after it returned (agents.spec, X11 and Wayland in the Linux container; every CI OS). So `isAgentInput` is a count of sends under way, with no queue to match. **The wheel** is seen inside too, but the scroll it starts arrives after the call returns: `gestureScrollBegin`, `gestureScrollUpdate`, `input-event`'s `mouseWheel` (once the page handled it) and `gestureScrollEnd`. None is a key or a button press, which is all the pause, `USER_MS`, the shortcuts and a pane's focus act on; history's scroll save hears the late `mouseWheel`, rightly. The journey checks the late ones stay so. |
| Can an agent's key run one of Chord's shortcuts? | **No.** `sendAgentInput` refuses, before anything is sent, any event off core's `agentInputAllowed` list (press_key's keys, Shift only with Tab; the left button, moves and the wheel; no modifier): nothing of the batch goes. Should one get past, `keyboard.ts` stops any agent key off the list (core's `agentKeyAllowed`), page and menu alike; DevTools' F12 and Ctrl+Shift+I are stopped the same way. A key of the list goes to the page as it is, Chord's handler skipped, even when it's a shortcut too: plain Escape is *Stop loading*, and stopping it would have made `press_key Escape` do nothing (review 2 of #103). Keys a page leaves alone go on to the window's menu accelerators after the send returns (S8), where `before-input-event` can't reach, so a send with keys turns the page's menu shortcuts off (`setIgnoreMenuShortcuts`) until your next key there turns them back on, before that key reaches the page or the menu. agents.spec: Ctrl+W refused, then, sent unchecked, stopped, every tab staying; the agent's Escape reaching the page. |
| Does input reach an agent tab that isn't on screen? | **Yes**, while one of the agent's calls runs (the tab is parked and painting, M1c): a click, a key, Enter and `insertText` all arrived, each `isTrusted: true`. The debugger fallback isn't needed. |

**Built:** `agents/peer.ts` (the lookup on each OS, and the choice), `window-owner.exe pipe-clients`, the service's *Started by* from the peer (the peer being Chord's own executable, its parent), `control/input.ts` (`sendAgentInput`, `isAgentInput`) with the pause, `USER_MS`, Chord's shortcuts, DevTools' keys and a split pane's focus (its click and its `focus`) all skipping the agent's input, core's `agentInputAllowed`, the card's *can't tell* state, and `AGENT_ACTIONS_RELEASED`. *Tests:* `agent-peer.test.ts` (the parsers and the choice as tables, and a real lookup against clients in their own processes, on every CI OS), `agent-input.test.ts` (the input allowed), cases in `agents.test.ts` for where *Started by* comes from and for claims, `agent-connect.test.ts` for a card that can't tell, and agents.spec journeys for the input (Ctrl+W included) and the card.

## M2b: as built (2026-11-22)

The `snapshot` tool and element refs, as the plan has them, behind `AGENT_ACTIONS_RELEASED`: a build that has M2 (`agentActions`) offers it to outside agents (`agentTools`, `AGENT_ACTION_TOOLS`) and the assistant (`assistantTools`); a scope without M2 (`ControlScope.actions`) refuses it as an unknown tool. The relay and Chord's connection build the same list for the build (`agentToolList(actions)`), so their fingerprints agree. Round 4 of #103's nits came first: window-owner.exe counts a file it can't copy, or whose query fails before it can tell, as `skipped`, and the client list is complete only with `stuck`, `truncated` and `skipped` all 0; `choosePeer`'s `complete` is required.

- **The script** (`control/snapshot.ts`) runs in the isolated world (4400), as forms do, and reuses forms' labels, visibility and clipping (`FORM_LIB`). It walks the main frame and open shadow roots, lists a frame by its title without entering it, and gives back nodes: a role (the element's `role`, else its implicit one), a name (`aria-labelledby`, `aria-label`, a field's labels, `alt`, `title`, then its own words, never a field's value), a depth (only nodes with a role nest), states and, for what can be acted on, a key. Text runs are nodes too, except inside an element their words name (an acted-on one, a heading). A pointer-cursor element with nothing keyed around it is a `generic` with a key. Keyed elements are kept by `WeakRef` under the read's token (`__chordSnapshots`, the latest one only) for M2c.
- **The rules** are core's (`control-snapshot.ts`): `ElementRefs` (per tab, `e1`… never reused, good only from the latest snapshot and on the page id it was taken of; a page that moved on during the read gets refs that are never good), `snapshotOutline` (Playwright MCP's indented form; a password, one-time-code, payment or identity field, by forms' `sensitiveField`, gets no ref and says the user fills it; states from a fixed list; roles kept to letters), `snapshotResult` (untrusted JSON as `pageResult`, in ranges of 40,000 characters that start and end at a line) and `cleanSnapshotRead` (keys whole, once each, at most 2,000).
- **Read as `read_tab` is:** the scope's rules and card (*Look over “Orders”*), every rule asked again after the card, the load and the read, never in reader view. The assistant's *This chord* asks for another chord's tab, as for `read_tab`.
- **Review 1 of #104:** a text field of any kind (a contenteditable, a `role=textbox`, as well as inputs and text areas) is named by its labels alone, never its words (what's typed in it), isn't walked into, and is described as a field, so `sensitiveField` vetoes a card number in a rich editor; a select is too (a card's expiry month: no ref, no choice shown). Text nodes count toward the scan's 20,000 and its time check, and main keeps no more than 20,000 nodes of any answer, so a page of 2,000,000 text nodes is cut like any other (measured: the script within its budget, main 10.9 ms). A later range (`start`) comes from the outline the latest snapshot made (`ElementRefs.remember`), while the page id is the same: no second read, card or activity line, and the first range's refs stay good; a page that moved on is read again. The page keeps each owner's latest snapshot (the agent's gate id: an outside agent, a chat), at most 16 owners, so one agent's snapshot never takes away another's before M2c acts on it. `aria-hidden="true"` subtrees are left out. Review 2: editability is decided first, whatever the tag or role (a `td`, an `li`, an `h1`, `role=none`): any editable element is a typed field, named by its labels alone, described as a field and never walked into; forms' `words` gives nothing for an editor itself (a button labelled by one), and stops after 2,000 steps. A later range carries the snapshot's own time, and asks no card: one approval covers a snapshot, all its ranges. Review 3: the walk's start is checked too: a page that's all editor (`<body contenteditable>`, `<html contenteditable>`, `designMode`, the `data:` notepad) is one typed field, never walked; and `words` gives nothing when it starts at a text area, a select, an input or an option (`aria-labelledby` pointing at one never shows its value or options). A sensitive field is never issued a ref at all (`snapshotKeys`), shown or not: before, the outline hid it but a ref number was still spent on it, which an agent could have guessed (agents.spec's journey found it). A range at or past the end is empty. Closed tabs' refs go at the next snapshot. window-owner.exe's `pipe-clients` counts a failed `GetFileType`, and a failed `GetNamedPipeClientProcessId` on a server end of the pipe, as `skipped`, except `ERROR_NOT_FOUND` (what it answers on the four instances libuv keeps waiting for the next connection; seen here), `ERROR_PIPE_NOT_CONNECTED` and `ERROR_PIPE_LISTENING`; its output says why each skip was (`skips`).

**Measured:**

| What | Budget | Seen |
|---|---|---|
| The script on a typical page (1,500 elements: 1,203 nodes, 600 refs), round trip from main | median 25 ms, worst 60 ms; the Intel Mac runner 45 and 90 ms | median 12.8 to 15.9 ms, worst 21 to 28 ms (three runs each on X11 and Wayland, the Linux container); CI's runners: median 11.0 (Windows x64) to 19.9 ms (Linux arm64), worst up to 36 ms; the Intel Mac (macos-15-intel) median 26.9 and 30.2 ms, worst 57 ms |
| The script on a 20,000-element page (2,000 refs, the cap) | 300 ms | median 127 to 166 ms, worst 194 ms (it scanned to its 150 ms bound); since text nodes count toward the scan (review 1 of #104), median 75 to 91 ms, worst 138 ms (cut at 20,000 nodes looked at: 8,890 in the outline) |
| The script on a page of 2,000,000 text nodes | 300 ms | median 31 to 34 ms, worst 49 ms (cut at 20,000) |
| Main's part (cleaning, refs, outline, result), typical page | median 3 ms (the plan: under 2) | 0.6 to 1.8 ms (Windows x64, `pnpm test:perf`) |
| Main's part, 20,000-element page | median 20 ms | 7.6 to 11.8 ms; 12.2 ms before names without hidden characters skipped `cleanPageText`'s passes |
| Main's part, an answer of 2,000,000 text nodes (cut to 20,000) | median 20 ms | 10.9 ms |
| A page no agent snapshots | nothing runs | the script runs only when called |

*Tests:* `core/test/control-snapshot.test.ts` (refs, the outline, the result, the cleaning, which builds offer it), `control-snapshot.perf.test.ts`, `control.test.ts`'s snapshot rows through the gate (unknown without M2, refs going stale, a page that moved on, never-readable, the card, no answer), and agents.spec's journey on a fixture page (roles, names, states, no ref on sensitive fields, nothing hidden, framed or typed shown, refs counted on) with the timings above.

## M2c: as built (2026-11-22)

Acting on pages, for outside agents, as the plan has it, behind `AGENT_ACTIONS_RELEASED` (development and E2E builds only). The assistant's acting is M2e: its scope has no `act` host, so the acting tools stay unknown there, and its tool list keeps `snapshot` alone. Every action counts as `act` (asks once per site); risky steps are M2d.

- **Tools** (core's `ACTION_TOOLS`, `AGENT_ACTION_TOOLS`): `click`, `type` (`text` up to 5,000, `replace` true unless false, `submit`), `press_key` (the plan's 15 keys), `select_option` (by the option's label), `hover`, `navigate` (http and https, never a *Never* site) and `back`; MCP annotations say they're not read-only, and `click`, `type` and `press_key` are destructive. Each element tool names a `ref` from the tab's latest snapshot on the page it's on now (`ElementRefs.resolve`); a stale or unknown one is refused before anything else.
- **The page's side** (`control/act.ts`): a script in the isolated world, with the snapshot's own rules (`SNAPSHOT_LIB`, split out of the snapshot script so both share one copy), finds the element in its owner's latest snapshot and checks it's still connected, shown, and the role and name the snapshot gave it (kept with its `WeakRef`). Then `describe` (disabled, takes text, a select), `point` (scrolled to the middle at once, hit-tested at its middle and its quarters' middles through open shadow roots; the cover named by its nearest role: *dialog “Cookie settings”*), `focus`, `select` (a field's contents, for `type`'s replace), `choose` (the fill's way: the native setter, input and change). Each action outlines its element in the agents' blue for 1.2 s with the Web Animations API, no fade with reduced motion.
- **Main's side** (`control/tools.ts`'s `actTool`, `control/page.ts`): clicks through `sendAgentInput` at the point times the page's zoom; text by `insertText`; keys by core's `pressKeyEvents` (each one `agentInputAllowed`). The page id is checked again right before the input: a page that moved on between the check and the click gets nothing (it would have landed on another page's element). After the input, a navigation it set off is waited for (its start within 150 ms, its load at most 10 s, then `loading: true`), else the page settles (quiet 100 ms, at most 500). The result: `done` in Chord's words, `navigated`, the page id, address and title, and a note to snapshot again when it navigated (the tab's refs are then stale).
- **The site card** (`agents/site-cards.ts`, the popover's `AgentSiteCardView`): the first action on each site (`loginSite`, as sharing's) asks where the connect card does: *Let Codex click and type on shop.example?* · *It wants to type in “Search orders”.* · **Deny** · **Allow for now** · **Always on this site** (only for an agent you always allow, kept in `AgentAllowance.actSites`, at most 100). Core's `grantAfter('site', …)` keeps both *Allow for now* and a no for the agent's life, so a page can't make it ask again and again; only a fresh *Always* is kept for good (the gate's own memory of a yes isn't). The mock's *It still asks before it submits, pays, sends or deletes anything* waits for M2d, when it's true.
- **Settings → Agents:** under each agent you always allow, *Can click and type on* and its sites, each with **Remove** (`removeSite`), which also clears that site's yes from its live connections, so the next action there asks, mid-task too; with none, *Asks before acting on any site.* Only in a build that acts (`AgentsView.acting`).
- **The bar:** while it acts, *Codex is clicking “Start a return”* (core's `barDoing`: typing in, pressing, choosing, pointing at, going to, going back), each wording at least 600 ms (`ACT_BAR_MIN_MS`); with a card up, *Codex is waiting for you*; otherwise *is reading this tab*, as before.
- **Shared tabs** stay read-only: *That tab is shared with you to read, not to act on.*
- **A site** is its registrable domain (`loginSite`, with the Public Suffix List's private suffixes), its scheme aside: a yes on `shop.example` covers `http://` and `https://` pages of it, and every subdomain of it, alike.
- **Review 1 of #110:**
  - *Stop and your hands, all the way through.* Before every input sent and every text put in, and right after the site card's wait, an action asks again: Stop, a pause (you used the tab, maybe while the card waited 45 s), a page that moved on since the element was checked. Any of them, and nothing more goes in, though the action had started (a click already sent stays sent).
  - *The focus and the field, checked last.* Text and keys go wherever the focus is, so right before each the page says whether the element still has it (through open shadow roots) and describes the field as it is now; main refuses one the page turned into a password, code or card field (core's `sensitiveField`, the snapshot's own check) or a focus the page sent elsewhere (a focus handler bouncing it to a password field). `describe` checks the field too, before any card.
  - *The page's words only.* select_option's choice is matched against the select's own options at `describe`, before the card: the card and the bar show the page's label, and a choice that isn't there is refused without quoting it and without a card.
  - *Frames and the last moment.* A hit on an `iframe`, `frame`, `embed` or `object` is never the element's, even one inside it (the cover is named by the frame's title). The pointer goes first, then the page hit-tests the point again, and only then does the button go down. That narrows the race between the check and the press (the page saw the scroll or the outline, and can move something over the point); it can't close it, as the page runs between the last test and the press too.
  - *One card per site,* for the agent: two tabs of it on one site wait on one card, and one answer settles both (the gate keys a site card by its site alone).
  - *Back* is checked before going, as navigate's address is: never to a site kept private or a Chord page.
- **Review 2 of #110:**
  - *The last hit test waits for the pointer.* Blink sends a mouse move with the page's next frame, while the hit test's script runs at once, so the test could run before the page's `mouseover` and `mouseenter` handlers had, and those can put a frame over the point that the press then lands on. `point` now starts watching for the move (a capture listener in the isolated world), and `hit` waits until the page has seen it at that point (at most 250 ms; a move into a frame goes to the frame's document, so the wait runs out and the test finds the frame), then a task more, so the move's own handlers are done, then tests. agents.spec has a button whose `mouseenter` puts a frame over itself: refused, nothing clicked. Review 3: it fails closed. A move never seen (a tab that draws no frames, a page's own capture listener swallowing moves, a move into a frame) gets no press (*The page didn’t see the pointer arrive*), as the press would send the move and its handlers would run after the test; only a pointer already at that point (a second click there, when no move is sent) goes on. agents.spec has a button the page swallows moves over. Review 4: and only if the last move seen there was over that very node (`composedPath()[0]`, kept by a `WeakRef`); another element the page put at the point is refused (its `mouseenter` would run on the press). agents.spec clicks one button twice, then one that took another's place.
  - *Back goes to the entry it checked.* Chromium's `goBack` skips entries a page added without a gesture (a `pushState`), so it could land further back than the entry checked, on a site kept private. `back` now checks the entry just before (`getActiveIndex() - 1`) and goes to exactly it (`goToIndex`), if it's still there.
  - *The focus, between the check and the input,* is narrowed, not closed: a timer can move it after the page says the element has it, and each key event is its own message. While text or a key goes in, the page has a guard up (capture listeners on the window for `keydown`, `keypress`, `keyup` and `beforeinput`, after any the page put there first): one that would land anywhere but the element is stopped there, the action ends and the agent hears the focus moved. The guard comes down once the page has seen the input's last event (the key's `keyup`, the text's `beforeinput`; at most 250 ms); one never seen (the focus went into a frame) means some may have gone there: the agent hears to check the field (reviews 3 and 4; where the focus ends up isn't checked, as split date and phone fields move it on). It can't stop what the page does with the focus inside its own handlers after that.
  - *Choices:* matched by the page's whole label (clipped only to show it), never a disabled one (itself or its `optgroup`) or a hidden one, and two by one label choose neither (*Ask the user to choose*). `fencedframe` counts as a frame.
  - *One site card, many tabs:* the card says what the first tab's action was; every tab waiting on it has its bar say it's waiting.

- **Neon's review of #110 (an independent security pass; the owner had every finding fixed in M2c):**
  - *Closed shadow roots.* `elementFromPoint` and `document.activeElement` stop at a closed root's host, so the page's own checks can't see a frame a button hides in one, or a password field a text box sends its focus to. Acting now opens a short session on the tab's debugger (control/deep.ts; `withDebugger`, attached for the press or the typing and let go once the page settles, as page_diagnostics does) for anything that presses or types: `DOM.getNodeForLocation` (in the document's coordinates: the view's point plus the scroll) finds the node under the point through closed roots, and Chord's own isolated world (found by its snapshots among the main frame's contexts, so the page can't reach the check or change what its functions do) walks from it up to the element (`getRootNode().host` leads out of a closed root from inside): never a frame, never a file input, and for a second click with no fresh move, the very node the last move was over. An element with a closed root anywhere in it (`DOM.describeNode`, `pierce`) is never typed in or pressed keys in. No debugger (someone's DevTools holding it in a way Chord can't share), nothing pressed or typed. This is Chord using the protocol for its own checks, as page_diagnostics does; agents never get it.
  - *The typing guard is the preload's.* It moved from Chord's isolated world to the agent tab's page preload (preload/agent-guard.ts), which runs before any of the page's scripts, so its listeners on the window are the first: a page's own capture listener can't see a key first, move the focus to a password field and stop everything after it. Main arms it (through the preload's world, Electron's 999), then checks the focus is the element's (in the main document, so not in a frame: a frame with the focus is the document's `activeElement`), that the element has no closed root, and Stop and a pause, then sends the input, then takes the guard down once the input's last event came. A guard that isn't there, or doesn't answer on the same page, fails closed. What it can't close: the focus moving into a frame between that check and the input's arrival (it's then reported, as *some of it may not have reached the field*).
  - *The site card's page.* The page and its site are taken before the element is described and checked again before the card, so a page that went elsewhere meanwhile gets no card with the first page's words. A yes is kept only once the action runs on that page and site (`ControlAgent.keep`); a no at once. One card is one site (the gate keys site cards by the site).
  - *File pickers.* A file input, or a label for one, has no ref and is refused (*agents never choose files*). The preload's click block is on the window (its first listener), and while an action's debugger session is open, a picker the page opens is intercepted (`Page.setInterceptFileChooserDialog`), never shown, and the result says so. A picker a page opens after the session, on the activation the agent's click gave it, isn't intercepted; the preload's block and its `showPicker` hold still apply.
  - *Your click pauses it,* as a key does. `navigate` and `back` check Stop and a pause after the tab's load. select_option and every action check the field at the point too (a field made a password field while the card was up).
  - *One host however written.* *Never*, sites and the site card compare hosts without a fully qualified name's trailing dot, lowercase and in IDNA (core's `normalHost`, `loginSite`): `bank.example.` was read though `bank.example` was *Never*.
  - *Your focus* (Neon's inference, not confirmed): the agents.spec journey checks the focused page is the same before and after an agent clicks and types in its parked tab; it was. Input Chord sends goes to the view's widget, not the window's focus.
  - Measured (the Linux container, the typical page, 30 runs): the debugger's session for a press or typing, median 4.4 ms, p95 5.0 ms on X11, 4.9 and 5.9 ms on Wayland (`ACT_DEEP_MS`: 25 and 60 ms); the snapshot unchanged (median 14.0 ms).

- **Review 5 and Neon's second pass (of a10b080):**
  - *File pickers, for the agent tab's whole life.* A page could open a picker after acting's session ended, on the activation the agent's click gave it (about 5 s): a detached input, one in a closed root, one in a frame. Now an agent's tab has its debugger attached from the moment its page is made (agents/pickers.ts), with `Page.setInterceptFileChooserDialog` on in its page and in each frame in another process (`Target.setAutoAttach`, flattened): no picker is ever shown there, and the agent hears of each with its next result. Its preload runs in every frame of it too (`nodeIntegrationInSubFrames`, sandboxed as the page is), whatever the frame's address (about:blank, srcdoc, blob:), so its holds (dialogs, the File System Access pickers) and the click block are there as well. A tab of yours never gets any of it; a kept tab's page is made again as yours (core's keepAgentTab, as before: the second pass's item 3 found it already so, and agents.spec now checks it).
  - *A repeat click moves off and back.* A second click at a point sends no move, so the page has nothing to run handlers on before the test: the pointer now goes 3 px off and back, and the page must see both moves, as for any click. The shortcut (the last move's node) is gone, with its stale pointer.
  - *Finding Chord's world once per document.* It takes `Runtime.enable` (contexts are named only to a client that enables it): now once per document, disabled at once, the context kept for the document's later actions (`Runtime.evaluate` and `Runtime.callFunctionOn` need no enable). Review 6: the page's console entries are kept (discarding them emptied page_diagnostics and DevTools), so the document's first action pays the replay: 36 to 45 ms on a page that logged 1,000 large objects, 6.5 ms on the typical page, then 3 to 4 ms (`ACT_DEEP_MS`: the first under 200 ms, the rest 25 and 60). Each enabling once per action was 41.7 ms median there.
  - *The guard.* Every frame's guard is up while main's is (over IPC to each frame: an agent's input is only ever for the top document, so a frame's blocks every key and insertion meanwhile, and says so); the guard lasts up to 30 s, past an action's worst path, and always comes down, even when the input fails. A key goes in two steps: its keydown, then everything checked again (focus, closed roots, Stop, a pause) before its character. A guard with no answer is a no; only one gone with its document (another page) counts as done.
  - *A late Always* is carried to the retry like a late once, and kept only if the action then runs on that page and site. Sites kept for good are as a site is written now (no trailing dot). `navigate` and `back` check a pause after the load too. A label for a file input, its text or an icon in it, counts as the input.

- **Review 6 and Neon's third pass (of efdc808):**
  - *Keys that work on their keydown.* Only a key that types a character into a field (Enter or Space in a text field) goes in two steps (its keydown, everything checked again, its character); any other key goes in at once, and its keydown moving the focus (Tab, an arrow in a radio group) or the page (Enter on a link) is the key working. A guard whose script went with its document (another document, counted from when it starts, not a `pushState`) is done; one that ran out in the same document, or was dropped, is a no (the preload says which).
  - *Objects let go of.* Everything a session gets of the page is in one object group, released when it closes (the agent tab's debugger stays attached, so nothing else would free it).
  - *Frames' words.* A dialog or a picker held in a frame of another origin reaches the agent only as *a frame from https://ads.example tried to show a dialog*, never the frame's own text.
  - *Frames' guards.* A frame made while the guard is up asks as its preload starts (`page:agentGuardState`) and starts with its own up. The guard comes down at once when you take the tab (your key or click), so your keys are never stopped. Composition events are guarded too; `insertText` has a time limit.
  - *The hold, if the debugger lets go.* A detach or a crashed renderer: attached and armed again (tried for 5 s); meanwhile the tab's hold is lost and nothing is pressed or typed there. Frames are held before they run (`waitForDebuggerOnStart`, then `Runtime.runIfWaitingForDebugger` once their interception is on), and only frames are attached (`filter`).
  - *Your focus* (Neon's nit 8, confirmed): the agents.spec journey now starts with focus in the window's own page and found it lost when an agent opened a tab (the parked view takes the window's focus a moment after it's shown), and left with the agent's tab after Enter on a link navigated it. Parking gives it back when no page has it (at once, then at 50, 200 and 500 ms), and every action and navigation gives it back to the page that had it, if it ended with the agent's tab or nothing. It can be gone for up to half a second after an agent opens a tab.
  - *File System Access* in a frame made with no address: the agent tab's permission handler already refuses every permission an agent's tab asks for; agents.spec checks a fresh frame's `showOpenFilePicker()` is refused, never shown. The passwords sentinel runs in the top frame only.

**Measured:** the page's `point` step (the check, the scroll and the hit test) on the typical page, round trip from main, median 0.5 ms, p95 0.8 to 3.6 ms (three runs, X11, the Linux container), against the plan's 15 and 40 ms (`ACT_POINT_MS`, agents.spec). Nothing runs in a page no agent acts on. The snapshot, with its rules split out to `SNAPSHOT_LIB`, measured against origin/main the same hour in the same container (three runs each): a typical page's median 17.8 to 23.7 ms here, 15.8 to 18.3 ms on main, both within the 25 ms budget and the machine's noise. Main's run also showed one pause of 777 ms among 35 to 43 ms on the 2,000,000-text-node page, so the huge pages' budget is now on the median of five (`SNAPSHOT_HUGE_MS`), the worst still printed.

*Tests:* `core/test/control-act.test.ts` (the keys, Chord's words, the bar), `control.test.ts`'s grant rows and acting rows through the gate on a fake page (the site card once, a lasting no, Always kept, a site kept before, every refusal before input, `type`'s steps, `press_key`, `select_option`, navigated, a page that moved on before the input, `navigate` and `back`), `agent-site-cards.test.ts`, and two agents.spec journeys (an agent types, clicks and chooses with *Allow for now*, refs go stale, a covered element named, navigate and back; *Always on this site* kept, listed in Settings, removed, asked again and denied).
