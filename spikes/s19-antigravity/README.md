# Spike S19: Antigravity as the assistant's third app

Not wired into the app, and in no build. The results are in [docs/decisions/S19-antigravity-assistant.md](../../docs/decisions/S19-antigravity-assistant.md).

| File | What it is |
|---|---|
| `policy.mjs` | The lockdown as pure functions: the private `settings.json`, the variables agy gets, the directory flags, the answer to each permission request (Chord's tools once, nothing else), the tripwire, and the sign-in methods allowed (never `oauth-personal`). |
| `acp-session.mjs` | The prototype: one `agy acp` session in a private home and an empty folder, signed in with a Gemini API key from a file, with Chord's `list_tabs` and `read_page`. `--record out.jsonl` keeps both directions, the key replaced by `<key>`. |
| `stand-in-chord.mjs` | Chord's tools as a stdio MCP server, answering from one fake tab. In the app this would be `chord mcp --assistant` (decision doc, risk 3). |
| `fake-gemini.mjs` | A stand-in Gemini API (agy reads `GOOGLE_GEMINI_BASE_URL`): logs the tools agy declares and plays a script of tool calls, so no key or credits are needed. |
| `fixtures/script-*.json` | Those scripts: Chord's tools, then a write, a command, reads, a web search, a workflow, subagents and a timer. |
| `fixtures/attack.jsonl`, `fixtures/search.jsonl` | Two recorded sessions of agy 1.5.14 under the prototype. |
| `selftest.mjs` | The policy against the recordings and hand cases: `node selftest.mjs`. |
| `container-run.sh` | The real agy in a throwaway Linux container: it fetches agy from Google's release channel (SHA-512 checked) into a Docker volume, starts the stand-in model and runs the prototype. |

Run it (Docker; on Windows from Git Bash add `MSYS_NO_PATHCONV=1`):

```sh
docker volume create s19-agy
docker run --rm -v s19-agy:/agy -v "$PWD:/s19" node:24-bookworm-slim \
  sh /s19/container-run.sh fixtures/script-attack.json fixtures/attack.jsonl
docker volume rm s19-agy
```

With a real key, mount it read-only at `/secret/key` and pass `real` instead of a script. Never on the desktop: agy starts a language server with two loopback ports, and its skills, plugins and logs land in its home.
