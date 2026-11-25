# Release notes

Newest first. Entries are only ever added, never rewritten. Each release's GitHub page links here.

## 0.15.0 · preview · unreleased

- **Agents can click and type, not just read.** An agent you've let in can now click buttons and links, type in fields, choose from a list, press keys like Enter and Tab, go to an address and go back, all in its own tabs. Chord gives it an outline of the page, so it names what it acts on instead of guessing at a picture.
  - **You say yes for each site.** An agent's first action on a site shows a card: *Let Codex click and type on shop.example?*, with what it wants to click. **Deny**, **Allow for now**, or **Always on this site** for an agent you always allow. Settings → Agents lists those sites under the agent, with **Remove**.
  - **Risky steps ask every time.** Before it submits a form, places an order, sends, deletes, signs in or out, or creates an account, a card says what it's about to click and what goes with it: the fields you filled, the option you chose and the boxes you checked, by name, never what's in them. **Show me** points at it on the page, and **Allow** is red for paying and deleting.
  - **What a click sends waits for you.** While a step runs and for 1.5 seconds after, anything the page sends with data in it is held for one card: *Send data to mail.example?* Loading a page and reading go on as usual. Reports a page sends to count visits are dropped, not asked about.
  - **Never passwords, codes or card numbers.** Those fields aren't offered to it.
  - **Your hand comes first.** Close an agent's tab with its × or a middle-click, as you would your own. Reloading it, going back or forward, or typing an address there pauses the agent at once, and anything it was about to send isn't sent. Alt+Tab to another app, or a Shift or Ctrl held on its own, doesn't.
  - **Pages that redraw themselves.** When a page swaps a button for a new copy between the outline and the click, Chord finds the same button again. If it can't tell which one, or the button changed, it refuses. A new tab's first outline waits for a page that draws itself after it loads.
- **The assistant can click and type in your tab.** Ask it to fill in a return form, change a setting, narrow a store's results or draft a reply, and it does it in the tab on screen, with the same kinds of cards in the chat. It's on in Settings → Assistant → *Click and type on pages*.
  - **Only in the tab you asked from, and only while you leave it be.** It acts in the tab on screen when you sent the message. Switch tabs, or click or type in the page yourself, and it stops, saying what it was: *Stopped: you used the tab (a click)*. Your next message lets it go on. Alt+Tab to another app and back doesn't stop it, and neither do your answers to its cards in the chat.
  - **Its first action on a site asks:** *Let the assistant click and type on game.example?* **Always on this site**, **Allow for this chat** or **No**. Risky steps ask every time, as they do for agents. The *Send data* card has **Allow for this chat** too, for the sites it names, in that tab.
  - **Leaving the site asks, every time,** with one card that shows the whole address, query and all: *Go to wikipedia.org?* It asks too when a link on the site sends your tab somewhere else, or from a secure page to one that isn't. Going there lets it act on nothing there yet: its first click or keystroke on the new site asks that site's card.
  - **What it read elsewhere stays in the chat.** Once a chat has read another tab, your history or the archive, an image you sent, or earlier turns from before you reopened it, it shows you anything it types, in full, before it goes into the page, and asks before it goes to any address.
  - **What its click sets off is caught.** For 6 seconds after each step, a file picker isn't shown, no passkey prompt appears, no popup or new tab opens, no other program starts, a download asks first (*Save invoice.pdf from shop.example?*), and a page that changes your clipboard has it put back. The chat says each one.
  - **Downloads it sets off.** A download the assistant sets off keeps arriving while you're asked, under a name that can't run, and is deleted if you say no. It takes its own name only once you allow it.
  - **Long tasks read as they happen.** What it writes between its steps is a paragraph each, and the activity row counts repeats (*Looked at “Table 7” (69 times)*) instead of calling one tab many.
  - **A bar over the page** while it works says what it's doing, like *The assistant is clicking “Raise”*, with **Stop**. It stays on, steady, between steps. Ctrl+. (⌘.) stops it too.
  - **Your passwords stay shut away.** The password menu doesn't open when it moves to a field, and doesn't take its Enter.
  - **Cards name the page it's on.** A page with no title of its own shows its site, in your tabs and on the assistant's cards, never the title of the page before it.
  - **An agent's tabs:** the assistant reads one only when it's on screen or you attach it, and never acts in one.
  - **What it can't hold back:** a page's live connection (a game's moves, for one), a shared worker's requests, what a page sends more than 1.5 seconds after a step, a copy made inside a frame (the chat says to check your clipboard), and a print dialog the page opens (the step stops there, and nothing prints without you).
- **Windows updates install while an agent is connected.** An agent's connection to Chord could keep running after Chord closed, and the update then failed with *Chord cannot be closed*. Setup now ends it, and the agent connects to the new Chord on its next step. If an update still can't replace Chord's files, Chord says why the next time it opens.
- **Filling a form:** whether the form was filled is said by the fill card alone; the assistant's reply no longer guesses.
- **Electron 45.5.0.**

## 0.14.1 · security · 2026-11-24

- **Security: Chromium fixes from Electron 45.4.1.** Chord now runs Electron 45.4.1, which brings security fixes from Chromium, V8, ANGLE, Dawn, FFmpeg and PDFium. Update as soon as you can.

## 0.14.0 · preview · 2026-11-22

- **Agents: the AI agents you run can use Chord.** Claude Code, Codex and Antigravity can open and read pages in Chord for you. Turn it on in Settings → Agents, then copy the line for Claude Code or Codex into your terminal, or press **Add to Antigravity** (Undo puts its settings back).
  - **You say yes first.** An agent's first try shows a card: *Claude Code wants to use Chord*, with the program that started it and its folder. **Deny**, **Allow once** or **Always allow**. Chord goes by the name the agent gives, so Settings → Agents lists every agent you've let in, with **Remove**.
  - **Tabs of its own.** An agent works in an Agent section below your tabs, kept in memory only. While it works on a tab, a bar over the page says so, with **Stop**. A key you press in its tab pauses it, and Ctrl+. (⌘.) stops every agent. When it's done, a toast asks *Keep these tabs?*
  - **Your tabs only when you share them.** *Share with Claude Code* in a tab's menu lets it read that tab, never change it, until you stop sharing, close the tab, or the tab leaves that site.
  - **Never your passwords.** Agents never see your vault or a site you keep private. They connect only from your own computer, never over the network.
- **Faster start with lots of tabs.** Finding each tab's icon at launch is now spread out in small steps, so a big profile no longer holds Chord's window for a moment.
- **Release builds are checked harder:** pinned build tools, a signature check on a Windows helper, and Electron's security switches confirmed on every build.

## 0.13.1 · security · 2026-11-21

- **Security: the assistant keeps away from sites you never let it read.** If a tab it was about to read was redirected, or moved to another page while you were answering its card, to a site on your *Never read* list, the assistant could read that site after all. It now checks again after the page loads and after reading, and refuses. Update as soon as you can.
- **Peek moves and resizes.** Drag Peek by the empty part of its bar to move it, or drag an edge or corner to resize it. It stays inside the window, and a double-click on its bar puts it back in the middle. The next Peek in that window opens where you left it, until Chord quits.
- **New profiles start faster.** A brand-new profile's database is set up in one step instead of two dozen, which is quicker on Windows in particular.
- **No pause while extensions install or update.** Checking, unpacking and setting up an extension now happens away from Chord's window, so a big extension no longer freezes it for a moment, including during the updates Chord checks for every few hours.
- **Smaller fixes:** sync passphrases never appear in error logs; the Linux sign-in terminal for the assistant tries the next terminal app when the first isn't installed; and the Flatpak now includes every license file.

## 0.13.0 · preview · 2026-11-20

0.12.0 was never published: everything in its entry below (importing and exporting passwords, the password generator, sign-up and change-password forms, and 0.11.1's sign-in box) comes in this release.

- **Passwords on harder sign-in pages.** More of the sign-ins you actually meet now get the menu, the fill and the save card.
  - **Two-step sign-ins save.** When the email comes on one step and the password on the next, the save card has both. The password step's menu lists that account first.
  - **Sign-ins with no new page.** When a site signs you in without loading a new page, Chord waits a moment for it to settle before calling the sign-in good. Press Save in that moment and the card says *Saving…* until the site has had its say. If the site turns the password down after all, nothing is saved: *The site didn't accept that password, so Chord didn't save it.* A generated password is marked confirmed only then too.
  - **Sign-in buttons that aren't buttons.** A *Next*, *Continue* or *Sign in* that's only styled text counts as the submit, when its words fit the form. *Sign back in* and *Sign in to view your account* count too.
  - **Fields inside a page's own components** (open shadow roots) fill and save as any other field.
  - **Sign-in forms in a frame from the same site** fill and save. A frame from another site, or a sandboxed one, still gets nothing.
  - **Google, Microsoft, Okta and Auth0.** Chord knows where their sign-in fields and buttons are, so a small redesign doesn't lose them; Google's *Next* now saves your email for the password step.
  - **A code typed after the password.** A few sites take a 6-digit code typed right after your password. On those (Apple's list), the first save leaves the code off and says so: *This site takes a sign-in code after the password, so Chord left off the last 6 digits.* **Keep them** saves it as you typed it. The eye shows exactly what will be saved, and a password you already have is never shortened.
- **No more "Today".** The tabs below Pinned are now simply unpinned tabs. Peek's button says *Open as tab*, the command is *Clear unpinned tabs* (searching "today" still finds it), and Settings says *Archive unpinned tabs after*. Nothing about how they behave has changed.
- **Generated passwords never use look-alike characters** (`0 O o 1 l I |`), even when a site's rules are tight. When a site's rules leave too little room without them, the password is made longer; when it can't be, it's offered as it is and called weak.
- **The sign-in box closes with its request.** If the page that asked for it removes the frame or stops loading, the box goes too. A held Enter or Space can no longer answer it before its half-second delay ends.
- **Peek, right after Chord starts.** In Peek's first moments, Ctrl+W (⌘W) closes it, reload and back act on its page, and the password menu shows over it.
- Not there yet: sign-in forms in another site's frame, and a component's own button submitting a field outside any form.

## 0.12.0 · preview · 2026-11-17

0.11.1 was never published: its changes come in this release.

- **Bring your passwords in.** Settings → Passwords → *Import…* reads a CSV you've exported from Chrome, Edge or Brave, Firefox, Safari or Apple Passwords, Bitwarden or 1Password. Another manager's file works too when its columns have the usual names. Not there yet in 0.11.0, it's here now.
  - **A preview first, before anything is written:** what's new, what you already have, and what's different from yours. Where a password differs, yours is kept unless you take the file's, all at once or row by row.
  - **Rows left out are listed**, each with its row number and why: no address, an app's address, no password, too long.
  - **One-time codes** in the file are never kept, and the preview says how many there were.
  - **Undo** takes the import back, from the card or the toast. A password you've changed since stays as you left it.
  - Chord reads only the file you chose, never another browser's own store. While the vault is locked, the preview waits for you to unlock it; with no vault yet, *Import* asks for its first passphrase.
- **Take your passwords out.** Settings → Passwords → *Export…* asks for your passphrase, as *Show* does, then writes them as:
  - **a CSV** in Chrome's shape, which every password manager reads. Its row says *Anyone with the file can read your passwords.*
  - **a Chord file, encrypted** with a passphrase of its own, which can't be the one your passwords are locked with.
- **Passwords in Chord's own file, only when it's encrypted.** Settings → Your data's encrypted export can carry your passwords, and importing that file brings them in with the same preview, keeping yours where they differ. A plain file never carries them, and sync still never does.
- **A strong password, made for you.** On a sign-up or change-password form, the menu under the new password's field starts with *Use a strong password*: 20 characters of letters, digits and `-`, with no look-alike characters. ↻, or Ctrl+Shift+K (⇧⌘K), makes another.
  - **Site rules take precedence.** The field's own rules come first, then Apple's list of rules for well-known sites, then the field's length limits. The menu says when they shaped it: *Letters and digits, 12–16, as this site asks*.
  - **A site whose rules only allow a weak password** gets *Use a password this site allows*, the strongest it takes, with its limit in words.
  - **Saved the moment it's filled**, so a sign-up that goes wrong never loses it. It's *Not confirmed* until a sign-in with it works. In the menu, an unconfirmed password shows for a day; in Settings → Passwords it stays until you delete it.
  - Private windows get no generator, since they never save.
- **Sign-up and change-password forms save too.** A sign-up with a password you typed gets the save card. A change is matched to your saved account by the current password the form asks for; when none or several match, the card asks which account you changed, or saves it as new. Filling an account into a change form fills only its current password, and leaves the new one to you.
- ***Change password on the site*** in Settings → Passwords opens the site's own page for it, on `https` only.
- **From 0.11.1, never published:**
  - **Passwords in the browser's own sign-in box**, the one a site or router shows before its page. It opens filled with the account you saved for that address, and nothing is sent until you press Sign in. Tick *Remember* to save or update its password. A password saved from the box fills only the box, and a proxy's box never uses the vault.
  - **More sign-in pages fill:** a password step showing the email from the step before, one swapped in where the email was, a first step whose password field isn't shown yet, a sign-in form beside a sign-up form, and a "Log in or sign up" page.
  - **Peek opens right after Chord starts.** A link from a pinned tab, clicked in Chord's first moments, no longer loads out of sight.
- Not there yet: sign-in forms inside another site's frame, and saving on sign-up forms with no `<form>` around them.

## 0.11.1 · preview · 2026-11-17

- **Passwords in the browser's own sign-in box.** The box a site or router shows before its page (HTTP sign-in), not there yet in 0.11.0, now works with your vault.
  - **Filling.** The box opens filled with the account you saved for that address, its password hidden, and nothing is sent until you press Sign in. With several, pick one from its list. While the vault is locked, the box offers *Unlock passwords*.
  - **Saving.** Tick *Remember* and sign in: once the page opens, the password is saved, or updated, with Undo on the toast. A wrong password isn't saved. The first password you save chooses the passphrase, as in a page's form.
  - A password saved from the box fills only the box for that exact address and its realm, never a page's form, and a form's never fills the box. Settings → Passwords shows the realm under the site.
  - **A box for a frame inside another site's page** says so, and isn't filled: pick the account to sign in.
  - Its buttons wait half a second after the box shows, so a page can't slip it under your click.
  - A proxy's box never uses the vault. Private windows fill the box, and never save.
- **More sign-in pages fill.**
  - A password step that shows the email from the step before fills the password, instead of filling nothing.
  - A sign-in that swaps its password step in where the email was, with no new page, gets the menu on the password.
  - A first step whose password field is on the page but not shown yet fills your email, instead of nothing.
  - A sign-in form beside a sign-up form on the same page fills, instead of being taken for the sign-up.
  - A "Log in or sign up" page with one email field is read as a sign-in's first step, so the menu fills your email there.
- **Peek opens right after Chord starts.** A link from a pinned tab, clicked in Chord's first moments, loaded out of sight and no Peek showed. It's been so since Peek came.

## 0.11.0 · preview · 2026-11-16

0.10.2 was never published: its update comes in this release.

- **Passwords, built in.** Chord keeps your passwords in a vault on this computer, locked with a passphrase only you know. Chord can't get it back for you: forget it and the vault can't be opened, though *Start over* in Settings → Passwords begins a new one.
  - **Filling.** Click into a sign-in field and a menu under it lists your accounts for the site: pick one with ↓ ↑ and Enter, or a click. The page never sees those keys, and nothing is filled until you choose. While the vault is locked, the menu offers *Unlock passwords*.
  - **Saving.** After a sign-in that worked, a card offers to save the password, or to update the one you have. The first password you save chooses the passphrase. Closed the card too soon? The key beside the address brings it back for a few minutes. *Never for this site* stops it asking there.
  - **Locking.** The vault locks each time Chord starts and after 30 minutes unused (*Lock after*, in Settings → Passwords), or at once with *Lock now*. *Keep unlocked on this computer* lets your system keep it open for you instead; it's off unless you turn it on, and isn't offered on Linux without a keyring.
  - **Settings → Passwords** lists them to search, show, copy, change or delete, with Undo. Showing or copying asks for the passphrase again after 5 minutes, and a copied password leaves the clipboard after a minute. Windows' clipboard history still keeps it, so copy sparingly there.
  - **A switch for each chord**, under *Offer to save and fill passwords*. In a chord where a password manager such as Bitwarden or 1Password is installed, Chord's stands aside, and that chord's switch says why. Turn it on there to have both.
  - **Private windows** fill from the vault, and never save.
  - **Your passwords stay on this computer.** Sync and Chord files never carry them.
  - **When Chord can't tell where a form's password goes**, it fills nothing and says so, rather than half the form.
  - Not there yet: importing and exporting passwords, a password generator, the sign-in box a site or proxy shows before its page (HTTP sign-in), and sign-in forms inside another site's frame. Sign-up and change-password forms come with the generator.
- **Huge sidebars stay quick.** With 5,000 pinned tabs and 30,000 bookmarks, opening, closing, pinning, moving or renaming a tab now takes about a millisecond, well under a frame; in 0.10.1, closing one took over a second. Deleting a chord, or its Undo, takes about 30 ms.
- **A long Pinned scrolls on its own.** Pinned stops at half the sidebar and scrolls, its lower edge fading while there's more below, so Today always has the rest. Before, a Pinned taller than the window ran under the chord switcher, hid Today, and its last tabs couldn't be reached. A Pinned that fits looks as it did, and each chord keeps where you'd scrolled.
  - With 5,000 pinned tabs, switching to their chord no longer stalls for about 2 seconds, and Chord's window is ready in less than half the time.
- **Dropdowns are readable in a dark chord** when your system is light. Their lists came up white, with text too pale to read, in Settings and elsewhere.
- **Security.** Updates Electron to 45.3.2 (Chromium 156.0.8078.100), which fixes security issues in Chromium and the components it uses. Update as soon as you can.

## 0.10.2 · security · 2026-11-16

0.10.1 was never published: its update comes in this release.

- **Security.** Updates Electron to 45.3.2 (Chromium 156.0.8078.100), which fixes security issues in Chromium and the components it uses. Update as soon as you can.
- **Thousands of pinned tabs stay quick.** Closing, pinning, moving or renaming a tab, deleting a chord and Undo no longer slow down as Pinned grows: with 5,000 pinned tabs, closing a tab went from about 170 ms to under 8.

## 0.10.1 · security · 2026-11-15

**Security.** Updates Electron to 45.3.2 (Chromium 156.0.8078.100), which fixes security issues in Chromium and the components it uses. Update as soon as you can.

## 0.10.0 · preview · 2026-11-12

- **Back, Forward and Reload sit beside the address** on Windows and Linux. With the sidebar showing, they're at its top right, next to the address, instead of beside the sidebar button. Settings → Appearance → *Keep Back, Forward and Reload beside the address* puts them back.

## 0.9.1 · preview · 2026-11-09

- **Clicking outside the address bar closes it** on Windows and Linux. Before, a click on the strip beside it dragged the window instead.
- **Ctrl+L after hiding or resizing the sidebar** opens the address bar over the address on Windows and Linux, rather than where the address had been.

## 0.9.0 · preview · 2026-11-09

0.8.1 was never published: its reload button on tabs and the ⌘L fix below come in this release.

- **Favorites for each chord.** A Favorite can be one chord's own or in every chord. Right-click one: *Only in Work* or *In every chord*. A new one belongs to the chord you add it in; the Favorites you have stay in every chord. Deleting a chord takes its own Favorites, and Undo brings them back.
  - Sync and Chord files carry it. An older Chord on another of your computers shows every Favorite in every chord until it's updated.
- **⌘L / Ctrl+L with the sidebar hidden** now opens the address bar exactly over the address, instead of 4 px lower.

## 0.8.1 · preview · 2026-11-09

- **Reload a tab from the sidebar.** Point at a tab and a reload button shows beside its ×: it reloads that tab without switching to it. Turn it off in Settings → Appearance → *Show a reload button on tabs*.
- **⌘L / Ctrl+L opens the address bar at the top of the window** on Windows and Linux with the sidebar showing, where the address is, rather than over the sidebar. Clicking an address edits the one you clicked.

## 0.8.0 · preview · 2026-11-06

- **Netflix, Spotify and the other services that need Widevine play right in the tab, on Windows.** With Chord Player 0.2, which Chord updates to by itself, the page plays where the tab's page would be: no second window. It moves and resizes with Chord's window, minimizes with it, and stays out of the taskbar and Alt+Tab.
  - Switch tabs or chords and it hides; come back and it's there.
  - When the command bar, Peek, a preview or the sidebar slides over it, a still picture of the page stands in until they close. Netflix's may be black: protected video can't be pictured.
  - Chord's shortcuts work from inside it: Ctrl+T, Ctrl+L, Ctrl+W, Ctrl+Tab.
  - The tab is the player now: closing the tab, or leaving the service's page, closes it.
  - On macOS and Linux it keeps its window of its own.
- **Chord Player's files are all code-signed on Windows**, its DLLs as well as the app, as Chord's are.
- **Now playing:** a video you paused just after it started, then left for another chord, no longer stays on the card for a minute.

## 0.7.0 · preview · 2026-11-06

- **Riff no longer has a name.** It's the assistant button now: the same icon and the same shortcut (⌘/Ctrl+E), in Settings → Assistant. Your chats and settings are all still there. Search your chats in the command bar with `@chats`.
  - An older chat's next message continues from a summary of it, as after switching between Claude Code and Codex.
  - Export files and sync folders from 0.6 still bring your chats, but not the assistant's settings or the styles it wrote for Effects. If you sync, update Chord on each computer.
- **Chord Player**, the companion app that plays Netflix, Spotify and the other services that need Widevine:
  - Install it from Settings → General → Chord Player, as well as from a service's page.
  - Chord notices a newly published version without a restart.
  - *Back to Chord* and *Back to the player* now bring the other window forward on Windows.
  - Uninstalling Chord on Windows removes Chord Player too.

## 0.6.1 · security · 2026-11-05

**Security.** Updates Electron to 45.2.3 (Chromium 156.0.8078.80), which fixes security issues in Chromium and the components it uses. Update as soon as you can.

## 0.6.0 · preview · 2026-10-31

- **Duet is now Riff.** Same panel, same shortcut (⌘/Ctrl+E), same settings, and your chats are all still there; only the name changed, since Anthropic's new Claude Duet is something else.
- **Bring a Chord file back**, in Settings → Your data → *From a Chord file*: an export from this computer or another. Before anything changes, Chord shows what it would bring: what's new, and what's newer than yours. It adds what's missing and updates what's older, and never removes anything. One Undo takes all of it back.
  - Into a new Chord it's a restore: everything comes in, settings too, in place of the chord Chord started with.
  - Into a Chord you use, your settings stay as they are unless you turn on *Settings from the file*, which names each change first. History, Riff chats and Effects each have a switch.
  - A file is treated as untrusted: tabs don't load until you open them, every site's Effects are checked again, sites you'd allowed to use your camera, microphone or location ask again, and Riff chats send nothing anywhere until you write in one.
- **Sync your setup between your computers**, in Settings → Your data → *Sync*, through a folder you already sync: iCloud Drive, Dropbox, OneDrive or Syncthing. Your chords, pinned tabs and folders, Favorites, themes, settings, link routes and Effects stay the same on each computer. History, Today tabs, Riff chats, page zoom, site permissions and proxies stay on each one.
  - Pick the folder, and choose a passphrase. Everything Chord puts there is encrypted with it, and you type it once on each computer. Lose it and the synced copy can't be opened; what's on each computer stays, and *Start over* syncs it again under a new one.
  - On another computer, pick the same folder and enter the passphrase. A new Chord takes your synced setup; one with chords of its own asks whether to use the synced setup (with Undo) or keep both.
  - A change on one computer reaches the others a few seconds after your sync app delivers it. If two computers change the same thing, the later change wins; changes to different things both stay. A computer whose clock is wrong can't make your changes lose to it.
  - A chord deleted on another computer never takes this computer's Today tabs or the tabs you have open: they move to another chord, a message says where, and Undo brings the chord back.
  - Settings lists your computers. Remove one or turn sync off, each with Undo first, pause it, or change the passphrase. Your data on each computer stays whatever you do.
  - What comes from the folder is treated as untrusted, as a file is: tabs don't load until you open them, Effects are checked again, a chord never changes its sign-ins or proxy, and sync never carries permissions or Riff chats.

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
