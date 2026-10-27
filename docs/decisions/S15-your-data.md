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

- **A new stamp** takes the wall clock if it's past the last stamp seen. Otherwise it takes the last stamp's milliseconds and adds one to the counter. Past the counter's top (65,535), it takes the next millisecond and starts the counter again: no stamp is ever past what a reader counts.
- **Whether a stamp is one depends only on the stamp:** a counter of at most 65,535, milliseconds no later than the end of the year 9999, a computer's id. Never on the reading computer's clock, so every computer takes or refuses the same records (*built*, §13).
- **Reading another computer's stamp moves the clock up to it, but never more than a minute past this computer's wall clock.** The last stamp is saved, so a clock that was set back at restart doesn't go backwards. One computer with a wrong clock (or a hostile one) doesn't carry every other computer's clock with it.
- **A change made here is stamped above the value it replaces,** whatever either clock says: the clock's stamp, or, when the value's stamp is ahead of it, the stamp just above that one. So a change made after seeing another always wins over it. With the wall clock and a device tiebreak alone, a computer whose clock is an hour slow would lose, for an hour, to changes it had already seen.
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
- **`sync_record` keeps three things per thing:** each field's value and its stamp (§7's fields and stamps), and `local`, what this computer last wrote of it. The stamping hook compares the model with `local`, not with the merged value, so it stamps only what you changed.
- **Stamping by origin: one rule** (the ninth review, below). Every write says whose it is (`WriteOp.origin`): *yours* (`user`, anything you did), *sync's* (`sync`, another computer's change applied) or *tidying's* (`tidy`: making way for the synced setup, Chord adjusting on its own). Yours are stamped, as of when you made each change (`at`; changes of one thing made more than a second apart and written together, each as of its own time); sync's and tidying's never are, and only update `local`. Writes wait in persistence in turns, yours and others' apart, in the order made, so yours is stamped against what sync applied before it and never after what sync applied since. A change of yours replaces the value this computer showed: it's stamped above that value's stamp if that was ahead (another clock); a value it never showed (read while its write waited, or not applied yet) isn't one it replaced, and the later of the two wins.
- **Deletions, explicit and inferred** (the eighth review, below). A deletion of one thing by id (a chord, a node, a Favorite, a route, a site's Effects) is stamped whenever the merged copy has that thing live, whatever `local` says: main may have applied it, and you deleted it, before its apply was written. An absence inferred from a list-shaped write (the themes' list) is stamped only for what `local` had: saving your list never deletes another computer's theme you never had.
- **`local` checked against the rows: the drift rule** (the eighth review, below). A differing field whose row changed after that field's stamp in the copy (`updated_at`; a setting at its default counts as 0) is a real edit, stamped at the row's time, raised above the field's stamp only to replace this computer's own value of the same moment. Any other difference is how a row is projected, and only refreshes `local`, unstamped and unsent; the first check under a new projection (`PROJECTION`: an icon cap, a newly synced setting) stamps nothing at all.
- **A change of yours waiting puts off another computer's to the same thing.** Main doesn't apply the incoming one over it; once yours is written and stamped, main asks chord-data for the thing again (`sync.repush`). Otherwise an edit made in the 250 ms before a push could be lost.
- **Equal stamps:** the larger value (its JSON with keys in order) wins, so the merge stays commutative even for a log that repeats a stamp. **Icons are facts:** the first copy of an id stays, and any stamp on one is dropped. One whose bytes don't hash to its id is refused, so a hostile computer can't make a spoofed icon stick.
- **Stamps far ahead are taken, and can't move a clock far** (§4, as revised after the security review, below). First built, a stamp more than a year ahead of the reader's clock was refused, which made the verdict depend on each reader's clock, and the clock moved up to any stamp it read, so one record with a counter at 2³² broke every computer's clock.
- **A chord you have keeps its sign-ins,** as import decided (§12). `profile` is carried and merged, but applied only to a chord that's new here, and then only if no chord here has those sign-ins; a chord here never changes its sign-ins, or its proxy, through sync.
- **Joining asks for the passphrase by how many computers sync, not their names:** the names are inside the encryption, so §8's *Austin's MacBook and Austin's Desktop* can't show before it opens. They show in the list once it does.
- **Joining, decided:**
  - a clearly fresh Chord (import's rule, `isFreshSetup`) takes the synced setup without asking, and its first-run chord makes way without a toast;
  - *Use the synced setup:* this computer's chords, and what's pinned in them, go, kept for Undo this session (`sync.replace`; the window's toast's Undo is `sync.unreplace`), their Today tabs and open tabs to the top of the first synced chord's Today; its Favorites, themes, routes and Effects join; its settings count as older than any synced one. Main applies the synced chords first, then this computer's make way, then the rest: so a chord of this computer's that another computer deleted makes way with the others, and the one Undo covers it too;
  - *Keep both:* everything joins, each thing with its row's stamp, and `deleted: false` at that stamp: a thing changed here after another computer deleted it stays, for everyone, and one that wasn't goes (with Undo here). A setting still at its default counts as never set (stamped older than anything), as an import's does (§12), so a new computer's defaults don't overrule your synced settings for being written at its first launch.
- **The first computer's things** go in the same way, by their rows' stamps, a slice at a time as a join's do (what you change meanwhile is noted, and stamped as it ends; a setup a crash stopped is cleared at the next launch), and its first segment is a snapshot (so is every computer's first in a generation).
- **A write too big for one short transaction** (a chord with thousands of pinned tabs going, or coming back with Undo), sync on, goes as an intent (`write_intent`): its parts recorded first, each in a transaction of its own, then marked whole; from then on it's written a part at a time (about 100 things), searches answered between, and a stop partway is finished before the next write. One stopped before it was whole never happened. The chord's tombstone is stamped with the first part, before its tabs'.
- **Turn off and Remove happen when their Undo runs out** (6 s), as §8 says: main holds them; the window's toast and Settings' card both offer Undo. Turning off writes this computer's `removed`, written to the folder before it stops. Quitting is no Undo: one held then happens as Chord quits, the folder given a moment only. On a disk too full to write `removed`, sync turns off all the same (the others list it until one removes it); too full even to turn off, it stays on, and a toast says why.
- **Problems:** one card at a time in Settings, and a toast once per kind per session, with *Sync settings* to open it. *Missing* (the folder isn't there) keeps looking at every poll and focus.
- **Moving to a new generation** (the passphrase changed elsewhere) is a folder operation of its own: no read of the old generation runs meanwhile. As first built, a read of the old generation found the new one, stopped the worker, and the snapshot being written under the new one never was; the E2E journey found it.
- **A copied id:** this computer takes a new id and writes a snapshot under it. The old id isn't marked removed: it's the other computer's now. Only a real segment or frame (one that opens with the key) past where this computer left off says so; junk never does.
- **Limits** (`SYNC_LIMITS`, core's sync.ts): per type, in all, and per thing, sized far past S15 §2's realistic profile, for changes to things already here as much as for new ones; a pass reads at most 64 computers with a real log, a step at most 16 MB read, 16 MB inflated and 20,000 records.
- **The folder on the disk** reads only regular files (a pipe under a segment's name would hold a read up for ever) and writes, appends and removes nothing that resolves outside `Chord sync` or goes through a link (a link planted in a shared folder could send Chord's writes elsewhere on the disk).
- **A pinned tab here off its home keeps its own title and icon** when another computer changes them: they're of the home page, which this one isn't showing.
- **A computer's name** starts as the computer's own (`os.hostname()`), and can be changed in the list.
- **Settings' *Change passphrase…*** asks for the new one twice, as Export does, and says the other computers pause until they have it. Before it moves, this computer says so in its log under the old passphrase (its `device` record's `rekeyed`), sealed, and keeps its old folder until the old file goes (30 days): the others name it from that, never from the new `sync-<n>.json`, which anyone who can write to the folder could put there. Without it they say *Sync was started again in this folder with a new passphrase.*
- ***Start over*** (a lost passphrase, §6) is *Lost it? Start over…* under the passphrase field, whenever sync is asking for one (after a launch with no key kept, or after it changed elsewhere). It's a passphrase change made without the old key: the next generation in the same folder, under a new passphrase, with this computer's snapshot; its old folder goes, and the others pause as for any change, naming no one (it can't say so under the old passphrase). Nothing under the old generation is read: it can't be.
- ***Choose folder…*** (a folder that moved, §8) takes a folder only if it's this sync's: its generation's `sync-<n>.json` opens with the key this computer has, or a newer generation is there (then sync pauses for the new passphrase as usual). Anything else gets *That isn't this sync's folder.*, and nothing changes. The cursors and this computer's segment are relative to the folder, so reading carries on where it was.
- ***Remember the key on this computer*** (question 6): on Linux without a keyring the card has a switch, off, saying the passphrase is asked after each launch, and that remembered anyway any program you run could read it. On, the key is kept with `safeStorage`'s `basic_text` and the note says *Kept without a keyring*; it stays so across launches until turned off, or sync is. With a keyring there's no switch: the key is always kept.

### Found

- **⚠ Worker threads inside a utility process: work.** `spikes/s15-sync-worker` (Electron 45.0.0, Node 24.22.0, the Linux container): a worker thread in a utility process opened `node:sqlite` on the same file (read-only), ran scrypt at N=2¹⁷ in 530 ms, sealed 8 MiB with AES-256-GCM in 17 ms, deflated 4 MiB in 15 ms, and `fs.watch` fired, while the utility process's own thread answered a query every 2 ms, never more than 1.3 ms late. The process grew by 13 MB with the worker; built into Chord, chord-data's private memory went from 22.7 MB to 33.6 MB with sync on, and to 30.7 MB once it was off again.
- **Performance** (`perf.spec.ts`, the Linux container on 4 CPUs). One change costs `write()` 0.1 ms more (the hook 0.12 ms, worst 0.39), and its frame 4.6 ms on the worker. The first version of *keystrokes during a large merge* missed: history's results waited up to 62 ms, because:
  1. main's writes of what it had applied (300 sidebar nodes) were one transaction of up to 56 ms, and every search waited for them, since a search flushed pending writes first;
  2. reading what changed back for main was one task (9 ms for 300 things, and more for more);
  3. checkpoints on chord-data's thread took 10–70 ms;
  4. main applied parts of 200 back to back, and the shell took each in one frame.

  What fixed it: the hook skips reading what's merged for sync's own writes; searches and the archive flush only history's happenings (visits, picks, the archive), never the sidebar's writes, and a big flush goes 100 entities a transaction, chords first; what changed is read back 100 at a time, parents first, merged 100 records a transaction; while sync is busy, checkpoints run on the worker thread's own connection (passive ones), never on chord-data's (§12's *next* step, done for sync); main applies parts of 50, two frames apart. After: every keystroke's results within 16 ms (10.6 ms worst while joining, 10.5 during frames of 300 changes, 7.9 typing alone), chord-data's tasks at most 6 ms, main's longest task 4.4 ms, its busiest 30 ms 8.3 ms while joining and 17 ms during back-to-back frames of 300 changes, a frame a few times a second, far more often than a computer writes (every 3 s at most). ARCHITECTURE.md has all the numbers.
- **The shell takes a part of new chords in one task of up to 18 ms** while joining, mounting their sidebar, as an import's restore does (§12). The store's and the shell's cost per change grows with the nodes (ARCHITECTURE.md §9, *Known limit: very big imports*).
- **The journeys pass on X11 and Wayland** (`sync.spec.ts`): two Chords, one folder, set up, join, edit on both, a wrong passphrase, one removed; a passphrase changed, the other paused and moved, and in the container, which has no keyring, a relaunch asking for the passphrase again (§3); then *Start over* from there (the other pauses), *Remember the key on this computer* (the next launch doesn't ask), and the folder moved on the disk (*Chord can't find the sync folder*, then *Choose folder…*).

### The security review, and what changed

A review of the branch found seven defects, reproduced with throwaway tests; each is fixed, with tests in core's, chord-data's and the desktop's suites.

1. **One record broke every computer's clock.** A counter of 2³²−1 passed the check, and reading it pushed the clock past what a stamp may be, so every later stamp was dropped everywhere; and the year-ahead check used each reader's own clock, so computers could disagree. Now (§4): the counter is at most 65,535 and carries into the next millisecond; a stamp is checked by its data alone; another computer's stamp moves the clock at most a minute past the wall clock; a change made here is stamped above the value it replaces, so it always wins. A stamp far ahead is taken, and stops nothing. A property test mixes far-ahead stamps, counters at their top and stamps a year short of the end with ordinary edits, on three computers: their copies agree, every edit beats what it replaced, and no clock drifts past a minute. The one case left: a stamp at the very end of the year 9999 can't be beaten (only a computer with the passphrase could write one).
2. **A planted file hid a computer's log, without the passphrase.** A file named `999999.chordlog` made the next snapshot `1000000.chordlog`, which no reader lists, and in the current generation made a computer take a new id at every write. Now a segment is real only once its first frame opens with the key; every segment's first frame holds only its computer's `device` record, so that's two small reads. A computer's newest segment, and a copied id, are judged from real segments only; a snapshot is numbered past the newest real one (and, after the second review, deletes only this computer's own segments up to its newest, never junk). At segment 999,999 a computer takes a new id. A fake snapshot header hides nothing either: a cursor says *snapshot* only once a frame opened.
3. **64 junk computers stopped all reading.** Now only folders with a computer's name that hold a real segment count towards the 64 read; past that, Settings says *More than 64 computers sync through this folder.* Junk is looked into once (by name, size and time), the rest the next pass (made to hold at scale after the second review, below).
4. **A deleted chord took this computer's tabs, with no Undo.** Now a chord another computer deleted makes way as a joining computer's do: its Today tabs and any open tab move to the top of the neighbouring chord's Today (an open pinned tab stops being pinned), the window that showed it goes there showing the same tab, and a quiet toast says *"Work" was deleted on another computer. Its 3 tabs moved to "Personal".* with **Undo**, which brings the chord, its pinned tabs and folders, and the moved tabs back. A chord's tombstone is applied before its nodes', so the Undo has them all. *Keep both* stamps `deleted: false` at each row's time; *Use the synced setup* makes way before anything deletes.
5. **Writing stopped for good once this computer's segment was gone.** Now, when its segment isn't there (or is shorter than it left it) while the folder is, it writes a fresh snapshot and carries on; when the folder itself is gone, it waits, and writes once a look finds it. A removed computer's folder goes only after a pass, once everything real in it has been read here and nothing in it was made after its removal (a computer that turned sync off and on again keeps its folder).
6. **Caps that didn't hold.** Changes to things already here now count against a thing's size and the copy's, as new things did. Reading is budgeted per step by bytes read (16 MB), bytes inflated (16 MB) and records (20,000), and a frame that inflates past 8 MB or holds more than 20,000 records is passed over and counted (Settings: *2 parts of another computer's changes went past what sync reads*), never read again and again. Snapshots are read and written a page of 256 KB at a time, so neither thread holds one whole; changes stamped while one is written stay in the outbox to follow it (they were deleted with it before).
7. **Lesser ones.** A `sync-<n>.json` anyone could write named a computer as having changed the passphrase: now only the old generation's log, sealed, names it (above). Icons must hash to their ids. `Chord sync` itself a link or junction: nothing is written.

Saying so under the old passphrase made *Change passphrase…* three folder steps where it had been one: the new generation's file, the record that says so, then the snapshot under the new one. A look at the folder between them found the new generation and paused this computer, as if another had changed it; the whole E2E suite caught it once, and a test that looks at the folder five times while the passphrase changes catches it every time without the fix. Now a newer generation that's this computer's own (it's moving there, or the look was from before it moved) is no reason to pause.

**Measured after** (`perf.spec.ts -g sync`, 4 CPUs, the same session as the code before them): one change's `write()` 0.2 ms with sync on (worst 0.5; 0.1 off), the hook 0.13 (worst 0.34), its frame 2.8 ms (before: 4.8); chord-data's memory 22.7 MB off, 33.9 on, 31.3 off again (before: 22.7, 33.6, 31.2); history's results within 12 ms while joining (before: 17.8 in that run) and 11.5 during frames of 300 changes (10.9); merged slices at most 2.6 and 6.9 ms (1.8, 6.3); snapshot pages at most 3.1 ms. First built at 1 MB, a page held chord-data's thread for about 10 ms while joining (a keystroke's results took 19 ms), so pages are 256 KB.

### The second review, and what changed

A second review checked those fixes: 2 and 7 held, 3 and 4 didn't, 5 held in part, and the fix for 5 caused a destructive regression. Each was reproduced with throwaway tests; each is fixed, with tests.

- **B. Two copies of one profile deleted each other's logs.** A copy whose segment the original had compacted away took *gone* to mean a fresh snapshot in the shared folder, which deleted every segment there, the original's included, and the original then did the same, round after round. Now a write first looks just past its segment (a computer's segments go up one at a time, so another copy writes there first): a real one there is another copy. Its segment gone is treated as one too. Either way it takes a new id and writes its snapshot there, deleting nothing in the old folder; and a snapshot deletes only this computer's own segments up to its newest, never one past it, nor junk. A test has two writers share an id through six compactions each: neither loses anything, and both, and a third computer, end with everything.
- **4. A tab a deleted chord had open was still lost** when the chord or its neighbour has sign-ins of its own: moving it closed its page, and its own tombstone in the same push then took it as an unloaded tab, with no Undo. Now what's carried is decided by what was open before the push, a tombstone takes only a pinned node (one in Today here is only this computer's), and a chord held for a change of yours holds its nodes' tombstones too, so it takes them, kept for Undo.
- **3. Junk at scale.** The junk remembered was emptied at 200,000, so the same first segments were looked into every pass and a computer sorting after them was never read, with passes back to back. Now it's never emptied while needed: a reader looks into at most 1,024 segments a pass and goes on from where the last stopped, 2 s later; past 4,096 junk entries it stops looking for computers it doesn't know, says *The sync folder holds files Chord doesn't recognise*, and reads the ones it knows at the usual times.
- **A. Every write looked into up to 4,096 segments**, 64 KB and more of each, remembering none: 537 MB and 1.6 s a write from planted files. Now a write looks at the two names just past its segment, at most a 4 KB head and an 8 KB first frame of each, and remembers junk: in steady state, a stat or two.
- **5. A half-delivered segment pruned.** A segment whose header is a sync header for its place but whose first frame isn't all there is pending, and keeps a removed computer's folder.
- **6. Caps.** What a thing counts for now includes its stamps and what a snapshot adds for its fields (a record's type, id and stamp each): the cap bounds the snapshot. And each record rewrote its whole thing (468 ms for 100 small changes to a thing of 2 MB); now a slice merges a thing's records together and writes it once, writes nothing when nothing changes, and ends after about 512 KB of things read and written.
- **1. The very last stamp.** At `[the end of 9999, 65535, a larger id]`, no stamp is above it, so a change here was written, lost everywhere, and still showed here. Now it isn't written, main is sent the merged value back (this computer shows what every other does), and Settings says *Another computer's clock is set far ahead, so some changes here can't sync: "Work".*
- **C.** A change stamped above a far-ahead value carried that time under this computer's id, so the others listed its clock as ahead. Now a clock is judged from what a computer says of itself (when it made its newest segment, sealed in its header), and a last change is never in the future.
- **Joining** read all of this computer's things into the copy in one transaction, and the copy back for main in one read: a keystroke waited up to 19 ms. Both now go a slice at a time.

### The third review, and what changed

A third review held the top stamp and the merge's slices (an 80-seed property test of `SyncStore.merge` matched merging one record at a time), and found that copies and a deleted chord's tabs still didn't hold, and a new silent stall. Each was reproduced; each is fixed with a test of its repro. The rule for all of them: a computer never silently stops writing or reading; someone with the folder may cause visible denial of service, never silent loss; nothing that can't be sent again is deleted until it's covered elsewhere.

- **N1. A failed snapshot after *gone* stopped all writing, silently.** The new id was taken, and the old segment forgotten, before the snapshot under it was written; if that failed, nothing was ever written again, even after a relaunch. Now a new id is this computer's only once its first snapshot is in the folder: until then its id and segment stand. A write that fails is tried again, 30 s later, then later and later up to 15 minutes, and Settings says *Chord couldn't write to the sync folder. It tries again every few minutes; 3 changes wait here.* Turning sync off keeps changes not yet in the folder (and says so); turned on again, the first snapshot holds them, each with its stamp.
- **2. A deleted chord's unloaded pinned tabs still went with no Undo** when more than a push's worth of changes split the chord's tombstone from its tabs', and the chord was held for a change of yours. Now a chord that went is always pushed with every node of it that went, so it takes them, kept for its Undo. Sync's Undo has a list of its own (the last 100 chords sync took away this session), so deleting chords here (`deletedChords`, five) never pushes one out.
- **1. Copies of one profile.**
  - *A segment brought back with a copy's edits*, after compactions deleted it (Dropbox, OneDrive and Syncthing let an edit beat a delete), was skipped by every reader and later deleted. Now a snapshot's header names what it covers: each of its computer's earlier segments it replaces, and how many bytes and frames of it the computer wrote. Readers read what it doesn't cover: a segment it doesn't name (whole), or one grown past what it names (from there). A computer deletes only what it covered, and only while it's that long; one that grew stops its compaction (it takes a new id, deleting nothing). A write looks at every real segment past its own, and a new segment never takes the place of anything already there.
  - *Copies that never write* treated the shared id as their own and never read each other. Now a profile whose kept key can't be read on this computer (DPAPI, the Keychain and a secret service keep it for the computer that kept it) is taken for a copy: unlocked with the passphrase, it takes a new id at once, writing or not, and reads the other's log as another computer's. A copy on the same computer, or one with the key kept without a keyring (`basic_text`), isn't told apart this way; the coverage above finds it once either writes.
  - *New ids forced on every write*: past three new ids in a day, a computer stops writing and says *Another computer keeps writing to the sync folder as this one*, until sync is turned off and on again.
- **5. Junk at scale.** What the reader remembers of junk is kept in chord-data (migration 20, `sync_junk`), so a relaunch doesn't look into it all again. Past 4,096 entries it says so and goes on looking, 1,024 segments a pass, at the usual times, never stopping for good; a computer that joins after the junk is still found, a few passes later. A join waits for the passes that finish looking, and says so if the folder is full of junk.
- **Measured** (`perf.spec.ts -g sync`, 4 CPUs, two runs): history's results within 14.7 ms while joining in one run; in the other, one keystroke waited 28.2 ms when a write of what main applied took 13.7 ms (4.4 in the first), a stall seen in runs before these fixes too. During frames, 10.4 and 13.4 ms. Merged slices at most 3.7 and 4.4 ms, one change's frame 2.7 ms, memory 22.9 / 34 / 31.6 MB.

### The fourth review, and what changed

A fourth review held the third's fix for a failed new id, and found five ways data was still lost or stranded silently, and four lesser ones. Each was reproduced; each is fixed with a test of its repro.

- **D1. Merged, never applied.** A quit or a crash between a pass's merge and main's apply left another computer's change in `sync_record` and nowhere on screen, for good: nothing pushed it again. Now what main writes back of what it applied (`local`) is the only mark of a thing applied, and whatever differs from the merged value is pushed again (`unappliedPages`, `sync.reconcile`): after each launch, after a read that failed, and after main couldn't apply a push (5 s later, then later and later up to 5 minutes). Tests: a quit mid-pass and mid-apply, then a relaunch that pushes only what isn't applied; what this computer never takes (a chord's sign-ins) is no difference.
- **D2. One failure stopped reading for good.** chord-data's chain of merges and passes' ends had links without a handler: one rejection (a full disk while saving junk) left every later link unrun, silently. Now every link catches: Settings says *Chord couldn't take in changes from the sync folder. It tries again in a few minutes; nothing's lost meanwhile.*, and it reads again 10 s later, then later and later up to 10 minutes. The worker waits at most 2 minutes for a step's answer, so its own chain is never held for ever; a worker that crashes answers whatever waited for it, and is started again the same way. Tests: a failing `saveJunk`, a failing merge, the worker crashing.
- **D3. A merge that failed was answered as merged**, so the worker moved its cursor on and never read those records again. Now the answer says whether the step merged, and is numbered, so one that comes late is never taken for the next step's; the cursor moves only on a yes, and a no ends the pass there, to be read again. Test: a merge that fails, then the same step read again and merged.
- **D4. A removed computer's folder was pruned with a late frame in it** that only this computer had read: delivered after this computer's last snapshot, it was in none of its segments, so computers that hadn't read it never would. Now each snapshot keeps the read positions it was taken at (`coveredReads`), and a folder goes only while what's been read of it is exactly what a snapshot of this computer's that's in the folder holds. Test: a late frame waits for the next snapshot.
- **D5. Two copies appending at once.** Both appended to the same segment, the sync app kept one, and the other's frames, never read by anyone, stood as written. Now a computer's segment must end exactly as it left it, its size and the SHA-256 of its last frame's bytes (`ownIntact`), checked before each write and once a pass, so a copy that has stopped writing finds out too. Otherwise another computer writes there: a new id, whose snapshot holds what this one wrote. Tests: two copies appending, the longer kept, the other finding out writing or not; the same length with other bytes.
- **A chord's deletion split across frames.** A chord deleted here could go out after its tabs' and folders' tombstones, so a computer that read only part of it took them with no Undo. Now a chord's tombstone goes out first. And pinned tabs and folders another computer took from a chord that stays are kept for Undo too, in sync's own list, with a quiet toast, *“Docs” was removed on another computer*, whose Undo puts them back where they were. Tests: the tombstone first; nodes taken away and put back.
- **Junk in one folder.** 6,000 junk names in one computer's folder used up each pass's 1,024 looks there: computers after it were never found, and its next segment never read. Now each folder is looked through within a budget of its own (512 names a pass, 4,096 for a computer already read, 64 looked into), on from where the last pass stopped, and the pass moves on to the next. A computer already read is looked for by its next number first, then from the top down: it numbers its next segment past whatever is there. One whose folder holds more than a pass gets through is named in Settings, *Changes from Desk are slow to come: its folder holds files Chord doesn't recognise.* Tests: 6,000 junk names in a known computer's folder (it's named, and its next snapshot is read at once); junk at the numbers past it; a folder of junk before a later computer.
- **Unlocking a copy took two new ids:** the unlock and the write it started both saw the profile marked as a copy. Now the unlock takes its new id through writing's own queue. Test: unlocked with changes waiting, one new id.
- **A launch with a key kept said sync was paused** for a moment: until main had read the key, Settings asked for the passphrase, and a toast said *Sync is paused* at every launch on Windows and macOS. CI found it there: the passphrase journey took the container's missing keyring for granted, and caught that moment instead. Now nothing asks, and no toast comes, until the key kept here has been tried. The journey runs the no-keyring path on every system, through a development build's switch (`CHORD_E2E_NO_KEYRING`, never honoured when packaged), and on Windows and macOS checks that a relaunch with a keyring carries on without asking.
- **Performance: the keystroke that waited 28.2 ms while joining.** Each of sync's steps on chord-data's thread is now timed by name (`SyncTimings.steps`). A search waits for the step under way and for whatever came in just before it (a write of what main applied, say), so it's the longest steps that count, and three were long: deciding whether this computer is a fresh Chord read its whole setup, icons hashed, 6.7 ms, as a join's read ended; ordering a push loaded every thing in it twice, 4 to 6 ms for 300; and merged slices and writes of what main applied, 100 at a time, took up to 7 and 9 ms. Now a fresh Chord is told from what's here first (history, chats, one chord), so a profile with history reads nothing more; ordering reads only whether each thing went and where it is, through SQLite's `json_extract`; and merges, pushes and writes of what main applied go 50 at a time. While joining, chord-data's longest step is now 2 to 7 ms. Measured three times (`perf.spec.ts -g sync`, 4 CPUs): history's results within 16.5, 12.7 and 10.1 ms while joining (14.3 and 18.5 in two runs before, the same session), and 12.5, 13.8 and 14.4 during frames of 300 changes. The 16.5 came in the run where typing alone, before any merge and with sync off, took 17.5 (a search's round trip of 12.8 ms with no sync work at all): the container's own noise, which the other two runs (9.8 and 7.6 alone) didn't have. Main's busiest 30 ms during back-to-back frames of 300 changes stays over a frame (17.9 to 23 ms), as before.

### And two it left open, closed

- **A folder operation that hangs** (a stalled network drive or cloud folder) held the worker's one-at-a-time chain for ever, and writing with it, silently. Now every request to the worker times out: while it owes an answer, a minute without a word from it (an answer, a snapshot page asked for, a step read) and its thread is let go. What waited is answered as failed, so the outbox stays and a join stops; Settings says *The sync folder isn't answering. Is your sync app or network drive working? Chord tries again in a few minutes; 3 changes wait here.*; and the worker starts again 30 s later, doubling up to 15 minutes, until the folder answers everything it's asked. Tests: a write that never returns (the problem shows, the changes wait, writing goes on once the folder answers), and a folder that goes on not answering (later and later).
- **Pushed again after every launch.** A thing this computer keeps other than the copy has it never matched, so it was pushed to main at each launch. Comparing through each kind's codec catches what's tidied, but not what's refused or placed otherwise for where it is here (a folder too deep, the last chord, a split waiting for its panes), so every kind gets a version instead: each push carries each thing's (a hash of its merged fields and stamps), main says which it applied once its writes are in (`sync.applied`; not what it put off for a change of yours), and a thing at that version isn't pushed again (migration 21). A push none of which applies is marked at once. Tests: a chord's colors tidied and a chord refused, relaunched twice with nothing pushed; one changed again elsewhere, pushed; one put off, pushed again; a quit before main said so, pushed again.
- **Measured once** (`perf.spec.ts -g sync`, 4 CPUs): history's results within 18.7 ms while joining, from one keystroke early in the join, and 13.5 during frames of 300 changes; main's confirmation costs chord-data 1.3 ms a join. Two more runs, with chord-data's event loop and its garbage collection watched, gave 11.1 and 11.4 while joining: sync's own steps there stay under 7 ms, and the longest waits are several tasks in one turn of chord-data's loop (up to 12 ms), and once a 6 ms scavenge. Spreading those, and what it takes to receive a step from the worker, is left for later.

### The fifth review, and what changed

A fifth review held D4, the junk, unlock and deletion fixes, and found that ordinary sync-app behaviour doesn't set off the tail check, and that a crash between main's write and its confirmation is harmless. D1, D2 and D5 didn't hold, and D1's first case was new with the versions. Each was reproduced; each is fixed with a test of its repro.

- **D1a. What arrived before what it depends on was confirmed anyway.** A tab another computer pinned into a chord made on a third, read before that chord, was dropped by the reducer (its chord isn't here), yet main confirmed its version; once the chord came, reconcile skipped the tab for good. A tab read before its folder stayed at the top the same way. Now main confirms only what it applied as it came, or as this computer will always keep it (tidied, refused for good, put at the top for a cycle): what waits on something not here yet, by the reducer's own rule (core's `syncWaiting`: a node or route whose chord isn't here; a node whose folder isn't, is in another chord, or came after it), isn't confirmed. After an apply that brings chords or folders, main asks for what isn't applied again, and it lands. Meanwhile reconcile leaves out what can't apply yet (its chord isn't in the copy), so a launch doesn't push it for nothing. Tests: a tab before its chord, and before its folder, through main's side and chord-data's wired over a real chord.db, each in place once that comes, and two relaunches pushing nothing; a folder that would hold itself, confirmed.
- **D1b. Main confirmed writes that never landed.** `flush()` resolves when chord-data refuses a batch or dies mid-write, and confirmation followed it. Now persistence counts those (`writeFailures`, `flush()` itself unchanged for export and import), and main confirms only when none more failed since the apply began: chord-data acknowledged every write as committed. Otherwise nothing is confirmed, and the apply is asked for again later. Test: a refused write confirms nothing.
- **D2. The watchdog.** Every message from the worker reset it, the watch's `changed` included, so a write that never returned went unnoticed while the folder kept changing; and any finished pass reset the backoff, so a hang outside a pass (a prune, a compaction, a write) restarted at the shortest wait again and again, each restart leaving a stuck file call. Now the worker says when each folder operation begins and ends (`busy`, `idle`), and only the one under way has a deadline, moved only by progress on it (its answer, a snapshot page asked for or sent, a step read or answered). A worker that misses it is let go (`abandon`: once its call returns, its folder refuses everything) and kept until then; with two calls stuck, no other starts until one returns, so two of the process's four file threads stay free. The wait before another doubles, and starts over only after 10 minutes with no timeout. Tests: a write that never returns while the watch fires every 40 s; two calls stuck, then one returning; the wait doubling and starting over.
- **D3. Stale answers after a restart.** A new worker numbers its steps from 1 again, and a merge still running answered whichever worker was current, so a new one could take an old step's answer as its own. Now each worker's messages are heard only while it's the one running, and a step is answered only to the worker that read it. Test: a step merged after its worker crashed, never answered to the next; an old worker's late answer never taken as the new one's.
- **D5. A failed append taken for a copy.** A write of this computer's own whose bytes landed though the call failed (a flush or a close that threw, the worker let go mid-flush), or that the disk took only part of, made the next tail check see another writer: three such in a day, and writing stopped with *Another computer keeps writing to the sync folder as this one*. Now the worker says what it's about to write (core's `Appending`: the bytes, where, and its segment as it will be), chord-data keeps it until the write is answered (`meta.appending`, across restarts), and the next write, compaction or pass settles it first (`settleAppend`): exactly those bytes there, they're its own; only their first part, the segment is cut back to where it was (`SyncFs.truncate`) and the write goes again. A short write throws (the bytes written checked against the length), never taken as done. A new segment renamed into place before the answer is settled the same way. Tests: the flush throwing after the bytes landed; the worker let go mid-flush, what it was writing handed to the next; a short write; a new segment; other bytes, or more, still another writer's.
- **Temp files a stopped write left** (`NNNNNN.chordlog.part-…`, `….tmp-…`) piled up. Now a worker's first operation removes this computer's own, older than a minute, in its own folder only, by exact name, never through a link. Test: its own old ones go; fresh ones, other names, and another computer's stay.
- **An error taking in what the worker said ended chord-data**: a full disk as it was told its segment had changed reached the process's last-resort handler. Now everything the worker says, and every timer, goes through one guard: the error is said in Settings (*Chord couldn't take in changes from the sync folder*), and reading tries again. Test: a full disk on `own-changed`, then the next pass keeping it.
- **Measured once** (`perf.spec.ts -g sync`, 4 CPUs): history's results within 10.1 ms while joining; during frames of 300 changes, one keystroke, the last, waited 22 ms behind a merged slice of 8.9 ms and a write of what main applied (7.9), the rest within 11.9. A second run of the large merge: 11.9 and 14.7. Main's confirmations cost chord-data at most a few milliseconds a push (`applied`, not among its three slowest steps); one change's frame 5.4 ms.

- **On Windows a running Chord kept the folder from being renamed.** CI found it: the journey renamed the folder that holds `Chord sync` while Chord ran, and Windows refused (EPERM): its watch (ReadDirectoryChangesW) holds a handle inside, and Windows won't rename or move a folder something holds. That would stop you, or a sync app, renaming or moving the folder while Chord runs: not acceptable for something you never see. So on Windows the folder is watched only while a Chord window is in front (`sync.front`); behind, the five-minute look and the look when Chord comes to the front find what changed, a little later. Renaming it from Explorer works, Explorer being in front; while a Chord window is in front, Windows still refuses a rename (from a sync app, say), as it would for any app with a file in the folder open. That narrower case we take. On macOS and Linux a watch holds nothing that stops a rename, and it's kept. Every system: a watch whose folder is deleted or moved is closed (a look that finds it missing closes it too), the looks go on, and a look that finds the folder again watches it again. The journey now moves the folder while Chord isn't running (as a user who moves it while Chord's behind would), and on macOS and Linux also while it runs, away and back.

### The sixth review, and what changed

A sixth review found no path that loses data outright, but three that still stranded it silently (D1a, D1b, D5), and a stall that could stop sync while Settings said it was on (D2). D3, the temp-file tidying, the guard and Windows watching held.

- **D1: confirmations replaced by a diff.** Several of D1's failures came from the confirmations themselves: a folder loop taken for a permanent adjustment and confirmed (once the other move came, it was never pushed again); a re-ask that fired only when an apply added chords or folders (a tab waiting on a folder that moved into its chord later, or on a chord brought back by Undo, waited for the next launch); a reconcile that left out a node whose merged parent was gone; capacity refusals (48 Favorites, the themes' limit) confirmed for good; a refused write confirmed because the re-apply changed nothing in memory, so wrote nothing and failed nothing; and a full reconcile after each part of a push that added something. So there are no confirmations now (`sync.applied` and migration 21 are gone: nothing shipped with them). Reconciling is a pure diff: what chord.db durably has (`local`: its rows as the stamping hook projects them, kept in the same transaction as the rows) against the merged copy, everything that differs pushed in slices. It runs after a launch, after a failed apply, after a refused write, once (2 s after the last) after writes that brought a chord, a folder or a split, moved one, or took a Favorite or a theme away (sync's or yours, an Undo included), and every 10 minutes while idle. What this computer always keeps otherwise (tidied, refused, waiting, at capacity) is pushed again then and applies as nothing, bounded by the caps; within a session the idle look skips a thing it pushed while its merged version and what chord.db has are both unchanged. A write chord-data refused shows as a difference, and the next launch, reading chord.db back, applies it again. Tests, with main's side and chord-data's over a real chord.db: the loop; a tab waiting on a folder that moves into its chord later; a chord brought back by Undo; a refused write, then a relaunch; Favorites at 48, then one removed; 200 folders reconciled once, not once a part; tidied colors, two relaunches, each push applied as nothing, nothing written.
- **⚠ Persistence dropped a batch chord-data refused**, for every write in the app, not only sync's: what's in memory then wasn't in chord.db until the thing was written again. Sync found its own such writes again (above); the seventh review's fix 4 (below) makes persistence keep and resend them, for every write.
- **D2.** `start` and `front` ran outside the worker's one-at-a-time chain and set the watch up synchronously: on a share that stopped answering the thread blocked before any operation began, so no deadline ran, and Settings said sync was on (on Windows at every focus). Now setting up the watch is an operation like any, under its deadline, after a reachability check off the thread. A worker let go could still finish an append, a cut or a rename already past its check: now it checks right before every call that changes the folder, and cutting back is compare-and-cut on the open file (`SyncFs.cutBack`: only if it's exactly the old end plus those bytes). chord-data's own merge time counted against the deadline (a merge over a minute let the worker go): it waits while the worker waits on chord-data. And the waiting counted towards the 10 healthy minutes, so the wait before another worker restarted at about 8 minutes, never reaching its cap: only work done well since a worker last started counts. Tests: the watch under a deadline; a merge longer than the deadline; the wait reaching 15 minutes; a worker let go mid-append writing nothing; a cut refused when the file isn't exactly so.
- **D5.** When a worker settled a write as landed, only its own idea of its segment moved, so after two unanswered writes and a restart the marker didn't match and the computer took a new id: now the worker tells chord-data (`settled`), which keeps the segment at once, before the next write's marker. A compaction stopped between its rename and its answer wasn't covered: it is now (its size and last frame). And the marker kept the bytes themselves in meta, rewritten on every save (a new segment is over a megabyte): now their length and hash, with the bytes only in the worker that wrote them (needed only to cut back a short write). A new file a short write cut short is removed in the same call, not only when a worker starts. Tests: a settled write kept before the next marker; a compaction stopped before its answer; the marker without the bytes; a short write's temp file gone.
- **Performance.** chord-data's sync slices are smaller (25 records merged, 25 things written per write of what main applied), and a write waits one turn, so a search that came in behind it is answered first. Its sync steps now stay within 2 to 7 ms (merged slices at most 2.5 to 6.8, writes of what main applied 3.2 to 7, ordering a push 3.3 to 5, a reconcile's page about 2.4). History's results, three runs (`perf.spec.ts -g sync`, 4 CPUs): 26.1, 14.4 and 20.9 ms while joining; 31.8, 16.6 and 24.2 during frames of 300 changes; and 18.7, 10.6 and 15.7 typing alone before any merge, with sync off. Under 16 ms in none of the three, but the machine was busier than in earlier rounds (containers of another project restarting in a loop in the same WSL), so the same check was run at the previous commit and at this one, alternating, twice each: before any merge 20.7 and 12.9 then, 14.1 and 7.6 now; while joining 23.6 and 30 then, 22.7 and 12.4 now; during frames 29.3 and 13.4 then, 18.9 and 16.1 now. No worse, and a little better; the target stays open, to measure again on a quiet machine.

### The seventh review, and what changed

A seventh review found one high-severity defect, held D2 (but for a minor point), D5 (but for a regression), the merge's slices and the reconcile (no loop). Each was reproduced (one was found by reading); each is fixed with a test.

- **1. Another computer's themes were deleted everywhere.** Saving or deleting a theme here wrote the whole list, and every merged theme not in it was stamped gone, since a deletion was stamped whatever this computer had: another computer's new theme not applied yet (certain when main held it back for a themes write of yours), any past the limit, any that failed the checks. Now a deletion is stamped only for what this computer had (`local`) and took away, for every kind, a whole list or one thing. Tests: a table across themes, Favorites, routes, Effects, chords and folders, another computer's never stamped gone; what this computer had, stamped. (Too broad for a deletion of one thing by id: the eighth review, below.)
- **2. `local` could drift from the rows.** (a) Joining with *Keep both*: a write while the join added this computer's things wasn't stamped (stamping is off then), so a chord renamed in that window kept its old name everywhere. Now the transaction that ends a join checks the rows against `local` and stamps what changed. (b) A node record under another kind of node's id (a folder over a pinned tab) took over the tab's edits and its deletion: now it's refused at merge, and counted. And a safety net: at launch and with each idle reconcile, `local` is checked against the rows a page at a time, and a thing that differs is stamped as the change it is (or, gone from the rows, as a deletion). (Stamped *now*, which always won: the eighth review, below.) Tests: a rename in the join's window, found as it ends; the decoy refused; after ordinary writes of every kind nothing to mend; a write that slipped past stamping, found and sent.
- **3. The idle look hid a Favorite refused as a twin** (an address one here has), which can land only once that address changes. Now any change to a Favorite starts a reconcile, which forgets what the idle look skipped. Test: the twin lands once the one here moves to another address, an idle look between.
- **4. A refused write stayed stale until a relaunch**, and turning sync off in that window cleared the merged copy, losing the change here. Now persistence never drops a batch refused for a reason that can pass: it's put back and sent again later and later, and the window says so if it keeps failing. Turning sync off waits until such writes are in. Tests: a full disk three times, then room, the batch whole; one refused for what's in it, dropped; turning off waiting.
- **5. A deleted chord's moved tabs lost their back/forward history** when the push was more than a batch: chords went first, and a chord going deletes its node rows, the tabs being moved with them. Now a flush sends chords that stay first and chords that go last, so the moves are in before. Test: the order, in one batch and across two.
- **6. Performance.** A reconcile page read icons only to skip them (40 icons of 1 MB, a page of 84 to 91 ms): now icons and devices aren't read, and a page stops at about 512 KB. An icon of 1.3 MB made a merged slice of up to 46 ms: icons past 128 KB of base64 are refused at merge and left out when stamping. Tests: a big icon refused; pages of big things kept small.
- **7. D5: a short write the last worker didn't cut back** (Chord quit on a full disk) made the next take a new id, since the marker no longer had the bytes. Now the worker writes them once per write to a file of chord-data's own beside chord.db (a write whose file can't be written doesn't go), and the next worker reads them back (checking their hash) and cuts back. Test: the next worker, given the bytes from the file, cuts back and keeps its id.
- **8. D2, minor.** On Windows with Chord behind, a watch operation that didn't touch the folder cleared *The sync folder isn't answering*: now only one that reached the folder does. Test.
- **Measured** (`perf.spec.ts -g sync`, 4 CPUs, three runs, after Docker in WSL had been up a minute and a half; its other containers, which start with it, restarted as the first run began, and had been up a minute by the others): history's results within 10.4, 12.5 and 10.7 ms while joining, 13.4, 12.7 and 11.2 during frames of 300 changes, and 7.4, 7.1 and 7.5 typing alone: under 16 ms in all three. chord-data's sync steps: merged slices at most 2 to 9.3 ms (once), writes of what main applied 2 to 6.4, the drift check's slowest page 3.8 to 4.9, ordering a push about 3. One change's frame 3.3 to 5.6 ms; memory 23 / 34.3 / 32.7 MB.

### The eighth review, and what changed

An eighth review found that the seventh's deletion rule lost a deletion (that fix's own doing), that the drift check's stamps always won, that a full disk still lost or hid writes three ways, that a crash between batches could bring a deleted chord back partly emptied, and that the drift check read everything at once. Each was reproduced; each is fixed with a test of its repro.

- **1. A deletion made before its apply was written was lost, and the thing came back.** Main applies another computer's Favorite; you remove it before persistence writes the apply; persistence keeps the newer write for the entity, the deletion, so chord-data never had a row or a `local` for it, the seventh review's rule stamped nothing, and the next reconcile put it back. **The rule now tells explicit deletions from inferred ones.** An explicit deletion of one thing by id (a delete op: a chord removed, a node, a Favorite, a route, a site's Effects) is stamped whenever the merged copy has that thing live, whether `local` has it or not: you took away that thing. Only an absence inferred from a list-shaped write (the themes' list) needs `local` to have had it, so saving your list never deletes another computer's theme you never had. Tests: each explicit kind deleted with no row and no `local`, stamped, and nothing to reconcile; the same end to end, the apply held as persistence holds it, the Favorite gone for good; another computer's theme kept through a save of this computer's list.
- **2. The drift check's corrections were stamped "now", so they always won**, even over a newer value from another computer, and a version of Chord that projects rows differently (the icon cap, a newly synced setting) stamped every thing it touched. **The drift rule:** a differing field whose row changed after that field's stamp in the copy (`updated_at`; a setting at its default counts as 0, as `localThings` has it) is a real edit, and is stamped at the row's time, raised above the field's stamp only to replace this computer's own value of the same moment. Any other difference is how a row is projected, and only refreshes `local`: no stamp, nothing sent. The projection has a version (`PROJECTION`, kept in sync's meta, set when `local` is written whole on turning on): the first check under a new one refreshes `local` and stamps nothing. A thing `local` has and the rows don't is refreshed as gone, never stamped (its time isn't known; the reconcile then puts the copy's back, which loses nothing); one the copy doesn't have at all isn't added (a chord that made way for the synced setup, say). Tests: an upgrade with an icon past the cap in `local`, nothing stamped and nothing left to mend; a difference older than another computer's stamp, `local` refreshed only; an edit that slipped past the hook, stamped at its row's time.
- **3. A full disk.** (a) A write that hit it threw *cannot rollback - no transaction is active* in place of the real error (SQLite had rolled back itself), so it was taken for one that would fail for ever and dropped. Now a transaction rolls back only if one is still open, and the real error is thrown. What can pass is told by SQLite's result code, not the message: FULL, IOERR (any extended code), BUSY, LOCKED and READONLY (`errorPasses`; chord-data's answer says `passing`). (b) Turning off waited while anything had been refused since the last write that landed, which could stay so for good (a retried batch later dropped for its content). Now what's unsaved is what's still waiting: each entity and history happening refused for now counts until a write of it lands, or is dropped. Turning off waits for them 15 s at a time, two minutes at most; then it turns off keeping the merged copy (`sync.off` with `keep`), and a toast says how many changes it brought aren't saved yet. Off with the copy kept, a reconcile at the next launch, and after writes, puts back what chord.db lacks, and once it lacks nothing the copy goes. (c) History's happenings written ahead of a search (`flushEvents`) were dropped when refused: now they're kept and sent again with the next try. Tests: a full disk made with `max_page_count`, the real error and its code, then room and the write in; refused, then refused for its content, nothing left unsaved; turning off after two minutes, the copy kept, and the next launch putting the change back and the copy going; history refused, kept, written.
- **4. A crash between batches brought a deleted chord back partly emptied.** Chords that stay went first and chords that go last, but in batches: a stop between one with the chord's node deletions and the one with the chord left it with only some of its pinned tabs, which the next reconcile kept. Now a chord's deletion goes in one transaction with every node's move and deletion waiting (and their histories), however many that makes. Test: the batch past its size with the chord and all its nodes.
- **5. The drift check read everything at once:** every chord, then all Favorites, routes and Effects, and `SELECT *` (each Effects' compiled CSS too), in single steps; and a join ended by checking every row. Now every kind is read a page at a time by bytes (about 128 KB of rows, with only the columns the projection needs), and the same reader (`rowThings`) gives a join this computer's things, added to the copy in slices of about 128 KB. A join notes the ids written in its window (`noteUnstamped`) and, in the transaction that ends it, reads back and stamps only those (`stampJoinWindow`). Tests: Effects at their largest read a few a page; the join's window stamped by id, the drift check then finding nothing. `perf.spec.ts` has a check of its own: this computer with 500 pinned tabs, each with its own icon, and Effects at their largest on 40 sites, joining while the command bar types, then the drift check while it types. Its first runs found more: the drift check's slowest page took 7.4 ms and history's results 17.2; and a page of the copy, for a reconcile or a join, up to 8 ms, whatever it held. A page was sized with SQLite's `length`, which reads all of a text to count its characters, for the hundred or so things ahead of it: 5 MB of Effects read before anything. Pages are sized by bytes now (`octet_length`, which SQLite takes from the row's header), from the key's index on; the drift check finds what's gone from the rows by key and size, reading `local` only for those (it read every `local`, CSS and all); comparing two values (core's `same`, every field of every thing a reconcile looks at) no longer writes both out first; and the pages are smaller (the rows about 128 KB, the copy 100 things or about 256 KB). On the development machine a page of the copy went from 8 ms to under 2, the drift check's slowest from 6.8 to 2.2. A seeded table checks `same` against writing both out, for 4,000 pairs.
- **Measured** (`perf.spec.ts -g sync`, 4 CPUs, three runs, after Docker in WSL had been up a minute and a half): history's results within 11.2 to 15.1 ms while joining the large merge and 10 to 11.9 during frames of 300 changes (7.5 to 8.3 typing alone); with the large setup here, within 14.9 to 15.9 while joining and 10.8 to 13.6 during the drift check (11.4 to 14.4 typing alone before it): every keystroke within 16 ms. chord-data's sync steps with the large setup here: reading this computer's things at most 3.1 ms a page, adding them 1.2 a slice, the join's window 0.8, the drift check's slowest page 1.6 to 2.3 (7.4 before); with the large merge, merged slices at most 2.1 to 6.5 ms, writes of what main applied 3.9 to 7.9 (once). One change's frame 5.7 to 5.8 ms; memory 23 / 34.4 / 32.9 MB. Main's busiest 30 ms during frames of 300 changes 9.2 to 18.3, over a frame once, as before.

### The ninth review, and what changed

A ninth review asked for one rule in place of the special cases, for a simulation of the whole pipeline to find what reviews by reading miss, and for eight fixes it had reproduced. Each is done; the simulation found 37 more defects, each fixed, each seed that found one kept as a test.

**One rule: stamping by origin** (Decided, above). Every write says whose it is; yours are stamped, sync's and tidying's never are, and tidying may take away only what the merged copy doesn't hold live (a reconcile puts the rest back). Each row says who last wrote what sync keeps of it, and when that was made (`row_origin`): joining and the drift check go by it, so a write that changed nothing sync keeps (a tab's last visit) never re-times a row, and a row sync or tidying wrote counts as older than anything. Within the rule:

- **When:** a change is stamped as of when you made it (`WriteOp.at`), not when its write lands, which a full disk can put off for minutes; changes of one thing made more than a second apart and written together are each stamped as of their own time (`before`).
- **What it replaced:** a change of yours is stamped above the value it replaced when that value's stamp is ahead (another computer's clock). A value this computer never showed (read while its write waited, or not applied yet), or another computer's stamped after the change was made, isn't one it replaced: the later wins.
- **Deletions:** an explicit deletion of one thing is stamped whenever the copy knows the thing, live or gone already (a bringing back elsewhere, not read here yet, may be earlier), and only by your change (`took`); one made here and gone again before the copy had it is stamped gone too (a route is one by its host, and another computer may have made it). An absence inferred from a list (the themes') is stamped only for what was here.
- **Edit against delete:** an edit of what another computer deleted, its deletion not applied here yet, leaves the deletion (§4). Only bringing a thing back says it's here (`deleted: false`): an Undo, a tab pinned again, one made again under its id (`back`), as of then, with only the fields that differ from what this computer had of it before it went (`sync_record.was`).
- **Joining:** what you change while a join waits for your choice is noted with what it was before (`sync_noted`, durable across a crash) and stamped as the join ends, as a change from that: gone in the window, and here before it, a tombstone even if the copy hasn't read the thing yet; out of sync before and after (a tab an Undo brought back to Today), nothing. Each join takes a new id, so what this computer wrote under the old one is read as another computer's, and its new log never reuses a segment number pruned from the folder. *Use the synced setup* keeps which chords make way (`makingWay`) until none is left, and, with no synced chord to make way for (what this computer had deleted read in first), keeps this computer's chords in sync instead. A chord the synced setup has too is noted as this computer's (`local`), so renaming it is a rename.
- **The drift check** stamps only a difference in a row you wrote, at its time; a thing never written here since it came (an apply a crash lost) only refreshes `local`; and a route waiting for a chord that isn't here keeps what this computer has of it.
- **Applying** puts off what has a change of yours waiting, being written, or taken after chord-data read the push (`WriteSeq`), each part checked again as it goes in; what waits for another of your changes (a pane for its split, a tab for its chord's deletion) is asked for again once that one is written, never straight away.

**The simulation** (`apps/desktop/test/sim`, `pnpm test:sim`): three computers and, partway, a copy of one's profile, each with a real chord.db, main's store, persistence and sync service, chord-data's controller and the worker's code (`createSyncWorker`, in-process), over an in-memory folder per computer, and a sync app between them that delays, reorders, delivers files in parts, keeps both versions of a conflict, lets an edit beat a delete, and puts back old versions. Seeded, on fake timers. Each run makes random changes (chords, tabs, folders, splits, Favorites, routes, themes, settings, Undo), turns sync off and on, joins both ways, removes a computer, copies a profile, and injects faults: a crash at any moment, a full disk (`max_page_count`), a folder that fails or hangs, a sync app that stops. At each quiet point it checks: **I1** one merged copy, and each computer's rows what it says; **I2** every field your latest change; **I3** nothing gone that no one deleted; **I4** sync never puts an older value of yours over a newer one; **I5** a Today tab never goes without an Undo; **I6** a computer that hasn't caught up shows a problem. Run for more than 40,000 seeds in all, each defect fixed as it was found; the last 10,000 (827 s, 16 processes, 1.2 million steps: 835,290 changes, 39,661 crashes, 25,672 full disks, 30,954 folder faults, 10,515 old versions put back) kept every invariant. Each seed that found one runs with `pnpm test` (`test/unit/sync-sim-seeds.test.ts`, 34 seeds, about 25 s).

What it found, by where:

- *Full disk:* a join refused partway threw, and Settings said nothing (now `full`, said, and choosing again carries on); a put-off apply retried in a busy loop, and so did asking again for what waited on another change; a change stamped at write time beat later edits elsewhere; a change put off was stamped above another computer's later deletion it had never shown; two changes put off went as one, as of the later; another computer's change applied after one of yours was written before it, and yours brought back a theme it deleted; a chord made and deleted was written gone first; history and coalesced flags lost when a refused batch went back in the queue; a transaction rolled back left sync's meta and clock as if it hadn't.
- *Stamping:* a Today tab's write stamped the deletion of a pinned tab sync had moved; Undo and pinning again put stale fields back over others' changes; a creation under a reused id lost to an earlier deletion; an edit brought back what another computer deleted; a bringing back lost to an earlier deletion read later; a route made and removed here survived another's; an edit of what sync applied, not yet written, was stamped as all of it; an edit of a route waiting for its chord, never written here, brought back another computer's deletion; another computer's chord applied and taken away by you in one write was taken away first, and its Undo made it again, every field; a chord with no rank was given one no rank can follow, and the next chord made threw.
- *Joining:* rows sync had written were stamped at their row time over newer changes; unrelated writes re-timed rows; what you changed in a join's window was stamped as new (bringing back), lost in a crash, never stamped when it matched the copy, never stamped when the copy hadn't read the thing yet, or stamped as a deletion when an Undo brought a tab back to Today; a route made and removed in it was never stamped gone, and a deletion in it was stamped above another computer's later bringing back; a rejoin didn't read its own earlier log, and its snapshot reused a pruned segment number; a join's first snapshot not written left everything unsent; a crash lost a chord's making way; *Use the synced setup* with no synced chord (none come yet, or all deleted here, not yet written) left this computer's out of sync; a chord both had was never noted, and renaming it brought back another computer's deletion.
- *The drift check:* a set-aside row was taken for an edit; a route waiting for its chord was taken for gone, and an edit of it brought back another computer's deletion.
- *Applying:* a part applied after a change you made meanwhile overwrote it; a push read before your write landed put the older value back.
- *The folder:* a turn-off on a copy of a profile removed the original; a log put back to an old version, its computer off, lost what others had read of it (now whoever read past it writes a snapshot, at most once a minute, kept across a crash); a reader stuck for good in one copy's history of a segment the sync app replaced with another's (the cursor keeps its last frame's hash, and reads again from the start when that's changed); the other copy's version of a segment, kept under its name and as long as the one read, was never read (the cursor keeps the file's time too, and checks its last frame again when that changes); two copies of a profile each writing a segment of its own under one id never found each other (now a name skipped choosing a segment, and any real segment past this one's, is looked at with each pass).

Hardest invariants: I2 and I3, almost every finding (a change lost, or something brought back); I1 caught the folder's and the joins'.

**The eight fixes asked for:**

- **1. `sync.replace` stamped deletions everywhere.** Tidying's writes are never stamped now (the rule); a chord that made way can't take another computer's thing with it.
- **2. "Drift never adds" stranded pinned tabs and reverted edits made at an older row time.** The drift rule is the origin rule: a row you wrote (`row_origin`) that differs is your change, at its time, in a chord the copy has.
- **3. Turning off on a full disk failed silently.** `removed` that can't be written is let go; turning off that's refused is said (`full`), with a toast, and nothing's thrown at a timer; a transaction rolled back re-reads sync's meta, clock and outbox's size.
- **4. The kept copy:** user edits after turning off go into it as they are (`keptWrite`), so it never reverts them; main settles it (`settleKept`: what chord.db lacks applied, saved, then `sync.forget`), whatever still differs, at launch, after turning off or being removed, and before setting up or joining, later and later while the disk is full.
- **5. Quitting during the two-minute wait cancelled Turn off.** Quitting carries out a held Turn off or Remove, keeping the merged copy if what sync applied isn't all saved.
- **6. `unsaved` counted your own edits and history.** It counts only another computer's changes applied and refused.
- **7. History went out of order** when a refused batch went back: happenings carry their order and are put back in it.
- **8. Unbounded transactions.** Deleting a chord with 500, 2,000 and 5,000 pinned tabs took 19, 88 and 219 ms in one transaction (stamping, about 45 µs a tab, most of it); setting up, 94 to 110 ms. Now the deletion (and its Undo) goes as a durable intent a part at a time, at most 6.6 ms a part with 5,000 tabs, 218 ms in all (its Undo 10.4 and 314; chord-data's own tests, checkpoints off its thread as the app has them), and setting up a slice at a time, as a join.

### Not done here

- **Changes of one thing made within a second of each other** and written together go as one, as of the later (typing a name, say); further apart, each as of its own time. A change elsewhere in that second can lose to the earlier of yours.
- **The simulation** runs one process's code on fake timers with an in-memory folder and sync app: no clock ahead, no real disk or sync app, and main's store without its windows. What it can't reach, the unit tests, the E2E journeys and `docs/testing/sync.md`'s checklist do.
- **A file call that never returns** stays stuck in the system after its worker is let go, holding one of the process's four file threads until it does. At most two are risked: with two stuck, no other worker starts until one returns.
- **New names ahead of re-looking at changed junk:** a pass looks at names in folder order, junk whose size or time changed among them; a reader can't yet be told to look at names it has never seen first.
- **A sync-<n+1>.json written by anyone who can write to the folder**, valid and openable by its own passphrase, still pauses every computer, now with the neutral *Sync was started again in this folder with a new passphrase*. Someone with that access can also delete everything; telling a real change from a forged one needs the old passphrase, which *Start over* doesn't have.
- **A computer that took a new id because its segment was gone** leaves its old id in the others' list, as a computer not seen since: the old id may be another copy's, so it isn't marked removed. *Remove* takes it off.
- **A segment damaged in place** (bytes changed, its size the same) by someone who can write to the folder stops readers at that frame until its computer's next snapshot. Telling that from a frame still being delivered needs its size and time to stay put across passes; not done. Its own computer, finding its last frame changed, takes a new id (seen, and counted towards three a day).

- **By hand with real sync apps:** iCloud Drive, Dropbox, OneDrive and Syncthing, between Windows, macOS and Linux, from the checklist in [docs/testing/sync.md](../testing/sync.md). Not run: how each uploads, holds online-only files (and iCloud's `.icloud` placeholders on older macOS, which Chord doesn't ask for) and delivers half-written ones is still ⚠ untried, as is watching cloud folders.
- **Windows and macOS:** the journeys ran only in the Linux container; CI runs them on every OS. `safeStorage` with a real keychain (DPAPI, the Keychain, a Linux secret service) wasn't tried: the container has none.
- **⚠ The Flatpak:** a folder chosen through the document portal; not tried.
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
