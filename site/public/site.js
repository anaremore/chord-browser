// chordbrowser.com: the chord chips, and the download links from the newest
// release on GitHub (the page's only request elsewhere). Without this script,
// or if GitHub can't be reached, every link still goes to the release page.
'use strict';

const REPO = 'anaremore/chord-browser';

/* ---------- The chord chips: the page changes key ---------- */

function chords() {
  const chips = [...document.querySelectorAll('.keys [data-hue]')];
  const pick = (chip, focus) => {
    for (const other of chips) {
      const on = other === chip;
      other.setAttribute('aria-checked', String(on));
      other.tabIndex = on ? 0 : -1;
    }
    document.documentElement.style.setProperty('--hue', chip.dataset.hue);
    if (focus) chip.focus();
  };
  chips.forEach((chip, i) => {
    chip.tabIndex = chip.getAttribute('aria-checked') === 'true' ? 0 : -1;
    chip.addEventListener('click', () => pick(chip, false));
    // A radio group: the arrow keys move along it.
    chip.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      pick(chips[(i + step + chips.length) % chips.length], true);
    });
  });
}

/* ---------- Which computer this is ---------- */

async function platform() {
  const data = navigator.userAgentData;
  let os = 'other';
  let arm = false;
  const name = (data?.platform || navigator.platform || '').toLowerCase();
  if (name.startsWith('win')) os = 'windows';
  else if (name.startsWith('mac')) os = 'mac';
  else if (name.includes('linux') && !/android/i.test(navigator.userAgent)) os = 'linux';
  try {
    const high = await data?.getHighEntropyValues?.(['architecture']);
    arm = high?.architecture === 'arm';
  } catch {
    // Not offered: guess Intel or AMD on Windows and Linux, Apple silicon on a Mac (below).
  }
  // Browsers on a Mac don't say which chip it has; Apple silicon is the safer default now.
  if (os === 'mac' && !data) arm = true;
  return { os, arm };
}

/* ---------- The newest release ---------- */

/** Each download's key (data-asset), and how its file is named in a release. */
const ASSETS = {
  'win-x64': /-win-x64-setup\.exe$/,
  'win-arm64': /-win-arm64-setup\.exe$/,
  'mac-arm64': /-mac-arm64\.dmg$/,
  'mac-x64': /-mac-x64\.dmg$/,
  'deb-amd64': /-linux-amd64\.deb$/,
  'deb-arm64': /-linux-arm64\.deb$/,
  'rpm-x86_64': /-linux-x86_64\.rpm$/,
  'appimage-x86_64': /-linux-x86_64\.AppImage$/,
  'appimage-arm64': /-linux-arm64\.AppImage$/,
};

const megabytes = (bytes) => `${Math.round(bytes / 1e6)} MB`;

async function latest() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) return null;
  const releases = await response.json();
  // Drafts aren't listed for visitors; previews are pre-releases, so "latest" alone would skip them.
  return releases.find((release) => !release.draft) ?? null;
}

function fill(release) {
  const files = {};
  for (const [key, pattern] of Object.entries(ASSETS)) {
    const asset = release.assets.find((a) => pattern.test(a.name));
    if (asset) files[key] = asset;
  }
  for (const link of document.querySelectorAll('[data-asset]')) {
    const asset = files[link.dataset.asset];
    if (!asset) continue;
    link.href = asset.browser_download_url;
    const size = link.querySelector('[data-size]');
    if (size) size.textContent = megabytes(asset.size);
  }
  for (const link of document.querySelectorAll('[data-release-link]')) link.href = release.html_url;
  const version = release.tag_name.replace(/^v/, '');
  for (const tag of document.querySelectorAll('[data-version]')) tag.textContent = `Preview ${version}`;
  for (const note of document.querySelectorAll('[data-release]')) note.textContent = `Chord ${version}`;
  return files;
}

/** The hero's button: the file for this computer, or the downloads below. */
function primary(files, { os, arm }) {
  const key = { windows: arm ? 'win-arm64' : 'win-x64', mac: arm ? 'mac-arm64' : 'mac-x64', linux: arm ? 'appimage-arm64' : 'appimage-x86_64' }[os];
  const card = document.querySelector(`.platform[data-os="${os}"]`);
  if (card) card.dataset.current = '';
  const asset = key ? files?.[key] : undefined;
  const label = document.querySelector('[data-primary-label]');
  const note = document.querySelector('[data-primary-note]');
  const named = { windows: 'Windows', mac: 'macOS', linux: 'Linux' }[os];
  if (!named || !label) return;
  label.textContent = `Download for ${named}`;
  // Linux has three kinds of package: the button goes to the choice rather than guess.
  if (os === 'linux' || !asset) {
    if (note) note.textContent = os === 'linux' ? '.deb, .rpm and AppImage' : 'Windows, macOS and Linux';
    return;
  }
  document.querySelector('[data-primary]').href = asset.browser_download_url;
  const chip = { 'win-x64': 'Intel and AMD', 'win-arm64': 'Arm', 'mac-arm64': 'Apple silicon', 'mac-x64': 'Intel' }[key];
  if (note) note.textContent = `${chip}, ${megabytes(asset.size)}`;
}

async function downloads() {
  const [found, here] = await Promise.all([latest().catch(() => null), platform()]);
  const files = found ? fill(found) : null;
  primary(files, here);
}

chords();
void downloads();
