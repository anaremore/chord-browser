# Chromium security patching runbook

**Goal:** when Electron releases Chromium security fixes, a Chord build with them ships on every platform **within 72 hours**. The process is in [ARCHITECTURE.md §14.3](../ARCHITECTURE.md#143-the-72-hour-chromium-security-process).

**Today (2026-10-22):** detection, the Renovate PR, CI, and automerge are automated. Release builds are unsigned (§15.2). There's no staged rollout, Flathub, Cloudsmith, or in-app install yet (§14.4). Steps that depend on those are marked **not built yet**.

✅ = verified against docs or real data on 2026-10-22. ⚠ = unverified.

---

## How we find out

| Signal | What happens |
|---|---|
| [`electron-watch.yml`](../.github/workflows/electron-watch.yml), hourly at :17 | Compares `releases.electronjs.org/releases.json` with the `electron` version in `apps/desktop/package.json`. For each newer stable release on our major, it reads the GitHub release notes and looks for security content. If it finds any, it opens **one issue per version**: "P0: Electron X has security fixes", labeled `security` + `p0`, assigned to `SECURITY_ONCALL` (or the repo owner). It then ticks the Renovate Dependency Dashboard's "run again" box. |
| Renovate, about every 4 hours ✅ | Opens `Update dependency electron to vX` on branch `renovate/electron`. There's no age wait and no PR rate limit. Patch and minor updates automerge after every CI check passes. |
| Electron's own advisories (GHSA) | Renovate's vulnerability-alert PR, labeled `security`, if Dependabot alerts are on (see [Setup](#one-time-setup)). The watcher also catches them in the notes. |
| End of support | The watcher opens one issue 30 days before our Electron major's end-of-life (from `releases.electronjs.org/schedule.json`). If the major has already ended, the issue is P0, because there are no more fixes to watch for. |

**What counts as security content.** Electron's notes don't say "security" consistently, so any of these lines counts:
- a CVE id;
- a `GHSA-…` advisory;
- a `Security:` line;
- any line starting with `Backported` (2026 notes say "Backported fixes from upstream ANGLE, Chromium, PDFium, Skia and V8" with no CVE ids ✅);
- `Updated Chromium to …`. The V8 zero-day fix CVE-2025-6554 shipped in Electron 37.2.0, and its notes said only "Updated Chromium to 138.0.7204.97" ✅.

A false alarm costs a minute; a miss costs the deadline.

**Rehearse it:** `node scripts/ci/electron-watch.mjs --current 44.9.0` prints the issue it would open and changes nothing. You can also run *Actions → Electron security watch → Run workflow* with **dry run** ticked.

---

## The checklist

The issue repeats this checklist and states the deadline: 72 hours after the oldest unpatched security release.

### T+0 h: Electron publishes

Nothing to do. The clock starts at the release time in `releases.json`.

### By T+1 h: triage (on-call)

- [ ] Read the issue's notes excerpt. **Not security?** (e.g. "Backported fix for AVX related crashes"): close it as *not planned* with a one-line reason, and stop.
- [ ] Look up the Chromium version on the [Chrome Releases blog](https://chromereleases.googleblog.com/search/label/Stable%20updates). If any fix is **"exploited in the wild"**, work through the remaining steps now, whatever the hour.
- [ ] Renovate's PR is open. If it isn't 30 minutes after the issue:
  1. On the **Dependency Dashboard** issue, tick *"Check this box to trigger a request for Renovate to run again"*.
  2. Or use **Run** on [developer.mend.io](https://developer.mend.io/) ✅.
  3. Or bump it by hand:
     ```sh
     git switch -c fix/electron-X main
     pnpm --filter @chord/desktop add -D --save-exact electron@X
     git commit -am "fix(deps): update electron to X (security)"
     git push -u origin HEAD   # then open a PR
     ```

### By T+8 h: CI green and merged

- [ ] Every check is green: *Typecheck · lint · unit tests* plus the seven *E2E* jobs.
- [ ] Merged. Renovate merges on its next run once all checks pass. It treats any failed check as red, and no checks at all as pending ✅. If the PR is green and still open, merge it yourself (squash). Don't wait for Renovate.
- [ ] Verified on `main`:
  ```sh
  pnpm install --frozen-lockfile
  pnpm --filter @chord/desktop list electron   # shows X
  pnpm dev                                     # Settings → About: Electron X, Chromium Y
  ```
  `Y` must match the Chromium version for X on [releases.electronjs.org](https://releases.electronjs.org/).

### By T+12 h: release built

Releases come only from CI, from a `v*` tag (§15.3). ⚠ `release.yml` is new; if its header says otherwise, follow it.

- [ ] Bump the patch `version` in `apps/desktop/package.json` and commit: `chore(release): vA.B.C`.
- [ ] Tag that commit `vA.B.C` and push the tag. The release workflow builds every platform and uploads a **draft** GitHub Release.
- [ ] Approve the `release` environment twice: first for the builds (they read the signing secrets), then for the draft.
- [ ] Write the release notes: "Security: updates Electron to X (Chromium Y)". Link the Electron release and the P0 issue.
- Code signing and notarization run by themselves once their secrets are in `release` ([releasing/signing.md](releasing/signing.md)). Until then, builds are unsigned. If a build that should be signed isn't, the release stops; fix the secret and re-run the failed jobs.

### By T+24 h: published

- [ ] A maintainer publishes the draft release.
- [ ] Post the release link in the P0 issue.
- **Today:** users get it from the notify-only update check (Phase 1) or by downloading it.
- **Not built yet:** `stagingPercentage` rollout, a Flathub PR, and Cloudsmith apt/rpm repos.

### By T+48 h: watch

- [ ] Watch new issues for crashes and regressions. There's no telemetry, so issue reports are the only signal.
- **Not built yet:** raising the staged rollout to 100%.

### By T+72 h: done

- [ ] Every channel has the release. Today that's just the GitHub Release; later it also includes Flathub and Cloudsmith.
- [ ] Close the P0 issue with the release link.

---

## When CI fails on a security bump

Ship the fix; don't let an unrelated failure hold it.

1. **Re-run the failed jobs once.** E2E can flake.
2. **The update broke something:** fix forward.
   - Push your own *new* commits to `renovate/electron`. Renovate then stops updating the branch and leaves the merge to you ✅. Don't amend Renovate's commit.
   - If the fix is large, do it on your own branch from `renovate/electron`.
3. **An unrelated test is broken:** fix it, or skip it with a linked issue, in a separate PR. Then re-run the security PR.
4. **One platform can't be fixed within the window:** a maintainer may ship anyway, with the known issue in the release notes and an issue to follow up. A known bug beats a known exploit.
5. **Never:**
   - pin Electron back to make CI pass;
   - set `ignoreTests`;
   - wait for the next Electron release.

---

## Pulling a bad release

electron-updater has no rollback ✅, so the fix is always a **higher version**.

1. Edit the bad GitHub Release: say what's wrong and that a fix is coming. ⚠ Whether marking it *pre-release* stops update checks depends on the updater, which isn't built yet.
2. Revert or fix the offending change on `main`. Keep Electron patched. If Electron itself regressed, take its next patch or work around the bug. Don't go back to a vulnerable version.
3. Bump the patch version, tag, build, and publish as above.
4. Never reuse a version number or move a tag. Updaters and caches key on the version.

---

## One-time setup

- [ ] Install the [Mend Renovate app](https://github.com/apps/renovate) on this repository.
  - `renovate.json` is already on `main`, so there's no onboarding PR ✅.
  - Check that the **Dependency Dashboard** issue appears.
  - Merge the first Renovate PR (the action-pinning PR is a good one) soon: until one Renovate PR is merged, Mend runs the repo **daily**, not every 4 hours ✅ ([job scheduling](https://docs.renovatebot.com/mend-hosted/job-scheduling/)).
- [ ] *Settings → Advanced Security:* turn on **Dependency graph** and **Dependabot alerts**. Renovate's vulnerability-alert PRs need them ✅. Leave *Dependabot security updates* off, because Renovate already raises those PRs.
- [ ] Optional: set the repository variable `SECURITY_ONCALL` (*Settings → Secrets and variables → Actions → Variables*) to comma-separated GitHub logins. The default assignee is the repo owner.
- [ ] Optional: request the **Community (OSS)** plan with a [Mend Hosted Request](https://github.com/renovatebot/renovate/discussions/new?category=mend-hosted-request). It gives more runner memory and time and 2 concurrent jobs. The schedule stays every 4 hours ✅.
- [ ] Optional, for faster merges:
  1. Add a branch ruleset on `main` that requires the CI checks.
  2. Turn on *Allow auto-merge*.
  3. Set `platformAutomerge` to `true` in `renovate.json`.

  GitHub then merges the moment CI passes. Don't flip `platformAutomerge` without the ruleset, or GitHub may merge before tests finish ✅ ([docs](https://docs.renovatebot.com/configuration-options/#platformautomerge)).
- The `security` and `p0` labels are created the first time they're needed.

### Update signing key

Installed copies on Windows and the AppImage install an update only when its manifest is signed with this Ed25519 key (ARCHITECTURE.md §14.4). Until the key exists, every copy only says a new version is out. Make it once, on a machine you trust:

1. **Create the environment.** *Settings → Environments → New environment*, named `release`.
   - Under *Deployment protection rules*, tick **Required reviewers** and add yourself.
   - Under *Deployment branches and tags*, choose **Selected branches and tags** and add the tag rule `v*`.
   - Do this before the next tag: a workflow that names an environment that doesn't exist creates it with no protection.
   - The code-signing certificates go in this environment too ([releasing/signing.md](releasing/signing.md)).
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

- ⚠ **Ticking the dashboard checkbox from a workflow** is how other repos trigger the Mend app, but Mend doesn't document it as an API. If it stops working, the issue still opens and Renovate still runs within about 4 hours. Tick the box by hand to go faster.
- **GitHub disables scheduled workflows** after 60 days without activity in a public repo, and delays them at busy times ✅. If *Actions* shows the watch disabled, re-enable it.
- **Electron notes don't name the Chromium bugs** they fix, and Electron doesn't rate severity. Every backport is treated as P0.
- **Bus factor:** you need two maintainers with release rights before 1.0 (risk R9).
