# The 72-hour patch runbook

**Goal:** when Electron ships a release with Chromium or Electron security fixes, a Chord release with them is on every channel **within 72 hours** of Electron's release. The design is in [ARCHITECTURE.md §14.3](../../ARCHITECTURE.md#143-the-72-hour-chromium-security-process); this is the checklist.

**Today (2026-10-23):**
- Automated: detection, the Renovate PR, CI, automerge, the release builds and their smoke tests.
- By hand: tagging, checking the draft release, publishing it.
- Built but switched off: the apt and dnf repositories ([linux-repos.md](linux-repos.md)). They update by themselves once `CLOUDSMITH_API_KEY` exists.
- Built but waiting on keys: code signing and notarization ([signing.md](signing.md)), and in-app updates on Windows and the AppImage, which need the [update signing key](#update-signing-key) (§14.4, §15.2).
- Not built yet: staged rollout. Chord isn't on Flathub yet ([flathub.md](flathub.md)).

The [dry run](#dry-run-2026-10-23) at the end records how long each step took.

✅ = verified against docs or real data. ⚠ = unverified.

---

## The clock

| By | Step | Who | Typical time (dry run) |
|---|---|---|---|
| T+0 h | Electron publishes. The clock starts at the release time in `releases.json`. | | |
| T+1 h | [Signal](#1-the-signal-electron-watchyml): the watcher opens a P0 issue; Renovate's PR is up | automated | the watcher runs hourly; a read takes 1–2 s |
| T+1 h | [Triage](#2-triage) | on-call | minutes |
| T+8 h | [Bump](#3-bump-electron) merged with [every suite green](#4-the-suites-that-must-pass) | Renovate, or you | CI: about 6 min a run (2026-10-23) |
| T+12 h | [Tagged](#5-tag-the-release); the [release workflow](#6-the-release-workflow) has built a draft | you, then CI | about 5 min for all six builds ✅ |
| T+24 h | [Artifacts smoke-tested](#7-smoke-test-the-artifacts) and the draft [published](#8-publish) | a maintainer | under an hour by hand |
| T+24 h | apt and dnf repositories updated | automated, on publish | minutes (once switched on) |
| T+48 h | Flathub update merged and built | you, then Flathub | Flathub publishes 1–2 h after a merge ✅ (once Chord is on Flathub) |
| T+72 h | Every channel has it; P0 issue closed | on-call | |

A known bug beats a known exploit: if one platform can't be fixed in time, see [when a platform build fails](#10-when-a-platform-build-fails).

---

## 1. The signal: `electron-watch.yml`

[`electron-watch.yml`](../../.github/workflows/electron-watch.yml) runs hourly at :17 (GitHub delays runs on the hour ✅). The logic is in `scripts/ci/electron-watch.mjs`, with unit tests.

1. It compares `releases.electronjs.org/releases.json` with the exact `electron` version in `apps/desktop/package.json`.
2. For each newer stable release **on our major**, it reads the GitHub release notes and looks for security content. Any of these counts, because Electron's notes don't say "security" consistently:
   - a CVE id or a `GHSA-…` advisory;
   - a `Security:` line;
   - a line starting with `Backported` (2026 notes say "Backported fixes from upstream ANGLE, Chromium, PDFium, Skia and V8" with no CVE ids ✅);
   - `Updated Chromium to …` (the V8 zero-day CVE-2025-6554 shipped in Electron 37.2.0 with only that line ✅).
3. On a hit it opens **one issue per version**, "P0: Electron X has security fixes", labeled `security` + `p0` and assigned to `SECURITY_ONCALL` (or the owner). The issue states the deadline (72 h after the oldest unpatched security release) and repeats this checklist.
4. It ticks the Renovate Dependency Dashboard's "run again" box, so Renovate runs now instead of within 4 hours. ⚠ Mend doesn't document that as an API.
5. Separately, 30 days before our major's end of life, it opens an issue to move to the next major (P0 once it has ended, since no more fixes will come).

Other signals: Renovate's own PR (about every 4 hours ✅), Electron's GHSA advisories through Renovate's vulnerability-alert PRs, and the [Chrome Releases blog](https://chromereleases.googleblog.com/search/label/Stable%20updates).

**Rehearse it** (read-only; writes nothing to GitHub):
```sh
node scripts/ci/electron-watch.mjs                   # against package.json
node scripts/ci/electron-watch.mjs --current 44.9.0  # prints the issue it would open for an older 44.x
```
Or *Actions → Electron security watch → Run workflow* with **dry run** ticked.

## 2. Triage

By T+1 h, the on-call person:
- [ ] Reads the issue's notes excerpt. **Not security?** (e.g. "Backported fix for AVX related crashes"): close it as *not planned* with a one-line reason, and stop.
- [ ] Looks up the Chromium version on the [Chrome Releases blog](https://chromereleases.googleblog.com/search/label/Stable%20updates). If any fix is **"exploited in the wild"**, works through the rest now, whatever the hour.
- [ ] Checks Renovate's PR is open (`Update dependency electron to vX`, branch `renovate/electron`). If it isn't 30 minutes after the issue: tick *"Check this box to trigger a request for Renovate to run again"* on the Dependency Dashboard, or press **Run** on [developer.mend.io](https://developer.mend.io/) ✅, or bump by hand (next step).

## 3. Bump Electron

Renovate pins the exact version and has no wait or rate limit for `electron` (§14.2). By hand:

```sh
git switch -c fix/electron-X main
pnpm --filter @chord/desktop add -D --save-exact electron@X
pnpm --filter @chord/desktop list electron        # shows X
git commit -am "fix(deps): update electron to X (security)"
git push -u origin HEAD                           # then open a PR
```

- **Patch and minor updates** automerge once every CI check passes. If the PR is green and still open, merge it yourself (squash); don't wait for Renovate's next run.
- **A new major** (our major reached end of life) is a manual PR. Read Electron's breaking changes for the jump; the same suites must pass.
- After the merge, check the Chromium version. The issue names it; `releases.electronjs.org` lists it per Electron version. In a running Chord, Settings → About shows both.

## 4. The suites that must pass

Every one, on the bump's commit. CI runs the first two on every PR and every push to `main`.

| Suite | Where | Command |
|---|---|---|
| Typecheck · lint · unit tests (Vitest) | CI job *Typecheck · lint · unit tests* | `pnpm typecheck && pnpm lint && pnpm test` |
| E2E, dev build (Playwright `_electron`) | CI: *E2E ·* Windows x64, Windows arm64, macOS arm64, macOS x64, Linux x64 X11, Linux x64 Wayland, Linux arm64 X11 | `pnpm build && pnpm --filter @chord/desktop test:e2e` |
| Packaged smoke test (Playwright over CDP) | the release workflow, on each installed build | `pnpm --filter @chord/desktop package:dir && pnpm --filter @chord/desktop test:packaged` |
| Flatpak build and smoke test | locally, until Chord is on Flathub | `flatpak/build.sh --test` (Linux, Docker or Podman) |

Electron updates change Chromium, so the packaged smoke test matters: it proves the fused binary starts, the asar'd shell loads, and `node:sqlite` in the chord-data utility process saves and restores a profile. It runs in the release workflow, on the installed `.exe`, `.app`, `.deb` and AppImage.

**When CI fails on the bump:**
1. **Re-run the failed jobs once.** E2E can flake.
2. **The update broke something:** fix forward. Push your own *new* commits to `renovate/electron`; Renovate then stops updating the branch and leaves the merge to you ✅. Don't amend Renovate's commit. For a big fix, branch from `renovate/electron`.
3. **An unrelated test is broken:** fix or skip it, with a linked issue, in a separate PR. Then re-run the security PR.
4. **Never** pin Electron back to make CI pass, set `ignoreTests`, or wait for the next Electron release.

## 5. Tag the release

Releases come only from CI, from a `v*` tag (§15.3). The tag must match `apps/desktop/package.json`, or the release workflow stops. One commit carries everything the tag needs, because the release page links to `RELEASE_NOTES.md` **at the tag**:

- [ ] Bump the patch `version` in `apps/desktop/package.json` (`A.B.C` → `A.B.C+1`).
- [ ] Add the [release notes](#9-release-notes) entry at the top of `RELEASE_NOTES.md`.
- [ ] Add a `<release>` line at the top of `<releases>` in `flatpak/io.github.anaremore.chord-browser.metainfo.xml` (Flathub shows it).
- [ ] Commit to `main` (through a PR if `main` is protected): `chore(release): vA.B.C`.
- [ ] Tag that commit and push only the tag:
  ```sh
  git switch main && git pull --ff-only
  git tag -a vA.B.C -m "Chord A.B.C"
  git push origin vA.B.C
  ```

Never reuse a version number or move a tag: updaters, package repositories and Flathub key on the version. If a tag points at the wrong commit, cut the next patch version instead.

## 6. The release workflow

[`release.yml`](../../.github/workflows/release.yml) starts on the tag. ⚠ Another change may be editing it; if its header says something different from this section, follow the header.

Approve the `release` environment twice: first for the builds (they read the signing secrets), then for the draft.

1. Six native builds: Windows x64 and arm64, macOS arm64 and x64, Linux x64 and arm64. Code signing and notarization run by themselves once their secrets are in `release` ([signing.md](signing.md)); until then, builds are unsigned. If a build that should be signed isn't, the release stops: fix the secret and re-run the failed jobs.
2. Each build is installed or opened the way a user would (silent per-user NSIS install, `codesign --verify` and `hdiutil verify`, the `.deb` with its AppArmor profile, then the AppImage), its fuses are read back, its browser registration is checked, and the packaged smoke test runs against that copy.
3. It signs the update manifests with the [update signing key](#update-signing-key). Without the key it warns, and that release's copies only say it's out.
4. If every leg passes, it uploads a **draft pre-release** with all the files and `SHA256SUMS.txt`.

Watch it: `gh run watch --repo anaremore/chord-browser` or *Actions → Release*. Runs on 2026-10-23 took 4–5 minutes from start to the last build ✅.

## 7. Smoke-test the artifacts

CI has already installed and smoke-tested each file. Before publishing, a person checks what CI can't:

- [ ] Download the draft's files and check them: `sha256sum -c SHA256SUMS.txt` (macOS: `shasum -a 256 -c`).
- [ ] **Windows** (your machine): install the `.exe` **over the previous version**, as users will. Chord starts, your tabs are there, and Settings → About shows Electron X and Chromium Y.
- [ ] **macOS** (Apple Silicon MacBook): open the `.dmg`, replace the app, and start it (Gatekeeper's *Open Anyway* the first time). Same About check. Allow *Chord Safe Storage* if asked.
- [ ] **Linux** (VM): `sudo apt install ./Chord-*-linux-amd64.deb` over the old one; same About check.
- [ ] Browse a few real sites, sign in to one, and play a video. Anything wrong goes in the P0 issue.

## 8. Publish

- [ ] A maintainer publishes the draft (*Releases → Edit → Publish release*). This is the only step that reaches users.
- [ ] Publishing starts [`linux-repos.yml`](../../.github/workflows/linux-repos.yml), which puts the `.deb` and `.rpm` files in the apt and dnf repositories. Until `CLOUDSMITH_API_KEY` exists it's skipped, and the run is still green. Once it's on, check the run finished and `apt update && apt list --upgradable` shows the new version in the VM.
- [ ] **Flathub** (once Chord is on it): update the app's repository under `github.com/flathub`, by hand ([flathub.md](flathub.md#each-release)). Flathub builds within 1–2 hours of the merge ✅.
- [ ] Post the release link in the P0 issue.
- [ ] Once the update signing key exists, copies on Windows and the AppImage download the release and offer *Restart to update*. Other GitHub builds, and every copy until then, see the notify-only update toast within a day (§14.4).

## 9. Release notes

`RELEASE_NOTES.md` is **append-only**: newest first, and entries are only ever added, never rewritten. A mistake in an old entry is corrected by a note in a new entry. Each GitHub release links to the file at its tag.

A security release adds one entry at the top:

```md
## 0.1.1 · security (2026-12-20)

**Security.** Updates Electron to 45.0.1 (Chromium 156.0.8078.60), which fixes security issues in Chromium. Update as soon as you can.
```

Name the Electron and Chromium versions, link nothing that isn't public yet, and keep it to what users need. The P0 issue links the Electron release.

## 10. When a platform build fails

The release workflow builds with `fail-fast: false`, so one failed build doesn't stop the others, but the draft is only created when **every** build passes.

1. **Re-run the failed job** (*Re-run failed jobs*). Smoke tests drive a real app and can flake: on 2026-10-23 the Linux arm64 smoke test failed once in a manual run while the other five passed ✅.
2. **It fails again:** read the uploaded `failures-<platform>-<arch>` artifact (test results and `builder-debug.yml`). Fix forward on a branch, merge, and tag the **next** patch version. Don't move the tag.
3. **One platform can't be fixed within the window:** ship the others. The maintainer decides, and the release notes say which platform is missing and why:
   ```sh
   gh run download <run-id> --repo anaremore/chord-browser --pattern 'chord-*' --dir dist
   mkdir files && mv dist/*/* files/ && cd files
   sha256sum -- * > SHA256SUMS.txt
   gh release create vA.B.C * --repo anaremore/chord-browser --verify-tag --draft --prerelease \
     --title "Chord A.B.C (preview)" --notes "…the same notes as release.yml, plus the missing platform…"
   ```
   These are still CI's builds, each smoke-tested in that run; only the upload is by hand. Open an issue for the missing platform and ship it in the next patch.
4. **Never:** pin Electron back, skip the smoke test in `release.yml`, or upload a build made on a laptop.

## 11. Pulling a bad release

electron-updater has no rollback ✅, and package repositories don't either, so the fix is always a **higher version**.

1. Edit the bad GitHub Release: say what's wrong and that a fix is coming.
2. Revert or fix on `main`. Keep Electron patched: if Electron itself regressed, take its next patch or work around the bug, never a vulnerable version.
3. Bump, tag, build and publish as above. The repositories and Flathub pick up the new version the same way.

---

## One-time setup

- [ ] Install the [Mend Renovate app](https://github.com/apps/renovate) on the repository. `renovate.json` is already on `main`, so there's no onboarding PR ✅. Check the **Dependency Dashboard** issue appears, and merge one Renovate PR soon: until one is merged, Mend runs the repo **daily**, not every 4 hours ✅ ([job scheduling](https://docs.renovatebot.com/mend-hosted/job-scheduling/)).
- [ ] *Settings → Advanced Security:* turn on **Dependency graph** and **Dependabot alerts** (Renovate's vulnerability-alert PRs need them ✅). Leave *Dependabot security updates* off.
- [ ] Optional: repository variable `SECURITY_ONCALL` (comma-separated GitHub logins). The default assignee is the owner.
- [ ] Optional: request Mend's **Community (OSS)** plan ([Mend Hosted Request](https://github.com/renovatebot/renovate/discussions/new?category=mend-hosted-request)) for more runner memory and 2 concurrent jobs ✅.
- [ ] Optional, for faster merges: a branch ruleset on `main` that requires the CI checks, *Allow auto-merge*, then `platformAutomerge: true` in `renovate.json`. Don't flip `platformAutomerge` without the ruleset, or GitHub may merge before tests finish ✅ ([docs](https://docs.renovatebot.com/configuration-options/#platformautomerge)).
- [ ] apt and dnf: [linux-repos.md](linux-repos.md#switching-it-on).
- [ ] Flathub: [flathub.md](flathub.md#submitting-to-flathub).
- [ ] Code signing certificates, when you have them: [signing.md](signing.md).
- The `security` and `p0` labels are created the first time they're needed.

### Update signing key

Installed copies on Windows and the AppImage install an update only when its manifest is signed with this Ed25519 key (ARCHITECTURE.md §14.4). Until the key exists, every copy only says a new version is out. Make it once, on a machine you trust:

1. **Create the environment.** *Settings → Environments → New environment*, named `release`.
   - Under *Deployment protection rules*, tick **Required reviewers** and add yourself.
   - Under *Deployment branches and tags*, choose **Selected branches and tags** and add the tag rule `v*`.
   - Do this before the next tag: a workflow that names an environment that doesn't exist creates it with no protection.
   - The code-signing certificates go in this environment too ([signing.md](signing.md)).
2. **Make the key pair.** From the repository root, run `node apps/desktop/scripts/update-key.mjs`. It prints a public key, a fingerprint and a private key, and writes nothing to disk.
3. **Store the private key.** In the `release` environment, under *Environment secrets → Add environment secret*:
   - Name: `CHORD_UPDATE_SIGNING_KEY`.
   - Value: the whole private key, from `-----BEGIN PRIVATE KEY-----` through `-----END PRIVATE KEY-----`.
   - Put it in an environment secret, not a repository secret, so only the reviewed release job can read it.
4. **Keep an offline copy** of the private key, in your password manager. GitHub won't show a secret again. Without a copy, losing it means users install one version by hand (step 7).
5. **Embed the public key.** Paste it into `apps/desktop/src/main/update-key.ts`, keeping the PEM's line breaks:
   ```ts
   export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
   MCowBQYDK2VwAyEA…
   -----END PUBLIC KEY-----
   `;
   ```
   Merge it through a normal PR. Then clear your terminal's scrollback.
6. **Check the first signed release.**
   - The *Sign the update manifests* step logs `Signed latest-win-x64.yml (key <fingerprint>)`, with the fingerprint from step 2.
   - The draft has a `.yml.sig` beside each `latest-win-*.yml` and `latest-linux*.yml`.
   - If the secret is missing, the step warns and the release ships notify-only. It doesn't fail.
7. **Copies made before the key was embedded can't install updates themselves.** They say the new version is out, and the user installs it by hand once. After that, they update themselves.

**Rotating the key:**
1. Make a new pair.
2. Ship one release that embeds the **new** public key but is signed with the **old** private key. Copies install it, and from then on they trust the new key.
3. Then replace the secret.

If the old key leaks, rotate at once. If it's lost, step 7 applies to everyone.

## Known gaps

- **CI has to be green on `main`** for a bump to merge. A red `main` (as on 2026-10-23, while an unrelated fix was in progress) delays every security release; fix it first.
- ⚠ **Ticking the dashboard checkbox from a workflow** is how other repos trigger the Mend app, but it isn't a documented API. If it stops working, Renovate still runs within about 4 hours; tick the box by hand to go faster.
- **GitHub disables scheduled workflows** after 60 days without activity in a public repo, and delays them at busy times ✅. If *Actions* shows the watch disabled, re-enable it.
- **Electron's notes don't name the Chromium bugs** they fix or rate severity, so every backport is treated as P0.
- **Flathub updates are by hand** and Flathub's policy forbids AI-generated manifests and AI-automated PRs ([flathub.md](flathub.md#flathubs-rules-on-ai)), so a person has to make each one.
- **Bus factor:** two maintainers with release rights before 1.0 (risk R9).

---

## Dry run, 2026-10-23

Every step that publishes nothing, on the maintainer's Windows 11 PC and in WSL2 (Ubuntu 22.04, Docker), at `main` (375415f) plus this change. No tag was pushed, no release created, nothing uploaded. The Flatpak container ran alongside the Windows suites, so these times are a little slow.

**No bump was needed.** The newest Electron 45 release was 45.0.0 (2026-10-21, Chromium 156.0.8078.48), which Chord already uses, so there was no newer 45.x to try on a scratch branch. The install step below is a fresh install from the lockfile, which is what a bump costs apart from downloading the new Electron (about 110 MB).

| Step | What ran | Result | Time |
|---|---|---|---|
| 1. Signal | `node scripts/ci/electron-watch.mjs` | "Chord is on Electron 45.0.0. Newer on 45.x: none." | 1 s |
| 1. Signal, rehearsed | `node scripts/ci/electron-watch.mjs --current 44.9.0` | Prints the P0 issue it would open for 44.9.3, deadline included | 2 s |
| 3. Bump | `pnpm install --frozen-lockfile` in a fresh worktree (pnpm store already warm), including `install-electron` | ok | 44 s |
| 4. Typecheck | `pnpm typecheck` | ok | 11 s |
| 4. Lint | `pnpm lint` | ok | 10 s |
| 4. Unit tests | `pnpm test` | 371 passed (38 files) | 4 s |
| 4. Build | `pnpm build` | ok | 8 s |
| 4. E2E, Windows x64 | `pnpm --filter @chord/desktop test:e2e` | 56 of 57 passed. *Screen sharing* failed once with `NotReadableError` from the capture, then passed when re-run alone (18 s): a flake, and there was no bump to blame | 3 min 54 s |
| 4. Package, Windows x64 | `pnpm --filter @chord/desktop package` (NSIS installer and unpacked app) | ok, 122 MB installer | 47 s |
| 4. Packaged smoke test | `pnpm --filter @chord/desktop test:packaged` | 2 passed (the macOS-only test skipped) | 6 s |
| 4. Flatpak | `flatpak/build.sh --test`, in WSL | built, linted, and the packaged smoke test passed on X11 and Wayland ([flathub.md](flathub.md#verified-on-2026-10-23)) | about 20 min with nothing cached; 5.5 min with the cache (3 of them building and bundling) |
| 5. Tag | Not run: it would push a tag. `release.yml` compares `v` + the `package.json` version with the tag name | | |
| 6. Release workflow | Not run: it needs a tag. Manual runs of the same workflow on 2026-10-23 built and smoke-tested all six targets in 4–5 min; one of them had a Linux arm64 smoke-test flake | | 4–5 min ✅ |
| 7. Checksums | `sha256sum` of the 122 MB installer | ok | under 1 s |
| 9. Release notes | Entry drafted as in §9, not committed (`RELEASE_NOTES.md` is append-only) | | |

**What this says about the 72 hours:** the work on the critical path is short. A bump that CI passes first time takes under 10 minutes of machine time locally and about 6 minutes in CI, and the release workflow 5 more. The deadline is spent waiting: on Renovate (up to 4 hours if the dashboard tick doesn't take), on a person to triage, tag and publish, and on Flathub's test build and publishing. A red `main` or a flaky suite costs more than any build.
