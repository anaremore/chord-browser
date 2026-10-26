# Chord's data files

Settings → Your data → **Export** writes everything in Chord to one file you can keep, read, or bring to another computer. This page says exactly what's in that file, so you can read it or write one without Chord. The design and its reasons are in [S15](decisions/S15-your-data.md).

A file is **plain** (`Chord data 2026-11-30.jsonl`) or **encrypted with a passphrase** (`Chord data 2026-11-30.chorddata`). Chord tells them apart by the first line, never by the name. Both hold the same lines; the encrypted one deflates and encrypts them.

## The plain file

UTF-8 [JSON Lines](https://jsonlines.org): one JSON value per line, each line ending in `\n`, no byte-order mark. A reader should accept `\r\n` too (`\r` is JSON's whitespace). Any editor, `jq` or DuckDB reads it.

1. **The header**, the first line:

   ```json
   {"chord":"data","format":1,"kind":"export","app":"0.5.0","device":"9f2c4e1a7b3d5c60","created":"2026-11-30T14:03:11.204Z","includes":["setup","today","history","duet"],"about":"https://github.com/anaremore/chord-browser/blob/main/docs/data-format.md"}
   ```

   | Field | What it is |
   |---|---|
   | `chord` | Always `"data"`: this is Chord's data. |
   | `format` | `1`. See [Versions](#versions). |
   | `kind` | `"export"`. (Sync's logs, later, use the same records.) |
   | `app` | The Chord version that wrote it. |
   | `device` | The computer that wrote it: 64 random bits as 16 hex digits. Its stamps carry the same id. |
   | `created` | When, in UTC (ISO 8601). |
   | `includes` | What's in it, in order: `setup`, `today`, and `history` and `duet` unless you switched them off. |
   | `about` | This page. |

2. **Records**, one per line, in this order: setup (chords, Pinned's folders, tabs and splits, Favorites, themes, settings, link routes, Effects, zoom, permissions), then Today's tabs and splits, then the icons they and Favorites use, then history, then Duet's chats. A reader that only wants setup can stop early.

3. **The end**, the last line: `{"end":<the number of records>}`. A file without it, or with a different count, was cut off or changed. A reader takes any object with a whole-number `end` and no `type` as the end line, since a later Chord may add to it.

**Limits.** No line is longer than 32 MiB of UTF-8: Chord leaves out a record that would be (a huge image, say) and says so, and refuses a longer line when it reads. A whole file holds at most 2 GiB of lines. Chord reads a file as it comes, a line (or a frame) at a time, never whole.

## Records

```json
{"type":"tab","id":"019a3c2e-7b1f-7c3d-9a1e-4f2b6c8d0e1a","at":[1764511391204,0,"9f2c4e1a7b3d5c60"],"set":{"pos":{"chord":"019a3c2d-…","section":"pinned","parent":null,"rank":"a1"},"url":"https://mail.example/","pinnedUrl":"https://mail.example/","title":"Inbox","customTitle":"Mail","icon":"sha256-3f…","muted":false,"created":1700000000200}}
```

| Key | What it is |
|---|---|
| `type` | What the record is (the table below). Lowercase letters, digits and `-`. |
| `id` | Which one. Chord's own ids are [UUIDv7](https://www.rfc-editor.org/rfc/rfc9562); some types use a natural key, such as a site or an address. |
| `at` | The stamp of every field in `set`: `[milliseconds since 1970 UTC, counter, device]`, compared in that order. Only setup has one. In an export it's when the row last changed; `0` means before Chord kept that time. |
| `set` | The fields this record sets. **A field that isn't there is "not set", never a default.** `null` is a value: "none". |

- One thing can take several lines, one per stamp: settings changed at different times, for example. Later lines add to earlier ones.
- `"deleted": true` in `set` deletes a thing (sync's tombstones). Exports never have them.
- **A type or field you don't know: pass over it, and keep it if you write the file back.** A newer Chord may add them; that's how format 1 grows.

### Types

`pos` (on folders, tabs and splits) is one field: `{"chord": <chord id>, "section": "pinned" | "today", "parent": <folder or split id> | null, "rank": <string>}`. Ranks are [fractional indexes](https://www.npmjs.com/package/fractional-indexing): siblings sort by rank as strings, then by id.

| Type | Id | Fields |
|---|---|---|
| `chord` | UUIDv7 | `name`; `icon` (an emoji, a symbol's name or a letter); `theme` (`{"stops": [{"l","c","h"}…] (1–3 OKLCH colors: l 0–1, c 0–0.4, h 0–360), "grain": 0–1, "appearance": "light" \| "dark" \| "auto", "themeId"?}`); `rank`; `profile` (`"default"` when it shares your sign-ins, else the id of its own; the sign-ins themselves are never exported); `created` (ms); `proxy` (its own proxy, or `null` for the proxy for every chord; see the `proxy` setting) |
| `folder` | UUIDv7 | `pos` (always Pinned); `title`; `collapsed`; `created` |
| `tab` | UUIDv7 | `pos`; `url` (where it is: a web address, or `chord://archive/`, Chord's archive page); `pinnedUrl` (a pinned tab's home, or `null`); `title`; `customTitle` (or `null`); `icon` (an `icon` record's id, or `null`); `muted`; `created` |
| `split` | UUIDv7 | `pos`; `direction` (`"row"`: side by side, or `"column"`); `sizes` (each pane's share, in pane order, adding up to 1); `created`. Its panes are the tabs whose `pos.parent` is the split, in rank order. |
| `favorite` | UUIDv7 | `url`; `title`; `icon`; `rank`; `created` |
| `theme` | its id | A theme you made: `name`; `stops`; `grain` |
| `settings` | `settings` | One field per setting ([below](#settings)) |
| `route` | the site, maybe with a path (`github.com/acme`) | `chord` (where its links open); `created` |
| `effects` | the site: its host without `www.`, with its port if any | `wet` (the site's Dry/Wet); `css` (your CSS, as written); `cssOn`; `hidden` (`[{"selector", "label", "on"}]`); `presets` (`"reading-width"`, `"dark"`, `"no-sticky"`: the ones that are on); `duet` (Duet's patches: `[{"ask", "summary", "css", "on"}]`). A switch that isn't there is on. Chord checks every stylesheet again before it uses it. |
| `icon` | `sha256-` and the hex of the bytes' SHA-256 | `mime` (`image/png`, …); `data` (the bytes, base64). Only icons a record above uses. |
| `zoom` | host | `factor` (0.25–5) |
| `permission` | origin (`https://meet.example`) | One field per permission (`camera`, `microphone`, `location`, `notifications`, `clipboard-read`): `"allow"` or `"block"`. Chord imports only blocks. |
| `page` | its address | `title`; `visits` (each visit's time in ms, oldest first); `typed` (how many times you typed it) |
| `thread` | UUIDv7 | A Duet chat: `chord`; `title`; `provider` (`"claude"` or `"codex"`); `model` (or `null`); `scope` (`"every"`, `"ask"`, `"chord"`, `"all"`: what it may read); `created`; `updated`; `lastUsed` |
| `message` | UUIDv7 | `thread`; `created`; `body`, as Chord keeps it, by its `role`: `user` (`text`, `attachments` `[{"ref","url","title"}]`, `images`?), `assistant` (`text`, `citations` `[{"n","ref","url","title","quote","tabId": null,"page"?}]`, `status`, `error`?, `images`?), `tool` (`tool`, `summary`, `detail`, `ok`), `approval` (`tool`, `description`, `target`, `decision`), `divider` (`text`). An image there is `{"id","mime","width","height","prompt"?}`. |
| `image` | its id (24 hex digits) | An image in a chat: `mime` (PNG, JPEG or WebP); `width`; `height`; `data` (base64); `thumb` (the small JPEG Duet's panel shows, base64, or `null`); `prompt` (what Codex made it from, or `null`) |

History, Duet's chats and icons never change once made, so their records have no `at`.

### Settings

Each setting that travels is a field of the `settings` record. A group's parts are fields of their own, with dotted names; a setting that's replaced whole (a list, the proxy) is one field.

| Fields | Values |
|---|---|
| `searchEngine` | `"google"`, `"duckduckgo"`, `"bing"`, `"brave"`, `"kagi"`, `"ecosia"` |
| `searchSuggestions`, `separateSignIns`, `sleepTabs`, `autoPip`, `pagePreviews`, `presentingHidesSidebar`, `sidebarPeek`, `keepScreenshots`, `googleFree`, `safeBrowsing`, `safeBrowsingAsked`, `encryptExports` | `true` or `false` |
| `colorScheme` | `"system"`, `"light"`, `"dark"` |
| `interface.contrast`, `interface.glass` | 0–1 |
| `motion.followSystem`, `motion.commandBar`, `motion.chordSlide`, `motion.tabMoves`, `motion.sidebar`, `motion.colorBlend` | `true` or `false` |
| `extensionButtons` | `"sidebar"` or `"titleBar"` |
| `archiveAfter` | `"12h"`, `"24h"`, `"7d"`, `"30d"`, `"never"` |
| `spellcheck.enabled`, `spellcheck.language` | `true`/`false`; a language like `"en-US"`, or `null` for the system's |
| `adBlocking.enabled`, `adBlocking.offSites` | `true`/`false`; the sites it's off for |
| `tabCounts.enabled`, `tabCounts.offSites` | `true`/`false`; the hosts whose counts are hidden |
| `duet.enabled`, `duet.keep`, `duet.scope`, `duet.readsNothing`, `duet.neverSites`, `duet.offChords`, `duet.codexImages` | Duet's settings (`keep`: `"forever"`, `"90d"`, `"30d"`) |
| `externalLinks` | `"mini"` or `"tab"` |
| `reader.size`, `reader.width`, `reader.theme`, `reader.font` | reader view's look |
| `effects.wet` | Dry/Wet for every site |
| `shortcuts.mac`, `shortcuts.other` | Your keyboard shortcuts, by action (`{"tab.new": ["Ctrl+Alt+T"]}`): a Mac writes `mac`, Windows and Linux write `other`, and each reads only its own. |
| `proxy` | The proxy for every chord: `{"mode": "system" \| "none" \| "server" \| "pac", "server": {"scheme": "http" \| "https" \| "socks5", "host", "port", "bypass": [...]} \| null, "pac": <a PAC file's address> \| null}`. Never a password: one in a PAC file's address is taken out. Exported so a restore brings it back, but never synced: it's about the network a computer is on. A chord's own proxy, on its `chord` record, is the same shape. |

Not in a file, because they're about one computer or happen once: the interface size, update checks, the mini window's size, developer tools' side and size, Duet's app and model, first run's flag. Themes you made are `theme` records.

## The encrypted file

```
chord-encrypted 1\n
{"chord":"data","format":1,…,"kdf":{"name":"scrypt","N":131072,"r":8,"p":1,"salt":"…"},"salt":"…","check":"…"}\n
[frame][frame]…[last frame]
```

1. **The first line** is `chord-encrypted 1`, so a person who opens the file can tell what it is. The `1` is the envelope's version (everything below), apart from the records' `format`.
2. **The header**, the second line: the plain file's header, readable, plus:
   - `kdf`: how the passphrase becomes a key: `scrypt` with `N`, `r`, `p`, and `salt` (base64, 32 bytes).
   - `salt`: this file's own salt (base64, 32 bytes).
   - `check`: base64 of a 12-byte nonce, then the word `chord` sealed with the check key (below), with its 16-byte tag. It tells a wrong passphrase from a damaged file before anything else is read.
3. **Frames**, each: a 4-byte length (big-endian: how many bytes follow in this frame), a 12-byte random nonce, the ciphertext, and its 16-byte GCM tag. A frame's plaintext is whole lines (about 256 KB of them, or one longer line), compressed with raw DEFLATE ([RFC 1951](https://www.rfc-editor.org/rfc/rfc1951): no zlib or gzip header). The frames' plaintexts, in order, are exactly the plain file's lines after its header: the records, then `{"end":…}`.

**The keys.**
- The passphrase, normalized to Unicode NFC and encoded as UTF-8.
- `root` = scrypt(passphrase, kdf salt, N, r, p, 32 bytes). With N=2¹⁷ and r=8 that takes 128 MiB; some libraries need their memory limit raised.
- `check key` = HKDF-SHA256(root, salt = kdf salt, info = `chord check 1`, 32 bytes). It must open `check` (AES-256-GCM, no associated data) to `chord`; otherwise the passphrase is wrong.
- `file key` = HKDF-SHA256(root, salt = the file's salt, info = `chord file 1`, 32 bytes).

**Each frame** is AES-256-GCM with the file key, its nonce, and as associated data: the SHA-256 of the header line (its bytes, without the `\n`), then the frame's index from 0 (8 bytes, big-endian), then one byte: 1 for the last frame, 0 for the others. So nobody can change the header, reorder frames, drop one or move one to another file; and a file whose last frame is missing was cut short. A frame is at most 40 MiB and inflates to at most 48 MiB. Chord reads scrypt with N a power of two from 2¹⁰, N < 2^(16·r), r up to 32, p up to 4, and 128·N·r at most 256 MiB; anything else reads as a newer Chord's.

**Decrypting in Python**, with the [`cryptography`](https://cryptography.io) package. Checked on 2026-10-26 with Python 3.12 and cryptography 44 against a file Chord wrote: its records came out byte for byte as the plain file's, with a passphrase typed in either Unicode form, and a wrong one failed.

```python
import hashlib, json, struct, sys, unicodedata, zlib
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from base64 import b64decode

def hkdf(key, salt, info):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(key)

def decrypt(data: bytes, passphrase: str) -> bytes:
    magic, header_line, frames = data.split(b"\n", 2)
    assert magic == b"chord-encrypted 1", "not an encrypted Chord file, or a newer one"
    header = json.loads(header_line)
    kdf = header["kdf"]
    assert kdf["name"] == "scrypt"
    kdf_salt = b64decode(kdf["salt"])
    root = hashlib.scrypt(unicodedata.normalize("NFC", passphrase).encode(), salt=kdf_salt,
                          n=kdf["N"], r=kdf["r"], p=kdf["p"], maxmem=2 * 128 * kdf["N"] * kdf["r"], dklen=32)
    check = b64decode(header["check"])
    if AESGCM(hkdf(root, kdf_salt, b"chord check 1")).decrypt(check[:12], check[12:], None) != b"chord":
        raise ValueError("wrong passphrase")  # cryptography raises InvalidTag first
    key = AESGCM(hkdf(root, b64decode(header["salt"]), b"chord file 1"))
    header_hash = hashlib.sha256(header_line).digest()
    out, at, index, last = [], 0, 0, False
    while at < len(frames) and not last:
        (length,) = struct.unpack(">I", frames[at:at + 4])
        nonce, body = frames[at + 4:at + 16], frames[at + 16:at + 4 + length]
        at += 4 + length
        last = at >= len(frames)
        aad = header_hash + struct.pack(">QB", index, 1 if last else 0)
        out.append(zlib.decompress(key.decrypt(nonce, body, aad), wbits=-15))
        index += 1
    # The header line (a plain file's, with kdf, salt and check too), then the plain file's records and end, byte for byte.
    return header_line + b"\n" + b"".join(out)

sys.stdout.buffer.write(decrypt(open(sys.argv[1], "rb").read(), sys.argv[2]))
```

## What Chord does with a file it imports

Settings → Your data → *From a Chord file* brings a file back. What Chord does with one, so a file you write by hand does what you expect:

- **Field by field, the newer stamp wins** over the same field here (each row's `updated_at` stands in for Chord's own stamps). A value equal to Chord's changes nothing. Into a clearly fresh Chord (only its first chord and that chord's one tab, no other setup, no Duet chats, at most 20 pages of history, settings as first run left them), every field of the file wins, and that chord makes way for the file's.
- **One import brings at most** 100 new chords, 10,000 new tabs and 2,000 new folders, in the file's order, folders at most 16 deep (one deeper comes in at its section's top level), and a page's newest 10,000 visits. Fields a record has that Chord doesn't read are dropped as it's read.
- **Nothing is deleted.** A thing whose newest `deleted` is `true` is passed over: it neither comes in nor goes. Something deleted here comes back if the file has it.
- **Matches merge:** a `favorite` at an address Chord has is that Favorite; `route`, `effects`, `zoom` and `permission` by their ids, a site or an origin.
- **Permissions:** only `block`. **Settings**, and a chord's own `proxy`, only when you turn on *Settings from the file*. **A chord Chord has keeps its sign-ins** (`profile`).
- **`page`:** a visit Chord has (the same address at the same millisecond) isn't added again; `typed` takes the larger count. **`thread`, `message`:** added by id, never replaced; a message only into a chat the same file brings, never one Chord has; a chat comes with no session, reads no more than a new chat would, and its turns go to Claude Code or Codex only as data, never as instructions. **`image`:** only if its bytes are the PNG, JPEG or WebP its `mime` says, and no image of that id is here.
- Every record is checked as Chord checks its own saved data. One that doesn't read, or points at a chord or folder that isn't there, is left out or put at its section's root.

## Versions

- **`format` is 1. Every later Chord reads every earlier format.** A format-1 file must open in every Chord to come.
- **Within format 1, changes are additions only**: new types, new fields, new values. A name never changes meaning; a new meaning gets a new name.
- `format` goes to 2, or the envelope to `chord-encrypted 2`, only when an older Chord would misread the file: a new cipher, say. An older Chord then says the file is from a newer Chord. A key derivation it doesn't know (Argon2id, one day) reads the same way.

## Never in a file

Passwords (Chord keeps none); cookies and sign-ins; open tabs' back/forward history (it can hold what you typed into forms); private windows; downloads; the archive; windows and their sizes; extensions; learned command bar picks; hover-preview pictures and screenshots; Duet's provider sessions and the copies Codex keeps of its images. The one address of your computer's a file can hold is a proxy's configuration file, if you set one there.
