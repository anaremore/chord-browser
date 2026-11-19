# Spike S18 M0: Chord's own MCP server

Not wired into the app. The results are in [docs/decisions/S18-agent-mcp.md](../../docs/decisions/S18-agent-mcp.md).

| File | What it is |
|---|---|
| `endpoint.mjs` | The endpoint a running Chord serves: a named pipe (Windows) or a Unix socket in a 0700 folder, plus `agent-endpoint.json` (path and token) in the profile folder. The token comes first; nothing is sent before it. |
| `bridge.mjs` | `chord mcp`: a stdio MCP relay. It answers `initialize` and `tools/list` itself and connects to Chord on the first `tools/call`. |
| `tools.mjs` | M1's proposed tool list, the refusal texts, and Chord's side of a connection with the approval gate. |
| `parent.mjs` | Who started the bridge (name, path, folder) on each OS. |
| `electron-main.mjs` | One Electron executable with both roles: `mcp` (the bridge, with no window and no lock) and a windowless host whose `open_tab` loads real pages in hidden windows. |
| `fake-chord.mjs`, `mcp.mjs`, `fake-client.mjs` | A plain-Node Chord, the bridge under Node, and a fake MCP client. |
| `selftest.mjs` | Every path with the fakes: `node selftest.mjs`. |
| `measure.mjs` | Start-up and memory: `node measure.mjs 20 <electron.exe> electron-main.mjs mcp --spike-user-data=<dir>`. |
| `pipe-acl.ps1` | A pipe's DACL, what a read-only opener gets, and tightening it: `pwsh pipe-acl.ps1 <dir>\agent-endpoint.json -Tighten`. |
| `posix-check.sh` | The Unix socket against another user (as root: `bash posix-check.sh <node> <user>`). |
| `real-clients.sh` | The user's `claude` and `codex` against the Electron host: `bash real-clients.sh claude [delayMs\|deny]`. Uses a throwaway profile, an empty folder and a cheap model. |
