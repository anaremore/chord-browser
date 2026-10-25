# chordbrowser.com

Chord's website: a few static pages, served by nginx, on Clank.

- `public/`: the home page (`index.html`, `styles.css`, `site.js`), `install.html`, `privacy.html`, the 404 page, Onest (OFL) and the images. Pages are served without `.html`: `/install`, `/privacy`.
- `public/partials/`: the header and footer every page shares. nginx puts them in (`<!--# include virtual="/partials/header.html" -->`), and doesn't serve them on their own. A new page includes both, and goes in `sitemap.xml`.
- The header has one way to get Chord, Download; the install steps are linked from the download section and the footer. Once there's a second help page (setting up Duet, shortcuts), the header gets Docs at `/docs`, with Install as its first page and `/install` redirecting there.
- `nginx.conf` and `headers.inc`: files, a strict content security policy, `/health` for Clank, and `www.` redirecting to the bare domain.
- `downloads.conf` and `public/latest.json`: the download links, written by `tools/latest.mjs` (below). Don't edit them by hand.
- `Dockerfile`: the image, built from the repo's root. `Dockerfile.dockerignore` keeps the build context to `site/`.
- `tools/assets.py`: the images, made from the repo's own (below).
- `test/`: unit tests for `tools/latest.mjs`, run with the repo's `pnpm test`.

## What the page does

- **The download links** are addresses on the site, `/download/<file>`, that nginx redirects to that file in the newest release. The newest release is the highest version that isn't a draft, previews included.
  - **Addresses:** `win-x64`, `win-arm64`, `mac-arm64`, `mac-x64`, `deb-amd64`, `deb-arm64`, `rpm-x86_64`, `rpm-aarch64`, `appimage-x86_64`, `appimage-arm64` and `checksums`. Plain `/download` goes to the release's page.
  - **Updating them:** `.github/workflows/site-downloads.yml` runs `tools/latest.mjs` whenever a release is published or deleted, and commits the new `downloads.conf` and `public/latest.json` to `main`. Clank then redeploys the site.
  - **Refreshing by hand:** run that workflow (*Actions → Site downloads → Run workflow*), or `node site/tools/latest.mjs` locally, then commit the two files.
  - **The page itself** reads `latest.json` for the version and the sizes, and picks the hero's file for the visitor's computer. It sends no request anywhere but this site, and every link works without the script.
- **The chord chips** change the page's `--hue`, the way a chord tints Chord's sidebar. No inline styles anywhere: the content security policy allows none.
- **Light and dark** follow the visitor's system.

## Images

The screenshots are the README's (`docs/images`, from `scripts/dev/readme-shots.mjs`). After they or the app icon change:

```sh
python -I site/tools/assets.py
```

That writes the WebP screenshots, the favicons and the link-preview card (`images/card.png`, set in Onest). It needs Pillow with WebP, and fontTools with brotli.

Fonts and images are cached for a year, so a changed image needs a new file name. `styles.css` and `site.js` are cached for 5 minutes; bump their `?v=` in the HTML when they change.

## Try it

```sh
docker build -f site/Dockerfile -t chord-site:dev .
docker run --rm -p 8089:8080 chord-site:dev
```

Then open http://localhost:8089. `/health` answers `ok`. Opened as files, the pages have no header or footer, since nginx puts those in.

## On Clank

Project **Chord site**, service **site**:
- **Source:** this repo, branch `main`.
- **Dockerfile:** `site/Dockerfile`.
- **Port:** 8080.
- **Health check:** `/health`.

Clank builds and deploys on every push to `main`, which it hears about through its GitHub App. **That app must have access to this repo** (GitHub → Settings → Applications → Installed GitHub Apps → Clank's → Configure → Repository access). Without it, nothing deploys by itself. *Site downloads* then fails its check that the site serves the new version, so a missed deploy shows up as a failed run, not as an out-of-date site. To deploy by hand: `clank deploy bc3faaf3-d723-4380-b65f-0df74c5db25d` (project *Chord site*, service *site*). The app has had access since 2026-10-25.

The domains are `chordbrowser.com` (primary) and `www.chordbrowser.com`. A Cloudflare redirect rule sends `www` to the bare domain, and nginx does the same if a request gets through.

## With each release

The site describes what people can download, so it changes with releases, not with every merge to `main`.
- **On publish, automatic:** *Site downloads* points the links at the new release, Clank redeploys, and the workflow checks chordbrowser.com serves it.
- **In the release commit** (`chore(release): vA.B.C`, docs/releasing/patch-runbook.md §5), when the release adds or changes a major feature:
  - the copy: the hero, *Everything in its place* and its list, and the privacy promises if they change;
  - the screenshots: retake them (`scripts/dev/readme-shots.mjs` makes `docs/images`), then run `python -I site/tools/assets.py`;
  - a quick look at the page, light and dark, before tagging.
