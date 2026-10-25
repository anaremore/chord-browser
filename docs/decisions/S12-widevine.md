# Spike S12: Widevine through castLabs ECS

*2026-10-24 · D4 (ARCHITECTURE.md §16) · re-run: `node scripts/dev/ecs-lag.mjs`*

## The question

Netflix, Spotify, Disney+ and the other top streaming services need Widevine, which stock Electron doesn't include. castLabs' **ECS** (Electron for Content Security) is Electron with Widevine. D4's plan was a notice now (built: `main/drm.ts`), then this spike, then a decision. The plan's likely answer was ECS on Windows, macOS and Linux x64, with a rule: whenever ECS is more than 72 hours behind on a critical fix, ship the stock build with DRM off until it catches up.

The spike had four parts:
1. ECS's patch lag over six months.
2. VMP signing through castLabs' EVS service in CI.
3. Which services and resolutions play on each OS.
4. Google-free mode.

Part 1 decides whether parts 2 to 4 matter, so it came first.

## 1. Patch lag: ECS trails security fixes by weeks

**Method:**
- For each Electron release in the last six months whose notes name a CVE, find the first ECS build of the same major at or past that version.
- Data: GitHub releases of `electron/electron` and `castlabs/electron-releases`, gathered by the script above.

| Electron release with CVE fixes | CVEs | Released | First ECS build at or past it | Wait |
|---|---|---|---|---|
| v42.0.0 | 10 | 2026-05-06 | v42.0.0+wvcus | 37 h |
| v42.4.0 | 2 | 2026-06-09 | v42.5.2+wvcus | 560 h (23 days) |
| v40.10.3 | 15 | 2026-06-09 | v40.10.6+wvcus | 548 h (23 days) |
| v41.7.2 | 12 | 2026-06-09 | v41.9.2+wvcus | 548 h (23 days) |
| v42.11.1 | 15 | 2026-09-01 | v42.11.10+wvcus | 814 h (34 days) |

**This understates the gap.** Electron names CVEs in only a few release notes. Twenty releases in the same months say "Updated Chromium to …", and each of those brings Chrome's own security fixes.

**ECS builds a fraction of releases:** 5 of 21 v41 releases, 7 of 45 v42, 5 of 26 v43 and 3 of 22 v44. Between its builds, an ECS app sits on an older Chromium.

**No stable ECS for Electron 45 yet,** which Chord runs. Electron 45.0.0 shipped 2026-10-21; the newest ECS 45 is alpha.14. Adopting ECS today would mean going back to 44.

**Against the 72-hour rule,** four of the five fixes would have switched DRM off for three to five weeks each. Over six months, DRM would have been off for roughly half the time, and flipping on and off with every security release. That's worse than not having it: people would learn that Netflix sometimes works.

## 2–4. Deferred

EVS signing in CI, services and resolutions per OS, and Google-free mode only matter if Chord adopts ECS. Notes for when they do:
- **VMP:** production builds need castLabs' free EVS signing service, with the maintainer's own account. It runs as a Python CLI in CI after packaging and before code signing on macOS.
- **The CDM:** it downloads from Google's component updater on first launch. Google-free mode would have to turn it off.
- **Linux:** no persistent licenses, and VMP is unverified there, so some services refuse. Linux arm64 has no Widevine CDM at all.
- **Testing:** check playback with the Widevine test streams (Shaka Player's demo assets) on each OS before trusting any service list.

## What this means for D4

A browser shows untrusted pages all day, so a Chromium fix weeks late is a real exposure, not a formality. The options:

| | Option | Security fixes | DRM |
|---|---|---|---|
| A | **Stay on stock Electron**; keep the notice and *Open in…* | same day as Electron | never; services open in another browser |
| B | A separate **"with Widevine" download** on ECS, alongside the stock build, labeled as trailing | stock: same day; Widevine build: weeks behind | for those who choose it |
| C | ECS for everyone, with the 72-hour rule | same day, by turning DRM off | off weeks at a time, unpredictably |
| D | ECS for everyone, accepting the lag | weeks behind, for every user | always |

**Decided 2026-10-24: A.** Re-run the script before revisiting. The path to these services is spike S14, a Widevine player: an optional companion app on ECS that opens only them, so ECS's lag stays off the open web.

**The original recommendation: A, and re-run the script every quarter.** B is the fallback if many people ask: it doubles the release matrix (builds, signing, E2E per OS), and it trails the way D does, only for people who chose it.
