# Flatpak and Flathub

Chord's Flatpak builds from source with no network during the build, on `org.electronjs.Electron2.BaseApp` (ARCHITECTURE.md [§15.1](../../ARCHITECTURE.md#151-targets)). The files are in [`flatpak/`](../../flatpak).

**Status (2026-10-23):** the from-source build works; see [what was verified](#verified-on-2026-10-23). Chord is **not on Flathub**, and nothing has been submitted. Submitting takes the maintainer's own accounts and, under Flathub's rules, a manifest written by a person.

✅ = verified against Flathub's docs or a real build on 2026-10-23. ⚠ = unverified.

## Flathub's rules on AI

Read this before anything else. Flathub's [requirements](https://docs.flathub.org/docs/for-app-authors/requirements) have a Generative AI policy ✅:

> Flathub manifests must not contain AI-generated or AI-assisted content. Disclosure does not exempt manifests from this restriction.

> AI tools or agents must not open or automate Flathub submission pull requests, or generate their commit messages, descriptions, review comments, or replies.

> Submitters must disclose any AI-generated code, documentation, packaging, or other material they know or reasonably believe is included in the application or its Flathub packaging.

What that means for Chord:
- **The manifest in `flatpak/` was written with an AI agent, so it can't be submitted, or copied into the one that is.** It exists to prove the build and to build test bundles. The maintainer writes the Flathub manifest by hand. Facts learned from this one (which base, which flags, which permissions and why) are research, which the policy allows.
- **`generated-sources.json`** is the output of `flatpak-node-generator`, a Flathub tool, not of an AI. ⚠ Confirm with the reviewers that a generated sources file counts as tool output.
- **The `.desktop` and metainfo files** are part of the application (Flathub wants them upstream), so they fall under disclosure, as does Chord's code, which is largely written with AI agents. **Reviewers may reject a submission because of how much is AI-generated**, at their discretion. That's a real risk to the Flathub plan; the apt and dnf repositories ([linux-repos.md](linux-repos.md)) don't depend on it.
- **A person** opens the pull request, writes its description and answers every review comment. Don't ask an AI agent to review it.

## The app ID

The ID is in every file name here and is hard to change later: Flathub accepts renames "on a conservative basis", by resubmitting ✅. Decide before submitting.

Flathub's rules ✅: at least 3 and at most 5 components; only `[A-Za-z0-9_]`, with `-` allowed in the last component only; it must exactly match the metainfo `<id>`. GitHub-hosted IDs use `io.github.<user>.<repo>` with at least 4 components, and the repository URL is the last component **as is**. A domain ID needs a domain the project controls and that answers over HTTPS.

| | **A. `io.github.anaremore.chord-browser`** (the files use this) | **B. `com.chordbrowser.Chord`** |
|---|---|---|
| Valid? | Yes: 4 components; the dash is in the last one; it maps to `https://github.com/anaremore/chord-browser`. (`chord_browser` would map to a repository that doesn't exist.) | Yes, if the project controls `chordbrowser.com` |
| Verification | Sign in to Flathub with the GitHub account that owns the repository ✅ | A token at `https://chordbrowser.com/.well-known/org.flathub.VerifiedApps.txt`, or a DNS TXT record at `_flathub.chordbrowser.com` ✅ |
| Matches the other platforms | No. Everything else uses `com.chordbrowser.Chord` (§15.0): the deb's `.desktop` file, the Wayland app ID, the Windows AppUserModelID, the macOS bundle ID | Yes |
| If the repository moves to an organization | The ID no longer matches its repository | Unaffected |
| What it needs first | Nothing | A page on `chordbrowser.com` over HTTPS. On 2026-10-23 the domain was registered (2026-10-22, at Cloudflare, owner redacted) but had no website or address records |

**Recommendation: B, if `chordbrowser.com` is yours.** It matches every other platform, it's verified with one DNS record on Cloudflare, and it survives a move to a GitHub organization. The registration date (the same day ARCHITECTURE.md chose the ID) suggests it is. It needs a one-page site over HTTPS first; Cloudflare Pages is free, and the domain's DNS is already at Cloudflare. **Otherwise A**, which works today.

To switch the files to B: rename the three `io.github.anaremore.chord-browser.*` files to `com.chordbrowser.Chord.*`, and replace the ID inside them (the manifest, the `.desktop` file's `Icon=` and `StartupWMClass=`, the metainfo's `<id>`, `<launchable>` and `<developer id="com.chordbrowser">`), and in `in-container.sh`, this doc, the README and the runbook. Nothing in Chord's code changes: the build sets the desktop file name from `FLATPAK_ID`.

## What's in `flatpak/`

| File | What it is |
|---|---|
| `io.github.anaremore.chord-browser.yml` | The manifest (not for submission, see above) |
| `io.github.anaremore.chord-browser.metainfo.xml` | AppStream metadata: description, license, links, branding colors, releases |
| `io.github.anaremore.chord-browser.desktop` | The launcher, with the MIME types that let desktops offer Chord as the default browser |
| `build.sh` | Builds the Flatpak in a throwaway Fedora container (Docker or Podman); `--test` also lints it and runs the packaged smoke test against it |
| `in-container.sh` | The container half of `build.sh` |

`generated-sources.json` is written next to the manifest by `build.sh`, and isn't committed: it changes whenever `pnpm-lock.yaml` does.

## How the build works

- **Runtime:** `org.freedesktop.Platform` 26.08, the newest on Flathub on 2026-10-23 ✅ (Flathub requires the latest at submission). **Base:** `org.electronjs.Electron2.BaseApp` 26.08, which brings zypak, libsecret and Electron's other runtime libraries ✅. **SDK extension:** `org.freedesktop.Sdk.Extension.node24` (Chord needs Node 24 for `node:sqlite`).
- **Offline dependencies:** [`flatpak-node-generator`](https://github.com/flatpak/flatpak-builder-tools/tree/master/node) (pinned commit `3d6ff66`, 2026-10-22) reads `pnpm-lock.yaml` and lists every package tarball, plus Electron's Linux zips for x64 and arm64. At build time it fills a pnpm 10 store and points `.npmrc` at it ✅. `--no-playwright-browsers` skips the browsers `@playwright/test` would otherwise pull in. pnpm itself comes from the npm registry tarball (10.33.0, matching `packageManager`).
- **Build:** `pnpm install --offline --frozen-lockfile` (its `postinstall` unpacks Electron from the offline cache), `electron-vite build`, then `electron-builder --linux dir` with:
  - `electronDist` pointing at that Electron, so nothing downloads;
  - `extraMetadata.desktopName` set to `$FLATPAK_ID.desktop`, because Electron uses it as the Wayland app ID and X11 class, and desktops match windows to the `.desktop` file by it.

  The fuses are set exactly as in the other builds (§14.1). The unpacked app goes to `/app/chord`, minus `chrome-sandbox`.
- **Launcher** (`/app/bin/chord`): `zypak-wrapper /app/chord/chord`. zypak runs Chromium's sandboxed processes in Flatpak's own sub-sandbox, since Chromium's sandbox can't nest inside Flatpak's; Chord's sandbox stays on (§14.1). It also points `TMPDIR` at `$XDG_RUNTIME_DIR/app/$FLATPAK_ID`, which every instance of the app shares, so a second launch finds the running Chord and hands it the link instead of opening the profile twice.
- **Licenses:** `LICENSE` (MIT), `GPL-3.0.txt`, `MPL-2.0.txt` and `Apache-2.0.txt` (pdf.js, Duet's PDF reader) go to `/app/share/licenses/`, and the app carries them in `resources/licenses` too. The metainfo says `GPL-3.0-only`, since the build includes the GPL-3.0-only extensions library (§16, D1).

**Permissions** (Flathub wants them minimal, with portals wherever one exists ✅):

| Permission | Why |
|---|---|
| `--share=network`, `--share=ipc` | It's a browser; IPC for X11 shared memory |
| `--socket=wayland`, `--socket=fallback-x11` | Wayland where available (Electron 45's default), X11 otherwise |
| `--socket=pulseaudio` | Sound, and microphones for sites you allow |
| `--device=all` | GPU, cameras, and security keys for WebAuthn (`/dev/hidraw*`). Flathub's Chromium does the same ✅ |
| `--filesystem=xdg-download` | Downloads save to `~/Downloads`. Other files go through the file-chooser portal |
| `--talk-name=org.freedesktop.Notifications` | Web notifications |
| `--talk-name=org.freedesktop.FileManager1` | "Show in folder" for downloads |
| `--talk-name=org.freedesktop.ScreenSaver` | Keeping the screen awake during video |
| `--talk-name=org.freedesktop.secrets`, `org.kde.kwalletd5`, `org.kde.kwalletd6` | Cookie encryption keeps its key in the desktop's keyring (§14.1). Without it, Chromium falls back to a fixed key |
| `--own-name=org.mpris.MediaPlayer2.chromium.*` | Media keys and the desktop's now-playing controls |

Screen sharing and file pickers use portals and need no permission.

## Build it yourself

On Linux, with Docker or Podman (nothing else to install):
```sh
flatpak/build.sh           # → apps/desktop/release/flatpak/Chord-<version>-linux-<arch>.flatpak
flatpak/build.sh --test    # also desktop-file-validate, appstreamcli, Flathub's linter, and test:packaged
flatpak install --user apps/desktop/release/flatpak/Chord-*.flatpak
flatpak run io.github.anaremore.chord-browser
```
The first run downloads the runtimes, every npm tarball and Electron's zips; a named volume (`chord-flatpak-cache`, about 5 GB with `--test`) keeps them for the next run.

Without a container, on a machine with `flatpak` and `flatpak-builder`:
```sh
pipx install "git+https://github.com/flatpak/flatpak-builder-tools.git@3d6ff6697785b52ae34db8078e0ad5188a710b1f#subdirectory=node"
flatpak-node-generator pnpm pnpm-lock.yaml --no-playwright-browsers -o flatpak/generated-sources.json
cd flatpak
flatpak-builder --user --install-deps-from=flathub --force-clean --install build-dir io.github.anaremore.chord-browser.yml
flatpak run io.github.anaremore.chord-browser
```

## Verified on 2026-10-23

`flatpak/build.sh --test`, on the maintainer's PC in WSL2 (Ubuntu 22.04, Docker 29), in a Fedora 44 container with flatpak 1.18.4. x86_64 only.

- **Built from source with no network** ✅: `pnpm install --offline` filled `node_modules` from the generated store (566 packages, 10 s), then `electron-vite build`, then `electron-builder --linux dir` on the offline Electron 45.0.0. The bundle is 90 MB; installed, 297 MB.
- **Inside the app** ✅: `app.asar`'s `desktopName` is `io.github.anaremore.chord-browser.desktop`. The fuses read back exactly as §14.1 lists. There's no `xdg-settings` in the sandbox, which is why Settings sends you to the system's settings.
- **Validators** ✅: `desktop-file-validate` reported nothing, and `appstreamcli validate` passed. Flathub's `flatpak-builder-lint manifest` reported nothing. `flatpak-builder-lint repo` reported two errors, both because there are no screenshots yet (`metainfo-missing-screenshots`, `appstream-screenshots-not-mirrored-in-ostree`); the submission has to add them.
- **It runs** ✅: the packaged smoke test (`test:packaged`) ran against the installed Flatpak through `flatpak run`, with zypak and Flatpak's portal starting Chromium's sandboxed processes. Under Xvfb (X11), both tests passed:
  - it browses a page, opens Settings, and restores the tabs and a setting after a relaunch, so `node:sqlite` works in the chord-data utility process;
  - a link given at launch opens, and a second `flatpak run` hands its link to the running Chord and exits.

  The same two passed again on Wayland, under headless Weston with no X display.
- **Time:** about 20 minutes with nothing cached, most of it downloading the runtimes, the 575 sources and the test's npm packages. With the cache, the whole `--test` run took 5.5 minutes: about 3 to build and bundle, and under 1 for the checks and both smoke tests.

**Not verified:**
- aarch64: the generated sources include arm64 Electron, but nothing was built on ARM.
- A real desktop session: the dock icon and window matching, the default-apps list, the keyring, notifications, the file-chooser and screen-sharing portals, and GPU acceleration. The container has none of those; check them on the Linux VM with the bundle.

## How the Flatpak differs

- **Default browser:** an app inside Flatpak can neither see nor change the system's default browser; no portal does that. So in a Flatpak (`FLATPAK_ID` is set), Settings has no *Make default* button. It says to choose Chord in the system's settings, and first run skips that step (`src/main/default-browser.ts`). The `.desktop` file's MIME types put Chord in the system's list: *Settings → Apps → Default Apps* (GNOME) or *System Settings → Default Applications* (KDE). The metainfo says so too.
- **Password managers' desktop apps** (1Password, Bitwarden) can't reach Chord's extensions: native messaging needs host programs the sandbox can't run. The extensions themselves work.
- **Updates come from Flathub.** Chord's notify-only update check still asks GitHub, so it can announce a version a few hours before Flathub has built it.
- **Your profile** is in `~/.var/app/io.github.anaremore.chord-browser/config/Chord`.

## Submitting to Flathub

All by hand, by the maintainer ([AI rules](#flathubs-rules-on-ai)). Flathub's own guide: [submission](https://docs.flathub.org/docs/for-app-authors/submission).

**Before:**
1. **Decide the app ID** ([above](#the-app-id)). For B, publish a page on `chordbrowser.com` over HTTPS first.
2. **Screenshots.** Add two or three to the metainfo (`<screenshots>`, with a caption each). They must be stable URLs, such as files committed under `docs/screenshots/` and linked at a release tag (`https://raw.githubusercontent.com/anaremore/chord-browser/v0.1.0/docs/screenshots/…`). Follow Flathub's [quality guidelines](https://docs.flathub.org/docs/for-app-authors/metainfo-guidelines/quality-guidelines): the window only, default settings, no shadows.
3. **A release tag** whose metainfo has that version in `<releases>`. The submission builds from the tag.
4. **Write the manifest yourself**, named `<app-id>.yml`. It builds from `type: git` with `url: https://github.com/anaremore/chord-browser.git`, the `tag`, and its `commit`, not from a local directory. Adding `x-checker-data` (`type: git`, `tag-pattern: ^v([\d.]+)$`) lets Flathub's checker open an update PR for each new tag.
5. **Generate the sources** from that tag's lockfile:
   ```sh
   git -C chord-browser checkout vX.Y.Z
   flatpak-node-generator pnpm chord-browser/pnpm-lock.yaml --no-playwright-browsers -o generated-sources.json
   ```
6. **Build and lint with Flathub's tools** ✅:
   ```sh
   flatpak install -y flathub org.flatpak.Builder
   flatpak run --command=flathub-build org.flatpak.Builder --install <app-id>.yml
   flatpak run <app-id>
   flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest <app-id>.yml
   flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo
   ```
   Every linter error needs a fix or, with a reason, an exception from the reviewers. Expect them to ask about `--device=all` and the keyring and MPRIS names; the reasons are in the permissions table above.

**Submit** ✅:
1. Fork [flathub/flathub](https://github.com/flathub/flathub) with **"Copy the master branch only" unticked**.
2. `git clone --branch=new-pr git@github.com:<you>/flathub.git && cd flathub && git checkout -b add-chord new-pr`
3. Add only `<app-id>.yml` and `generated-sources.json` (no source code, no builds). Commit and push.
4. Open the PR **against `new-pr`** (not `master`), titled `Add <app-id>`. In the description, write the AI disclosure yourself: which parts of Chord and its packaging were AI-generated, and roughly how much.
5. Answer the review yourself. When it's done, comment `bot, build` for a test build.
6. After the merge: accept the invitation to `flathub/<app-id>` within a week (GitHub 2FA required). The app publishes 1–2 hours after the merge.
7. **Verify** the app in Flathub's developer portal: *Your app → Verification*, with the GitHub login (A) or the domain token or DNS record (B).
8. Add the Flathub install line to the README, and mark it live in ARCHITECTURE.md §15.1 and ROADMAP.md Phase 3.

## Each release

Once Chord is on Flathub, every release (security releases within the [72 hours](patch-runbook.md#8-publish)) also needs, by hand:
1. In `flathub/<app-id>`: update the git source's `tag` and `commit` (or merge the checker's PR).
2. If `pnpm-lock.yaml` changed since the last release, regenerate `generated-sources.json` from the new tag.
3. Open the PR, wait for its test build, and merge. Flathub publishes 1–2 hours later ✅.

The `<release>` line in the metainfo is added in Chord's repository before tagging ([runbook §5](patch-runbook.md#5-tag-the-release)).
