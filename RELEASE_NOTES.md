# Release notes

Newest first. Entries are only ever added, never rewritten. Each release's GitHub page links here.

## Next · Phase 2 (unreleased)

**Duet.** Press ⌘E / Ctrl+E, or click ✦ Duet, for a chat beside the page.
- It uses your own Claude Code or Codex app and subscription. Chord never sees your sign-in; *Sign in* opens a terminal where the app signs you in.
- Ask about the page you're on (it's attached for you), or `@` another tab. Duet asks before it reads anything else, unless you let it read your chord or all your tabs.
- Answers cite their sources with numbered pills; click one to jump to the quote.
- It reads what's on the page, never what you type into forms, and never private windows or sites you add to *Never read* in Settings → Duet.
- Chats stay with each chord, survive a restart, and turn up under `@duet` in the command bar. Export one as Markdown, delete one (the app's own copy goes too), or have Chord keep them for 30 or 90 days.
- Duet only chats and reads; it doesn't move or close your tabs. Turn it off for one chord, or everywhere.
- It reads PDFs open in a tab too, and its citations say which page (*1 · p. 3*). Up to 25 MB and the first 200 pages.
- On Windows, Claude Code or Codex installed only inside WSL works too: Setup offers *Claude Code in WSL (Ubuntu)*.
- A small pie beside the chat's title shows how much of the model's context the chat has used, when your app reports it.

**Licenses.** Duet's PDF reading uses pdf.js, under the Apache License 2.0; its text ships with every build.

**Fedora and RHEL.** Releases include an `.rpm` for x64 and arm64: `sudo dnf install ./Chord-<version>-linux-<arch>.rpm`.

## 0.1.0 · preview (unreleased)

The first public preview: a calm, colorful browser for people leaving Arc. Builds aren't code-signed yet: see [Try the preview](README.md#try-the-preview) for the first-launch steps on each OS.

**Chords.** Each set of tabs is a *chord* with its own name, icon and colors. Switch with ⌘1–9 / Ctrl+1–9, the switcher, or a swipe. Pick from built-in themes or make, share and import your own. A chord can keep its own sign-ins.

**The sidebar.**
- Pinned tabs and folders, Today tabs, and Favorites shared by every chord.
- Drag to reorder, pin and unpin; resize the sidebar.
- Collapse it to a minimal bar that peeks back in from the edge.
- Closing and clearing come with Undo.

**The command bar.** ⌘T / Ctrl+T finds open tabs, history, the archive and actions. It ranks like Crest's and learns what you pick. It also offers inline completion, search suggestions, site keywords (`yt`, `gh`, `wiki`, …) and `@` filters.

**Archive and sleeping tabs.**
- Tabs you haven't looked at in 12 hours move to the archive. You can change the time or turn it off.
- ⌘⇧T reopens closed tabs, even after a restart.
- Background tabs sleep after an hour and wake where you left them.

**The essentials.**
- Chrome extensions from the Web Store, with buttons in the sidebar or the title bar.
- Videos pop out into picture-in-picture when you switch away.
- Find in page, downloads, permission prompts, and friendly error pages.
- Several windows, and private windows.
- Chord can be your default browser.
- A first run that gets you to your first chord in under a minute.
- Update notices.

**Licenses.** Chord's source is MIT, with one MPL-2.0 file. Release builds include a GPL-3.0 extensions library, so they're distributed under the GPL-3.0.
