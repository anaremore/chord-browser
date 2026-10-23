# @chord/chrome-extensions

Chrome extension APIs for Electron, vendored into Chord. This is the
**iamEvanYT fork of electron-chrome-extensions**:

- **Source:** [github.com/iamEvanYT/electron-browser-shell](https://github.com/iamEvanYT/electron-browser-shell),
  branch `patched`, commit `25cf4d7`, `packages/electron-chrome-extensions/src`.
- **Published as** [`@iamevan/electron-chrome-extensions`](https://www.npmjs.com/package/@iamevan/electron-chrome-extensions) 4.9.5.
  Rebuilt from this source with upstream's settings, the result matches that package (see the commit that vendored it).
- **Original project:** [samuelmaddock/electron-browser-shell](https://github.com/samuelmaddock/electron-browser-shell), by Samuel Maddock.
  Upstream's own README is in [UPSTREAM-README.md](UPSTREAM-README.md).

## License

**GPL-3.0** ([LICENSE-GPL](LICENSE-GPL)). Upstream also offers a Patron License
([LICENSE-PATRON.md](LICENSE-PATRON.md)); Chord doesn't use it. Chord's own source is MIT, and
release builds of Chord, which include this package, are distributed under GPL-3.0 as a combined
work (ARCHITECTURE.md §16, decision D1). Everything here, including Chord's changes, stays GPL-3.0.

## How Chord uses it

Only through `ExtensionHost` (`apps/desktop/src/main/extensions/host.ts`), one per profile session.
Chord builds the source itself: electron-vite bundles `src/index.ts` into the main process and
`src/preload.ts` into `out/preload/extensions.cjs`.

Chord's typecheck reads the declarations in `types/` rather than this source, which keeps
upstream's compiler settings (`tsconfig.json`). After changing anything in `src/`, run:

```sh
pnpm --filter @chord/chrome-extensions typecheck
pnpm --filter @chord/chrome-extensions types
```

## Changes

Chord's changes are listed in [CHORD-CHANGES.md](CHORD-CHANGES.md), and each modified file says so in
its first line. Generic fixes should go upstream too.
