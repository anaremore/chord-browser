# Testing Chord on a Mac

Chord is built and tested mostly on Windows, with macOS covered by CI runners. This guide is for a real Mac: building from source, running the suites, and checking by hand what automation can't see. Read README.md, then skim ARCHITECTURE.md, DESIGN.md and ROADMAP.md for what Chord is and how it's put together.

## House rules

- **No native modal dialogs** (message boxes, confirm boxes) anywhere in Chord. Use in-app UI and undo toasts.
- **Every Electron process you start** must install `uncaughtException` and `unhandledRejection` handlers that exit, so no error box ever appears. Chord's own main process already logs these instead of showing a box, and E2E fails on them.
- **Screenshots of Chord only:** `page.screenshot` from Playwright, or `screencapture -l <window id>` of a Chord window. Never capture the whole screen or other apps.
- **Never push to `main`.** Push branches named `mac/<topic>`; the maintainer merges them.
- **No personal email addresses** in any file.
- **Commits end with** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Setup (once)

```sh
xcode-select --install                  # Command Line Tools (git, compilers)
brew install node@24 gh                 # or Node 24 from nodejs.org; gh is optional
brew link --overwrite --force node@24   # node@24 is keg-only, so this puts node on your PATH
corepack enable && corepack prepare pnpm@10.33.0 --activate
git clone https://github.com/anaremore/chord-browser.git ~/Projects/chord-browser
cd ~/Projects/chord-browser && pnpm install
```

## Automated checks

Keep the Mac awake and unlocked, and leave it alone while the E2E suites run: they open real Chord windows.

```sh
pnpm typecheck && pnpm lint && pnpm test          # types, lint, unit tests
pnpm --filter @chord/desktop build
pnpm --filter @chord/desktop test:e2e             # dev-build E2E (every spec in test/e2e)
pnpm --filter @chord/desktop package:dir          # an unsigned Chord.app in apps/desktop/release/mac*/
pnpm --filter @chord/desktop test:packaged        # the packaged smoke tests
```

Each step must exit 0. If something fails, keep the failure details from `apps/desktop/test-results/`. When a failure is macOS-only, fix the root cause on a `mac/fix-<topic>` branch, with a test, rather than skipping it.

To run Chord yourself from source: `pnpm --filter @chord/desktop dev`. Use `--user-data-dir=<folder>` on a packaged app to keep a test profile separate. A brand-new profile starts with first-run onboarding; `--no-first-run` skips it.

## By hand

Use the packaged app: either `apps/desktop/release/mac-arm64/Chord.app`, or the `chord-mac-arm64` artifact from the latest **Release** run in GitHub Actions, which is the real install path. Mark each item pass or fail, with a note and a screenshot of Chord's window where it helps.

1. **Install:**
   - Open the `.dmg` from the artifact and drag Chord to Applications.
   - On first launch, System Settings → Privacy & Security → **Open Anyway** should work.
   - Is the icon right in the Dock, Finder and ⌘Tab?
   - On macOS 26, is it shown on a gray backdrop?
2. **First run:** with a fresh profile, onboarding should take under a minute. The mark animates, the name and colors change the real sidebar live, and pinned sites land in Pinned.
3. **Keyboard.** Automation can't test these on macOS, so check them all:
   - ⌘T, ⌘L, ⌘W, ⌘⇧T, ⌘1–9, ⌘S (sidebar), ⌘F, ⌘, (Settings), ⌘⌥/ (shortcuts), ⌘N, ⌘⇧N.
   - Each should work with a web page focused, and only once.
   - With a page that handles ⌘S itself (Google Docs, for one), the page should get it.
4. **Window:**
   - Traffic lights are placed correctly.
   - Vibrancy behind the sidebar looks right.
   - Settings → Appearance: Window tint at 0%, 50% and 100%, and color scheme Light, Dark and System.
   - Resizing the sidebar and collapsing it to the minimal bar both work, as does peek from the left edge.
5. **Several windows:**
   - ⌘N opens a window, and the Window menu lists both.
   - Clicking a tab that's open in the other window moves it.
   - ⌘⇧N opens a dark private window, even when the system is in light mode.
6. **Default browser:**
   - Settings → General → **Make default**: does macOS ask to confirm?
   - A link clicked in Mail or Notes should open in Chord.
7. **Sign-ins:**
   - Sign into Google in one chord.
   - Make a second chord with "Keep sign-ins separate" and sign into another account there.
   - Each chord should keep its own account.
8. **Extensions:**
   - Install uBlock Origin Lite and a password manager (Bitwarden, 1Password or Proton Pass) from the Chrome Web Store.
   - Popups open from the sidebar shelf, the password manager signs in, and autofill works on a login page.
   - Desktop-app pairing works, if you have the app.
9. **Picture-in-picture:**
   - Play a YouTube video with sound, then switch tabs; it pops out.
   - "Back to tab" returns you to the tab.
   - ✕ pauses the video and leaves you where you are.
   - Check it over a full-screen app and across Spaces.
10. **Updates:** after installing a newer build over an older one, macOS may ask about *Chord Safe Storage* in the keychain. Always Allow should work, and your tabs should still be there.
11. **Camera, microphone and location:** allow a site's request in Chord (a Meet test call, then a map's *show my location*). macOS asks once for each, in Chord's words ("Sites you allow can…"), and the site works after you allow it.
12. **Accessibility** (DESIGN.md §10). Turn on VoiceOver (⌘F5), and keep Full Keyboard Access off unless noted:
    - **F6** from a page lands on the tab on screen in the sidebar; VoiceOver says "Today, tree" or "Pinned, tree", the tab's title, "selected", and "1 of 3"; ⇧F6 goes back.
    - In the tree: ↑ ↓ read each row, → / ← open and close a folder (VoiceOver says expanded or collapsed), Space then ↓ then Space moves a row and VoiceOver says where it went.
    - **⌘T:** VoiceOver says "New tab, dialog", then the field; ↓ reads each result as it becomes active, without leaving the field; Esc puts you back where you were.
    - **Chords:** switching (⌘2, or ← → on the switcher) is announced: "Work chord, 3 pinned, 7 today".
    - **A toast** (Clear Today): read once, on its own; ⌘Z undoes it.
    - **Settings:** each switch is read with its description; ↺ is named for its setting; radio groups are one Tab stop with arrow keys.
    - **Duet:** a reply isn't read word by word while it streams; "Duet finished answering." is; a card asking to read more is announced, and ⌘↵ in the message field allows it.
    - **System Settings → Accessibility → Display:** Reduce motion makes chord switches and the command bar appear without moving; Reduce transparency makes the sidebar solid while Chord runs, with no restart; Increase contrast leaves every text readable.

## Reporting

Write `docs/testing/reports/macos-<YYYY-MM-DD>.md`:
- the Mac model, chip and macOS version;
- each automated step's result;
- the by-hand checklist with pass or fail and notes.

Push it on `mac/qa-<YYYY-MM-DD>`. Screenshots are big, so keep them out of git: list them in the report by file name and share them in the chat.
