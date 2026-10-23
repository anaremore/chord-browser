# S10: Which hosts Chord contacts on its own (Google-free mode)

**Result: Chord's own Google traffic comes from four sources.**
- Search suggestions.
- The default search engine.
- Spellcheck dictionary downloads.
- Chrome Web Store extension updates.

A fifth Google contact is only a page: a brand-new profile's first tab is `www.google.com`. Electron 45.0.0 (Chromium 156) itself sends nothing to Google: no Safe Browsing, component updater, variations or metrics. Measured on Windows 11 on 2026-10-23. Linux and macOS are covered by the CI test, not by hand.

**What Chord does about it:** Settings → Privacy → **Google-free mode** (`googleFree` in `@chord/core`; `src/renderer/settings/Privacy.tsx`).

## How it was measured

`spikes/s10-google-free/audit.mjs` runs the development build with Chromium's net log (`--log-net-log`) on a fresh profile, twice:
- **A.** The first launch with defaults, idle for 40 s.
- **B.** A launch whose only page is a local one (`CHORD_HOME_URL`). In it, you type a search in the command bar and focus a text field with misspellings. `--spell nl` first picks a spelling language Windows doesn't check itself, and `--google-free` first turns the mode on.

The log is read by `apps/desktop/test/e2e/netlog.ts`. It counts only what was actually contacted, meaning URL requests started and names looked up, not hosts merely mentioned in headers or page text. Loopback is left out.

Run it from `apps/desktop` after `pnpm build`:

```
node ../../spikes/s10-google-free/audit.mjs [--seconds 40] [--spell nl] [--google-free]
```

## What it found

| Session | Host | What asked for it |
|---|---|---|
| A, first launch | `www.google.com`, `www.gstatic.com`, `fonts.gstatic.com`, `ogads-pa.clients6.google.com`, `play.google.com`, `csp.withgoogle.com` | **The first tab.** A new profile's first tab is `https://www.google.com/` (`HOME_URL`, `src/main/index.ts`), and these are that page and what it loads: scripts, fonts, its logging (`play.google.com/log`) and its CSP reports. This is a visited page, not a background call. Later launches restore your tabs instead. |
| A and B | `wpad` (DNS only) | **Windows proxy auto-discovery**, from the system's "Automatically detect settings". This is on the local network, it isn't Google, and the OS decides it, not Chord. |
| B | `www.google.com/complete/search` | **Search suggestions** (`src/main/suggestions.ts`), on by default with Google as the engine. Each pause in typing sends what's been typed. |
| B with `--spell nl` | `redirector.gvt1.com`, then `rr4---sn-….gvt1.com` | **A spellcheck dictionary download** (`nl-nl-3-0.bdic`), from `SPELLCHECK_DICTIONARIES_URL` (`src/main/spellcheck.ts`), Chromium's default CDN. Windows checks the languages it has itself, so English didn't download. On Linux, every language downloads the first time it's used. macOS never downloads. |

Not seen in a fresh session, but in the code:

| Host | When | Source |
|---|---|---|
| `clients2.google.com`, then Google's download CDN | A minute after launch, then every 5 hours, **if any Chrome Web Store extension is installed** | The Web Store update check, `src/main/extensions/webstore.ts`. Installing from the store goes there too, but you start that yourself. |
| `www.google.com/search` | Whenever you search, with Google as the engine | `SEARCH_ENGINES`, `@chord/core` |
| `api.github.com`, `github.com` and its download host | 30 s after launch, then daily (**installed builds only**) | The update check and in-app updates (`src/main/updates.ts`, `update-installer.ts`). This is GitHub, not Google, and it stays on in Google-free mode. |
| `www.google.com/maps`, `www.youtube.com`, `chrome.google.com/webstore` | Only when you type the `maps` or `yt` keyword, or open an extension's store page from its menu | Navigations you ask for, like any link. |

Nothing else came up:
- **Chromium services:** Electron doesn't build in Safe Browsing, the component updater, variations, UMA or GCM.
- **Favicons:** fetched from the page's own icon URL (`tabs.ts`), never from a favicon service.
- **Fonts:** Chord's are bundled.

## What Google-free mode changes

| Source | With the mode on |
|---|---|
| Search engine | **Never Google.** Turning the mode on moves to DuckDuckGo (`GOOGLE_FREE_ENGINE`), and Settings → Privacy offers the other five. The reducer ignores a Google choice while the mode is on, and restoring a profile repairs one. Settings → General greys Google out. |
| Search suggestions | Follow your switch in General, and come from the chosen engine, which is never Google. Main also refuses Google suggestions as a backstop. |
| Spellcheck dictionaries | **Only dictionaries already downloaded**, plus the system's own spellchecker: macOS, and Windows for its languages. The download URL becomes `SPELLCHECK_OFFLINE_URL` (`http://127.0.0.1:9/`). Port 9 is on Chromium's restricted-ports list, so a missing dictionary fails at once and nothing leaves the computer. Chord's own UI session never spellchecks at all, so it never needs a dictionary, in either mode. |
| Web Store extension updates | **No background checks.** Settings → Extensions → *Check for updates* still works when you press it. |
| First tab of a new profile | Unchanged: the mode can't be on before the first launch. |
| Chord's own update check | Unchanged (GitHub). |

### Pointing dictionaries elsewhere instead

Electron publishes `hunspell_dictionaries.zip` with every release, for exactly this ([`session.setSpellCheckerDictionaryDownloadURL`](https://www.electronjs.org/docs/latest/api/session#sessetspellcheckerdictionarydownloadurlurl)). Chord could host those files on a host it controls and point Google-free mode there, so new languages still work. Chromium asks for lowercase names, like `nl-nl-3-0.bdic`, so each file must be served under its lowercase name.

That needs a hosting decision, and a check on each Electron upgrade that the files still match. Until then the mode stays local-only.

## Kept honest by a test

`apps/desktop/test/e2e/google-free.spec.ts` runs on every OS in CI and needs no network:
1. It turns the mode on through Settings → Privacy and picks a Dutch spelling dictionary that isn't downloaded.
2. It relaunches with `--log-net-log`, then types in a text field and searches in the command bar.
3. It **fails if any Google host** (`google`, `gstatic`, `googleapis`, `gvt1`, `withgoogle`, `youtube` and their kin) was contacted.
4. It also requires `duckduckgo.com`, so the search must really have happened.

The same steps with the mode off contact `redirector.gvt1.com`, `rr1---sn-….gvt1.com` and `www.google.com/complete/search` (checked when the test was written), so the test can tell the two apart.

## Not verified here

- **Linux by hand.** Dictionaries download for every language there, including the system's, so this is where the offline URL matters most. The CI test covers it.
- **The first tab of a new profile** still loads Google. Having first run offer the search engine, and open that engine's home page, would close this.
