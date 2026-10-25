// The site's download links: /download/<file> on chordbrowser.com redirects to
// that file in Chord's newest release, so the page and the README can link to
// one address forever. This writes:
//   site/downloads.conf    nginx's redirects (nginx.conf includes it)
//   site/public/latest.json  the version and each file's size, for the page
// .github/workflows/site-downloads.yml runs it whenever a release is published
// or deleted, and commits what changed; Clank redeploys the site from main.
//
// "Newest" is the highest version among releases that aren't drafts, previews
// included, so a patch to an older line never takes over the links.
// Usage: GH_TOKEN=... node site/tools/latest.mjs   (the token is optional locally)
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.env.GITHUB_REPOSITORY || 'anaremore/chord-browser';
const SITE = resolve(import.meta.dirname, '..');

/** Each download's address under /download/, and how its file is named in a release. */
export const FILES = {
  'win-x64': /-win-x64-setup\.exe$/,
  'win-arm64': /-win-arm64-setup\.exe$/,
  'mac-arm64': /-mac-arm64\.dmg$/,
  'mac-x64': /-mac-x64\.dmg$/,
  'deb-amd64': /-linux-amd64\.deb$/,
  'deb-arm64': /-linux-arm64\.deb$/,
  'rpm-x86_64': /-linux-x86_64\.rpm$/,
  'rpm-aarch64': /-linux-aarch64\.rpm$/,
  'appimage-x86_64': /-linux-x86_64\.AppImage$/,
  'appimage-arm64': /-linux-arm64\.AppImage$/,
  checksums: /^SHA256SUMS\.txt$/,
};

/** A tag's version as numbers to compare, or null for a tag that isn't Chord's (player-v…). */
export function version(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? m.slice(1).map(Number) : null;
}

/** Whether version a is above version b. */
function newer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The newest of Chord's releases that are out (not drafts). */
export function newest(releases) {
  let best = null;
  for (const release of releases) {
    const v = version(release.tag_name);
    if (release.draft || !v) continue;
    if (!best || newer(v, best.v)) best = { release, v };
  }
  return best?.release ?? null;
}

/** nginx's redirects for a release; a file it doesn't have goes to the release's page. */
export function redirects(release) {
  const lines = [
    `# Written by site/tools/latest.mjs from ${release.tag_name}. Don't edit: the next release replaces it.`,
    `location = /download { return 302 ${release.html_url}; }`,
  ];
  for (const [key, pattern] of Object.entries(FILES)) {
    const asset = release.assets.find((a) => pattern.test(a.name));
    lines.push(`location = /download/${key} { return 302 ${asset ? asset.browser_download_url : release.html_url}; }`);
  }
  lines.push(`location ^~ /download/ { return 302 ${release.html_url}; }`, '');
  return lines.join('\n');
}

export function summary(release) {
  const files = {};
  for (const [key, pattern] of Object.entries(FILES)) {
    const asset = release.assets.find((a) => pattern.test(a.name));
    if (asset) files[key] = { name: asset.name, size: asset.size };
  }
  return { version: release.tag_name.replace(/^v/, ''), tag: release.tag_name, url: release.html_url, published: release.published_at, files };
}

async function main() {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the releases`);
  const release = newest(await response.json());
  if (!release) throw new Error('No published Chord release: leaving the links as they are.');
  for (const url of [release.html_url, ...release.assets.map((a) => a.browser_download_url)]) {
    // Each goes into nginx's config: nothing but a plain https URL may.
    if (!/^https:\/\/github\.com\/[\w.@%/+-]+$/.test(url)) throw new Error(`Unexpected URL in the release: ${url}`);
  }
  writeFileSync(resolve(SITE, 'downloads.conf'), redirects(release));
  writeFileSync(resolve(SITE, 'public', 'latest.json'), `${JSON.stringify(summary(release), null, 2)}\n`);
  console.log(`Downloads now point to ${release.tag_name} (${Object.keys(summary(release).files).length} files).`);
}

// Run as a script; imported (by its test), it only lends its functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
