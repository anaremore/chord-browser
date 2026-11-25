---
name: chord-release
description: Cut a Chord (anaremore/chord-browser) patch or minor release, from the release commit through tag, the owner's approval and publish, the site's download links, and the notes back on main; including a patch cut from the last tag while main has unreleased work.
---
# Chord release (patch or minor)

**The procedure is `docs/releasing/patch-runbook.md`** (§5 tag, §6 the workflow, §7 smoke test, §8 publish, §9 notes, §10–11 when it goes wrong). This is the order to run it in, and what 0.14.1 (2026-11-24) added. Releases come only from CI, from a `vA.B.C` tag.

**The owner's steps, never an agent's:** saying a release goes out, approving the `release` environment, and publishing the draft. Ask with what's ready and what was checked; wait for the answer.

## 1. Where the release commit goes

- **A minor (A.B.0), or a patch when main has nothing unreleased:** the release commit goes to `main` through a PR.
- **A patch while main has unreleased work** (0.14.1: main had agents acting, which ships only in the next minor): cut a branch from the last tag, in its own worktree on Z:, and cherry-pick only the fix. Here `vA.B.C` is the last release's tag (`v0.14.0`) and `A.B.x` its branch's version (so 0.14.1 came from v0.14.0 on the branch release/0.14.x):

  ```sh
  git fetch origin --tags
  git worktree add -b release/A.B.x /z/Projects/chord-browser-wt/release-A-B-x vA.B.C
  cd /z/Projects/chord-browser-wt/release-A-B-x
  git cherry-pick -x <fix-sha>          # a conflict: keep the release's side unless the fix needs the line
  ```

  Keep `release/<A.B>.x` and its worktree for further patches until the next minor ships.

## 2. The release commit (runbook §5)

One commit, `chore(release): vA.B.C`, with everything the tag needs. `pnpm release:prep A.B.C --kind security` (or
`preview`; `--lists` refreshes the ad-blocking lists) makes the first three edits and refuses a version that isn't
newer; then write the notes entry over its placeholder. `node scripts/release-prep.mjs --check A.B.C` says whether
it's complete; `.github/workflows/release.yml` runs the same check on the tag before it builds anything.
- `version` in `apps/desktop/package.json`;
- a `<release>` line at the top of `<releases>` in `flatpak/io.github.anaremore.chord-browser.metainfo.xml`;
- the entry at the top of `RELEASE_NOTES.md` (append-only; a security release names the Electron and Chromium versions: runbook §9);
- for a minor with a major feature: the site's copy and the README's and site's screenshots (`site/README.md`, *With each release*; `node scripts/dev/shots.mjs`). Skip `pnpm --filter @chord/desktop lists` on a security patch.

Typecheck and the unit tests pass locally (AGENTS.md: read the exit codes).

## 3. Every platform green on that commit

- **On a release branch:** `git push origin release/<A.B>.x`, then `gh workflow run ci.yml --ref release/<A.B>.x` (a dispatched run is the full tier: every OS, arm64 and Chord Player). Check: `gh run list --workflow ci.yml --branch release/<A.B>.x`.
- **On main:** the last full run on that commit: the nightly, or `gh workflow run ci.yml --ref main` (a pull request's `ready` run is the merge tier, only some platforms), and no open *Nightly full tier failed on main* issue. The release commit merges like any PR: `ready`, then `gh pr merge <n> --merge` on `E2E` success.

Not green: fix it, or rerun the failed jobs once to rule out a flake. Never tag a red commit.

## 4. Tag only

```sh
git tag -a vA.B.C -m "Chord A.B.C" <release-commit-sha>
git push origin vA.B.C                 # the tag alone: never push the branch with it by habit
```

Never move a tag or reuse a version; a wrong tag means the next patch number (runbook §5). The tag must match `apps/desktop/package.json`, or `.github/workflows/release.yml` stops.

## 5. The owner approves, CI builds the draft (runbook §6)

The release run waits on the `release` environment (twice: builds, then the draft). Tell the owner the run's link. It builds and smoke-tests six installers and uploads a draft pre-release with `SHA256SUMS.txt`.

## 6. Check the draft, then the owner publishes (runbook §7–8)

- Download the draft's files and verify them: `sha256sum -c SHA256SUMS.txt` (at least the Windows installer, from Z:, never C:).
- The owner installs it over the previous version on Windows, and publishes (the same prerelease flag as the last release unless they say otherwise).

## 7. After publishing

- `.github/workflows/site-downloads.yml` runs on publish and points chordbrowser.com at the release. Check it finished, then that the site serves the new version: `curl -sI https://chordbrowser.com/download/win-x64` gives a `location` ending in `/vA.B.C/Chord-A.B.C-win-x64-setup.exe` (the redirects live in `site/downloads.conf`).
- **Notes back on main** (a release branch only): a docs-only PR that adds the release's `RELEASE_NOTES.md` entry and its metainfo `<release>` line. Main's `package.json` keeps its version until the next minor.
- Post the release link where it was asked for (the P0 issue for a security release).
