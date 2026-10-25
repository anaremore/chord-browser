// Watches two windows (the host's and the player's) from outside both
// processes, as the OS sees them, and optionally drives real input while it
// watches. Samples are recorded only when a rectangle changes.
//
//   node tools/sampler.mjs <plan.json>
//
// plan: { koffi, host, player, durationMs, out, actions: [{ at, do, ... }], zorder }
//   host / player: HWND (Windows), XID (Linux X11) or CGWindowID (macOS)
//   actions (Windows; macOS through CGEvent, which needs Accessibility):
//     press {rel:[x,y]} (relative to the host window), moveBy {d:[dx,dy]}, release,
//     click {rel:[x,y], of:'host'|'player'}, keys {keys:['CONTROL','T']}, mark {label}
// Writes { samples: [[t, hostL, hostT, hostR, hostB, playerL, playerT, playerR, playerB]], events, zorder }.
// t is milliseconds on the monotonic clock the host and player stamp with too.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const here = dirname(fileURLToPath(import.meta.url));
const winModule = process.platform === 'win32' ? await import('../shared/win32.mjs') : null;

function loop(read, act) {
  const samples = [];
  const events = [];
  const actions = [...(plan.actions ?? [])].sort((a, b) => a.at - b.at);
  const start = now();
  let last = '';
  while (now() - start < plan.durationMs) {
    const t = now();
    while (actions.length && t - start >= actions[0].at) {
      const a = actions.shift();
      try {
        act(a);
        events.push([now(), a.do, a.label ?? null]);
      } catch (error) {
        events.push([now(), a.do, `error: ${error.message}`]);
      }
    }
    const h = read(plan.host);
    const p = read(plan.player);
    const row = [...(h ?? [0, 0, 0, 0]), ...(p ?? [0, 0, 0, 0])];
    const key = row.join(',');
    if (key !== last) {
      samples.push([+t.toFixed(3), ...row]);
      last = key;
    }
  }
  return { samples, events };
}

function windows() {
  const { win32, input } = winModule;
  const w = win32(plan.koffi);
  w.f.SetProcessDpiAwarenessContext(-4); // per-monitor v2: physical pixels for every window
  const kb = input(w);
  let cursor = [0, 0];
  const rectOf = (h) => {
    const r = w.rect(h);
    return r ? [r.left, r.top, r.right, r.bottom] : null;
  };
  const act = (a) => {
    const base = rectOf(a.of === 'player' ? plan.player : plan.host);
    switch (a.do) {
      case 'press':
        cursor = a.abs ?? [base[0] + a.rel[0], base[1] + a.rel[1]];
        kb.moveTo(...cursor);
        kb.down();
        break;
      case 'moveBy':
        cursor = [cursor[0] + a.d[0], cursor[1] + a.d[1]];
        kb.moveTo(...cursor);
        break;
      case 'release':
        kb.up();
        break;
      case 'click':
        cursor = a.abs ?? [base[0] + a.rel[0], base[1] + a.rel[1]];
        kb.moveTo(...cursor);
        kb.down();
        kb.up();
        break;
      case 'keys':
        kb.chord(a.keys);
        break;
      case 'mark':
        break;
      default:
        throw new Error(`unknown action ${a.do}`);
    }
  };
  const result = loop(rectOf, act);
  if (plan.zorder) {
    const order = w.topLevel();
    result.zorder = { host: order.indexOf(plan.host), player: order.indexOf(plan.player) };
  }
  result.focus = w.focus();
  return result;
}

function linux() {
  const koffi = createRequire(import.meta.url)(plan.koffi);
  const x11 = koffi.load('libX11.so.6');
  const XOpenDisplay = x11.func('void *XOpenDisplay(const char *name)');
  const XDefaultRootWindow = x11.func('unsigned long XDefaultRootWindow(void *dpy)');
  const XTranslateCoordinates = x11.func('int XTranslateCoordinates(void *dpy, unsigned long src, unsigned long dst, int x, int y, _Out_ int *dx, _Out_ int *dy, _Out_ unsigned long *child)');
  const XGetGeometry = x11.func('int XGetGeometry(void *dpy, unsigned long d, _Out_ unsigned long *root, _Out_ int *x, _Out_ int *y, _Out_ unsigned int *w, _Out_ unsigned int *h, _Out_ unsigned int *bw, _Out_ unsigned int *depth)');
  const XQueryTree = x11.func('int XQueryTree(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *parent, _Out_ void **children, _Out_ unsigned int *n)');
  const dpy = XOpenDisplay(null);
  if (!dpy) throw new Error('no X display');
  const root = XDefaultRootWindow(dpy);
  const read = (win) => {
    const x = [0], y = [0], child = [0], r = [0], gx = [0], gy = [0], w = [0], h = [0], bw = [0], depth = [0];
    if (!XTranslateCoordinates(dpy, win, root, 0, 0, x, y, child)) return null;
    if (!XGetGeometry(dpy, win, r, gx, gy, w, h, bw, depth)) return null;
    return [x[0], y[0], x[0] + w[0], y[0] + h[0]];
  };
  const result = loop(read, (a) => {
    if (a.do !== 'mark') throw new Error('no input injection on Linux (no XTest library in the image)');
  });
  if (plan.zorder) {
    // The top-level frame each window sits in, in the root's stacking order (bottom first).
    const rootId = Number(root);
    const topOf = (win) => {
      let current = Number(win);
      for (let depth = 0; depth < 16; depth++) {
        const r = [0], parent = [0], children = [null], n = [0];
        XQueryTree(dpy, current, r, parent, children, n);
        const up = Number(parent[0]);
        if (!up || up === rootId) return current;
        current = up;
      }
      return current;
    };
    const r = [0], parent = [0], children = [null], n = [0];
    XQueryTree(dpy, root, r, parent, children, n);
    const list = Array.from(koffi.decode(children[0], koffi.array('unsigned long', n[0])), Number);
    const at = (win) => {
      const i = list.indexOf(topOf(win));
      return i < 0 ? null : n[0] - 1 - i;
    };
    result.zorder = { host: at(plan.host), player: at(plan.player), hostTop: topOf(plan.host), playerTop: topOf(plan.player), note: 'index from the top' };
  }
  return result;
}

function mac() {
  const r = spawnSync('osascript', ['-l', 'JavaScript', join(here, 'sampler-mac.js'), JSON.stringify(plan)], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`osascript: ${r.stderr}`);
  return JSON.parse(r.stdout || r.stderr);
}

const result = process.platform === 'win32' ? windows() : process.platform === 'linux' ? linux() : mac();
result.platform = process.platform;
writeFileSync(plan.out, JSON.stringify(result));
console.log(`[sampler] ${result.samples?.length ?? 0} samples, ${result.events?.length ?? 0} events -> ${plan.out}`);
