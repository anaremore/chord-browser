# Chord Player: checking the services by hand

Chord Player (ARCHITECTURE.md §9, §16 D4; DESIGN.md §7.14) plays the streaming services Chord's stock Electron can't, in a window of its own, on castLabs ECS.

What's tested automatically:
- **E2E** (`apps/desktop/test/e2e/player.spec.ts`, Linux x64): Chord installs the player from a stand-in release with a test-signed manifest, opens a Widevine test page in it, sees it play, and controls it from the Now playing card. Also: a link handed back to Chord, Back to Chord, closing it, removing it in Settings, a corrupted download refused, and no player in private windows or Google-free mode.
- **Smoke test** (`apps/player/scripts/smoke.mjs`, every OS in `.github/workflows/player.yml`): the packaged player plays the same test stream.
- **Unit tests:** the navigation lock (`packages/player-protocol/test/services.test.ts`), the channel, manifests and the zip format, and the installer (`apps/desktop/test/unit/player-install.test.ts`).

The test page is Shaka Player with Shaka's Angel One stream and its no-auth licence server, which accepts any client. Real services check more:
- that the player is VMP-signed for production;
- your account;
- your OS;
- often your region and your plan.

None of that can run in CI. Check it by hand once production VMP signing is on, then before each player release and after an ECS bump to a new Electron major. Check again whenever a service is reported broken.

## Before you start

1. **A production-signed player.** The release's manifest says `"vmp": "production"`, and CI's *Package* step logged a passing `verify-pkg` for Windows and macOS. A build without the EVS secrets keeps ECS's development signature, which real services refuse on Windows and macOS (S14 §1).
2. **A Chord that installs it:** a release build that has the update key, or a development build pointed at the release:
   - `CHORD_PLAYER_FEED=https://api.github.com/repos/anaremore/chord-browser/releases?per_page=30`
   - `CHORD_PLAYER_DOWNLOADS=https://github.com/anaremore/chord-browser/releases/download/`
   - `CHORD_PLAYER_PUBLIC_KEY` set to the PEM in `apps/desktop/src/main/update-key.ts`.
3. **An account** for each service you check, and Google-free mode off.
4. Note the player's version and ECS build: Settings → General → Chord Player.

To check a VMP signature offline on an installed player:

```sh
python3 -m castlabs_evs.vmp verify-pkg --name-hint "Chord Player" "<root>/<version>"
```

`<root>` is `%LOCALAPPDATA%\Chord Player` on Windows and `~/Library/Application Support/Chord Player` on macOS.

## For each service, on each OS

1. Open the service in Chord. The notice says *[Service] won't play in Chord yet*, with **Open in Chord Player** first (or **Install Chord Player (about N MB)**, then its progress).
2. Click it.
   - The player comes forward with the page, its bar in the chord's colors, showing the service's name.
   - The tab in Chord shows *Playing in Chord Player*.
3. Sign in with the service's own form.
   - Your password manager's browser extension doesn't run in the player. Its desktop app's autofill, copy and paste, or a code by e-mail do.
   - Where the service offers it, try *Continue with Google* or *Apple* too: a popup of the player's own. Google may refuse it (S14 §6); note it if it does.
4. Play something.
   - The picture and sound are right. Note the resolution: Netflix shows it with Ctrl+Alt+Shift+D (⌃⌥⇧D on macOS).
   - Try fullscreen and back, and picture-in-picture where the site offers it.
5. In Chord, switch to another tab.
   - The Now playing card shows what plays, with artwork when the site gives some, and *Back to the player*.
   - Pause, Play and Mute on the card reach the player.
   - *Back to the player* brings it forward.
6. Follow a link that leaves the service: its help center, an outside link, a gift-card or billing page that lives elsewhere. It opens as a tab in Chord, and the player stays where it was.
7. Click **Back to Chord** in the bar. Chord comes forward on the tab.
8. Close the player's window. The tab shows its page again, and the card lets it go.
9. Open it again from the notice. You're still signed in.

Write down anything off, with the OS, the player's version and what the service said (its error code, if any).

## Services

What to expect with production VMP (S14 §1). "Refuses" means its player shows an error rather than playing.

| Service | Sign-in to try | Windows, macOS | Linux | Notes |
|---|---|---|---|---|
| Netflix | E-mail and password, or a code | Plays; 1080p at most (no hardware DRM in ECS) | Plays; Netflix "can't guarantee" Linux | Without production VMP: M7121-1331 / E100 |
| Spotify | E-mail, code; Google, Apple, Facebook (popups) | Plays | Plays | Without production VMP: licence calls fail (403) |
| Disney+ | MyDisney (`login.disney.com` frame) | Plays | Plays, reduced resolution | Error 83 means platform verification failed |
| Prime Video | Amazon's sign-in (`/ap/signin`) on your country's Amazon | Plays | **SD only**, by Amazon's rule | Its store pages outside `/gp/video` and `/ap/` open in Chord |
| HBO Max | `auth.hbomax.com`; Google, Apple | Plays (expected; StreamDock plays it on EVS-signed ECS) | Not listed as supported | A TV provider's sign-in opens in Chord, and won't carry over (S14 §3) |
| Hulu | `auth.hulu.com`, MyDisney | Plays (expected) | Not listed as supported | Bundles go through Disney's pages |
| Apple Music | Apple ID (`idmsa.apple.com` frame) | Expected to play | Not documented | |
| Apple TV | Apple ID | Plays (expected) | Not documented | |
| Peacock | `/signin` | Plays (expected) | Not listed as supported | |
| Paramount+ | `/account/signin/` | Plays (expected) | Unknown | |
| Tidal | `login.tidal.com`; Google, Apple, Facebook | Expected to play | Plays (tidal-hifi does) | DataDome's captcha frame is allowed |

**Ad-supported plans** load ad frames the lock blocks (S14 §3). Whether such a plan still plays is unknown: note it.

## Each OS

**Windows 11**
- The player's window joins Chord's taskbar button: one button, two windows on hover. It's in Alt+Tab.
- The window controls in the bar are Windows' own, with Snap layouts on the maximize button.
- The window isn't blank after sleep or a display change.

**macOS (Apple silicon and Intel)**
- *Chord Player* in the Dock and Cmd+Tab, with Chord's icon until it has its own.
- It opens without a Gatekeeper prompt: Chord downloads it itself, so it carries no quarantine flag.
- The traffic lights sit in the bar.
- Fullscreen goes to a Space of its own.
- Back to Chord and Back to the player bring the other app forward.

**Linux (X11 and Wayland)**
- The window controls are drawn in the bar (Electron's window controls overlay).
- On Wayland the compositor places the window.
- On Ubuntu 23.10 and later, AppArmor stops apps it doesn't know from using user namespaces. Chord doesn't offer the player there unless `kernel.apparmor_restrict_unprivileged_userns` is 0. Check the notice offers only other browsers on a stock Ubuntu 24.04.
- Fedora offers and runs it.

## Updates, Google-free mode, removing it

- **Updates:** after a new `player-v*` release, Chord's daily check downloads it in the background. Settings says *Version X starts the next time it opens*. Close and reopen the player: Settings then shows the new version, and the old folder is gone.
- **A version that won't start** is skipped from then on, and the previous one runs instead. To try it, rename the new version's executable and open the player.
- **Google-free mode** (Settings → Privacy): turning it on closes a running player. The notice then offers only other browsers, and Settings → General → Chord Player says it's off.
- **Remove** (Settings → General → Chord Player): click Remove, then *Remove it and its sign-ins?*. Its folder goes:
  - Windows: `%LOCALAPPDATA%\Chord Player`
  - macOS: `~/Library/Application Support/Chord Player`
  - Linux: `~/.local/share/chord-player`
