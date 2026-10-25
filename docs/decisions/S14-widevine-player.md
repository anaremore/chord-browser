# Spike S14: a Widevine player

*2026-10-25 · D4 (ARCHITECTURE.md §16) · prototypes in `spikes/widevine-player/` · re-run: `node spikes/widevine-player/run-linux.mjs`, or push to `agent/widevine-spike` for Windows and macOS*

**Built 2026-10-25 as Chord Player** (`apps/player`; ARCHITECTURE.md §9, *Chord Player*). One finding since: castLabs EVS signs only ECS with its own fuses or one set castLabs accepts, so the player keeps `GrantFileProtocolExtraPrivileges` on.

**Result: go, with a window of its own (a) on every OS.** ECS installs the CDM and plays Widevine test streams on Windows, macOS and Linux, up to 4K, with picture-in-picture and fullscreen. The navigation lock holds in all 14 cases tested, and the control channel answers in well under a millisecond. The real services are a separate question: they need production VMP signing through castLabs' EVS (the maintainer's account), and some refuse Linux whatever you do.

Glueing the player over Chord's content area (b) works, with a seam per OS:
- **Windows:** it follows a real drag within 3 ms (under a frame). It has to be an *owned* window to stay above Chord and out of Alt+Tab, and clicking it makes it the foreground window.
- **macOS:** it trails during drags. Electron sends about ten `move` events a second there, and even polling Chord's window leaves the player tens of milliseconds behind. Clicking Chord puts Chord's window over the player, and clicking the video takes activation from Chord. A panel avoids both, but floats over every app.
- **Linux:** it works on X11 (as a transient window, to stay above Chord) and can't work on Wayland.

True embedding (c) works on Windows and X11 and doesn't trail, but on Windows it covers Chord's own popovers, keeps keys from the page, and can't go fullscreen. macOS and Wayland can't do it at all. The details are below.

## The question

S12 kept Chord on stock Electron, because ECS trails Chromium's security fixes by weeks. S14 asks whether those services can still play in Chord. The idea is a **small companion app on ECS**, the *Widevine player*, that opens only the services in `main/drm.ts` and hands every other link back to Chord. Two things decide it:
- Can it play the services on each OS?
- How much does it look like part of Chord, and what does that cost?

## How it was tested

- **Builds:**
  - The player: ECS v44.9.3+wvcus (Chromium 152.0.7977.167), the newest stable build.
  - A stand-in for Chord: stock Electron 45.0.0 (Chromium 156), with a sidebar and a content area like Chord's.
- **Content:** Shaka Player 5.3.2 (pinned by hash) with Shaka's Widevine demo assets and the no-auth licence proxy (`cwip-shaka-proxy.appspot.com/no_auth`):
  - *Angel One*, up to 768×576;
  - *Sintel*, up to 3840×1636, in AVC and VP9, with a key per resolution.
- **Where:**
  - Linux x64 in the E2E container (Ubuntu 24.04), on Xvfb with openbox and on headless Weston.
  - Windows (`windows-latest`, Server 2025, 1024×768 at 64 Hz) and macOS 26 on Apple silicon (`macos-26`, 1024×768) on GitHub's runners, through `.github/workflows/widevine-spike.yml` on the `agent/widevine-spike` branch.
  - Linux x64 on `ubuntu-24.04` too, as a cross-check.
  - Nothing ran on a desktop someone uses.
- **Runs:**
  - CI, four rounds, each fixing what the last one found:
    - [40153765095](https://github.com/anaremore/chord-browser/actions/runs/40153765095) and [40154169106](https://github.com/anaremore/chord-browser/actions/runs/40154169106): probes, first scenarios.
    - [40154449747](https://github.com/anaremore/chord-browser/actions/runs/40154449747): all of macOS and Linux, and Windows (b).
    - [40157063004](https://github.com/anaremore/chord-browser/actions/runs/40157063004): Windows only, real drags and (c).
  - Linux: the same runs in the E2E container, on X11 and Wayland, plus the census and a 7-minute idle run (`run-linux.mjs`).
- **What runs** (`spikes/widevine-player/run.mjs`):
  1. **The probe**, on a fresh profile, with a net log: CDM install (`components.whenReady()`), EME capabilities, playback, picture-in-picture, fullscreen, captures, memory and CPU.
  2. **The component updater off** (`--disable-component-update`), with the CDM already installed and on a fresh profile. Then a second normal launch, and on Linux one left idle for 7 minutes.
  3. **The host scenarios:** the control channel, the navigation lock, (a), (b) in several variants, and (c). On Windows and macOS, *real* drags and keys are injected by `tools/sampler.mjs` (`mouse_event`/`keybd_event`, and `CGEventPost`). The same tool reads both windows' rectangles from the OS, from outside both processes, which is how trailing is measured: in a busy loop on Windows (`GetWindowRect`) and X11 (`XTranslateCoordinates`), and about 450 times a second on macOS (`CGWindowListCopyWindowInfo`).
  4. **The census** (`census/main.mjs`, stock Electron): each service's home page, its own *Sign in* button, and its sign-in page, with every main-frame request, redirect, frame and popup recorded. It ran from the maintainer's network, without an account.
- **Limits:**
  - Runners and the container are VMs without a GPU or a real display, and HDCP can't be checked on them.
  - No real service was played: that needs accounts.
  - Captures are the spike's own windows only: `capturePage`, or `PrintWindow` on the stand-in's own handle.

## 1. Playback

ECS installs the CDM in under 2 seconds and plays every test stream on all three OSes, in software (L3).

| | Windows x64 | macOS arm64 | Linux x64 |
|---|---|---|---|
| CDM install (`components.whenReady()`) | 0.5 s, Widevine 4.10.3112.0, 23.0 MB | 1.9 s, same version, 20.4 MB | 0.6–0.8 s, same version, 22.0 MB |
| Robustness offered (AVC, VP9, AV1) | `SW_SECURE_CRYPTO`, `SW_SECURE_DECODE` | same | same |
| `HW_SECURE_*` | no | no | no |
| HEVC | no | no | no |
| Persistent licences | no | no | no |
| `cbcs` | yes | yes | yes |
| HDCP (`getStatusForPolicy`, 1.0 to 2.3) | `output-restricted` | `output-restricted` | `output-restricted` |
| Angel One, 768×576 | plays, first frame 1.2 s, 0 dropped | plays, 1.5 s, 0 dropped | plays, 1.1–1.3 s, 0 dropped |
| Sintel 1080p, AVC and VP9 | plays at 1921×818, 0 dropped | plays, 0 dropped | plays, 0 dropped |
| Sintel 4K (3840×1636), AVC and VP9 | plays, 0 dropped | plays, 4 of 156 dropped (AVC) | plays, 1 of 155 dropped (AVC) |
| Video in `capturePage` | yes (not blanked) | yes | yes |
| Picture-in-picture | works: 284×213, keeps playing | works | works |
| Fullscreen from the page | fills the display | fills the display (its own Space) | fills the display |

- **The playback session was `SW_SECURE_DECODE` everywhere.** The CDM decrypts *and* decodes in software, in its own utility process (`media.mojom.CdmServiceBroker`), which is where most of the CPU goes (§8). Chromium itself says hardware security isn't supported with the Widevine key system on Windows ([source](https://chromium.googlesource.com/chromium/src/+/main/components/cdm/renderer/widevine_key_system_info.cc)).
- **Resolution is the licence server's choice, not the CDM's.** The test proxy hands out every key to an L3 client, so 4K plays. Real services decide by robustness, platform and VMP status: at L3, browsers typically get 720p or 1080p. Netflix's help page lists Chrome at 1080p on macOS and Linux. It lists Chrome on Windows "up to Ultra HD" on computers that meet its Ultra HD requirements, presumably through hardware DRM, which ECS doesn't offer (no `HW_SECURE_*`, no `com.widevine.alpha.experiment`); expect 1080p at best in the player ([help](https://help.netflix.com/en/node/23742), fetched 2026-10-25).
- **`output-restricted` for every HDCP version** is probably the VMs' missing display link. On real hardware Chrome reports what the monitor supports; unverified here.
- **Captures show the video** ([`docs/images/s14/sintel-1080-capture-linux.png`](../images/s14/sintel-1080-capture-linux.png); the middle of the 1080p capture averages 133–140 of 255 on every OS). L3 doesn't blank screenshots, so Chord could even show a frame of it.

### What development-signed builds allow, and which services refuse

castLabs: "The provided builds are VMP-signed for development", which works with "Widevine UAT or servers accepting development clients", and "for production use you can sign up for our EVS service" ([README](https://github.com/castlabs/electron-releases), [VMP wiki](https://github.com/castlabs/electron-releases/wiki/VMP)). In the wiki's words, an unverified platform means "production streaming services will typically not work" on Windows and macOS. Linux has no VMP at all: "Widevine does not support VMP on Linux, *at all*" ([castLabs, issue 199](https://github.com/castlabs/electron-releases/issues/199)).

| Service | ECS without production VMP (Windows, macOS) | Linux |
|---|---|---|
| Netflix | **Refuses** (M7121-1331 in [#33](https://github.com/castlabs/electron-releases/issues/33); E100 in [#199](https://github.com/castlabs/electron-releases/issues/199), April 2025). Works once EVS-signed ([#224](https://github.com/castlabs/electron-releases/issues/224), March 2026). | Its help page lists Linux browsers at 1080p but "can't guarantee" Linux ([help](https://help.netflix.com/en/node/23742)); older sources say 720p. |
| Spotify | **Refuses** (licence calls fail with 500/403 in [#56](https://github.com/castlabs/electron-releases/issues/56), 2020, and a 403 in #199, 2025). | Desktop browsers, any OS ([help](https://support.spotify.com/us/article/web-player-help/)). |
| Disney+ | No ECS report found; error 83 is a platform-verification failure ([2019](https://itsfoss.com/disney-plus-linux/)). | Plays, at reduced resolution. |
| Prime Video | Named as failing in development mode (#33, 2019). | **SD only** for "an operating system other than Windows or macOS" ([Amazon](https://www.primevideo.com/help?nodeId=GUX9FYHU5D8LC9EJ)). |
| HBO Max, Hulu, Peacock, Paramount+ | No ECS report found; all four are in [StreamDock](https://github.com/jtvberg/StreamDock), an EVS-signed ECS app. | Not listed as supported (HBO Max, Peacock: Windows and Mac only); Paramount+ unknown. |
| Apple Music, Apple TV | No report found. | Not documented. |
| Tidal | No Windows or macOS report found. | Plays in [tidal-hifi](https://github.com/Mastermindzh/tidal-hifi), an ECS wrapper for Linux. |

So: **without EVS, assume none of them play on Windows or macOS.** With EVS, the evidence is good for Netflix, Disney+, HBO Max, Hulu, Peacock, Paramount+, Prime Video and Apple TV (StreamDock). On Linux, expect Netflix, Spotify, Disney+ and Tidal, Prime Video in SD, and the rest uncertain. Linux arm64 has a CDM since ECS 44.9.3 ("now that the Widevine is officially available for the platform"); untested here.

## 2. Seamlessness

The stand-in is a 900×600 window. The player covers its content area (232 px in from the left, 8 px in from the other edges), plays Angel One, and is moved three ways: a real drag of the stand-in's own drag region (Windows, macOS), 100 `setPosition` steps of 16 ms, and 60 `setSize` steps. **Trailing** is time during which the player's rectangle, as the OS reports it, is not where it should be relative to the stand-in's. The sampler reads both rectangles one after the other, so episodes under about 1 ms are its own noise.

### (a) A window of its own

The player opens its own frameless window: a 40 px bar in the chord's colors (service, *Back to Chord*, close) above the service. It was captured on all three OSes; Windows: [`docs/images/s14/a-frameless-windows.png`](../images/s14/a-frameless-windows.png).

- **Works everywhere, Wayland included.** It's an ordinary window, so moving, resizing, fullscreen, Spaces and picture-in-picture are the OS's and Chromium's own.
- **Windows:** an ordinary window, in Alt+Tab, with a taskbar button of its own unless it shares Chord's.
  - Given Chord's AppUserModelID (`app.setAppUserModelId`), it joins Chord's taskbar button. Measured through UI Automation on the taskbar: one button, *2 running windows*, for the stand-in and the player together.
  - That's the closest (a) gets to being part of Chord on Windows.
- **macOS:** it's a second app: its own Dock icon and Cmd-Tab entry, as *Electron* until it's packaged. As an accessory app (`LSUIElement`, or `setActivationPolicy('accessory')` as measured) it leaves the Dock and Cmd-Tab. Then Mission Control is the only way back to it except through Chord, which is wrong for a window you watch in.
- **Linux:** a separate window; on X11 it can share Chord's `WM_CLASS` so the dock groups them, and on Wayland its `app_id` (both inferred, not measured).

### (b) Glued over Chord's content area

The player is a borderless window with no taskbar entry (`skipTaskbar`). The host tells it its content area's rectangle over the control channel on every `move`, `resize`, `minimize`, `restore`, `hide` and `show`, and asks it to `moveAbove` the host when the host is focused. Two alternatives were measured: `will-move`, which gives the new bounds before the move, and polling, where the player reads the host's rectangle from the OS every 8 ms (`shared/follow.mjs`).

| (b), measured | Windows | macOS | Linux X11 (openbox) |
|---|---|---|---|
| Real drag | **Under a frame.** `move` events come throughout the drag (234 for the stand-in's 116 moves). The player was off 8 % of the drag, in episodes of median 0.8 ms and at most 2.6 ms, by up to 8 px. Owned: the same (9 %, at most 2.2 ms). `will-move` (30 %, at most 11 ms) and polling (43 %, at most 16 ms) are worse. *The runners drag outlines by default ("Show window contents while dragging" off); the sampler turned it on for these drags.* | **Trails throughout.** Electron sends about 10 `move` events a second during a drag (9–11 for the host's 91–125 position changes): the player sits still for 200–900 ms at a time, up to 64–80 px off, for 83–86 % of the drag. Polling: 72 % of the drag, median 30 ms, p95 176 ms, up to 24 px. | not measured (no XTest in the image) |
| Host's own `setPosition`, 16 ms steps | 4.7 % of the time off, episodes median 0.8 ms, p95 1.6 ms, longest 3.5 ms, ≤ 5 px: under a frame. Owned: the same (4.8 %, p95 1.6 ms). `will-move`: no better, and its guesses miss now and then (one episode of 58 ms, 15 px). Polling every 8 ms: worse (23 %, p95 8.6 ms). | 42–51 % of the time off, episodes median 10–17 ms, p95 81–116 ms, ≤ 10 px. The channel and `setBounds` take about 1 ms; the rest is the window server placing the second window a frame or more later. | 0.3–1.8 %, episodes ≤ 3 ms: the sampler's own noise (a true child window, (c), measures the same) |
| Resize, 16 ms steps | 10–12 %, p95 3.7–9.7 ms, ≤ 6 px; polling 22 % | 26–62 %, p95 29–109 ms | ≤ 2.4 %, noise |
| Minimize, restore, hide, show | follows (the player hides and comes back) | follows | follows |
| Clicking Chord brings Chord above the player? | **Yes:** `moveAbove` doesn't keep an unowned player above the stand-in once the stand-in is activated. **An owned window does:** with the stand-in as its owner (`SetWindowLongPtr(GWLP_HWNDPARENT)`, set cross-process by the host), the player stayed above it. | **Yes, and the player stays behind.** Neither `moveAbove` nor `moveTop` (`orderFront…`) raises another app's window over the active app's. Only a panel stays above, at the floating level, over *every* app, and on every Space (`setVisibleOnAllWorkspaces(false)` didn't take; `setAlwaysOnTop(false)` drops it behind Chord again). | **Yes**, despite `moveAbove`. **Not with `WM_TRANSIENT_FOR`** set to Chord's window (`XSetTransientForHint` through koffi): the window manager then keeps the player above. |
| Focus | Clicking or focusing the player makes it the foreground window (`GetGUIThreadInfo`: the player's `Chrome_WidgetWin_1`). Chord draws its own frame, so it could keep it looking active meanwhile: the channel says when the player has focus. | Focusing the player activates the player *app*: Chord's window turns inactive and the menu bar becomes the player's. A panel (`type: 'panel'`) is the exception: it takes keys while Chord stays the active app (measured: `lsappinfo front` stays Chord). | the player's window takes focus |
| Chord's shortcuts while the player has focus | Ctrl+T, sent by `keybd_event`, reached Chord through the player's `before-input-event` in 0.4 ms, in every variant | Cmd+T, sent by `CGEventPost`, reached Chord through the player's `before-input-event` in 0.3–1 ms, in every variant | forwarded in 0.2–0.3 ms (sent by `sendInputEvent`) |
| Taskbar, Alt+Tab, Cmd+Tab | `skipTaskbar` keeps it off the taskbar (UI Automation lists only the stand-in's button). **Alt+Tab still lists it** (visible, unowned, no `WS_EX_TOOLWINDOW`). Owned: neither. | A regular player is a second *Foreground* app: Dock and Cmd+Tab. As an accessory (`setActivationPolicy('accessory')`, or `LSUIElement` when packaged) it's a *UIElement*: neither. | `skipTaskbar` sets `_NET_WM_STATE_SKIP_TASKBAR` (Electron's behaviour; not read back) |
| Fullscreen from the page | fills the display; back in place after, in every variant | the player's own fullscreen Space; back in place after | fills the screen; back in place. The glued window has to be resizable, or openbox leaves it at its size (first run). |
| Picture-in-picture | works (§1) | works | works |
| A hung player (main thread busy 2.5 s) | **No effect on Chord:** with the player's main thread busy for 2.5 s, a key pressed in the stand-in reached it in 0.4–11 ms, owned or not. | not measured | not measured |

- **Rounded corners:** the player is a rectangle over Chord's rounded content area ([`docs/images/s14/b-glued-macos.png`](../images/s14/b-glued-macos.png): the stand-in's and the player's captures put together at the measured offset). A transparent window with CSS corners would fix that; not tried.
- **Spaces (macOS):** a regular glued window stays on its own Space when Chord's window is moved to another one, and a panel shows on all of them. Neither follows Chord's window between Spaces. Inferred from the window kinds; Mission Control can't be driven on a runner.
- **What a drag looks like:** on macOS the video visibly lags behind Chord's frame: by a few frames when polling, and with events it stalls for up to 0.9 s and then jumps. On Windows the player is off for at most 3 ms at a time, so most composited frames (64 Hz here) catch it in place. About one frame in twelve would show it a few pixels behind (inferred from the 8 %). On X11, no lag shows within the sampler's 1 ms resolution, but that was the window manager answering programmatic moves, not a person's drag.

### (c) A child window

The player's top-level window becomes a child of Chord's: the OS moves, clips and hides it with Chord's, so it can't trail.

- **macOS: not possible.** `addChildWindow:` works only within a process. Showing another process's rendering takes `CALayerHost` with a remote `CAContext`, private API, which Chromium uses inside itself.
- **Wayland: not possible** (below).
- **X11:** `XReparentWindow` through koffi, from the host. Measured in the container and on CI:
  - It reparents in 0.05 ms, and drags show no trail beyond the sampler's noise.
  - But Chromium in the player still thinks it's a top-level window. Its position had to be set again after the reparent, the host has to resize it itself, and a fullscreen request no longer fills the screen (the window manager no longer manages it).
- **Windows:** `SetParent` through koffi from the host, with `WS_CHILD` set and `WS_POPUP`/`WS_CAPTION`/`WS_THICKFRAME` cleared first, as Microsoft says to ([SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)). No native module of Chord's own: koffi ships prebuilt binaries, loads in Electron's main process, and installed here with `--ignore-scripts`.

Measured on Windows (run [40157063004](https://github.com/anaremore/chord-browser/actions/runs/40157063004)), with the player playing:

| (c) on Windows | Result |
|---|---|
| Adopting | 5.5 ms; style `0x14000000` → `0x54000000`. The stand-in's window then holds the player's `Chrome_WidgetWin_1`, its `Chrome_RenderWidgetHostHWND` and its `Intermediate D3D Window`, above the stand-in's own D3D window. |
| Real drag, `setPosition` | **No trail:** off 0.03 % of the time, episodes ≤ 0.05 ms (the sampler's two reads). |
| Resize | The host has to resize the child itself (`SetWindowPos` with `SWP_ASYNCWINDOWPOS`, so a stuck player can't block it): off 6.8 %, p95 3.9 ms. |
| Minimize, hide | Hidden with the parent, by the OS. |
| Taskbar, Alt+Tab | Never: a child window isn't a top-level window. |
| **Chord's own views over the player** | **Hidden under it.** A red view added to the stand-in, over part of the player, doesn't show in a capture of the stand-in's window: the foreign child draws above all of Chord's own content ([`docs/images/s14/c-child-windows.png`](../images/s14/c-child-windows.png), `PrintWindow` with `PW_RENDERFULLCONTENT`). Chord's command bar, menus, toasts and popovers over the content area would all be covered. |
| **Clicking into the video, then typing** | **The keys went to Chord**, not to the page: the stand-in's frame got `a`, `b`, Ctrl+T, and the page got nothing. The foreground stays Chord's window. That's good for Chord's shortcuts, but a service's search box or sign-in form can't be typed into without more work (focus across attached threads), which wasn't tried. |
| Fullscreen from the page | **Fills Chord's window, not the screen:** the child grew to 1024×768 inside Chord's 916×608 window, clipped. The player would have to leave Chord's window (release it) to go fullscreen, and be adopted again after. |
| A hung player (2.5 s) | No effect on Chord's keys (0.26 ms) |
| Releasing it again | Works: back to a top-level window, still playing |
| DPI | Both 96 here; mixed scale factors untested |

The trail is gone, but four new seams appear in its place:
- Chord can't draw over the player.
- The page doesn't get keyboard focus.
- Fullscreen needs a release and a re-adopt.
- Chord and the player are tied through attached input queues.

Cross-process parent and owner relationships are "technically legal", but they attach the two threads' input queues, and "the consequences can be very difficult to manage" ([Raymond Chen](https://devblogs.microsoft.com/oldnewthing/20130412-00/?p=4683)). Mixed DPI awareness between the two forces a reset of the child's process (SetParent's remarks); both are per-monitor-v2 Electron here.

### Linux: X11 and Wayland

- **X11 allows both (b) and (c).** Windows can be placed by their clients, and any client can reparent another's window (`XReparentWindow`, as XEmbed does; [spec](https://specifications.freedesktop.org/xembed-spec/latest/)).
  - Measured under openbox: (b) followed `setPosition` and `setSize` steps within the sampler's resolution, about 1 ms.
  - (c) reparented the player in 0.05 ms and followed drags with no measurable trail. Its position has to be set again after the reparent, and the host has to resize it itself.
  - Real drags couldn't be injected: the image has no XTest.
- **Wayland allows neither.** "Wayland deliberately forbids apps from accessing global screen coordinates", and `setPosition` isn't supported; the compositor places windows ([Electron, March 2026](https://www.electronjs.org/blog/tech-talk-wayland)). Cross-client embedding doesn't exist: subsurfaces belong to one client. The only cross-client link, `xdg-foreign`, sets a parent "with the same stacking and positioning semantics as xdg_toplevel.set_parent", meant for dialogs ([protocol](https://wayland.app/protocols/xdg-foreign-unstable-v2)). Measured under headless Weston:
  - The player plays everything there: the probe passed, including 4K, picture-in-picture and fullscreen.
  - After `setPosition(160, 120)`, Electron's `getBounds()` simply echoes 160, 120 for the stand-in, and the player echoes whatever it was asked. There is no global coordinate to check them against, which is the point.
- So on Wayland the player can only be (a), or a dialog-like child of Chord's window through `xdg-foreign`, which Electron doesn't expose.

## 3. Navigation lock

**Only documents are locked:** top-level navigations, popups and frames. A document is what runs code under its own origin in ECS's older engine. Subresources (CDNs, APIs, licence servers, media) load freely, because they run, if at all, inside a service's own page, as it chose. Locking them would mean tracking every CDN.

**How** (`player/main.mjs`, `applyLock`):
- `will-navigate` and `will-redirect` stop a page before it leaves, and hand its address to Chord. That leaves the service's page as it was.
- `setWindowOpenHandler` opens allowed popups (sign-in) as player windows, and hands the rest to Chord.
- `will-frame-navigate` and `webRequest` block frames from elsewhere.
- `webRequest` is the backstop for any main-frame request that still gets through. A request cancelled there leaves an error page, which is why the navigation events come first.
- Downloads and external protocols (`mailto:`, `spotify:`) are handed to Chord.
- Permissions: only `mediaKeySystem`, `fullscreen` and `pointerLock`, and only for the services' pages.

**Measured** (all three OSes, `navlock.html` against a test lock):

| Attempt | Result |
|---|---|
| Link, `target=_blank`, `window.open` elsewhere, form POST, `location.assign`, plain-HTTP link | Stays on the page; handed to Chord in 1–5 ms |
| Server redirect (302) elsewhere | Stays on the page (`will-redirect`); handed to Chord |
| Meta refresh elsewhere | Handed to Chord; the page that did the refresh stays, blank |
| Frame from elsewhere | Blocked; the page stays |
| Popup and frame on an allowed host | Allowed |
| `mailto:`, `spotify:` | Handed to Chord |
| Download | Handed to Chord |

**The hosts** (`shared/allowlist.mjs`). A host matches itself and its subdomains, over HTTPS only. The census (stock Electron, Linux, 2026-10-25, no account) checked it against what each service's pages actually did. With this list, nothing they navigated to went to Chord:

| Service | Pages (top level and popups) | Sign-in seen | Frames the census saw blocked |
|---|---|---|---|
| Netflix | `netflix.com` | same origin, `/login` | 8 ad and tracking hosts (adsrvr, rubicon, adnxs, doubleclick, snapchat, tapad, facebook), plus Netflix's own tag frame on `nflximg.net` |
| Spotify | `open.spotify.com`, `accounts.spotify.com`, `challenge.spotify.com`, `www.spotify.com`; Google, Apple, Facebook sign-in | `accounts.spotify.com/login` | none |
| Disney+ | `disneyplus.com`, `login.disney.com` | `/identity/login`, MyDisney frame on `login.disney.com` | doubleclick, snapchat, tapad |
| Prime Video | `primevideo.com`; Amazon's stores on `/gp/video` and `/ap/` | `amazon.com/ap/signin` | none |
| HBO Max | `hbomax.com`, `max.com` | `auth.hbomax.com` | `warnermediacdn.com` (an ID frame) and `pypestream.com` (the support chat) |
| Hulu | `hulu.com`, `login.disney.com`, `disneyplus.com` | `auth.hulu.com` | snapchat, doubleclick, tapad, adsrvr, facebook |
| Apple Music, Apple TV | `music.apple.com` / `tv.apple.com`, `authorize.music.apple.com`, `idmsa.apple.com`, `appleid.apple.com` | an `idmsa.apple.com` frame in the page | none |
| Peacock | `peacocktv.com` | `/signin` | 7 tracking hosts (optimizely storage, pinterest, doubleclick, demdex, bounceexchange, zenimpact) |
| Paramount+ | `paramountplus.com` | `/account/signin/` | 7 ad and tracking hosts |
| Tidal | `tidal.com` (logged out, `listen.tidal.com` goes to `tidal.com`) | `login.tidal.com` | none (DataDome's captcha frame is allowed) |

Shared frames allowed for every service: reCAPTCHA (`www.google.com/recaptcha`), hCaptcha, Arkose, DataDome, Cloudflare's challenge, and Disney's MyDisney frame. Google, Apple and Facebook are allowed as sign-in pages and popups, never as frames: on Netflix's and Hulu's pages, `facebook.com` frames are tracking pixels.

**What a lock can't cover:**
- **Signing in through a TV provider.** HBO Max, Paramount+ and Peacock bundles go through the provider's own login page ([Adobe Pass](https://experienceleague.adobe.com/en/docs/pass/authentication/integration-guide-mvpds/authn-usecase)), and there are dozens of providers. Handed to Chord, the sign-in lands in Chord's cookies, not the player's.
- **Checkout and 3-D Secure frames**, which vary by bank. Sign-up and billing belong in Chord. The player can show *Manage your account in Chord* on those pages.
- **Google sign-in** may refuse the player whatever the list says: Google blocked its sign-in inside ECS v40.7 ([#224](https://github.com/castlabs/electron-releases/issues/224)).
- **Third-party scripts inside a service's page** (ads, analytics) still run in ECS's engine. Ad-supported tiers load more of them; blocking their frames, as the census shows, is a privacy gain, but whether an ad tier still plays without its ad frames is unknown.

**Handing links back to Chord:**
1. **Over the control channel** (`open {url}`): Chord treats it like a link from another app. This is the normal path, since Chord starts the player.
2. **If Chord isn't running:** the player starts Chord's own executable with `--single-argument <url>`, which reaches `second-instance` (or starts Chord) through the path Chord already has for links from other apps (`os-links.ts`).
3. **Not a custom protocol:** a registered `chord-open:` scheme could be invoked by any app or page on the system.

## 4. Control channel

`shared/channel.mjs`, measured end to end on all three OSes:
- **Transport:** newline-delimited JSON over a named pipe (`\\.\pipe\chord-wv-<128 random bits>`) on Windows, and on macOS and Linux a Unix socket in a new 0700 folder (in `$XDG_RUNTIME_DIR` when there is one). Lines are capped at 64 KB.
- **Chord is the server.** It creates the pipe or socket before starting the player and takes one player at a time.
- **Chord starts the player with a cleaned environment.** Without the variables Electron and Chromium add to their own process (`CHROME_*`, `ELECTRON_*`, `FC_FONTATIONS`, a `disabled:` D-Bus address). With the host's environment as it was, the player's zygote died at once on Linux. Which variable did it wasn't narrowed down.
- **Per-launch secret** (256 bits):
  - **How it travels:** on macOS and Linux, on the player's stdin. On Windows in the environment, because an Electron app's main process has no stdin there (measured: the player never got the line). The player reads it and deletes it from its environment as soon as its main script runs, before it opens any window, so renderers started later don't inherit it. (Whether a helper started even earlier, such as the crash handler, saw it wasn't checked.) Never on the command line, which any local process can read on Linux.
  - **Neither side sends it:** Chord sends a nonce; the player answers with its own nonce and HMAC-SHA256(secret, "player", both nonces); Chord answers with an HMAC the other way round. A wrong secret, a second client, or a client that stays silent for 3 s is dropped (`tools/channel-test.mjs`).
- **Messages:**
  - **Chord → player:** `window {style, bounds}`, `navigate {url}`, `bounds {x, y, width, height, visible}`, `above {mediaSourceId}`, `play`, `pause`, `mute {muted}`, `focus`, `fullscreen {on}`, `close`.
  - **Player → Chord:** `ready`, `media {title, paused, muted, …}` (on `media-started-playing` and `media-paused`, for the Now playing card), `open {url, why}`, `key {key, control, meta, …}` (Chord's shortcuts while the player has focus), `focus`, `fullscreen {on}`.
  - Requests carry an `id`, and answers carry `re`.

| Measured | Windows | macOS | Linux (X11; Wayland) |
|---|---|---|---|
| Start to authenticated channel (ECS launch included) | 96–195 ms | 374–549 ms | 160–209 ms; 172 ms |
| …to `ready` (CDM installed, handlers in place) | 127–215 ms | 419–604 ms | 181–226 ms; 193 ms |
| Request round trip, median (p95) | 0.11–0.19 ms (0.25–0.36) | 0.08–0.11 ms (0.21–0.87) | 0.21–0.23 ms (0.36–0.43) |
| Now playing card gets the title after playback starts | 0.3–1.4 ms | 0.5–0.7 ms | 0.24–0.37 ms |
| `pause` → card says paused | 1.3–3.9 ms | 1.7–3.3 ms | 1.3–2.1 ms |
| `play` → card says playing | 1.3–1.9 ms | 1.9–3.6 ms | 1.9–3.5 ms |
| `focus` (bring to front) | 10 ms, focused | 19–36 ms, not focused (presumably macOS not letting a background app take activation) | 1 ms, not focused (openbox) |
| `close` → process gone | 110–121 ms | 205–219 ms | 84–90 ms |

The title, play and pause come from the page as it is (here the test page's own `MediaSession` metadata and its `<video>`). For the real services, Chord's Now playing logic (which presses a site's own button where its element isn't enough) would move into the player, unchanged.

## 5. Install and update

| | Windows x64 | macOS arm64 | Linux x64 |
|---|---|---|---|
| ECS download (zip) | 158.8 MB | 130.9 MB (x64: 134.6 MB) | 123.4 MB (arm64: 124.4 MB) |
| Unpacked | 386.7 MB | 322.9 MB | 296.5 MB |
| CDM, downloaded on first run | 23.0 MB | 20.4 MB | 22.0 MB |
| Where (per user) | `%LOCALAPPDATA%\Chord\Widevine Player\<version>\` | `~/Library/Application Support/Chord/Widevine Player/<version>/Chord Widevine Player.app` | `~/.local/share/chord/widevine-player/<version>/` |
| Its profile (cookies, CDM) | `%LOCALAPPDATA%\Chord\Widevine Player\Profile` | `~/Library/Application Support/Chord/Widevine Player/Profile` | `~/.local/share/chord/widevine-player/profile` |

The player's own code is a few hundred kilobytes; the download is ECS itself. A player package is roughly the zip above, 125–160 MB, against Chord's own download of about the same size, plus the CDM on first run.

**Installing.** From the DRM notice: *Play here with Chord's Widevine player (160 MB)*. Chord downloads it, checks it, unpacks it into a versioned folder, and starts it.
- No installer and no admin prompt.
- Nothing registered with the OS: no protocol, no file types.
- Removing it means deleting the folder (Settings → *Remove the Widevine player*).

**Checking it.** Reuse Chord's update signing (ARCHITECTURE.md §14.4):
- The release workflow publishes a `widevine-player.json` manifest per OS and architecture (version, ECS version, URL, size, SHA-512), signed with the same Ed25519 key as `<manifest>.sig`.
- Chord refuses a manifest that doesn't verify against the key baked into it, then checks the download against the manifest's hash before unpacking.
- On Windows and macOS the player is also code-signed and, on macOS, notarized, like Chord: a download Chord makes itself carries no quarantine flag, but an unsigned app is a bad habit to teach.

**Updating.** The player follows ECS, which builds a fraction of Electron's releases, mostly in a batch at the start of each month: 44.1.0 on 2026-09-03, 44.5.1 on 10-03, 44.9.3 on 10-22 (S12).
- Renovate (or `scripts/dev/ecs-lag.mjs` on a schedule) opens a PR for each new `+wvcus` stable.
- CI builds, VMP-signs and code-signs the player, and publishes the signed manifest.
- Chord checks daily, downloads in the background, and switches versions when the player is next closed. The old version stays until the new one has started once: a rollback that Chord's own updater doesn't have.
- **Never more than one ECS major behind.** If ECS has no stable build of a supported Electron major, Chord says the player is out of date rather than run it. That's the S12 risk in a smaller box: about 12 first-party sites instead of the whole web.

### EVS (VMP signing) in CI: the maintainer's steps

Production VMP needs an EVS account, which is free but personal. Nothing here was created; these are the maintainer's steps, from castLabs' [EVS wiki](https://github.com/castlabs/electron-releases/wiki/EVS):

1. On your own machine, with Python 3.7 or later:
   ```sh
   python3 -m pip install --upgrade castlabs-evs
   python3 -m castlabs_evs.account signup   # asks for e-mail, name, organization, account name, password; then an e-mailed code
   ```
2. Store the account name and password as secrets of a protected GitHub environment (for example the existing `release` environment): `EVS_ACCOUNT_NAME`, `EVS_PASSWD`.
3. In the player's release job, after packaging. Options can come from `EVS_`-prefixed variables, and `EVS_NO_ASK` makes any missing input an error instead of a prompt:
   ```sh
   export EVS_NO_ASK=1                                  # EVS_ACCOUNT_NAME and EVS_PASSWD come from the environment's secrets
   python3 -m pip install --upgrade castlabs-evs
   python3 -m castlabs_evs.account reauth
   python3 -m castlabs_evs.vmp sign-pkg <folder that holds the .app or .exe>
   python3 -m castlabs_evs.vmp verify-pkg <same folder>
   ```
4. **Order matters:**
   - macOS: VMP-sign *before* code signing.
   - Windows: VMP-sign *after* code signing ("or things will break"). Anything that touches the executable afterwards (icon edits, re-signing) breaks the VMP signature ([#199](https://github.com/castlabs/electron-releases/issues/199)).
   - With electron-builder, that means an `afterPack` hook on macOS and an `afterSign` hook on Windows.
5. Use the default `streaming` signature, not `--persistent`: persistent licences are gone from the browser CDM since ECS 42.
6. Linux gets no VMP signature: the Linux CDM doesn't support VMP.
7. **Tokens expire about monthly** ("currently every month"). Re-run `reauth` from CI each time, or `refresh` by hand. castLabs once paused EVS "at Widevine's request" (2022), so a release must not depend on it being up.

Then check the result with castLabs' [VMP Lab](https://castlabs.github.io/wv-vmp-lab/) on a Windows and a Mac machine: `PLATFORM_SOFTWARE_VERIFIED` is what most services need.

## 6. Signing in without Chord's extensions

The player has no extensions, so 1Password's, Bitwarden's or KeePassXC's browser extension can't fill its sign-in pages. The options, honestly:

1. **Sign in once.** Sessions live in the player's own profile (`persist:player`) and last weeks to months, so this happens once per service per computer.
2. **Codes instead of passwords.** Several services sign in with a one-time code by e-mail or text (Netflix, Disney+, Amazon), which needs no password manager.
3. **The password managers' desktop apps.** 1Password's *Universal Autofill* and Bitwarden's auto-type (Windows) fill any app's fields from the desktop app. Copy and paste always works.
4. **Passkeys** depend on Electron's WebAuthn support, which is incomplete for platform authenticators (Touch ID needs entitlements and a keychain group). Untested here.
5. **Not recommended: Chord's extension stack in the player.** It would put Chord's extension support (S9) into an engine weeks behind on fixes, for one sign-in per service.
6. **Not possible: Chord filling the player's page.** That would be a cross-process injection channel into another engine's renderer, the kind of thing the navigation lock exists to keep small.

Google's own sign-in (Spotify's *Continue with Google*) may fail in the player whatever is done, as above.

## 7. Google-free mode

**Confirmed: the player can't be used in Google-free mode.** From the net logs:
- **The first launch fetches the CDM from Google:** `update.googleapis.com` (`POST /service/update2/json`), then the CRX from `edgedl.me.gvt1.com`, over plain HTTP. The component updater checks the CRX's signature, not the transport.
- On Linux, ECS also fetched a spellcheck dictionary from `redirector.gvt1.com` until the player turned spellcheck off.
- **With the component updater off** (`--disable-component-update`), a fresh profile has no Widevine at all (`requestMediaKeySystemAccess` refuses; Shaka error 6001), on all three OSes.
- **With the updater off and a CDM already installed,** the OSes differ:
  - Windows and macOS: Widevine is gone too.
  - Linux: the installed CDM still loads and plays, with no Google contact. It would never be updated, though, and Widevine eventually stops licensing old CDMs.
- **A second normal launch** made no Google request within its first 8 seconds on any OS. The background check comes later ("always done on a delay timer"). Left idle on Linux, the player asked `update.googleapis.com` again 60 seconds after launch, so presumably any session longer than a minute calls Google.

So in Google-free mode, Chord shouldn't offer the player at all. The notice's *Open in…* another browser stays.

## 8. Cost

Memory and CPU of the player's processes (`app.getAppMetrics()`), idle with the page open and paused, then playing Sintel 1080p (AVC), each averaged over 10 s. These are VMs without a GPU, so decoding is in software and CPU is higher than on real hardware. The CDM decodes in software anyway at L3.

| | Windows x64 | macOS arm64 | Linux x64 |
|---|---|---|---|
| Idle: memory | 259–263 MB private (620 MB working set) | 653 MB resident | 503 MB PSS (865–914 MB RSS) |
| Idle: CPU (% of one core) | 0.3 % | 0.8 % | 0.3–0.7 % |
| Playing 1080p: memory | 274–277 MB private | 771 MB resident | 485–532 MB PSS |
| Playing 1080p: CPU | 30–42 % (CDM 15–23 %, renderer 6–10 %, GPU 6–7 %) | 47 % (CDM 30 %) | 29–32 % (CDM 16–18 %) |
| Processes | browser, GPU, network, renderer, CDM, audio | same | same |
| Disk | 387 MB + 23 MB CDM + profile | 323 MB + 20 MB + profile | 297 MB + 22 MB + profile |

- **Resident sizes overcount:** they count shared pages in every process. Private bytes (Windows) and PSS (Linux) are the fair numbers: **about 250–500 MB for a second engine while it's open.** It costs nothing once it's closed.
- **The player should quit when its last window closes.** A second engine left idle is a quarter to half a gigabyte for nothing.

## Recommendation

**Go**, on two conditions the maintainer has to meet first: an EVS account for production VMP (§5), and code signing for Windows and macOS, which Chord needs anyway.

**Approach per OS:**

| OS | Ship | Why not the others |
|---|---|---|
| Windows | **(a)**, as a window in Chord's own taskbar button (the shared AppUserModelID; measured) | (b) is good here *as an owned window*: under a frame of trail, above Chord, out of Alt+Tab. It's the one place where (b) is worth building, later. (c) hides Chord's own popovers under the player, keeps keyboard focus from the page, and breaks fullscreen. |
| macOS | **(a)**, a regular app named *Chord Widevine Player* with its own icon | (b) trails during every drag, and Chord's window either falls behind the player or loses activation to it. A panel fixes activation but floats over every app and Space. (c) doesn't exist without private APIs. |
| Linux X11 | **(a)** | (b) and (c) work here, but shipping them on X11 alone would make Chord behave differently on X11 and Wayland, for the services that work least well on Linux anyway. |
| Linux Wayland | **(a)** | (b) and (c) are impossible by design |

**Why (a), even though (b) looks better in a screenshot:**
- **It's the same everywhere**, Wayland included. It needs no z-order fights, focus tricks or input coupling, and a person can understand it: *Netflix opens in Chord's Widevine player*.
- **The seams of (b) show exactly when people look:** while dragging, clicking, or switching apps.
- **(a) still gets most of the polish:**
  - Chord's colors on the bar, and *Back to Chord*.
  - The Now playing card through the channel.
  - Chord's shortcuts forwarded.
  - Links back to Chord.
  - On Windows, one taskbar group.

**What to build, in order:**
1. The player app (this spike's `player/` grown up): the lock from `shared/allowlist.mjs`, the channel from `shared/channel.mjs`, a Chord-colored bar, spellcheck off, and quit when its last window closes.
2. Release CI for it: ECS bump PRs, VMP signing, code signing, signed manifests.
3. In Chord:
   - The notice's new first action, *Play in Chord's Widevine player*.
   - Install and update through the signed manifest.
   - Hand-off, Now playing, and shortcut forwarding over the channel.
   - Hidden in Google-free mode.
4. On Linux, label it honestly: some services refuse Linux or cap it at SD (§1).

**If people ask for (b) later:**
- **Windows first:** an owned window following `move` events. Chord then has to hide the player whenever it shows something over the content area (command bar, menus, toasts), because the player is a window above Chord's.
- **Then macOS, maybe:** only as a non-activating panel, shown just while Chord is the active app and on its Space, with a polling glue, and accepting the trail during drags.
- **X11:** a transient window (`WM_TRANSIENT_FOR`) following `move` events.
- **Never on Wayland.**

**Keep S12's rule for ECS's lag in a smaller box.** The player shows a dozen first-party sites, not the web. If ECS has no stable build of a supported Electron major, Chord marks the player out of date rather than run it.

## Not verified

- **Any real service.** Nothing here signed in to or played Netflix, Spotify or the others: that needs accounts, and production VMP needs the maintainer's EVS account. The per-service table in §1 is from castLabs' issues and other ECS apps, not from this spike.
- **EVS signing itself**, and whether a signed player reaches `PLATFORM_SOFTWARE_VERIFIED`.
- **Real hardware:** GPU decoding and compositing, HDCP, high-DPI displays, several monitors, 120 Hz. The VMs have none of these, so trailing on a real Windows or Mac desktop may differ in either direction, and CPU will be lower.
- **A person's drag on Linux X11.** The container has no XTest, so only programmatic moves were measured there.
- **macOS Spaces and Mission Control**, and a panel's behaviour across them. These can't be driven on a runner.
- **Linux arm64 and Windows arm64.** ECS 44.9.3 ships both; neither was run.
- **Desktop Windows 11.** Everything Windows ran on Server 2025 runners at 100 % scale. Taskbar grouping by AppUserModelID and full-window drags behave the same on Windows 11 by documentation, not by measurement here.
- **(c)'s missing keyboard focus on Windows:** whether attaching the threads' input (`AttachThreadInput`) and `SetFocus` would fix it. Not tried, since (c) isn't recommended.
- **Passkeys and the password managers' desktop autofill** in the player.
- **Whether ad-supported tiers play with their ad frames blocked.**
- **How long a Widevine CDM keeps working without updates** (the Linux Google-free case).
- **Gnome and KDE on Wayland.** Headless Weston only shows that positions are the compositor's; real compositors weren't tried, and they're the same by design.
