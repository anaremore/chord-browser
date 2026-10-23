# Third-party notices

Chord's own source is MIT ([LICENSE](../LICENSE)). It builds on the work and services below. This file travels with every copy of Chord, in its `licenses` folder, next to the license texts it mentions.

## Services

### Safe Browsing by Google

Chord's warnings about suspected phishing, malware and unwanted software come from the [Google Safe Browsing API](https://developers.google.com/safe-browsing) (v5, Local List Mode), used for non-commercial purposes under [Google's terms](https://developers.google.com/safe-browsing/v4/usage-limits) and the [Google APIs Terms of Service](https://developers.google.com/terms).

- Advisory provided by Google: <https://developers.google.com/safe-browsing/v4/advisory>.
- Google works to provide the most accurate and up-to-date information about unsafe web resources, but it can't guarantee that its information is comprehensive and error-free: some risky sites may not be identified, and some safe sites may be identified in error.
- What Chord sends: only when an address's 4-byte hash prefix is on one of the lists kept on your computer does Chord ask Google about that prefix. The address itself is never sent.
- Settings → Privacy turns it off; Google-free mode keeps it off. Builds made without Chord's API key (development, forks) don't include it.

## Components

| Component | License | Where |
|---|---|---|
| [Electron](https://www.electronjs.org/) and [Chromium](https://www.chromium.org/) | MIT, and Chromium's own licenses (BSD-3-Clause and others) | Each release's `LICENSE` and `LICENSES.chromium.html`, next to the executable |
| electron-chrome-extensions (the iamEvanYT fork), vendored as `packages/chrome-extensions` | GPL-3.0-only | [GPL-3.0.txt](GPL-3.0.txt); Chord's changes are in its CHORD-CHANGES.md |
| Crest's command bar ranking, adapted in `packages/core/src/rank.ts` | MPL-2.0 | [MPL-2.0.txt](MPL-2.0.txt) |
| [pdf.js](https://mozilla.github.io/pdf.js/), Duet's PDF reader (`out/main/pdf.js`) | Apache-2.0 | [Apache-2.0.txt](Apache-2.0.txt) |
| [Onest](https://github.com/googlefonts/onest), Chord's typeface | SIL Open Font License 1.1 | `OFL.txt` beside the fonts |

Other libraries bundled into Chord's own code (React, Motion, lucide-react, zod, immer, dnd-kit, fractional-indexing, uFuzzy and their dependencies) keep their MIT, ISC or CC0 licenses, listed in `pnpm-lock.yaml`.
