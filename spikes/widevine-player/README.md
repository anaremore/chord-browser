# Spike S14: a Widevine player

Throwaway prototypes for [docs/decisions/S14-widevine-player.md](../../docs/decisions/S14-widevine-player.md). Nothing here ships.

- **`player/`** is the companion app, on castLabs ECS (Electron with Widevine).
  - `--mode probe`: installs the CDM, asks EME what Widevine offers, plays Shaka Player's Widevine test streams, and tries picture-in-picture and fullscreen. It also measures memory and CPU.
  - `--mode serve`: what Chord would run. It connects to the control channel, opens a window in one of three styles, and locks its pages to the services.
- **`host/`** is a stand-in for Chord, on stock Electron 45. It starts the player and measures each way of showing it:
  - (a) a frameless window of its own;
  - (b) a borderless window glued over the host's content area;
  - (c) a child window (`SetParent` on Windows, `XReparentWindow` on X11).
  - It also runs the navigation lock and the control channel.
- **`census/`**, on stock Electron, records which hosts each service's home and sign-in pages navigate to, frame and open.
- **`shared/`** holds what the host and the player share:
  - `channel.mjs`: the control channel. NDJSON over a named pipe or a Unix socket, with an HMAC handshake on a per-launch secret.
  - `allowlist.mjs`: the navigation lock.
  - `follow.mjs`: glue by polling the host's rectangle from the OS.
  - `win32.mjs`: koffi bindings.
- **`tools/`**:
  - `fetch.mjs`: downloads and checks the runtimes (ECS, Electron, koffi).
  - `sampler.mjs` (and `sampler-mac.js`): watches both windows from outside, and drives real input.
  - `printwindow.ps1` and `taskbar.ps1`: Windows checks.
  - `channel-test.mjs`: a plain-Node check of the channel.
  - `check-lock.mjs <census.json>`: the lock against what the census saw.
  - `summarize.mjs <results folder>…`: the numbers the decision record quotes.

## Running it

It opens windows and, on Windows, moves the mouse, so it never runs on a desktop someone is using.

- **Linux, in the E2E container** (Docker, as for `pnpm test:e2e:linux`). Results land in `results/linux-<display>/`:
  ```sh
  node spikes/widevine-player/run-linux.mjs                      # X11: Xvfb with openbox
  node spikes/widevine-player/run-linux.mjs --wayland --steps host --scenarios glue
  node spikes/widevine-player/run-linux.mjs --steps census       # the host census (stock Electron)
  ```
  Downloads are cached in the Docker volume `chord-wv-spike-cache`. Remove it afterwards with `docker volume rm chord-wv-spike-cache`.
- **Windows and macOS, on GitHub's runners**: push to `agent/widevine-spike`. `.github/workflows/widevine-spike.yml` runs the same steps and uploads `results` as artifacts.
- **By hand**, on a machine nobody is using:
  ```sh
  node tools/fetch.mjs --dest <new empty folder>
  node run.mjs --runtime <that folder> --out <results> --work <new empty folder> [--steps probe,nocu,host,census]
  ```
- **The channel alone** (plain Node, no windows): `node tools/channel-test.mjs`.

## House rules it follows

- **Downloads are untrusted.** Each one goes to a new folder of its own and is checked against its release's SHA-256 before it's unpacked. Unpacking refuses paths that leave the folder, and koffi installs with `--ignore-scripts`.
- **No error dialogs.** Every Electron entry point imports `shared/guard.mjs` first, which exits on an uncaught error or rejection, or after a deadline.
- **Captures show only the spike's own windows**: `capturePage`, or `PrintWindow` on the spike's own window handle.
- **No accounts, keys or certificates.** The test streams use Shaka's public no-auth licence proxy.
