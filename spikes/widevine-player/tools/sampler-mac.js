// macOS half of tools/sampler.mjs, in JavaScript for Automation: window
// bounds from the window server (CGWindowListCopyWindowInfo, which needs no
// permission for bounds and order), and input through CGEventPost, which the
// system drops unless the calling process has Accessibility access.
//   osascript -l JavaScript tools/sampler-mac.js '<plan json>'
ObjC.import('CoreGraphics');
ObjC.import('Foundation');

function run(argv) {
  const plan = JSON.parse(argv[0]);
  const uptime = () => $.NSProcessInfo.processInfo.systemUptime * 1000;
  const INCLUDING_WINDOW = 8;
  const ON_SCREEN_ONLY = 1;
  const bounds = (id) => {
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(INCLUDING_WINDOW, id));
    if (!list || list.count === 0) return null;
    const b = list.objectAtIndex(0).objectForKey('kCGWindowBounds');
    if (!b || b.isNil()) return null;
    const x = b.objectForKey('X').doubleValue, y = b.objectForKey('Y').doubleValue;
    return [x, y, x + b.objectForKey('Width').doubleValue, y + b.objectForKey('Height').doubleValue];
  };
  let cursor = [0, 0];
  const post = (type, x, y) => {
    const ev = $.CGEventCreateMouseEvent($(), type, { x, y }, 0);
    $.CGEventPost(0, ev);
  };
  const KEYCODES = { T: 17, W: 13, S: 1, A: 0, B: 11, C: 8, '1': 18 };
  const act = (a) => {
    const base = bounds(a.of === 'player' ? plan.player : plan.host);
    switch (a.do) {
      case 'press':
        cursor = a.abs || [base[0] + a.rel[0], base[1] + a.rel[1]];
        post(5, cursor[0], cursor[1]); // mouse moved
        post(1, cursor[0], cursor[1]); // left down
        break;
      case 'moveBy':
        cursor = [cursor[0] + a.d[0], cursor[1] + a.d[1]];
        post(6, cursor[0], cursor[1]); // left dragged
        break;
      case 'release':
        post(2, cursor[0], cursor[1]);
        break;
      case 'click':
        cursor = a.abs || [base[0] + a.rel[0], base[1] + a.rel[1]];
        post(1, cursor[0], cursor[1]);
        post(2, cursor[0], cursor[1]);
        break;
      case 'keys': {
        const flags = a.keys.includes('META') ? 0x100000 : a.keys.includes('CONTROL') ? 0x40000 : 0;
        const key = a.keys[a.keys.length - 1];
        for (const down of [true, false]) {
          const ev = $.CGEventCreateKeyboardEvent($(), KEYCODES[key], down);
          $.CGEventSetFlags(ev, flags);
          $.CGEventPost(0, ev);
        }
        break;
      }
      case 'mark':
        break;
      default:
        throw new Error('unknown action ' + a.do);
    }
  };
  const actions = (plan.actions || []).slice().sort((a, b) => a.at - b.at);
  const samples = [];
  const events = [];
  const start = uptime();
  let last = '';
  let reads = 0;
  while (uptime() - start < plan.durationMs) {
    const t = uptime();
    while (actions.length && t - start >= actions[0].at) {
      const a = actions.shift();
      try {
        act(a);
        events.push([uptime(), a.do, a.label || null]);
      } catch (e) {
        events.push([uptime(), a.do, 'error: ' + e]);
      }
    }
    const h = bounds(plan.host) || [0, 0, 0, 0];
    const p = bounds(plan.player) || [0, 0, 0, 0];
    reads++;
    const row = h.concat(p);
    const key = row.join(',');
    if (key !== last) {
      samples.push([Math.round(t * 1000) / 1000].concat(row));
      last = key;
    }
  }
  const result = { samples, events, readsPerSecond: Math.round((reads * 1000) / plan.durationMs), clock: 'systemUptime' };
  if (plan.zorder) {
    const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(ON_SCREEN_ONLY, 0)));
    const ids = all.filter((w) => w.kCGWindowLayer === 0).map((w) => w.kCGWindowNumber);
    result.zorder = { host: ids.indexOf(plan.host), player: ids.indexOf(plan.player), note: 'index from the front, layer 0' };
  }
  return JSON.stringify(result);
}
