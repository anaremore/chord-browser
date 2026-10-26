# Sync: checking by hand

E2E covers Chord's part in the Linux container (`test/e2e/sync.spec.ts`): two Chords with profiles of their own share one temp folder, set sync up, join, edit on both and agree, try a wrong passphrase, remove one, change the passphrase, relaunch with no keyring, start over, remember the key anyway, and find a folder that moved. Unit tests cover the folder protocol against an in-memory folder: a frame half there, a shorter file, conflicted copies, compaction in the middle of a read, a copied id, a newer format and a changed passphrase (ARCHITECTURE.md §9, *Your data: sync*).

What they can't reach is real sync apps and real keychains: how each app uploads a file that grows, delivers one half-written, keeps files online only, makes conflicted copies, and whether Chord's folder watch fires. Check these by hand before the release that ships sync, and when a sync app changes how it works.

## Setting up

- **Two computers at least**, ideally three, on different systems: Windows 11, macOS (14 or later), and Linux (GNOME on X11 or Wayland, with a keyring; and once without one).
- **Each with its own Chord profile**, not your everyday one: a packaged build with `--user-data-dir=<a temp folder>` (ARCHITECTURE.md §7, *Throwaway profiles*). Delete those folders, and the test's `Chord sync` folder, afterwards.
- **A test account** in each sync app, not your own, with nothing else in the folder you pick.
- A few chords on the first computer: one with pinned tabs in folders, a split in Pinned, a Favorite, a custom theme, a link route, Effects on a site, and a few settings changed (search engine, ad blocking's sites).
- On each computer, Settings → Your data → *Sync*. Watch the card's line (*Up to date*, *Last change from …*), and the list of computers.

## Every sync app

Run these for each app, between two systems at least. A change counts as arrived when the other computer shows it without a restart; the app's own upload and download time comes first, so allow a minute, and bring the other window to the front (Chord looks at the folder then).

| Check | Expected |
|---|---|
| *Turn on sync…* on the first computer, in the app's folder, with *Suggest one* | *On · <folder> › Chord sync · Up to date*. In the folder: `Chord sync/sync-1.json` and `Chord sync/1/<16 hex digits>/000001.chordlog`, and nothing readable in either |
| *Turn on sync…* on the second, the same folder | *<folder> syncs 1 computer already.* A wrong passphrase: *That passphrase doesn’t open this folder.* The right one, on a fresh Chord: the first computer's setup replaces the first-run chord. On one with chords of its own: *This computer has its own chords.*, and both choices do what they say (*Use the synced setup*'s toast has Undo) |
| Rename a chord, recolor it, pin a tab, move it into a folder, add a Favorite, change the search engine, on each computer in turn | Each arrives on the other, with nothing doubled |
| Edit the same chord's name on both within a few seconds, offline on one, then back online | Both end with the same name: the later edit's |
| Rename a chord on one, delete it on the other | It stays deleted on both |
| Delete a chord the other computer is showing | That window moves to another chord, with *“Work” was deleted on another computer* |
| Unpin a tab on one that's open on the other | On the other it moves to Today, still open |
| A split in Pinned, made on one | It arrives whole, both panes, on the other |
| Effects on a site, made on one | They apply on the other's next visit to the site |
| Quit one Chord within 3 s of a change | The change still arrives (it's written on quit) |
| Leave both running for a day with a few changes | Nothing doubles; the folder holds a few segments per computer, not hundreds |
| Remove the second computer from the first | After 6 s (with Undo before), the second says *This computer was removed from sync* and keeps what it has |
| Turn sync off on one | Its Undo; then it leaves the other's list. Its data stays |
| *Change passphrase…* on one | The other says *The passphrase was changed on <name>*; the old passphrase doesn't open it, the new one does; then changes cross again. In the folder: `sync-2.json` and `2/`, and each computer's `1/<id>` folder goes once it has moved |
| *Lost it? Start over…* on one, while it asks for the passphrase | It goes on under the new passphrase; the other says *The passphrase was changed on <name>* and takes the new one. In the folder: the next `sync-<n>.json` |
| Quit the sync app, move the synced folder elsewhere on the disk, start the app again | *Chord can’t find the sync folder.* **Choose folder…**, the folder where it is now: sync carries on, nothing doubles. Another folder: *That isn’t this sync’s folder.* |
| Set sync up on two computers at once, in a new folder, before the app syncs | The second to find the other's file stops: *Sync was set up in this folder from two computers at once.* |

## Each app's own ways

| App | Check | Expected |
|---|---|---|
| **Dropbox** | Files online only (*Make online-only* on `Chord sync`) | Chord reads them (the OS downloads them as they're read); sync goes on |
| **Dropbox** | A conflicted copy (`000001 (Someone's conflicted copy).chordlog`) | Passed over; nothing doubles |
| **OneDrive** | *Files On-Demand*, the folder *Free up space* | As Dropbox's online-only files |
| **OneDrive** | Pausing OneDrive's sync for an hour, with changes on both | Everything arrives once it resumes; the card says *Chord can’t find the sync folder* only if the folder itself is gone |
| **iCloud Drive** | *Optimize Mac Storage* on, the folder evicted | On macOS 14 and later, files download as they're read. ⚠ On older macOS, files show as `.000001.chordlog.icloud` placeholders, which Chord doesn't ask for: note what happens |
| **iCloud Drive** | iCloud for Windows | As on the Mac |
| **Syncthing** | Two computers on the same network, then one offline for a while | Everything arrives on reconnecting; Syncthing's temp files (`.syncthing.*.tmp`) are passed over |
| **Syncthing** | *Send Only* on one, *Receive Only* on the other | The receive-only one can't write its log: its changes stay waiting (*3 changes to write*); note how Chord says so |
| **Each** | Does the folder watch fire? Make a change on one and leave the other in front | Note the delay with and without bringing it to the front; it looks every five minutes regardless |

## The key on each computer

| System | Check | Expected |
|---|---|---|
| Windows | Quit and relaunch Chord | Sync carries on without asking (DPAPI keeps the key) |
| macOS | Quit and relaunch; then a build signed differently | Carries on without asking (the Keychain); the Keychain may ask once for a differently signed build |
| Linux with GNOME's keyring or KWallet | Quit and relaunch | Carries on without asking |
| Linux without a keyring (`--password-store=basic`, or a desktop with none) | Quit and relaunch | *Sync is paused. Enter your passphrase.*, a toast once; the card says *This computer has no safe place for the key, so Chord asks for the passphrase after each launch.* Then *Remember the key on this computer* on, quit and relaunch: carries on without asking, and the note says *Kept without a keyring* |

## Afterwards

Delete the test profiles, the `Chord sync` folder in each app (and its trash), and the test accounts' copies. Note anything unexpected in S15 §13 or an issue.
