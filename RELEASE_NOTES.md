# Release notes

Newest first. Entries are only ever added, never rewritten. Each release's GitHub page links here.

## 0.5.0 · preview · 2026-10-26

- **Export everything in Chord to one file**, in Settings → Your data: your chords, pinned and Today tabs, folders, Favorites, themes, settings, link routes, Effects, and if you like, your history and Duet chats. Keep it as a backup, read it, or bring it to another computer.
  - It's plain text anyone can read (JSON Lines), and [docs/data-format.md](docs/data-format.md) says what every line means, so it never depends on Chord.
  - Or turn on **Encrypt with a passphrase**: at least 12 characters, or *Suggest one* for five random words. Chord remembers the switch, never the passphrase, and can't open the file without it.
  - Passwords, cookies, extensions, downloads, the archive, private windows and what you typed into pages never go in.
  - Bringing a file back into Chord comes next, then sync.
- **Settings → Import is now part of Settings → Your data**, as *From another browser*. It works as before.

## 0.4.0 · preview · 2026-10-26

- **Duet fills in forms you ask it to**, on the tab you're on: "fill this in with my work address", say. It reads what the form asks for, never what's already typed in it, and shows each field with the value it suggests in a card in its panel, where you can change a value or leave a field out. Nothing goes into the page until you press **Fill**, and Chord never sends a form: you press the page's own button. Undo puts every field back.
  - It never fills passwords, payment details, one-time codes or hidden fields, and says which ones it left for you.
  - It follows what you've let Duet read: never in a private window, on a site you said Duet may never read, or when Duet is set to read nothing.

- **Proxies:** one for every chord, or one for a chord of its own. In Settings → Privacy → Proxy, choose the system's (as before), none, a proxy server (HTTP, HTTPS or SOCKS5) or an automatic configuration file. Private windows and Chord's own requests, like update checks, use it too.
  - A chord can have its own, from Settings, its right-click menu or the command bar. It comes with the chord's own sign-ins, so a chord that shares yours is signed out of sites, and Chord says so before it does it. Undo puts both back.
  - Nothing goes out the old way: a page waits until its proxy is set, connections opened before a change are closed, and video calls can't go around it. A proxy that's down shows why in the tab, and the page doesn't load without it.
  - If an HTTP proxy asks for a password, Chord asks you over the page and forgets it when you quit. Chord can't sign in to a SOCKS5 proxy that needs one.

- **What Duet can read is one button at the top of its panel**, saying what the chat does now (*Reads this tab*, for example). It opens the four choices, each with what it lets Duet read. The row of four buttons it replaces didn't fit the panel.

- **Fixed: Effects not coming back after reloading a busy page.** On a site that keeps the page busy as it loads, like Reddit, an Effect could stop showing after a reload, though the card still said it was on. Chord stopped waiting for the page to take the styles, and took them out when they arrived late. Now they stay.

## 0.3.0 · preview · 2026-10-25

- **Choose what Duet can read**, in Settings → Duet, from least to most:
  - **Nothing:** Duet only sees what you type. It gets no way to read your tabs, pages, history or Archive, nothing can be attached, and no chat can change that.
  - **Ask every time:** nothing goes with your messages unless you attach it, and Duet asks before reading any page.
  - **The tab you're on** (the default, which was called *Ask first*): the tab on screen goes with each message, as *Reading example.com*. Remove it and Duet asks first.
  - **Tabs in this chord** and **All your tabs**, as before. Each chat can pick these from the top of Duet's panel; *Nothing* is only set in Settings.

- **The hidden sidebar stays hidden until you bring it back:** click its button or press Ctrl+S (⌘S on macOS). It no longer slides out when the pointer reaches the window's edge. If you liked that, turn on Settings → Appearance → *Show the sidebar when you point at the window's edge*: pointing at the edge, or resting on the sidebar button, then slides the sidebar in over the page, looking just as it does when it's showing.

- **Fixed: tabs losing their site's icon.** A tab could drop to the letter tile when a page named no icon, its icon failed to load, or a navigation never arrived (a download, a cancelled link): sites that update their pages in place, like YouTube, did it most. A tab now keeps its site's icon. On a site Chord already has an icon for, it shows at once.

- **Fixed: extension buttons showing a puzzle piece.** An extension that draws its own button icon, like Tampermonkey, showed Chord's puzzle piece instead. Its icon shows now, and if an extension sets one Chord can't read, its button keeps the extension's own icon.

- **Effects:** restyle a site your way, in place of Arc's Boosts. Open them from the page's right-click menu (*Effects for this site…*) or the command bar, then:
  - write your own CSS, which applies as you type;
  - hide an element: click it on the page, and it stays hidden on the site's other pages too;
  - turn on a preset: *Reading width*, *Dark* for a site that has no dark mode, or *No sticky bars*, which lets headers scroll away and hides cookie banners;
  - or ask Duet: your Claude Code or Codex app writes the styles from an outline of the page. It never sees a private window, a site you said Duet may never read, or what's typed in a form.
  - Each one has its own switch, so you can turn one off without losing it. Duet's styles can be renamed and their CSS edited in the card, and a hidden element's selector narrowed when it hid too much.
  - **Dry/Wet** takes a site's Effects off at once and puts them back (Ctrl+Shift+E, ⌘⇧E on macOS), and Settings → Effects does it for every site. A site with Effects shows a button beside its address.
  - Effects never load anything: whatever in a stylesheet would fetch a file is left out before it's used, and Chord says what it left out. They're styles only, never scripts, and they stay on this computer. In a private window, what you change lasts until the window closes.
  - The CSS parser Effects use is MIT-licensed; its notice ships with every build.

- **Developer tools in the window:** F12 (⌥⌘I on macOS) now opens a tab's developer tools beside the page, on the right, as Chrome does, instead of in a separate window.
  - Drag the edge between the page and the developer tools to resize them. Their header moves them to the bottom (and back), pops them out into a window of their own, or closes them. In that window, *Dock in the window* puts them back. Ctrl+Shift+D (⌘⇧D) inside them does both.
  - Chord remembers the side and the size, and whether you like them in a window.
  - Each tab keeps its own: switch tabs and you see that tab's, or none. Closing the tab closes them, and a tab with them open doesn't go to sleep.

- **Opens faster:** the window is ready to use about a tenth of a second sooner. Chord now waits until the first page has loaded to tidy up old data and to look for Claude Code and Codex, and the command bar loads just after the window first appears.

- **Easier on your battery:** on battery, tabs you haven't looked at sleep after 15 minutes instead of an hour, and the Now playing card checks a playing tab every 15 seconds instead of every 5. Chord also no longer wakes every 30 seconds when there's nothing to save. *Sleep tabs you're not using* in Settings → General turns sleeping off, on battery too.

## 0.2.1 · preview · 2026-10-25

- **Signed for Windows:** the installer and Chord itself are signed by Austin Naremore, through Microsoft's Artifact Signing, so Windows shows who made them. SmartScreen may still warn about the first few signed releases until it knows the publisher. Once you're on this version, Chord installs only updates signed by the same name. Mac builds aren't signed yet.

- **Fixed: dragging a tab onto the page to split it.** In 0.2.0 a dragged tab showed as a strip across the middle of the window. Letting go over that strip could show the tab you were dragging instead of splitting, and then there was nothing to split it with. A dragged tab now stays a row under your pointer.

- **Tab and chord switches are smoother:** the highlight slides to the new tab without making the sidebar measure itself mid-switch.

- **Pages open sooner from the command bar:** while you type, Chord connects to the site you're about to open, so it starts loading the moment you press Enter.

- **Videos stay in their tab** when you switch away: popping out by themselves is now off, and turned off once for everyone. Pop one out from Now playing in the sidebar, or turn it back on in Settings → General → *Pop out playing videos when you switch away*.

- **Updates install themselves** on Windows and with the AppImage, from the next version on. Chord downloads a new version in the background, checks that it's signed by Chord's update key, and offers *Restart to update*; it also installs when you quit. This is the last version you install by hand there. On macOS, and with the `.deb` and `.rpm`, Chord still says when a new version is out.
  - **Smaller downloads:** only what changed, often well under 1 MB instead of the whole 130 MB installer. The installer you download from the release page is about 11 MB larger for it.

- **Counts on tabs** also come from a site's background worker, so a message that arrives while the tab sleeps can show when it wakes. A site open in two tabs counts once on Chord's icon.

## 0.2.0 · preview · 2026-10-25

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
- **Reader view:** on a page that reads as an article, the book beside the address (or F9, ⌥⌘R on macOS) shows just the article, in Chord's typeface and your chord's colors, without the site's layout, ads or scripts. Esc brings the page back, where you were.
  - Make the text bigger or smaller, pick a serif, a narrower or wider column, or Light, Dark or Sepia colors; Chord remembers them for every page.
  - Pictures show as they do on the page, signed in as you are there; links go where they would from the page.
  - It works in private windows too, and keeps nothing of what you read.
  - It uses Mozilla's Readability, under the Apache License 2.0; its notice ships with every build.
- **Media controls:** a tab playing sound shows a speaker on its row; click it (or press Ctrl+M, ⌃M on macOS) to mute the tab, and it stays muted after it sleeps or Chord restarts.
  - Leave a tab while it plays, in any chord, and a Now playing card at the bottom of the sidebar shows what it is (with the track and artist when the site says), with play and pause, mute, picture-in-picture for videos, and a way back to the tab. A tab that starts playing on its own in the background just gets its speaker.
  - Several playing: the newest in full, and a row for each of the others with its own mute and play and pause, and picture-in-picture for videos, so you choose which one is popped out.
  - Play and pause work with Twitch, SoundCloud and Bandcamp's own players too.
- **Share a single tab:** when a site asks to share your screen, Chord's picker lists your tabs first. Only that page goes out, with its sound, which you keep hearing; it keeps working while you look at another tab. On macOS 15 and later, and on Wayland, *Screen or window…* opens the system's own picker for the rest.
  - **Presenting mode** starts by itself while a page shares, and with Ctrl+Shift+P (⌘⇧P on macOS) when another app like Zoom or Teams shares Chord: history in the command bar, hover previews, websites' notifications and Chord's own notes stay hidden until it ends. A card in the sidebar says it's on, and turns it off. Settings → General can hide the sidebar while you present, too.
  - What's shared is outlined in red: the shared tab's frame, or a window that's being shared. The shared tab's row has its own Stop.
- **Duet reads whole pages** on sites it used to read only part of: Substack newsletters (just their footer before), MDN and BBC News among them, and a long page's top after you've scrolled down.
- **Streaming services that need Widevine** (Netflix, Spotify, Disney+, Prime Video, HBO Max, Hulu, Apple Music and TV, Peacock, Paramount+, Tidal) say so when you open them, since Chord can't play them yet, with a button to open the page in Chrome, Edge, Firefox, Safari or Brave if you have one.
- **Chord Player** will play them, in a window of its own, from that notice: *Install Chord Player* the first time (about 125–160 MB), then *Open in Chord Player*. It comes in its own release, without another Chord update; until it's out, the notice offers your other browsers.
  - It's a small companion app with Widevine, on castLabs' build of Electron. Chord itself stays on the standard engine, which gets security fixes first. The player shows only those services' pages, and every other link opens in Chord.
  - Its bar wears your chord's colors, with Back to Chord. On Windows it shares Chord's taskbar button.
  - The tab you came from stays, saying the page plays in Chord Player, with a way back. The Now playing card shows what plays and controls it, as it does for tabs.
  - It installs for you alone (no admin prompt) and updates itself in the background. Chord checks every download against a signature before unpacking it, and keeps the previous version until the new one starts.
  - Settings → General → Chord Player shows its version and removes it, with its sign-ins.
  - It isn't offered in private windows, or in Google-free mode, since Widevine comes from Google. On Linux, some services play only in lower quality, or not at all.
  - Sign in to each service once in the player: your password manager's browser extension doesn't run there, but its desktop app or a code by e-mail does.
- **Signing in to Google works again**, where it said "This browser or app may not be secure". On Windows, the passkey dialog no longer pops up by itself each time you click a sign-in field; choose the site's passkey option when you want one.
- **Passkeys on a security key** sign in on every OS. When the key holds more than one for a site, Chord asks which.
- **Search by image:** paste or drop an image into the command bar to search Google Lens or Bing by it (your engine's own; Google Lens, clearly named, when yours can't search by image; Bing in Google-free mode).
  - Or ask Duet about it, with your words as the question.
- **Counts on tabs:** a site that counts your unread messages (Telegram, WhatsApp, Slack) shows the number on its tab, on its Favorites tile, on a closed folder, and as a dot on its chord. Chord's icon adds them all up. Such tabs stay awake so the count stays current. Hide a site's from its tab's right-click menu, or all of them in Settings → General.
- **Duet makes images with Codex:** ask for one and Codex makes it with its own image tool, within your plan's limits. It shows in the chat with Copy and Save, and is deleted with the chat, Codex's own copy too. Claude can't make images; when you ask it, the reply offers **Make it with Codex**. Settings → Duet → *Codex can make images* turns it off.
- **Duet names tabs by their titles,** not "t1"; a tab it mentions is a button that takes you there.
- **Duet sees images:** a screenshot's toast, and your recent screenshots, have Ask Duet, which puts the picture in Duet's chat. Up to four go with a message, kept with the chat and deleted with it.
- **Screenshots, built in:** press ⌘⇧2 (Ctrl+Shift+2) and click an element, drag an area, or take what's on screen or the whole page. It's on your clipboard at once; Save puts it in Downloads, and your recent screenshots wait in the downloads panel (a private window's only until it closes). Based on Screenboard.
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
