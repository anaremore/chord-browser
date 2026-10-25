# chordbrowser.com

Chord's website: one static page, served by nginx, on Clank.

- `public/`: the page (`index.html`, `styles.css`, `site.js`), Onest (OFL), the images and the 404 page.
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

Then open http://localhost:8089. `/health` answers `ok`.

## On Clank

Project **Chord site**, service **site**:
- **Source:** this repo, branch `main`.
- **Dockerfile:** `site/Dockerfile`.
- **Port:** 8080.
- **Health check:** `/health`.

Clank builds and deploys on every push to `main`. The domains are `chordbrowser.com` (primary) and `www.chordbrowser.com`, which nginx redirects to it.
