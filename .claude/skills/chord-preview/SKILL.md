---
name: chord-preview
description: Build a Windows test installer of Chord (anaremore/chord-browser) from any ref, or main plus a PR, on Z:, and put it in Z:\Projects\chord-builds for the owner to try.
---
# Chord preview build (Windows x64)

**When:** the owner should try a slice early, or a ref before a release. It builds an unsigned NSIS installer; it doesn't publish anything. The rules (Z: only, exit codes) are AGENTS.md's; what the installer is, is `apps/desktop/electron-builder.config.ts` (`nsis`, artifact `Chord-<version>-win-x64-setup.exe` in apps/desktop/release).

**Inputs:** `REF` (a commit, tag or `origin/<branch>`), optionally `MERGE` (a second branch, for "main plus a PR"), and a short `LABEL` for the file name (`m2e-1`, `main+stale-refs`).

Run in Git Bash, from the main checkout (Z:\Projects\chord-browser), one block at a time, reading each exit code:

```sh
git fetch origin
SHA=$(git rev-parse --short=7 "$REF")
WT=/z/Projects/chord-browser-wt/build-$SHA
git worktree add --detach "$WT" "$REF"            # a detached worktree: no branch to clean up
cd "$WT"
# Optional, main plus a PR: stop and report a conflict, never resolve it here.
git merge --no-edit "$MERGE" || { git merge --abort; echo "merge conflict: not built"; }
SHA=$(git rev-parse --short=7 HEAD)                 # the merge's, when there was one

mkdir -p /z/Projects/chord-builds/logs
LOG=/z/Projects/chord-builds/logs/build-$SHA.log
unset ELECTRON_RUN_AS_NODE                          # set by editors and agent shells: Electron would start as Node
export ELECTRON_CACHE='Z:\caches\electron' ELECTRON_BUILDER_CACHE='Z:\caches\electron-builder'
pnpm install --frozen-lockfile > "$LOG" 2>&1; echo "install exit=$?"
pnpm --filter @chord/desktop package --win --x64 >> "$LOG" 2>&1; echo "package exit=$?"
```

**A slice behind a release flag:** to let the owner try the assistant clicking and typing (S18 M2e) before `ASSISTANT_ACTING_RELEASED` is on, run `export CHORD_PREVIEW_ACTING=1` before the package step (Settings → Assistant then shows *Acting on pages*), and add `-acting` to `LABEL`. Only previews set it; the release workflow never does (assistant-preview.test.ts).

Both exit codes must be 0. On anything else, read the end of `$LOG` (`tail -40 "$LOG"`, after the run, never a pipe on the build itself), report it, and skip the copy. The build takes several minutes: run it in the background and wait for it.

**Copy only a real installer** (exit 0, and over 50 MB; a Chord installer is about 139 MB):

```sh
VER=$(node -p "require('./apps/desktop/package.json').version")
EXE=$(ls apps/desktop/release/*-win-x64-setup.exe)
SIZE=$(stat -c %s "$EXE")
[ "$SIZE" -gt 52428800 ] || echo "too small ($SIZE bytes): not copied"
OUT=/z/Projects/chord-builds/Chord-$VER-$LABEL-preview-$SHA-$(date +%Y%m%d-%H%M).exe
cp "$EXE" "$OUT"
```

**Clean up:** keep the newest 10 previews and their logs, then remove the worktree (it holds about 2 GB of `node_modules` and build output):

```sh
ls -t /z/Projects/chord-builds/*-preview-*.exe | tail -n +11 | while read -r f; do rm -- "$f"; done
ls -t /z/Projects/chord-builds/logs/build-*.log | tail -n +11 | while read -r f; do rm -- "$f"; done
cd /z/Projects/chord-browser && git worktree remove --force "$WT"
```

Never remove anything else in Z:\Projects\chord-builds (a release draft's folder lives there too).

**On CI instead** (when Z: is busy, or for another platform): `gh workflow run release.yml --ref <branch> -f platform=win-x64`
(or `mac-arm64`, `linux-x64`, …) builds that one installer, unsigned, as an artifact of the run; a tag always builds all six.

**Report:** the installer's full Windows path (`Z:\Projects\chord-builds\…`), its size, the ref (and the merged branch) with the SHA, and that it's unsigned (Windows SmartScreen asks once).
