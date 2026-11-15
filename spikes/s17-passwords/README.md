# Spike S17 M0: Chord's own password manager

Throwaway code for the seven questions of [S17](../../docs/decisions/S17-passwords.md) §15, M0. The findings are in S17, *M0 findings*. Nothing here is product code, and nothing in `apps/` or `packages/` changed.

Nothing here opens a window on your desktop: everything that starts Electron, or runs someone else's code, runs in the Linux E2E container (`run-linux.mjs`, which uses the image `pnpm test:e2e:linux` builds) or on CI (`.github/workflows/s17-spike.yml`, Windows and macOS, on pushes to this branch only).

| File | What |
|---|---|
| `corpus.mjs` | Fetches DuckDuckGo's labelled forms (`duckduckgo-autofill` 19.2.1, commit `4d58486`) into `.cache/ddg/` (git-ignored, never committed), checking the tarball's SHA-256 and the tree hash of `test-forms/` |
| `chromium/form-parser.ts` | The TypeScript port of Chromium's password form parser (BSD-3, commit `4e452b6`): `autocomplete`, base heuristics, the HTML username detector |
| `chromium/vocabulary.mjs` | Chromium's username word lists, copied as data (BSD-3) |
| `chord-detector.ts` | What S17 §4 adds: form kind from its words, username-only first steps, vetoes, the email preference, a password field's own words |
| `agent/scan.js` | The agent's scan: fields to Chromium-style records, grouped by form. Reads, never writes |
| `agent/agent.js` | The agent in world 4440: focus and rects, frames, §11.6's fill, the resource observer |
| `corpus-extract.mjs` | Every corpus file in Playwright's headless Chromium, scanned: `results/corpus/corpus-records.json` |
| `ddg-run.mjs` | DuckDuckGo's own classifier through its own Jest harness, every score kept: `results/ddg/ddg-scores.json` |
| `bakeoff.ts` | Scores all three; prints the tables; `results/bakeoff.json` |
| `probes/` | Electron: the sentinel preload, the fixture server (React 19 sign-in forms, frames, a news page with ad frames) and the probes for questions 1–3 and 5–7 |

```sh
node spikes/s17-passwords/run-linux.mjs corpus            # records (about 1 minute once Chromium is cached)
node spikes/s17-passwords/run-linux.mjs ddg               # DuckDuckGo's own scores (about 2 minutes)
node spikes/s17-passwords/bakeoff.ts                      # the bake-off, in Node
node spikes/s17-passwords/run-linux.mjs probes --only world,card
node spikes/s17-passwords/run-linux.mjs probes --cpus 4 --only frames,preload
```

When the spike is done: `rm -rf ~/.cache/electron/s17-ms-playwright` inside a container (Playwright's Chromium, kept in the Electron cache volume), and delete `spikes/s17-passwords/.cache/`.
