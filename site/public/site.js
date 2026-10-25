// chordbrowser.com: the chord chips, and the hero's download button for this
// computer. Without this script every download link still works: each is an
// address on this site that redirects to the newest release's file.
'use strict';

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

// Every download link is an address on this site, /download/<file>, that the
// server redirects to that file in the newest release (site/tools/latest.mjs
// rewrites the redirects when a release comes out). latest.json, beside the
// page, only adds the version and the sizes.

const megabytes = (bytes) => `${Math.round(bytes / 1e6)} MB`;

async function latest() {
  const response = await fetch('/latest.json');
  return response.ok ? response.json() : null;
}

function fill(release) {
  for (const link of document.querySelectorAll('[data-asset]')) {
    const file = release.files[link.dataset.asset];
    const size = link.querySelector('[data-size]');
    if (file && size) size.textContent = megabytes(file.size);
  }
  for (const tag of document.querySelectorAll('[data-version]')) tag.textContent = `Preview ${release.version}`;
  for (const note of document.querySelectorAll('[data-release]')) note.textContent = `Chord ${release.version}`;
}

/** The hero's button: the file for this computer, or the downloads below. */
function primary(release, { os, arm }) {
  const key = { windows: arm ? 'win-arm64' : 'win-x64', mac: arm ? 'mac-arm64' : 'mac-x64' }[os];
  const card = document.querySelector(`.platform[data-os="${os}"]`);
  if (card) card.dataset.current = '';
  const label = document.querySelector('[data-primary-label]');
  const note = document.querySelector('[data-primary-note]');
  const named = { windows: 'Windows', mac: 'macOS', linux: 'Linux' }[os];
  if (!named || !label) return;
  label.textContent = `Download for ${named}`;
  // Linux has three kinds of package: the button goes to the choice rather than guess.
  if (!key) {
    if (note) note.textContent = '.deb, .rpm and AppImage';
    return;
  }
  document.querySelector('[data-primary]').href = `/download/${key}`;
  const chip = { 'win-x64': 'Intel and AMD', 'win-arm64': 'Arm', 'mac-arm64': 'Apple silicon', 'mac-x64': 'Intel' }[key];
  const file = release?.files[key];
  if (note) note.textContent = file ? `${chip}, ${megabytes(file.size)}` : chip;
}

async function downloads() {
  const [release, here] = await Promise.all([latest().catch(() => null), platform()]);
  if (release) fill(release);
  primary(release, here);
}

chords();
void downloads();
