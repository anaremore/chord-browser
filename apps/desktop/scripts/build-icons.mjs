// Renders Chord's app icon from its SVG masters (build/icon.svg, and
// icon-16/24/32.svg for those sizes on Windows and Linux) into everything
// packaging and the window need:
//   build/icon.png          1024 px on the macOS grid (also the README's)
//   build/icon.icns         macOS, 16–1024 px
//   build/icon.ico          Windows, 16–256 px
//   build/icons/NxN.png     Linux hicolor sizes, 16–512 px
// Chromium draws the SVGs in a hidden offscreen page, so there's no image
// library to install, and the output only changes when a master does.
// Usage: pnpm --filter @chord/desktop icons
/* global document, Image -- used in the page that draws the icons */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const build = join(dirname(script), '..', 'build');

if (!process.versions.electron) {
  // Under Node: run this file in Electron. Electron-based hosts export
  // ELECTRON_RUN_AS_NODE, which would start it as plain Node again.
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [script], { stdio: 'inherit', env });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
} else {
  // Not awaited: Electron holds `ready` until the entry module has finished evaluating.
  void renderAll();
}

async function renderAll() {
  // A failure exits with a message; Electron would otherwise show an error dialog.
  const fail = (error) => {
    console.error(error);
    process.exit(1);
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  const { app, BrowserWindow } = await import('electron');
  app.dock?.hide();
  await app.whenReady();

  const masters = {
    mac: readFileSync(join(build, 'icon.svg'), 'utf8'),
    full: fullBleed(readFileSync(join(build, 'icon.svg'), 'utf8')),
    16: readFileSync(join(build, 'icon-16.svg'), 'utf8'),
    24: readFileSync(join(build, 'icon-24.svg'), 'utf8'),
    32: readFileSync(join(build, 'icon-32.svg'), 'utf8'),
  };
  /** Windows and Linux: the pixel-fitted masters at their own sizes, the full-bleed body from 48 px up. */
  const square = (size) => (size in masters ? String(size) : 'full');

  const jobs = [];
  const want = (master, size) => {
    const key = `${master}@${size}`;
    if (!jobs.some((j) => j.key === key)) jobs.push({ key, svg: masters[master], size });
    return key;
  };
  const MAC = [16, 32, 64, 128, 256, 512, 1024];
  const WINDOWS = [16, 24, 32, 48, 64, 128, 256];
  const LINUX = [16, 24, 32, 48, 64, 128, 256, 512];
  for (const s of MAC) want('mac', s);
  for (const s of [...WINDOWS, ...LINUX]) want(square(s), s);

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html,<!doctype html><title>icons</title>');
  const rendered = await win.webContents.executeJavaScript(`(${rasterize})(${JSON.stringify(jobs)})`);
  win.destroy();
  const png = (master, size) => Buffer.from(rendered[`${master}@${size}`].png, 'base64');
  const rgba = (master, size) => Buffer.from(rendered[`${master}@${size}`].rgba, 'base64');

  writeFileSync(join(build, 'icon.png'), png('mac', 1024));

  // PNG entries, as iconutil writes them; macOS reads these since 10.7.
  writeFileSync(
    join(build, 'icon.icns'),
    icns([
      ['icp4', png('mac', 16)],
      ['ic11', png('mac', 32)],
      ['icp5', png('mac', 32)],
      ['ic12', png('mac', 64)],
      ['ic07', png('mac', 128)],
      ['ic13', png('mac', 256)],
      ['ic08', png('mac', 256)],
      ['ic14', png('mac', 512)],
      ['ic09', png('mac', 512)],
      ['ic10', png('mac', 1024)],
    ]),
  );

  // 32-bit bitmaps below 256 px and PNG at 256, the layout every Windows tool (and NSIS) reads.
  writeFileSync(
    join(build, 'icon.ico'),
    ico(WINDOWS.map((s) => (s === 256 ? { size: s, png: png(square(s), s) } : { size: s, rgba: rgba(square(s), s) }))),
  );

  mkdirSync(join(build, 'icons'), { recursive: true });
  for (const s of LINUX) writeFileSync(join(build, 'icons', `${s}x${s}.png`), png(square(s), s));

  console.log(`wrote icon.png, icon.icns, icon.ico and icons/ (${LINUX.join(', ')} px) in ${build}`);
  app.exit(0);
}

/**
 * Windows and Linux draw no shadow around app icons and expect the body to
 * fill the square, so this crops the macOS master to its body (94% of the
 * canvas, as in the small masters) and drops the shadow.
 */
function fullBleed(svg) {
  const cropped = svg.replace('viewBox="0 0 1024 1024"', 'viewBox="74 74 876 876"').replace(' filter="url(#plate-shadow)"', '');
  if (!cropped.includes('viewBox="74 74 876 876"') || cropped.includes('url(#plate-shadow)')) {
    throw new Error('icon.svg changed shape: update fullBleed() in build-icons.mjs');
  }
  return cropped;
}

/** Runs in the page: draws each SVG at its size and returns PNG and raw RGBA, base64. */
function rasterize(jobs) {
  const load = (svg) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('An icon master failed to load'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  const base64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  return (async () => {
    const out = {};
    for (const { key, svg, size } of jobs) {
      const img = await load(svg);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      out[key] = {
        png: canvas.toDataURL('image/png').split(',')[1],
        // Bitmaps are only needed for the .ico's sizes below 256.
        rgba: size < 256 ? base64(new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer)) : null,
      };
    }
    return out;
  })();
}

/** An .icns file: a header, then one PNG per type. */
function icns(entries) {
  const parts = entries.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

/** An .ico file: a directory, then each image as a PNG or a bottom-up BGRA bitmap with its 1-bit mask. */
function ico(images) {
  const datas = images.map(({ size, png, rgba }) => (png ? png : dib(size, rgba)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size }, i) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(datas[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += datas[i].length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...datas]);
}

function dib(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(size, 4);
  info.writeInt32LE(size * 2, 8); // the color bitmap and the mask, stacked
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  info.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const o = (row * size + x) * 4;
      pixels[o] = rgba[i + 2];
      pixels[o + 1] = rgba[i + 1];
      pixels[o + 2] = rgba[i];
      pixels[o + 3] = rgba[i + 3];
      if (rgba[i + 3] === 0) mask[row * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([info, pixels, mask]);
}
