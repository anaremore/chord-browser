# S15: Your data — export, import and sync

*2026-10-25 · ROADMAP.md 0.5 · decision D14 (ARCHITECTURE.md §16) · **reviewed and decided 2026-10-25:** the maintainer took all ten recommendations in §10. **Step 1, Export, built 2026-10-26** (ARCHITECTURE.md §9 *Your data: export*, DESIGN.md §8.8, [docs/data-format.md](../data-format.md)): what it decided and found is in §11, and marked *as built* where it lands. **Step 2, Import, built 2026-10-26** (ARCHITECTURE.md §9 *Your data: import*, DESIGN.md §8.8): what it decided and found is in §12. **Step 3, Sync, built 2026-10-26** (ARCHITECTURE.md §9 *Your data: sync*, DESIGN.md §8.8, [docs/data-format.md](../data-format.md#syncs-folder)): what it decided and found, and what's left, is in §13.*

**In short.** Export and sync use one record format. Export ships first, then import, then sync.

- **A file is a header line, then one record per line (JSON Lines).** A record names one thing, the fields it sets, and a stamp: `{"type":"chord","id":"…","at":[…],"set":{"name":"Work"}}`. A deletion is a record that sets `deleted`.
- **Merging is per field: the newest stamp wins.** Stamps come from a hybrid logical clock (wall-clock milliseconds, a counter, the device). A change made after seeing another always beats it, even on a computer whose clock is behind.
- **An export is a snapshot. A sync log is the same records appended over time,** and compacting a log writes a snapshot. That's what makes them one format.
- **The plain export is readable text:** about 3.8 MB for a profile with 50,000 visits. *Encrypt with a passphrase* deflates and encrypts the same lines, to about 1.4 MB.
- **Encryption is scrypt and AES-256-GCM,** both built into Electron 45's Node. Argon2id isn't there, and ChaCha20-Poly1305 is there only as an experimental Web Crypto algorithm (checked: Electron's Node uses BoringSSL). Each file has its own key, and every chunk is authenticated, in order, with the end of the file marked.
- **Import adds what's missing and updates what's older. It never deletes,** and one Undo takes it all back. Tabs arrive unloaded, Effects go through the sanitizer, Duet chats send nothing anywhere, and a file can't give a site your camera.
- **Sync gives each computer its own folder inside a `Chord sync` folder you pick.** The computer appends its log there, in segments. Nothing else writes in that folder, so sync apps never make conflicted copies. A half-written file is read up to its last whole chunk.
- **Nothing heavy runs on main.** Export and import run in a short-lived utility process, like browser import. Sync runs beside chord-data. An export of 50,000 visits reads the database through its own read-only connection, so it never holds chord-data up.

---

## 1. Records

### What a record is

```json
{"type":"tab","id":"019a3c2e-…","at":[1764511391204,0,"9f2c4e1a7b3d5c60"],"set":{"title":"Inbox","customTitle":"Mail"}}
```

- `type` and `id` name one thing. The ids are the model's own (§4).
- `set` holds the fields this record changes. Fields it doesn't list keep their values.
- `at` is the stamp of every field in `set`: `[milliseconds, counter, device]` (§4). After merging, one thing's fields can carry different stamps. A snapshot then writes it as one record per stamp, so most things are one line and a few are several.
- A deletion is `"set":{"deleted":true}`: a tombstone. Deleting is just another field under the same rule. A later edit made elsewhere doesn't bring the thing back; only `"deleted":false` does (Undo, or an import that restores it, §5).
- History, Duet chats and icons are facts, not setup, so their records have no `at`. History and Duet chats are never synced, and an import only adds what's missing. Icons are synced (setup uses them), but an icon's id is its content, so it never changes. *(Corrected 2026-10-26: this line said icons were never synced, which the table below contradicted.)*

### The record types

`pos` is one field: `{chord, section, parent, rank}`. A move sets all four at once, so a merge can't leave a tab half-moved (§4).

| Type | Id | Fields | From | Export | Sync |
|---|---|---|---|---|---|
| `chord` | UUIDv7 | `name`, `icon`, `theme` (stops, grain, appearance, themeId), `rank`, `profile` (`default`, or the id of its own sign-ins), `created`; `proxy` (its own, or `null`: added 2026-10-26, §11) | `chord`, `Chord` | ✓ | ✓, without `proxy` |
| `folder` | UUIDv7 | `pos`, `title`, `collapsed`, `created` | `node` + `folder` | ✓ | ✓ |
| `tab` | UUIDv7 | `pos`, `url`, `pinnedUrl`, `title`, `customTitle`, `icon`, `muted`, `created` | `node` + `tab`, `TabNode` | Pinned and Today | Pinned only, without `url` |
| `split` | UUIDv7 | `pos`, `direction`, `sizes`, `created`. Its panes are the tabs whose `pos.parent` is the split. | `node` + `split` | ✓ | Pinned only |
| `favorite` | UUIDv7 | `url`, `title`, `icon`, `rank`, `created` | `favorite` | ✓ | ✓ |
| `theme` | UUIDv7 | `name`, `stops`, `grain` | `settings.themes` | ✓ | ✓ |
| `settings` | `settings` | one field per setting, with dotted names (`adBlocking.offSites`) | `setting` | the portable ones | the portable ones |
| `route` | the route key (`github.com/acme`) | `chord`, `created` | `link_route` | ✓ | ✓ |
| `effects` | the site (`nytimes.com`) | `wet`, `css`, `cssOn`, `hidden` (`[{selector, label, on}]`), `presets`, `duet` (`[{ask, summary, css, on}]`) | `effect` | ✓ | ✓ |
| `icon` | `sha256-` and the hex of its bytes | `mime`, `data` (base64) | `favicon`, but only icons used by a record above | ✓ | ✓ |
| `zoom` | host | `factor` | `site_zoom` | ✓ | — |
| `permission` | origin | one field per permission: `allow` or `block` | `site_permission` | ✓ | — |
| `page` | its address | `title`, `visits` (ms, oldest first), `typed` (a count) | `history_url` + `history_visit` | ✓, a switch | — |
| `thread` | UUIDv7 | `chord`, `title`, `provider`, `model`, `scope`, `created`, `updated`, `lastUsed` | `duet_thread` | ✓, a switch | — |
| `message` | UUIDv7 | `thread`, `created`, `body` (as stored, without a citation's `tabId`) | `duet_message` | ✓ | — |
| `image` | its id (24 hex characters) | `mime`, `width`, `height`, `data`, `thumb`, `prompt` | `<userData>/duet/images/` | ✓ | — |
| `device` | device id | `name`, `os`, `app`, `removed` | — | — | ✓ (§6) |

- **A pinned tab syncs its home, not where you've browsed to.** Sync leaves out `url`. A new copy on another computer opens at `pinnedUrl`, and `title` and `icon` are written only while the tab is on its pinned address. Browsing in a pinned tab is activity, not setup (D14).
- **Leaving Pinned counts as a deletion for sync.** If you unpin a tab, sync writes its tombstone. On another computer the tab leaves Pinned too: an open copy moves to that computer's Today, and an unloaded one goes. Pinning it again writes the whole record, with `deleted: false`.
- **Effects:** `EffectsRecord` in `core/effects.ts` already anticipates this, and it changes a little now, before any file exists. Its fields become the `effects` record's fields, its `version: 1` moves to the file header, and its `updatedAt` becomes the stamp. Each item's own switch is in it (2026-10-25), and one that isn't there reads as on, so a record written before the switches loads with everything on. Your CSS's switch is a field of its own, `cssOn`, next to `css`; a hidden element's and a patch's (`on`) are inside `hidden` and `duet`, so each of those lists merges as one field, switches and all (§4). Every record read is still checked by `effectsFromRecord` and then the sanitizer worker. *As built 2026-10-26:* exactly so (`effectsRecord(site, at)`, `effectsFromRecord(record, newId)`); a stamp's time becomes the site's `updatedAt` and its items' times.
- **Unused columns aren't exported:** `chord.duet_enabled` (Duet's off chords are in settings) and `tab.zoom` (zoom is per site).

### Which settings travel

| | Settings |
|---|---|
| Exported and synced | search engine and suggestions; color scheme; interface contrast and tint; motion; extension buttons; whether new chords get their own sign-ins; archive and sleep timing; auto picture-in-picture; page previews; presenting; sidebar peek; keep screenshots; spelling; Google-free mode; Safe Browsing and whether its notice was answered; ad blocking and its sites; tab counts and their sites; Duet's on/off, keep, scope, reads-nothing, never sites, off chords and Codex images; where links from other apps open; reader view; Effects' Dry/Wet everywhere; whether exports are encrypted (*Encrypt with a passphrase*, remembered: added 2026-10-26) |
| Exported, never synced, because it's about this computer's network | the proxy for every chord (and a chord's own, on its `chord` record). *Added 2026-10-26, §11.* |
| Keyboard shortcuts | per OS family. A Mac writes `shortcuts.mac`, and Windows and Linux write `shortcuts.other`; each computer uses only its own family's. |
| Neither, because they're about this computer | interface size (it depends on the display), mini window size, DevTools' side and size, update checks (they depend on how Chord was installed), Duet's app and model (which CLI is installed here) |
| Neither, because they're one-time flags | first run done; the one-time switch-off of auto picture-in-picture |
| Moved out | custom themes become `theme` records, so two computers that each add a theme keep both |

- **Safe Browsing travels with its notice answer.** The notice is shown to you, not to a computer. Restore's rules still hold: it's on only once the notice was answered, and off in Google-free mode.
- **A list is one field.** If two computers change the same list at once (say, the sites ad blocking is off for), only the later list is kept. That's accepted: the window is narrow, and the edits are rare.

### Left out, and why

| Left out | Why |
|---|---|
| Passwords | They're your password manager's job (D12), and Chord holds none. |
| Cookies and site storage (your sign-ins) | Chromium keeps them in its own encrypted stores, tied to this computer, and a copy of them is a copy of your sign-ins. Whether a chord keeps its own sign-ins is exported; the sign-ins themselves aren't. |
| Site permissions. **Decided: exported, imported as blocks only, never synced.** | Your decisions are your data, so the export has them. But an `allow` from a file would let a site use your camera or location without asking, while a `block` is safe to take. Sites you'd allowed ask again, once. |
| Downloads | The list points at files on this computer, and the files aren't in the export. |
| Private windows | They're never saved, so they're never exported. |
| The archive. **Decided: left out.** | It holds Today tabs for 30 days. Every page in it is in history, which is exported. Its entries carry Chromium's back/forward state, which can hold what you typed into forms. And an imported entry older than 30 days would be swept at the next launch anyway. |
| Open tabs' back/forward history (`nav_state`) | It's Chromium's own `pageState`, form contents included, and it's tied to Chromium's version. Tabs come back at their address. |
| Windows, their sizes, which tab each shows | That's live layout for this computer's screens. A restore opens one window on the first chord. |
| Live state | Loading, sound, sharing, presenting, crashed (ARCHITECTURE.md §6.2). |
| Extensions | Installing one runs code from the web and needs your click, and each extension keeps its own data and sync (1Password, Bitwarden). Maybe later: the Web Store ones as a list, offered on import as *Install* buttons. |
| Learned command bar picks | They come from use, and they rebuild within days. Frecency is recomputed from the imported visits. |
| Hover-preview pictures, screenshots, favicons nothing exported uses | These are caches and files, and they come back as you browse. |
| Duet's provider sessions | They're the CLI's own cache. Chord's transcript is the chat (ARCHITECTURE.md §11.5), and an imported chat starts a new session when you write in it. |

## 2. The file

### Plain

The file is UTF-8 JSON Lines with `\n` line endings and no byte-order mark. The first line is the header:

```json
{"chord":"data","format":1,"kind":"export","app":"0.4.0","device":"9f2c4e1a7b3d5c60","created":"2026-11-30T14:03:11.204Z","includes":["setup","today","history","duet"],"about":"https://github.com/anaremore/chord-browser/blob/main/docs/data-format.md"}
```

- **Order:** setup, then Today tabs, icons, history and Duet, so a reader that only wants setup can stop early.
- **The last line, `{"end":<records>}`,** tells a file that was cut off from a whole one.
- **`docs/data-format.md` ships with export.** It lists every type and field and says how to decrypt a file, so nothing about the file depends on Chord.

### Encrypted

```
chord-encrypted 1\n                                       a line a person who opens the file can read
{"format":1,"kind":"export",…,"kdf":{…},"salt":"…","check":"…"}\n   the header: readable, and authenticated
[frame][frame]…[last frame]
```

A frame is a 4-byte length, a 12-byte nonce, the ciphertext and a 16-byte tag. Its plaintext is about 256 KB of whole lines, deflated. §3 covers the keys.

### Versions

- **`format` is 1. Every later Chord reads every earlier format, forever.** A format-1 file must open in every Chord to come; that's the promise.
- **Within format 1, changes are additions only:** new types, new fields, new values. A missing field means "not set". It never means a default that overwrites what's there.
- **An older Chord with a newer format-1 file reads what it knows.**
  - Import skips the rest and says how much: *12 items from a newer Chord were skipped.*
  - Sync keeps the rest as it came, merges it under the same rules, and writes it back when it compacts. An older computer never strips what a newer one wrote.
- **A name never changes meaning.** A new meaning gets a new name.
- **`format` goes to 2 only when an older Chord would misread the file,** for example after a new cipher or a new envelope. An older Chord then refuses: *This file is from a newer Chord. Update Chord to import it.* Sync pauses the same way.

### Sizes

The realistic profile: 12 chords, 260 pinned tabs in 40 folders, 60 Today tabs, 24 Favorites, 30 link routes, Effects on 40 sites, 200 distinct icons, 50,000 visits on 15,000 pages, and 200 Duet messages in 20 chats. The numbers below were measured on generated data of that shape (Node 24, deflate at level 6). ⚠ Real titles and addresses will compress differently.

| Part | Records | Plain | Deflated (as inside an encrypted file) |
|---|---|---|---|
| Setup | 607 | 480 KB, two-thirds of it icons | 270 KB |
| Today tabs | 60 | 26 KB | 7 KB |
| History | 14,985 pages | 3.0 MB | 1.0 MB |
| Duet, without images | 220 | 250 KB | 90 KB |
| **All of it** | | **3.8 MB** | **1.4 MB** |

- **Duet images go in as they are,** base64 in a plain file. Deflating them gains nothing.
- **A sync folder holds about 270 KB per computer** (setup only). An everyday change adds a frame of well under 1 KB.
- **Time for the whole file on this Windows development machine:** serializing the history took 12 ms, deflating everything 82 ms, and AES-GCM 1 ms (8 MiB took 8 ms). scrypt takes about 0.5 s. ~~⚠ SQLite reading the 50,000 visits isn't measured yet.~~ *Measured 2026-10-26* (§11): 70–77 ms to read them; the whole plain export 209 ms in the Linux container, encrypted 787 ms.

### Extension and MIME type

- **Plain:** `Chord data 2026-11-30.jsonl`, with the type `application/jsonl`. That's the common name for JSON Lines; ⚠ it isn't registered with IANA, and Chord doesn't need it to be. Any editor, `jq` or DuckDB reads the file.
- **Encrypted:** `Chord data 2026-11-30.chorddata`, with the type `application/vnd.chord-browser.data`. ⚠ It's unregistered; only file pickers' filters use it.
- **Sync segments:** `.chordlog`, and only inside the sync folder.
- **Not `.chord`:** ChordPro song files sometimes use it. Chord registers no file type with the OS. Import… goes by the file's first line, not its extension.

## 3. Encryption

### What Electron 45 has

Checked 2026-10-25 by running Electron 45.0.0's own Node (24.22.0, through `ELECTRON_RUN_AS_NODE`) on Windows. Its crypto is BoringSSL, not OpenSSL (`process.versions.openssl` is `0.0.0`), and it lacks some of what Node's docs list:

| | Result |
|---|---|
| AES-256-GCM (`createCipheriv`) | Works. 8 MiB took 8 ms. |
| ChaCha20-Poly1305 (`createCipheriv`) | *Unknown cipher*. It exists only as an experimental Web Crypto algorithm, and Node warns when it's used. |
| XChaCha20-Poly1305 | Not there. |
| Argon2id: `crypto.argon2Sync` (added in Node 24.7) | The function exists but throws *Argon2 algorithm not supported*. Web Crypto says *Unrecognized algorithm name*. |
| scrypt | Works. N=2¹⁷, r=8, p=1 took 516 and 531 ms. Node's default `maxmem` (32 MiB) refuses those parameters, so Chord sets `maxmem`. |
| HKDF (`hkdfSync`, Web Crypto) | Works. |
| zlib: deflate, brotli, zstd | All there. zstd is experimental in Node 24 (Stability 1). |

### The choices

- **KDF: scrypt, with N=2¹⁷, r=8, p=1.** That's 128 MiB and about 0.5 s here, and it's OWASP's minimum for scrypt. Argon2id would be the first choice, but here it would need a WebAssembly build (⚠ not evaluated), slower than native code, for one derivation per export, per import and per computer. The header names the KDF and its parameters, so a later Chord can move to Argon2id once BoringSSL has it, or raise N, and still open old files.
- **The passphrase is normalized to NFC.** *Suggest one* offers five random words. There's a minimum length (open question 9), and there's no recovery (D14). *As built:* at least 12 characters, counted as characters (code points), at most 1,024; the words come from Chord's own list of 1,738 (`core/words.ts`), about 54 bits for five.
- **Cipher: AES-256-GCM.** It's the only AEAD that Electron's Node ships as a cipher. It's fast on CPUs with AES instructions, which covers nearly all of Chord's targets. ⚠ Some arm64 boards lack them (the Raspberry Pi 4, for one), but even software AES is quick at a few MB.
- **Keys:**
  - The root key is scrypt of the passphrase and the KDF salt.
  - Each file (an export, or one sync segment) has a random 32-byte salt. Its key is HKDF-SHA256(root, file salt, `chord file 1`).
  - Each frame gets a random 96-bit nonce. With a key per file, each key seals only a few frames, far below GCM's limit for random nonces (2³² messages per key).
- **The key check:** the header's `check` is the word `chord`, encrypted with HKDF(root, KDF salt, `chord check 1`). It tells *wrong passphrase* from *damaged file* before any data is read.
- **What's authenticated:** each frame, with the SHA-256 of the header line, the frame's index and a last-frame flag as associated data.
  - So nobody can edit the header, reorder frames, drop one from the middle or move one to another file.
  - An export that was cut short is caught, because its last frame is missing.
  - A sync segment is open-ended, so a missing tail reads as "not arrived yet" (§6).
- **What isn't hidden:** file sizes, when files change, how many computers sync, and the header (KDF parameters, salts, a random device id). Device names and everything else are inside the encryption.
- **Readable without Chord:** scrypt, HKDF, AES-GCM and raw deflate are all in common libraries, for example Python's `hashlib.scrypt` and `zlib` plus the `cryptography` package. ⚠ Not tried. `docs/data-format.md` spells out the steps.

### Plain or encrypted

**I agree with plain by default.** Readable JSON is what "no lock-in" means. For a backup, a forgotten passphrase is a worse failure than a file someone else might read.

- *Encrypt with a passphrase* is a switch on the same card, and Chord remembers it for next time.
- When a plain export includes history or Duet chats, a line under the switch says *Anyone with the file can read it.*
- **Sync is always encrypted.** The folder has no plain mode: it sits in someone else's cloud and changes every day.

### The key on each computer

- **Sync runs without asking each time,** so each computer keeps the derived root key, never the passphrase.
- **It's stored with `safeStorage`'s async API** (the sync API is deprecated, and Electron 46 removes it). That means the Keychain on macOS, DPAPI on Windows, and the secret service on Linux.
- **Linux with no secret store:** `safeStorage` falls back to `basic_text`, which protects nothing. Chord then keeps no key and asks for the passphrase after each launch, in Settings and in a quiet card (open question 6).
- **`safeStorage` works only in main,** so main reads the key once, after the first page, and hands it to sync.

## 4. Ids and merging

### Ids

Today's ids are global enough.

- **Chords, sidebar nodes, Favorites, custom themes, Duet threads and messages use UUIDv7** from `crypto.getRandomValues` (`core/ids.ts`): 48 bits of time and 74 random bits. Two computers won't collide.
- **Natural keys where two computers should agree:** link routes by route key, Effects by site, zoom by host, permissions by origin, history pages by address, icons by content hash, plus `settings` and the `default` profile. Two computers adding a route for the same site end up with one route.
- **Duet images have 96 random bits.** Effects' Duet patches already get new ids when they're read from a record (`effectsFromRecord`), so their ids aren't in the record.
- **Device ids are 64 random bits,** made the first time export or sync needs one and kept in chord-data. They're never exported as data.

The one trap is first run: every computer starts with its own "Personal" chord. Joining sync deals with it (§6).

### The clock

A **hybrid logical clock**: `[wall ms, counter, device]`, compared in that order.

- **A new stamp** takes the wall clock if it's past the last stamp seen. Otherwise it takes the last stamp's milliseconds and adds one to the counter.
- **Reading another computer's stamp moves the clock up to it.** The last stamp is saved, so a clock that was set back at restart doesn't go backwards.
- **So a change made after seeing another always wins over it,** whatever either clock says. With the wall clock and a device tiebreak alone, a computer whose clock is an hour slow would lose, for an hour, to changes it had already seen.
- **A clock far ahead still wins races** against changes that hadn't seen its stamps, until real time catches up. That can't be corrected when reading, or computers would disagree: the merge must give the same answer everywhere, whenever it runs. Instead Chord says so. Stamps more than five minutes ahead of this computer's clock show in Settings → Sync, naming the computer that made them: *Austin's MacBook's clock is 2 hours ahead. Its changes may win over newer ones.*

### Merging

- **Per field, the higher stamp wins.** The merge is commutative, associative and idempotent, so neither the order files arrive in nor reading one twice changes the result.
- **Merged values go through the checks a restore uses** (`restoreSettings`, `restoreRoutes`, `settleSplits`, `validTheme`, `cleanSiteEffects`). A combination no single computer wrote still makes sense: Google-free mode and Google search can't both win.
- **Changes from another computer never go into this computer's log; only your own commands do.** Otherwise a value that two Chord versions tidy differently could bounce between computers forever.

### Order in the sidebar

- **Ranks merge as they are, through `pos`.** They're already fractional-index strings with the id as a tiebreak (`core/nodes.ts`), and `rankBetween` already copes with equal neighbors.
- **The later move wins,** and every computer sorts the same way.
- **Two computers inserting at the same spot** may make equal ranks; the ids order them.

### When two computers move the same tab

- **The later move wins whole,** since `pos` is one field. The tab ends up where it was last moved, never half in one place and half in another.
- **Into a folder another computer deleted:** it shows at the root of that chord's Pinned, by restore's existing repair.
- **Into a chord another computer deleted:** it goes with the chord, as that delete meant. Undoing the delete there brings both back.
- **Folder A into B on one computer, B into A on the other:** that's a cycle, and every computer breaks it the same way. The folder whose `pos` is newest goes to its section's root. Nothing is written for it: it's simply how the merged state is read.
- **Edits to different fields both stay.** One computer renames a chord, the other recolors it, and you get both.
- **Edit against delete: the delete stays,** since only `deleted: false` restores a thing. The edit is kept in the record, so undoing the delete brings back the edited version.

### Tombstones

Tombstones are kept forever in v1. Each is about 90 bytes, and setup is deleted rarely. Dropping them safely needs every computer to have seen them; that waits until sizes call for it.

## 5. Import and restore

### What it does

- **Into a new profile,** everything in the file comes in: it's a restore. A profile that has only its first-run chord counts as new, and that chord makes way.
- **Into a profile with data, import adds what's missing and updates what's older. It never deletes.**
  - **Things compare field by field:** the file's stamp against this computer's. With sync on, this computer's stamps are sync's own (§7). Without sync, they're the rows' `updated_at`. Migration 17 (built with export, 2026-10-26; this said 16 before Effects' switches and proxies took 15 and 16) adds `updated_at` to `setting`, `favorite` and `link_route`, which lack it, so an old export can't overwrite yesterday's edit.
  - **With sync on, what an import brings keeps the file's stamps,** so it can't overrule a newer change another computer made. Only something brought back from deletion gets a new stamp.
  - **Tombstones in a file are ignored,** though exports have none anyway. *As built (§12):* both ways: a thing whose newest `deleted` is `true` neither comes in nor is deleted here.
  - **Something you deleted here comes back** if the file has it: importing it is the choice.
  - **Matches merge instead of doubling:** a Favorite with the same address, a route for the same site, Effects for the same site.
  - **History:** visits are matched by address and time, so importing the same file twice adds nothing. Typed counts take the larger of the two.
  - **Duet:** threads and messages are added by id. A thread whose chord isn't here goes to the chord you're in.
- **One Undo takes it all back,** history included, from the window's toast or from Settings, for the rest of the session, like browser import. It reuses `import.undo`'s parts and `undoImport`'s history bookkeeping. Updated things go back to their earlier values.

### Nothing runs or loads until you open it

- **Tabs arrive unloaded,** and load when you open them (as `import.add` does).
- **Effects:** `effectsFromRecord` checks each one, then the sanitizer worker writes out only known rules and nothing that fetches, exactly as for Effects you write (D13). They apply, as stylesheets only, on the next visit to the site. A file from someone else could still restyle a site to mislead you, for example by hiding a warning. So the preview lists the sites, and Effects can be left out.
- **Duet chats send nothing.**
  - They keep no provider session, so writing in one later starts a new session.
  - For an imported chat, the earlier turns go to the CLI as untrusted, quoted data, the way page text does (ARCHITECTURE.md §11.4). They don't go in the instructions, where `transcriptSummary` puts a summary today.
  - Their text renders as it does now: as React elements, never HTML (`dangerouslySetInnerHTML` appears nowhere in the renderers).
  - Links in citations and attachments must be http(s), or they're dropped.
  - Images must be PNG, JPEG or WebP by their bytes (`imageInfo`), within a size cap.
- **Permissions:** only `block` decisions come in.
- **Settings:** the preview names each one that would change. They come in by default for a new profile. For a profile with data they're off until you turn them on (open question 2), since a file could turn off ad blocking or Safe Browsing.
- **Everything else is checked the way a restore checks saved data,** before it reaches the store: types, lengths, addresses, allowed values, references. Lines over 32 MB and files over 2 GB are refused.

## 6. Sync's folder protocol

```
<the folder you pick>/Chord sync/
  sync-1.json                          KDF, salt and key check, written once
  1/9f2c4e1a7b3d5c60/000001.chordlog   this computer's log, in segments
  1/9f2c4e1a7b3d5c60/000002.chordlog
  1/03be7d1c55a2e9f4/000001.chordlog   another computer's log
```

`1` is the passphrase generation (see *Changing the passphrase*). A computer writes only in its own folder.

**Writing.**
- Your changes to synced things are stamped in chord-data as they're saved (§7).
- Chord writes them about 3 seconds after the last change, and on quit, as one frame appended to the newest segment, then flushed.
- A segment closes at 1 MB and is never touched again, so a sync app uploads each closed segment once.
- Each segment starts with a `device` record: the computer's name, OS and Chord version.

**Reading.**
- Chord watches the folder where the OS allows it. It also looks every five minutes and whenever Chord comes to the front. ⚠ Watching cloud and network folders isn't reliable.
- For each other computer, Chord remembers how far it has read each segment.
- **A frame that's cut short, or that fails its check at the end,** means the sync app hasn't delivered all of it yet. Chord stops there and tries again at the next change.
- **A segment that got shorter** (a sync app delivered an older copy) is read again from the start. Merging twice changes nothing.
- **Names that aren't `NNNNNN.chordlog` are ignored.** That covers temp files and the *conflicted copy* files sync apps make.
- **Files a sync app keeps online only** are downloaded when Chord reads them. ⚠ This covers OneDrive and Dropbox on demand, and iCloud's optimized storage; older macOS uses `.icloud` placeholder files, which Chord would have to ask for. Setup suggests keeping the folder on the computer.

**Compaction.**
- **When it happens:** at most daily, once a computer's own segments pass twice the size of a snapshot, or 500 frames.
- **What it writes:** a new segment holding everything that computer knows: every live thing and every tombstone, each field with its stamp, from its own changes and other computers' alike.
- **Then:** the new segment is marked as a snapshot that replaces the computer's earlier segments, and the computer deletes them. So any one computer's log is enough to start from.
- **Out-of-order delivery is safe.** A reader that sees the deletions before the new segment arrives has lost nothing: it merged the old segments already.

**A new computer joins.**
1. In Settings → Your data → Sync, *Turn on sync…*, then pick the folder. Chord finds `Chord sync` and asks for the passphrase; the key check catches a wrong one.
2. Chord reads each computer's newest snapshot and what came after it, and merges them.
3. If this computer has only its first-run setup, the synced setup replaces it. If it has its own chords, pinned tabs or Favorites, Chord asks:
   - *Use the synced setup:* this computer's chords go, with Undo, and its Today tabs move to the first synced chord.
   - *Keep both:* everything stays, side by side. This computer's things are stamped with their rows' `updated_at`, not with the time of joining, so its settings don't overrule the synced ones just because it joined last.
4. The computer writes its first segment: a snapshot, plus its `device` record.

The first computer writes `sync-1.json`. If two computers set up the same empty folder at once, the second finds two of them (one as a conflicted copy) and stops: *Set up sync on one computer first, then join from the others.*

**Removing a computer.**
- In Settings → Sync, on that computer's row, *Remove*. This writes `removed: true` to its `device` record.
- The next time the removed computer syncs, it stops, keeps its own data, and says *This computer was removed from sync on Nov 30.*
- Its changes up to then still count everywhere, so every computer ends up the same whatever order they hear things in.
- Once it's removed, any computer that has compacted since may delete its folder.
- Removing doesn't take the key away from a lost laptop; changing the passphrase does, and the *Remove* line says so.

**Turning sync off** on a computer removes it, from itself. Its data stays.

**Changing the passphrase** starts generation 2: a new `sync-2.json`, and this computer's snapshot under `2/`.
- The other computers find a generation they can't open, and pause: *The passphrase was changed on Austin's MacBook. Enter the new one to keep syncing.*
- Each deletes its own `1/` folder once it has moved, and the computer that changed the passphrase deletes `sync-1.json` after 30 days.
- **A lost passphrase** works the same way, through *Start over*. The synced copy is gone; each computer's data isn't (D14).

**Two computers with the same id** (a profile folder copied to a new computer): before appending, a computer checks that its newest segment ends where it left it. If it doesn't, another computer is writing under the same id, so this one takes a new id and joins again.

**A newer Chord on another computer** (a higher `format`, or a cipher this one doesn't know): this computer pauses with *Another computer has a newer Chord. Update this one to keep syncing.*

## 7. Where the work runs

Main only routes, as performance rule 1 asks.

**Export runs in a short-lived utility process,** like browser import. *Built 2026-10-26 as written here* (ARCHITECTURE.md §9, *Your data: export*).
- Main flushes pending writes and shows the OS's save dialog (async). It then starts *Chord Export* with the database path, the Duet images folder, the target, the options and the passphrase, if there is one. Main never holds the data.
- **The process opens `chord.db` itself, read-only** (`node:sqlite`'s `readOnly` option), in one read transaction. WAL gives it a steady snapshot while chord-data goes on writing. ~~⚠ A second, read-only connection from another process is standard SQLite, but Chord hasn't tried it yet.~~ *Checked 2026-10-26* (§11): the snapshot holds, chord-data's writes neither fail nor wait, on Node 24.19 and on Electron 45's own Node, and in the export process itself in the E2E container.
- It streams rows (`StatementSync.iterate()`) through core's record functions into frames, writes to `<name>.part`, and renames that when done.
- It sends progress at most 10 times a second, then exits and gives its memory back.
- chord-data's thread does nothing for it, so command bar searches keep their 16 ms.

**Import runs in the same kind of process,** since a file from elsewhere is untrusted work, like another browser's files.
- It reads, decrypts and checks every line, and makes the preview's counts.
- **Setup:** on *Import*, it asks chord-data, over a port, for this computer's stamps for the ids in the file, and decides what wins. It sends main the setup in parts of 200 things, as `data.merge` commands: like `import.add`, plus updates, with what they replaced kept for Undo. *As built (§12):* it reads this computer's stamps itself, over a read-only connection of its own as the export process reads, so chord-data's thread does nothing for a preview or a plan.
- **History and Duet** go straight to chord-data over a port, in batches, never through main, as browser import's history does.
- **Effects** go to main's Effects service, which sends each through its sanitizer worker.

**Sync runs beside chord-data.**
- **The folder work** (watching, reading, writing, scrypt, AES) runs in a worker thread in chord-data's process. A slow cloud folder or a big snapshot never touches the thread that answers searches, and nothing runs while sync is off. ~~⚠ Worker threads inside a utility process are untried in Chord. The fallback is a utility process of its own with a port to chord-data, as import has.~~ *Checked 2026-10-26* (§13): they work, `node:sqlite` in them too, so the fallback wasn't needed.
- **chord-data's own thread owns the sync tables.** It stamps your changes in `write()`, in the same transaction, and merges what the worker read in slices of a few milliseconds.
- **Things whose winning value changed go to main as one push.** Main applies them as a `sync.apply` command: no Undo toast, and nothing written to the log. A quiet toast appears only when something you're looking at goes away, such as the chord on screen.

**The change to packages/data is moderate, and additive.**
- **Migration 17 (with export; Effects' switches took 15 and proxies 16, so this was 16 before):** `updated_at` on `setting`, `favorite` and `link_route`, set on every write that changes the row, plus a small `meta` table for the device id. *Built 2026-10-26.*
- **`export.ts`:** turns rows into records over a read-only connection, for the export process. *Built 2026-10-26*, with `rows.ts` (rows as the model has them, shared with `db.ts`) and `crypto.ts` (Node's primitives for core's container).
- **Import:** `importHistory` learns to skip visits it already has. A new `duet.import` op adds threads, messages and images, with Undo bookkeeping like `import_page`'s. *As built (§12):* `importDuet` adds threads and messages by id (temporary `import_thread` and `import_message` for Undo); the import process writes the images; migration 18 marks a chat that came from a file.
- **Migration 19 (with sync; it was 17, then 18 until import took 18, §12):**
  - `sync_record` (type, id, fields JSON, stamps JSON): the merged copy;
  - `sync_outbox`;
  - `sync_cursor`: how far each segment has been read;
  - the clock, folder and generation in `meta`.
- **A hook in `write()` for synced kinds:** it diffs against `sync_record`, stamps what changed, and queues it. Without sync it's off and costs nothing.
- **Core gets the pure parts:** the record codecs for each type, the clock, the field merge and the settle step. They're table-tested without Electron.

**Performance checks** go into `perf.spec.ts`:
- the 50,000-visit export while typing in the command bar: the keystroke budget holds, and main's event-loop delay is unchanged;
- the export's wall time;
- with sync on, the cost of one change (stamp to frame), and memory with the sync worker on and off.

## 8. UI sketch

Settings → **Your data**, in place of today's Import, which moves in as a group (open question 5). Copy is in italics.

**Export**
- The row: *Export your data*, with *Everything in Chord in one file you can keep, read, or bring to another computer.* and **Export…**
- **Export…** opens a card under the row, not a dialog:
  - *What goes in:* *6 chords · 214 pinned tabs in 18 folders · 31 Today tabs · 24 Favorites · 3 themes · 12 link routes · Effects for 9 sites · your settings.*
  - Switches, both on: *History* (*15,002 pages*) and *Duet chats* (*20 chats, 4 images*).
  - A switch: *Encrypt with a passphrase*. On, it shows two fields and *Suggest one*, with *Chord can't open the file without it, and can't get it back for you.*
  - Off, with history or chats included: *Anyone with the file can read it.*
  - **Choose where to save…** opens the OS's save dialog at *Chord data 2026-11-30.jsonl* (or `.chorddata`).
  - While Chord writes: a 4 px accent bar and *Writing history: 8,000 of 15,002 pages*. Then *Saved Chord data 2026-11-30.jsonl, 3.8 MB* and *Show in folder*.
  - If it can't save: *Chord couldn't save there. Choose another place.* **Choose where to save…**
- *As built 2026-10-26* (DESIGN.md §8.8), with these additions: the two fields are *Passphrase* and *Again*; *Suggest one* puts its words in both and shows them, with *Five words at random. Write them down, or keep them in your password manager.*, and typing hides them again; a field's problem shows once you've left it (*At least 12 characters.* · *The two don’t match.*); the line under the bar says *Locking the file with your passphrase…*, *Writing your setup…*, *Writing Today tabs…* and *Writing Duet chats: 3 of 20 chats* too; two more problems: *Chord couldn’t read your data to write the file. Choose where to save to try again.* and *Chord is still writing your last export. Try again when it’s done.* The passphrase fields empty once a file is saved.

**Import**
- A row: *From a Chord file*, with *Bring back an export, here or on another computer. Nothing here is removed.* and **Choose a file…** (*As built 2026-10-26*, DESIGN.md §8.8: as sketched here, with the additions in §12.)
- A row: *From another browser*: today's panel, unchanged (DESIGN.md §8.7).
- After you choose a file:
  - *Reading Chord data 2026-11-30.chorddata…*
  - If it's encrypted: *This file is encrypted. Enter its passphrase.*, a field and **Open**. A wrong one: *That passphrase doesn't open this file.*
  - The preview: *From Austin's ThinkPad, exported Nov 30.* Then *New: 2 chords, 40 pinned tabs, 3 Favorites, Effects for 2 sites. Newer than yours: 5 tabs, 1 theme. Everything else is here already.*
  - Switches:
    - *History* (*3,000 new pages*);
    - *Duet chats* (*20 chats*);
    - *Effects*, which lists the sites;
    - *Settings from the file*, which names each change: *Search engine: DuckDuckGo → Google*.
  - Under them, small: *Tabs stay unloaded until you open them. Sites you'd allowed to use your camera, microphone or location ask again.*
  - **Import**. Then *Imported 2 chords, 40 tabs, 3 Favorites and 3,000 pages of history.* The window's toast says the same with **Undo**, and Settings has **Undo** too.
- Problems, each in a soft card with one button:
  - *Part of this file is damaged. Chord can bring in what it read: 6 chords and 200 tabs.* **Import what's readable**
  - *This file is from a newer Chord. Update Chord to import it.* **Check for updates**
  - *That isn't a Chord file.*

**Sync (later)**
- Off: *Sync your setup*, with *Chords, pinned tabs, Favorites, themes, settings, link routes and Effects, the same on each of your computers, through a folder you already sync: iCloud Drive, Dropbox, OneDrive or Syncthing. History and Today tabs stay on each computer.* and **Turn on sync…**
- The steps, in the card:
  1. **Choose a folder…** with *Pick a folder your sync app keeps on every computer. Chord adds a "Chord sync" folder inside.*
  2. For a new folder: *Choose a passphrase. Everything Chord puts in the folder is encrypted with it, and you'll type it once on each computer. Lose it and the synced copy can't be opened; what's on each computer stays.* Two fields, *Suggest one*, and **Start syncing**.
     To join: *This folder syncs 2 computers: Austin's MacBook and Austin's Desktop. Enter your passphrase.* and **Join**.
  3. Only if this computer has its own setup: *This computer has its own chords.* Then *Use the synced setup* (*This computer's 3 chords go. You can undo this.*) or *Keep both*, and **Continue**.
- On: *On · Dropbox › Chord sync · Up to date*, or *Last change from Austin's MacBook, 2 minutes ago*.
  - A list of the computers, each with its name (this one's can be edited), its system and when it last synced, and *Remove* on the others.
  - *Pause* · *Change passphrase…* · *Turn off*.
- Problems, one card at a time:
  - *Sync is paused. Enter your passphrase.* **Unlock**
  - *The passphrase was changed on Austin's MacBook. Enter the new one to keep syncing.* **Unlock**
  - *Chord can't find the sync folder. Is your sync app running?* **Choose folder…**
  - *Another computer has a newer Chord. Update this one to keep syncing.* **Check for updates**
  - *This computer was removed from sync on Nov 30.* **Turn on again**
- *Remove* and *Turn off* take effect when their toast's Undo runs out (6 s), so Undo has nothing to write.
- Sync shows nothing in the sidebar. Only a problem that needs you gets a toast, once.

## 9. Build order and tests

As the maintainer prefers: a few journey E2Es, which run in the Linux container and CI, never on the desktop, plus table-driven unit tests. ⚠ The durations are estimates.

**1. Export** (about a week) · **built 2026-10-26** (§11)
- **What's built:**
  - in core: the record codecs, the clock (for stamps from rows) and the encrypted container;
  - migration 17 (it was 16), `export.ts` and the export process;
  - Settings' card and `docs/data-format.md`.
- **Unit tables:**
  - model → record → model for every type, including the fields that must never appear: back/forward state, live state, private chords;
  - the container: the right and a wrong passphrase, a flipped byte in the header or in a frame, frames swapped, dropped or cut short, a newer `format`, an unknown KDF.
- **The journey:** a seeded profile exports plain and encrypted. The plain file's lines parse and hold what was seeded, and the encrypted file opens with the passphrase only.
- **Performance:** the 50,000-visit export while typing in the command bar.

**2. Import** (about a week) · **built 2026-10-26** (§12)
- **What's built:** `data.merge` and its Undo, history dedupe, `duet.import`, the import process and the preview.
- **Unit tables:**
  - the merge planner: a new profile, a profile with data, older and newer stamps, something deleted here, tombstones in a file, duplicate Favorites, settings on and off, and `allow` permissions dropped;
  - hostile files: the Effects sanitizer's table of hostile stylesheets (reused), `javascript:` links in Duet citations, something that isn't an image in an image record, a huge line, unknown types.
- **The journeys:**
  - Export, then import into a new profile. Check the sidebar, Favorites, a site's Effects applied, history in the command bar and a Duet chat. Then Undo removes it all.
  - Once more, into a profile with data.

**3. Sync** (two to three weeks) · **built 2026-10-26** (§13)
- **What's built:** migration 19 (it was 17, then 18), the stamping hook, the worker, the folder protocol, and Settings.
- **Unit tables:**
  - the clock: behind, ahead, equal, the counter;
  - the field merge: concurrent edits, edit against delete, bringing a thing back, the same tab moved twice, a cycle, equal ranks, settings that conflict, unknown types kept and written back;
  - a property test that merging any set of logs, in any order and any number of times, gives the same result;
  - the folder protocol against an in-memory filesystem: a half-written frame, a shorter file, conflicted copies, compaction mid-read, a removed computer, a copied id, a newer format, a changed passphrase.
- **The journey (Linux container):** two Chords with separate profiles share one temp folder. Set up sync on one, join on the other, edit on both, and check they agree. Then try a wrong passphrase, and remove one.
- **By hand:** real iCloud Drive, Dropbox, OneDrive and Syncthing, between Windows, macOS and Linux, from a checklist in `docs/testing/sync.md`.

## 10. Open questions

**Decided 2026-10-25: all ten as recommended.**

1. **Plain export by default?** You proposed it, and **I agree** (§3). The only addition is the *Anyone with the file can read it* line when history or chats are included.
2. **Settings from a file, into a profile with data: off until you turn them on, or on like the rest?** **I recommend off,** with each change named: a file can turn off ad blocking, Safe Browsing or Google-free mode.
3. **Site permissions: export them and import only blocks, or leave them out entirely?** **I recommend export, with blocks only on import.**
4. **Which settings sync?** The table in §1 is my call. The doubtful ones:
   - interface size, which stays per computer;
   - motion and tab sleeping;
   - *keep screenshots* and *page previews*, which sync, so turning either off on one computer deletes those pictures on the others too;
   - Safe Browsing with its notice answer.

   **I recommend the table as it is.**
5. **One Settings page: fold today's Settings → Import into *Your data*** (Export; Import from a file or from another browser; Sync)? **I recommend yes:** one place for your data, in and out.
6. **Linux without a keyring: ask for the passphrase after every launch, or offer *Remember on this computer anyway*,** which stores the key where any program you run could read it? **I recommend asking,** with that option behind a plain warning.
7. **KDF: scrypt now (built in), or Argon2id through WebAssembly from the start?** **I recommend scrypt** at N=2¹⁷. The header lets a later Chord move on.
8. **Duet images in exports:** **I recommend including them,** counted on the switch, since they can be most of the file.
9. **Passphrase length:** **I recommend at least 12 characters,** with *Suggest one*.
10. **Tombstones forever in v1, and extensions left out of v1:** **I recommend both.**

## 11. Building export: what it decided and found (2026-10-26)

Step 1 is built as §1–§3, §7 and §8 say, apart from what's here. [docs/data-format.md](../data-format.md) is the format as built.

### Decided

- **Proxies: exported as settings, never synced.** Two arrived after this was written: Settings' proxy for every chord (`settings.proxy`) and a chord's own (`chord.proxy`, ARCHITECTURE.md §9 *Proxies*). I agree with the suggestion, by §1's principles:
  - *Exported*, because it's setup you typed (a server, its port, the addresses that skip it, a PAC file's address), and a restore, here after a reinstall or on a new computer, should bring it back. The proxy for every chord is the `proxy` field of the settings record, whole; a chord's own is its `chord` record's `proxy` field (`null` for the proxy for every chord), which restore's rule keeps only on a chord with its own sign-ins. Neither holds a password: there's no field for one (D12).
  - *Never synced*, because it's about the network this computer is on, and a wrong one fails closed: Chord sets proxies with no direct fallback, so a laptop's corporate proxy or a `127.0.0.1:1080` SSH tunnel synced to a desktop at home would stop every page there. It's a new row in *Which settings travel*: "Exported, never synced". Sync leaves `chord.proxy` out of chord records.
  - *On import* (step 2): a proxy is a setting like any other, named in the preview (*Proxy for every chord: system's → SOCKS5 proxy at 10.0.0.2:1080*), on for a new profile and off until you turn it on for a profile with data (question 2). A chord's own comes in with its chord only when *Settings from the file* is on, since it decides whether that chord's pages load at all.
- **Effects' per-item switches** go in as §1 had them (`cssOn`, and `on` inside `hidden` and `duet`), and read as on when missing.
- **Which fields a setting is.** A group that a settings change merges part by part (`SettingsPatch`'s nested `Partial`s: motion, interface, spelling, ad blocking, tab counts, Duet, reader view, Effects) is a field per part, with dotted names; a value that's replaced whole (the proxy, a list, a family's shortcuts) is one field. Every key of `Settings` says how it travels in `SETTING_TRAVEL` (core's `records.ts`), typed so that a new setting doesn't build until it does. *Encrypt with a passphrase*, which Chord remembers (§3), is a new setting, `encryptExports`, exported and synced.
- **Stamps from rows.** A row's `updated_at` moves only when its value changes (migration 17's columns; chords' and nodes' already moved on every write). A row from before migration 17 has 0: when it last changed isn't known, so it's older than anything a file has.
- **The encrypted file, exactly:** the frames' plaintexts are the plain file's lines after its header, the end line included, so a decrypted file reads as a plain one. A frame's length counts the bytes after it (nonce, ciphertext, tag). Its associated data is the SHA-256 of the header line without its `\n`, the index as 8 bytes big-endian, and one byte for the last frame. `check` is a nonce, then `chord` sealed with the check key and no associated data. A reader passes over a frame that fails its check (each stands alone), so *Import what's readable* gets everything else; frames swapped or dropped fail from there on, by their index.
- **Readers refuse what costs too much:** a key derivation needing more than 256 MiB (or that scrypt won't run: N < 2^(16·r)), a frame over 40 MiB, a frame that inflates past 48 MiB, a line over 32 MiB, a file of more than 2 GiB of lines; they parse a frame's lines as it comes, never the whole file as one string, and never throw. A key derivation Chord doesn't know or won't run reads as *newer*. Plain files may have `\r\n` endings (JSON's whitespace). The end line is any object with a whole-number `end` and no `type`, so format 1 can add to it.
- **Writers keep to the readers' limits:** a record whose line would pass 32 MiB (a huge image Codex made, say) is left out, and *Saved* says how many were.
- **The envelope has a version of its own** (`chord-encrypted 1`), apart from the records' `format`: a new record format needn't change how files are sealed, nor the other way round.
- **Never a password, even in a proxy's PAC address:** one there is taken out on export. A PAC file on this computer (`file:`) is kept, as the setting it is. Tabs read from a file take only web addresses and the archive page (`chord://archive/`).
- **Order inside setup:** chords, then Pinned in the sidebar's order (a folder or split before what's in it), Favorites, themes, settings, routes, Effects, zoom, permissions.

### Found

- **⚠ A second, read-only connection from another process: works.** A writer as chord-data keeps the database (WAL, `synchronous=NORMAL`) committed a batch every 50 ms while a read-only connection (`readOnly: true`) held one read transaction for 1.5 s and read 50,000 visits joined to 15,000 pages. The reader's counts didn't move while the writer added rows; the writer never failed or waited (its worst batch 1.9 ms on Node 24.19, 2.5 ms on Electron 45's Node 24.22 through `ELECTRON_RUN_AS_NODE`); the read took 70–77 ms; a write through it was refused; and it opened with no other connection and no `-wal` or `-shm` too. `data/test/export.test.ts` keeps the snapshot check.
- **⚠ `node:sqlite` in a utility process other than chord-data: works** (the export process in `your-data.spec.ts`, Linux X11 in the container, reading while chord-data had the database open). Worker threads inside a utility process (sync's) are still unchecked.
- **⚠ Decrypting with Python: works.** docs/data-format.md's reader (Python 3.12, `cryptography` 44, `hashlib.scrypt`) gave a Chord-written file's records and end line back byte for byte, with the passphrase typed composed or decomposed; a wrong one failed.
- **⚠ SQLite reading 50,000 visits:** 70–77 ms (above). **The whole export**, measured by `perf.spec.ts` (*export: 50,000 visits while typing in the command bar*) in the Linux container on 4 CPUs (CI's runner size), on a generated profile of 50,000 visits on 15,001 pages and 61 Today tabs, from the click to *Saved*:
  - **Plain: 209 ms** (median of 23 exports run one after another; the slowest 236 ms), **2.44 MB**.
  - **Encrypted: 787 ms**, about 500 of them scrypt; **241 KB**. The generated titles repeat, so they deflate about ten to one; real ones won't (§2's estimate is nearer three to one).
  - **While typing** 35 letters in the command bar, every keystroke during an export: history's results committed in at most 10.7 ms (8.6 typing alone), within their 16 ms; rows from memory were never late; the shell's and the command bar's worst frame 7.6 ms (6.4 alone), their longest task 5.6 ms. chord-data, which answers those searches, never waits on the export.
  - **Main:** its longest task went from 1.6 ms to 5.2 ms, once per export, and nearly all of it is Electron's `utilityProcess.fork` (0.3–4.8 ms on main, measured); its busiest 30 ms held 11.3 ms of tasks (3.5 alone). Its process CPU time came to about 17 ms per export, every thread included. A 5 ms timer's worst delay is too noisy to judge in the container (8.5 to 28 ms typing alone, across runs), so it's reported, not held.
- **The line in §1 that called icons never synced** contradicted the table; corrected there.

### Not done here

- **⚠ The Flatpak, saving outside Downloads.** Its only folder of the user's is Downloads (`--filesystem=xdg-download`), so a file saved elsewhere comes back through the document portal, which lets Chord write the file it chose and nothing beside it. When `<name>.part` can't be made there (`EACCES`, `EPERM`), the export writes the chosen file in place. Not tried in a Flatpak.
- ~~`readDataFile` reads a whole file into memory; step 2's import process, which takes files up to 2 GB, should read frames as they come.~~ *Done in step 2* (§12): `openDataFile` and a stream read a file as it comes; `readDataFile` is the two at once.
- ~~*From a Chord file* is a row with no button: step 2 gives it **Choose a file…** and the preview.~~ *Done in step 2.*

## 12. Building import: what it decided and found (2026-10-26)

Step 2 is built as §5, §7 and §8 say, apart from what's here. ARCHITECTURE.md §9 *Your data: import* has the flow, and a table of where each rule about untrusted input is enforced; DESIGN.md §8.8 has the card.

### Decided

- **This computer's side is read, not asked for.** The import process reads this computer's setup as the export process does, over a read-only connection of its own (`@chord/data/import-file`), after main writes what's pending; §7 had it ask chord-data over a port. So chord-data's thread does nothing for a preview or a plan. Both sides are records, and the merge is records against records, field by field (`core/merge.ts`, `planMerge`): the pure step sync will use.
- **A new profile** is only a clearly fresh Chord: the one chord first run made, with no more Today tabs than first run opens (one) and nothing pinned; no folders, splits, Favorites, themes, routes, Effects, page zoom or permissions; no Duet chats; at most 20 pages of history (`FRESH_PAGES`); and every setting at its default, but for what first run sets (Safe Browsing's notice answered, pop-out videos off). In doubt, it's a profile with data: *Settings from the file* starts off and nothing makes way. (As first built, Today tabs, history, chats and settings didn't count, so a long-time user with nothing pinned had the switch start on and their chord replaced; a security review found it.) The first-run chord makes way: its tab goes to the top of the file's first chord's Today, windows on it go there showing what they showed, and the chord goes. Undo brings it back as it was.
- **Tombstones in a file are ignored both ways:** a thing whose newest `deleted` is `true` neither comes in nor is deleted here. Ignoring only the field would bring back what the file's own computer deleted.
- **A setting still at its default counts as never set.** A profile writes every setting at its first save, so each has a stamp newer than any file made before it, and a file's would never win. A setting at Chord's default here takes the file's, whatever the stamps; one you've changed is weighed by its stamp. *Settings from the file* is off for a profile with data, so each change is named before it can happen.
- **Settings are checked together:** the file's winning fields over ours, through restore's own checks (`restoreSettings`). A value Chord can't use stays out (the default restore would put in its place isn't taken for the file's), and what changes with it is named too: Google-free mode moves search off Google. Main checks the patch again with `ImportedSettings`, the schema Settings' own changes pass (with *Safe Browsing's notice answered* and reader view, which travel but which no Settings row sets alone), and `settings.set` applies it.
- **A chord you have keeps its sign-ins.** `profile` never changes on a chord here: changing it signs the chord out of every site. A new chord whose own sign-ins share an id with a chord here gets a new one, and a private window's profile id is refused (in the codec and in the reducer).
- **Duet** (migration 18, `duet_thread.imported_at`; sync's tables move to 19):
  - Any chat's earlier turns, an imported one's or not, reach a provider session that hasn't seen them (a chat's first from a file, one that can't resume, the other provider's after a switch) only at the start of your message, as JSON marked untrusted (`earlierTurns`: what you and Duet said, newest kept, never tools' details). Never in the instructions, which are Chord's words alone, with a line saying what such a block is: a file can say anything, and Duet's own replies can carry what pages said. §5 asked for this for imported chats; before, a chat with no session started with nothing of its past, and a failed resume put a summary (`transcriptSummary`, gone now) in the instructions, for every chat.
  - **A chat continued on another computer doesn't gain its new turns by import; sync is for that.** A message comes in only to a chat the same import adds: never to one that's here, made here or brought by an earlier import, which a file could otherwise fill with turns you never had.
  - It reads no more than a new chat would: the narrower of its scope and Settings' (a file can't make a chat read all your tabs). An approval in it grants nothing; grants live only in a session.
  - Its links open only web pages, checked when read (`messageFromRecord`) and again where they open (a citation, a tab's name).
  - Its images are written by the import process beside Duet's own, only if their bytes are the type they say (`imageInfo`), only for messages in the file, and only when no file of that id is here, of any type, nor its thumbnail. Each file (the picture, and the thumbnail apart) is named to main before it's written, and written only once main has kept the name and lets it go on (never once the import's stopped); one found there by the time of writing isn't written over, and main forgets it. Undo deletes exactly the names kept, each checked again to be an image file's name (`IMAGE_FILE`: 24 hex characters and a picture's or thumbnail's extension), never a path. (As first built, the files were recorded only from a reply the import was still reading, so an import stopped meanwhile left them, and Undo deleted both possible names of an id whether it wrote them or not.)
- **Every import skips visits Chord has** (the same page at the same millisecond), another browser's too: importing the same history twice adds nothing. A Chord file's `typed`, a count without times, takes the larger of the two.
- **The preview** says *From this computer* or *From another computer*: a file's header has a computer's id, not its name (names come with sync's `device` records). A damaged or cut-short file shows what could be read, and *Import what's readable* stands where **Import** would.
- **Proxies** are named in the preview with the settings (*Proxy for every chord: …*, *Work's own proxy: …*), and come only with *Settings from the file*, a chord's own included (§11). A chord's own comes apart from its chord, in a part's `proxies`, which the plan fills and main passes on only with the switch on; `data.merge` never takes a proxy from a chord in `chords`, new or here. (As first built, a chord whose name or colors changed took the proxy its record held, this computer's as an export writes it, without its password, with the switch off.)
- **One import at a time, of either kind** (`ImportGate`): another browser's and a Chord file's share one gate, and each answers `busy` while the other runs.
- **An import's Undo takes exactly its own visits.** Each batch is one transaction on chord-data's one connection, and its visits take the ids just above both the largest there is and the largest any import has had this session (an Undo frees the largest ids, which another import would otherwise take, inside the ranges a slower Undo is still working through). Undo deletes the import's visits by those ranges (`import_range`), 1,000 ids a transaction, and then puts each page right; before, one range from its first batch to its last could hold another import's.
- **A split comes in whole.** The plan lists folders and tabs depth first, so a split's tabs follow it, and `mergeParts` keeps a split and its tabs in one part: the store settles splits after every part, and one without its tabs went (with 250 Today tabs ahead of it, a restore lost its split and both tabs went to the root). So an import stopped between parts never leaves an empty split.
- **One import brings at most** 100 new chords, 10,000 new tabs (a split counts as one) and 2,000 new folders, in the file's order, and folders nest at most 16 deep: one deeper comes in at its section's top level, with what's in it (`IMPORT_LIMITS`). A chord here, or a tab or folder, is updated whatever the count. No profile comes near; the preview's small print says what's left out (*3 chords and 40 tabs will be left out: …*).
- **What's kept of a file until the plan** is only the fields the plan reads of each setup record (`setupRecord`; for settings, the ones Chord knows), at most 100,000 records and 64 M characters of them; past either, the rest of setup isn't read, and the preview says the file is damaged. A page's visits come in newest first, at most 10,000 (`MAX_PAGE_VISITS`), and 1,000 at a time over as many batches as it takes, so a page of millions is never one transaction (`pageShares`). A page counts once in *pages of history* however many batches bring it.

### Found

- **⚠ A Node `Buffer`'s `slice` is a view of the same memory, not a copy** (a plain `Uint8Array`'s is a copy). The reader kept a line's first part with `slice`, and on the import process's reused `Buffer` the next read overwrote it: one record lost at each megabyte's boundary (`perf.spec.ts` counted 15,000 pages of 15,001). It copies explicitly now, and the unit tests read through a reused `Buffer`, as the process does.
- **Performance** (`perf.spec.ts`, the Linux container on 4 CPUs; ARCHITECTURE.md has the numbers as built). The first version imported 50,000 visits in 947 ms and undid them in 661, and a keystroke's search waited up to 80 ms. What changed:
  1. Each page's update set its title, unchanged too, and setting it fires the full-text index's trigger, which rewrites the page's search entry. Now the title is set only when an untitled page gets one, in Undo too.
  2. Undo comes in slices of 100 pages, each a transaction, with chord-data answering searches in between (`undoImportSlice`).
  3. History comes in batches of 50 pages or 1,000 visits: 1–2 ms each, measured directly (100 took up to about 12 ms in the container).
  4. SQLite's checkpoints, which copy the write-ahead log into the database on chord-data's thread, took about 20 ms each at SQLite's 1,000 pages. While an import writes (its batches, its Undo) they come at 250 pages: about 10 ms each, for about half as long again in all (measured directly, on Windows).
  5. Progress goes to main at most ten times a second, and the import process runs below normal priority.

  Result, over two runs: 550–600 ms to import, 340–360 ms to undo, main's longest task 4–6 ms, the shell's and command bar's frames in budget (into a profile with data); export's own check unchanged (214 ms plain). ⚠ **Left:** during an import, up to four of 35 keystrokes' searches wait past 16 ms, at most about 20–25 (at most 10 typing alone): checkpoints, and the import process sharing 4 CPUs. Running checkpoints from the import process's own connection, off chord-data's thread, would be next. And a restore's switch to the file's chord mounts that chord's sidebar in one task (24.5 ms with 61 Today tabs), as switching to it would.

  After the security review's fixes (ARCHITECTURE.md has the numbers): into a profile with data, unchanged within the runs' noise, with Undo taking visits back by the ids each batch took, 1,000 at a time (a first try, a lookup per visit, took 840 ms). Into a new profile, now a clearly fresh one with 16 pages of history, every page is new: 1.1–1.3 s to import and 0.9–1.0 s to undo.
- **The journeys pass on X11 and Wayland** (`your-data.spec.ts`), and the whole suite on X11.
- **A security review of the first version found seven things,** each fixed as *Decided* says: turns a file could add to a chat that was here; a split lost on an ordinary restore; one import's Undo taking another's visits; a chord's proxy changing with *Settings from the file* off; Undo deleting an image file the import hadn't written, and leaving ones it had when stopped; no limit on what setup a file brings, or on a page's visits in one write; and *Settings from the file* starting on, the first-run chord making way, for a long-time user with nothing pinned. It found sound: what addresses are let in, permissions as blocks only, sign-ins, image paths, scrypt's and inflate's bounds, Effects, imported chats' turns as data with a narrower scope, folders inside each other, and settings through `ImportedSettings`.

### Not done here

- **Undo from Settings lasts while its card is open,** and the toast's while the toast shows: as browser import's (§5 says *for the rest of the session*; neither keeps the button once its view is gone).
- **⚠ The Flatpak:** a file chosen outside Downloads comes through the document portal, which allows reading the file chosen; not tried in a Flatpak.
- **⚠ Big files:** reading is linear, a megabyte at a time, and the setup kept is capped (above); measured to 3.1 MB. A 2 GB file of images wasn't tried.

## 13. Building sync: what it decided and found (2026-10-26)

Step 3 is built as §4, §6, §7 and §8 say, apart from what's here. ARCHITECTURE.md §9 *Your data: sync* has the flow, and a table of where each rule about untrusted input is enforced; DESIGN.md §8.8 has the card; [docs/data-format.md](../data-format.md#syncs-folder) has the folder's format.

### Decided

- **The worker thread, in chord-data's process, as §7 has it.** Checked first (below), so §7's fallback, a utility process of its own, wasn't needed. The worker does the folder work; chord-data's thread owns the tables, merges a slice at a time, and pushes what changed to main.
- **`sync_record` keeps three things per thing:** each field's value and its stamp (§7's fields and stamps), and `local`, what this computer last wrote of it. The stamping hook compares the model with `local`, not with the merged value, so it stamps only what you changed. Main marks the writes of what another computer changed (`WriteOp.sync`, from `sync.apply`); the hook takes those as `local` only, so another computer's change never goes into this computer's log (§4), even if this computer's checks tidy it differently. A change of yours to the same thing, still waiting to be written, keeps its own mark, and wins.
- **A change of yours waiting puts off another computer's to the same thing.** Main doesn't apply the incoming one over it; once yours is written and stamped, main asks chord-data for the thing again (`sync.repush`). Otherwise an edit made in the 250 ms before a push could be lost.
- **Equal stamps:** the larger value (its JSON with keys in order) wins, so the merge stays commutative even for a log that repeats a stamp. **Icons are facts:** the first copy of an id stays, and any stamp on one is dropped.
- **A stamp more than a year ahead is refused.** §4 says a clock far ahead can't be corrected when reading; a year bounds a broken or hostile clock that would otherwise drag every computer's clock with it (and its counter past 32 bits). Two computers whose clocks differ by about a year could disagree about a stamp right at the edge; no other.
- **A chord you have keeps its sign-ins,** as import decided (§12). `profile` is carried and merged, but applied only to a chord that's new here, and then only if no chord here has those sign-ins; a chord here never changes its sign-ins, or its proxy, through sync.
- **Joining asks for the passphrase by how many computers sync, not their names:** the names are inside the encryption, so §8's *Austin's MacBook and Austin's Desktop* can't show before it opens. They show in the list once it does.
- **Joining, decided:**
  - a clearly fresh Chord (import's rule, `isFreshSetup`) takes the synced setup without asking, and its first-run chord makes way without a toast;
  - *Use the synced setup:* this computer's chords, and what's pinned in them, go, kept for Undo this session (`sync.replace`; the window's toast's Undo is `sync.unreplace`), their Today tabs to the top of the first synced chord's Today; its Favorites, themes, routes and Effects join; its settings count as older than any synced one;
  - *Keep both:* everything joins, each thing with its row's stamp. A setting still at its default counts as never set (stamped older than anything), as an import's does (§12), so a new computer's defaults don't overrule your synced settings for being written at its first launch.
- **The first computer's things** go in the same way, by their rows' stamps, and its first segment is a snapshot (so is every computer's first in a generation).
- **Turn off and Remove happen when their Undo runs out** (6 s), as §8 says: main holds them; the window's toast and Settings' card both offer Undo. Turning off writes this computer's `removed`, written to the folder before it stops.
- **Problems:** one card at a time in Settings, and a toast once per kind per session, with *Sync settings* to open it. *Missing* (the folder isn't there) keeps looking at every poll and focus.
- **Moving to a new generation** (the passphrase changed elsewhere) is a folder operation of its own: no read of the old generation runs meanwhile. As first built, a read of the old generation found the new one, stopped the worker, and the snapshot being written under the new one never was; the E2E journey found it.
- **A copied id:** this computer takes a new id and writes a snapshot under it. The old id isn't marked removed: it's the other computer's now.
- **Limits** (`SYNC_LIMITS`, core's sync.ts): per type, in all, and per thing, sized far past S15 §2's realistic profile; a pass reads at most 64 computers and the newest 1,000 segments of each, at most 16 MB a step.
- **The folder on the disk** reads only regular files (a pipe under a segment's name would hold a read up for ever) and writes, appends and removes nothing that resolves outside `Chord sync` or goes through a link (a link planted in a shared folder could send Chord's writes elsewhere on the disk).
- **A pinned tab here off its home keeps its own title and icon** when another computer changes them: they're of the home page, which this one isn't showing.
- **A computer's name** starts as the computer's own (`os.hostname()`), and can be changed in the list.
- **Settings' *Change passphrase…*** asks for the new one twice, as Export does, and says the other computers pause until they have it.

### Found

- **⚠ Worker threads inside a utility process: work.** `spikes/s15-sync-worker` (Electron 45.0.0, Node 24.22.0, the Linux container): a worker thread in a utility process opened `node:sqlite` on the same file (read-only), ran scrypt at N=2¹⁷ in 530 ms, sealed 8 MiB with AES-256-GCM in 17 ms, deflated 4 MiB in 15 ms, and `fs.watch` fired, while the utility process's own thread answered a query every 2 ms, never more than 1.3 ms late. The process grew by 13 MB with the worker; built into Chord, chord-data's private memory went from 22.7 MB to 33.6 MB with sync on, and to 30.7 MB once it was off again.
- **Performance** (`perf.spec.ts`, the Linux container on 4 CPUs). One change costs `write()` 0.1 ms more (the hook 0.12 ms, worst 0.39), and its frame 4.6 ms on the worker. The first version of *keystrokes during a large merge* missed: history's results waited up to 62 ms, because:
  1. main's writes of what it had applied (300 sidebar nodes) were one transaction of up to 56 ms, and every search waited for them, since a search flushed pending writes first;
  2. reading what changed back for main was one task (9 ms for 300 things, and more for more);
  3. checkpoints on chord-data's thread took 10–70 ms;
  4. main applied parts of 200 back to back, and the shell took each in one frame.

  What fixed it: the hook skips reading what's merged for sync's own writes; searches and the archive flush only history's happenings (visits, picks, the archive), never the sidebar's writes, and a big flush goes 100 entities a transaction, chords first; what changed is read back 100 at a time, parents first, merged 100 records a transaction; while sync is busy, checkpoints run on the worker thread's own connection (passive ones), never on chord-data's (§12's *next* step, done for sync); main applies parts of 50, two frames apart. After: every keystroke's results within 16 ms (10.6 ms worst while joining, 10.5 during frames of 300 changes, 7.9 typing alone), chord-data's tasks at most 6 ms, main's longest task 4.4 ms, its busiest 30 ms 8.3 ms while joining and 17 ms during back-to-back frames of 300 changes, a frame a few times a second, far more often than a computer writes (every 3 s at most). ARCHITECTURE.md has all the numbers.
- **The shell takes a part of new chords in one task of up to 18 ms** while joining, mounting their sidebar, as an import's restore does (§12). The store's and the shell's cost per change grows with the nodes (ARCHITECTURE.md §9, *Known limit: very big imports*).
- **The journeys pass on X11 and Wayland** (`sync.spec.ts`): two Chords, one folder, set up, join, edit on both, a wrong passphrase, one removed; a passphrase changed, the other paused and moved, and in the container, which has no keyring, a relaunch asking for the passphrase again (§3).

### Not done here

- **By hand with real sync apps:** iCloud Drive, Dropbox, OneDrive and Syncthing, between Windows, macOS and Linux, from the checklist in [docs/testing/sync.md](../testing/sync.md). Not run: how each uploads, holds online-only files (and iCloud's `.icloud` placeholders on older macOS, which Chord doesn't ask for) and delivers half-written ones is still ⚠ untried, as is watching cloud folders.
- **Windows and macOS:** the journeys ran only in the Linux container; CI runs them on every OS. `safeStorage` with a real keychain (DPAPI, the Keychain, a Linux secret service) wasn't tried: the container has none.
- **⚠ The Flatpak:** a folder chosen through the document portal; not tried.
- ***Choose folder…*** on the missing-folder card (§8), for a folder that moved: the card has no button; turning sync off and on again picks a folder.
- ***Start over*** for a lost passphrase (§6): not built; turning sync off on each computer and setting it up again in a new folder does it.
- ***Remember on this computer anyway*** (question 6's option) for Linux without a keyring: not built; such a computer asks after each launch.
- **Each computer's own *last synced*** isn't shown for this one, and a removed computer leaves the list.
- **Effects' Duet patches get new ids each time another computer's change to their site is applied** (records carry none), as for an import.

## What was checked, and what wasn't

**Checked:**
- Electron 45.0.0's own Node (24.22.0), run on Windows: its crypto is BoringSSL. AES-256-GCM works. ChaCha20-Poly1305 and XChaCha20 aren't ciphers there. `argon2Sync` throws, and Web Crypto has no Argon2id. scrypt and HKDF work. Timings are as given above.
- Node 24's docs: zstd is experimental; `node:sqlite` has `readOnly`, `timeout` and `iterate()`; `crypto.argon2` arrived in 24.7.
- Electron's docs: `safeStorage` is main-only; its sync API goes in Electron 46; `basic_text` on Linux protects nothing.
- OWASP: N=2¹⁷, r=8, p=1 is its minimum for scrypt.
- The model, tables and functions named here, in the code as of `cd27baf`.

**Checked since, building export (2026-10-26, §11):** a read-only second connection to the live database from another process; `node:sqlite` in a second utility process; SQLite's time to read 50,000 visits, and the whole export's; decrypting a file with Python. **Building import (§12):** reading a file as it comes; importing and undoing 50,000 visits while typing; SQLite's checkpoints' cost at 1,000 and 250 pages. **Building sync (§13):** worker threads (with `node:sqlite`) inside a utility process; a change's cost from stamp to frame; chord-data's memory with the worker on and off; keystrokes while joining a realistic setup and during frames of 300 changes; checkpoints from a second connection on another thread.

**Not checked (⚠ above):**
- the sizes, which come from generated data (export's measured ones are generated too);
- how each sync app uploads, holds online-only files and delivers half-written ones;
- folder watching on cloud folders;
- `application/jsonl`'s registration status (from secondary sources);
- AES speed on arm64 boards without AES instructions;
- the build estimates.
