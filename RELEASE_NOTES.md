# Release notes

Newest first. Entries are only ever added, never rewritten. Each release's GitHub page links here.

## 0.2.0 · preview (unreleased)

- **Ads and trackers blocked** by default, in every chord and in private windows, with EasyList and EasyPrivacy. The empty spaces ads leave behind are hidden too.
  - Pages are checked against the lists on your computer; nothing about the sites you visit is sent anywhere. Chord fetches fresh lists from easylist.to every few days, which sees your IP address when it does. Google-free mode doesn't change any of this: the lists aren't Google's.
  - Turn it off for one site from the page's right-click menu (*Block ads on this site*), with Undo, or list sites in Settings → Privacy, where the switch for everything is too. A private window's exceptions are forgotten with it.
  - Extensions keep working beside it: uBlock Origin Lite and others block as before.
  - Licenses: blocking uses Ghostery's adblocker engine, under the Mozilla Public License 2.0, and the EasyList lists, under the GPL-3.0 (or CC BY-SA 3.0). Their notices ship with every build.
- **Import from other browsers:** bring your bookmarks, history and open tabs from Chrome, Edge, Brave, Firefox or Safari, in first run or Settings → Import.
  - Chord shows what a browser holds before anything comes across, and you say where each top-level folder goes: a new chord named after it, or a pinned folder in a chord you have. The bookmarks bar's own links can become Favorites.
  - Firefox's open tabs land in a chord's Today. Chrome, Edge and Brave keep theirs, since their files can't be read reliably.
  - History comes in with every visit, so the command bar ranks those pages as if you'd always used Chord.
  - Big imports stay smooth and show their progress, and Undo takes all of it back, history included.
  - Chord reads copies of the other browser's files and never changes them. It never copies passwords, cookies or extensions; your password manager can bring passwords across.
  - Safari needs Full Disk Access, and Chord says where to turn it on.
- **Media controls:** a tab playing sound shows a speaker on its row; click it (or press Ctrl+M, ⌃M on macOS) to mute the tab, and it stays muted after it sleeps or Chord restarts.
  - Leave a tab while it plays, in any chord, and a Now playing card at the bottom of the sidebar shows what it is (with the track and artist when the site says), with play and pause, mute, picture-in-picture for videos, and a way back to the tab. A tab that starts playing on its own in the background just gets its speaker.
  - Several playing: the newest in full, and a row for each of the others with its own mute and play and pause.
  - Play and pause work with Twitch, SoundCloud and Bandcamp's own players too.
- **Duet reads whole pages** on sites it used to read only part of: Substack newsletters (just their footer before), MDN and BBC News among them, and a long page's top after you've scrolled down.
- **Streaming services that need Widevine** (Netflix, Spotify, Disney+, Prime Video, HBO Max, Hulu, Apple Music and TV, Peacock, Paramount+, Tidal) say so when you open them, since Chord can't play them yet, with a button to open the page in Chrome, Edge, Firefox, Safari or Brave if you have one.
- **Peek** gets the sign-in box too, when a site in it asks for a username and password.
- **Link routes for part of a site:** `github.com/acme` can go to Work while the rest of GitHub goes elsewhere (Settings → General → Link routes).
- **Low on memory,** tabs you haven't looked at in 5 minutes go to sleep, instead of after an hour.
- **Smoother:** collapsing and docking the sidebar and opening Duet take half the time per frame they did with many tabs, and dragging through a long Today list no longer stutters.
- **Sturdier start:** if the disk is busy for a moment as Chord opens your saved tabs, it tries again instead of opening no window.

## 0.1.0 · preview · 2026-10-24

The first public preview: a calm, colorful browser for people leaving Arc. Builds aren't code-signed yet: see [Try the preview](README.md#try-the-preview) for the first-launch steps on each OS.

**Chords.** Each set of tabs is a *chord* with its own name, icon and colors. Switch with ⌘1–9 / Ctrl+1–9, the switcher, or a swipe. Pick from built-in themes or make, share and import your own. A chord can keep its own sign-ins.

**The sidebar.**
- Pinned tabs and folders, Today tabs, and Favorites shared by every chord.
- Drag to reorder, pin and unpin; resize the sidebar.
- Collapse it to a minimal bar that peeks back in from the edge.
- Hover a pinned tab or folder for a preview.
- Closing and clearing come with Undo.

**The command bar.** ⌘T / Ctrl+T finds open tabs, history, the archive and actions. It ranks like Crest's and learns what you pick. It also offers inline completion, search suggestions, site keywords (`yt`, `gh`, `wiki`, …) and `@` filters.

**Archive and sleeping tabs.**
- Tabs you haven't looked at in 12 hours move to the archive. You can change the time or turn it off.
- ⌘⇧T reopens closed tabs, even after a restart.
- After a restart, or if Chord or your computer crashes, open tabs come back with their back and forward history, scrolled where you left them.
- Background tabs sleep after an hour and wake where you left them.

**Split view, Peek and the mini window.**
- Split view puts two to four tabs side by side, kept together as one entry in the sidebar.
- Links from pinned tabs open in a Peek over the page, so the pinned page stays where it was.
- Links from other apps open in a small window you can move into a chord, and link routes send a site's links to the chord you choose (Settings → General).

**Duet.** Press ⌘E / Ctrl+E, or click Duet, for a chat beside the page.
- It uses your own Claude Code or Codex app and subscription. Chord never sees your sign-in; *Sign in* opens a terminal where the app signs you in.
- Ask about the page you're on (it's attached for you), or `@` another tab. Duet asks before it reads anything else, unless you let it read your chord or all your tabs.
- Answers cite their sources with numbered pills; click one to jump to the quote.
- It reads what's on the page, never what you type into forms, and never private windows or sites you add to *Never read* in Settings → Duet.
- Chats stay with each chord, survive a restart, and turn up under `@duet` in the command bar. Export one as Markdown, delete one (the app's own copy goes too), or have Chord keep them for 30 or 90 days.
- Duet only chats and reads; it doesn't move or close your tabs. Turn it off for one chord, or everywhere.
- It reads PDFs open in a tab too, and its citations say which page (*1 · p. 3*). Up to 25 MB and the first 200 pages.
- On Windows, Claude Code or Codex installed only inside WSL works too: Setup offers *Claude Code in WSL (Ubuntu)*.
- A small pie beside the chat's title shows how much of the model's context the chat has used, when your app reports it.

**Safe Browsing.** A warning before suspected phishing and malware sites and downloads, from Google's lists, checked on your computer; only a match sends Google a short partial fingerprint of the address. You're asked before it's turned on, and the notice says what Google sees. Release builds only; off in Google-free mode.

**Google-free mode.** Settings → Privacy: Chord stops contacting Google on its own (no search suggestions, no Safe Browsing lists). Sites you visit can still load from Google, and signing in to Google still works.

**The essentials.**
- Chrome extensions from the Web Store, with buttons in the sidebar or the title bar.
- Videos pop out into picture-in-picture when you switch away.
- Find in page, downloads, permission prompts, and friendly error pages.
- A sign-in box for sites and proxies that ask for a username and password (routers, staging servers). Chord keeps nothing; a sign-in that worked lasts until you quit.
- Several windows, and private windows.
- Editable keyboard shortcuts.
- Interface size: Chord's own sidebar, bars and Settings at 90–150%, with pages at their own zoom.
- Chord can be your default browser.
- A first run that gets you to your first chord in under a minute.
- Update notices.

**Linux.** `.deb` and `.rpm` packages for x64 and arm64, and an AppImage that refuses to run without its sandbox: `sudo apt install ./Chord-<version>-linux-<arch>.deb` or `sudo dnf install ./Chord-<version>-linux-<arch>.rpm`. apt and dnf repositories, and Flathub, are coming.

**Licenses.** Chord's source is MIT, with one MPL-2.0 file. Release builds include a GPL-3.0 extensions library, so they're distributed under the GPL-3.0. Duet's PDF reading uses pdf.js, under the Apache License 2.0; its text ships with every build.
