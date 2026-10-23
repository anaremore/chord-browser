# S7: Automatic picture-in-picture

**Result: works on Windows, as built.** Electron 45.0.0 (Chromium 156.0.8078.48) on Windows 11. Chord asks the page for picture-in-picture from an isolated world with `userGesture`. Chromium's own PiP window opens with its full set of controls, and keeps drawing the video after the tab goes off screen. macOS and Linux are covered only by the E2E test in CI, so far; see [Not verified here](#not-verified-here).

**What Chord does:** ARCHITECTURE.md §9, *Auto picture-in-picture*, and `apps/desktop/src/main/auto-pip.ts`.

## How it was measured

`spikes/s7-auto-pip/` is a Chord-shaped app: a BaseWindow, and one WebContentsView per tab, swapped the way `AppWindow.showTab` does. Its local page plays a 20-second test video made by ffmpeg (a moving test pattern with a frame counter, so captures show whether it's still being drawn). Audio is muted at the WebContents level, so nothing is heard.

- **The PiP window** is found among the process's own top-level windows.
- **Captures** use `PrintWindow`: the window draws itself, so no other app's pixels can be captured.
- **Controls** are read and pressed through MSAA (`accDoDefaultAction`). No mouse or keyboard input is sent.

Run it with `node spikes/s7-auto-pip/run.mjs [youtube]`; results land in `spikes/s7-auto-pip/results/` (gitignored).

## Results

| Question | Result |
|---|---|
| Can Chord start PiP without a click? | **Only with `userGesture`.** Without it: `NotAllowedError: Must be handling a user gesture`. With `executeJavaScriptInIsolatedWorld(world, …, userGesture = true)` it enters at once. |
| Does it work once the tab is off screen? | **Yes.** It works on a view that's already detached (document `hidden`), on a minimized window, and on a blurred one. So Chord switches tabs first and asks afterwards: the switch is never delayed. ARCHITECTURE's original plan, to keep the old view attached for up to 300 ms, isn't needed. |
| Does the video keep rendering after the view is detached? | **Yes.** `currentTime` keeps advancing, and two captures of the PiP window a second apart differ, with the frame counter moving. |
| Which controls does the PiP window have? | All of Chrome's, named in MSAA and shown on hover: **Back to tab, Close, Minimize**, the origin (e.g. `127.0.0.1:62949`), **Pause/Play, Rewind 10 seconds, Forward 10 seconds, Previous track, Next track, Time scrubber** with `0:00 / 0:20`, **Mute**, and the video-call set (Turn on camera, Mute microphone, Hang up), which only shows for calls. |
| Does *Back to tab* reach Chord? | **No event at all.** No WebContents event, and no window `focus` or `restore`. It ends PiP with the video still playing (`leavepictureinpicture`, `paused = false`). Chord recognizes it by that: PiP ended, Chord didn't end it, and the video plays on. |
| What does ✕ do? | Ends PiP, then Chromium **pauses** the video (`leavepictureinpicture` with `paused = false`, then `pause`; `media-paused` and `audio-state-changed` on the WebContents). Chord can't stop that pause through any API, so ✕ means stop, as in Chrome. The pause is also how Chord tells ✕ from *Back to tab*. |
| Returning to the tab | `document.exitPictureInPicture()` from the isolated world brings it back inline, still playing. |
| Muted video | Enters PiP like any other. Whether it should is Chord's rule (below), not Chromium's. |
| Several videos | Picking the largest *playing* one works: a small muted one and a larger paused one are skipped. |
| `disablePictureInPicture` | `InvalidStateError`. The attribute is readable from the isolated world, so Chord skips those videos up front. |
| Chromium's automatic PiP (Media Session `enterpictureinpicture`) | The page can register the action, but **Electron never fires it** when the tab is hidden: that logic lives in Chrome's browser layer. Registered Media Session actions do show in the PiP window (skip and track buttons). |
| Document Picture-in-Picture | `documentPictureInPicture` exists and `requestWindow()` **resolves**, but **no window appears** (Electron #39633). Not usable for a custom player. |
| YouTube (Big Buck Bunny, no ad) | Unmuted autoplay played. Chord's request entered PiP, the video kept playing and drawing after switching away, and exit brought it back. YouTube's own PiP button is present, and its player didn't object. |

## Chord's rules (DESIGN.md §7, ARCHITECTURE.md §9)

- **When:** switching tabs or chords, in any window. Not on minimize or switching apps; ARCHITECTURE scopes it to leaving a tab, though the spike shows it would work there.
- **Which video:** the largest one playing, at least 200×112, without `disablePictureInPicture`. It's searched through open shadow roots, and through the page's frames, so an embedded player in an article counts.
  - A **muted** video counts only if the page has made sound since it loaded, so a background loop never pops out.
  - Frames other than the main one are asked in their own main world, because Electron has no isolated world for subframes.
- **Not when:** something on the page is already in PiP (you started it yourself), another tab's video is already popped out, or the setting is off.
- **Back:** returning to the tab, or clicking the PiP glyph in its sidebar row, ends PiP. *Back to tab* in the PiP window brings the tab forward. If another video took over the PiP window, the tab isn't brought back.
- **Never slept or archived** while popped out: `live.pip` joins the busy check, as does the archive's own PiP query.

## Not verified here

- **macOS and Linux:** the E2E test (`a playing video pops out when you switch away…`) runs on every CI platform, and covers entering, the glyph, simulated *Back to tab* and ✕, and the setting. The PiP window's controls and the real buttons were checked on Windows only.
- **Wayland:** the compositor places the PiP window.
- **Protected video** (Netflix and other EME players): Chord ships no Widevine (D4), so such players don't play at all yet.
- **Sites with their own PiP button:** a page that puts its own custom player into PiP isn't tracked by Chord, so returning to the tab doesn't end it. That matches Chrome.
