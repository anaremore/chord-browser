// The Win32 calls the spike needs, through koffi (an FFI with prebuilt
// binaries: no compiler, no native module of Chord's own). Used by the host
// (stock Electron) for SetParent and window owners, and by the sampler (plain
// Node) to read window rectangles and send real mouse and keyboard input.
import { createRequire } from 'node:module';

export function win32(koffiPath) {
  const koffi = createRequire(import.meta.url)(koffiPath);
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');

  const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
    cbSize: 'uint32',
    flags: 'uint32',
    hwndActive: 'uintptr_t',
    hwndFocus: 'uintptr_t',
    hwndCapture: 'uintptr_t',
    hwndMenuOwner: 'uintptr_t',
    hwndMoveSize: 'uintptr_t',
    hwndCaret: 'uintptr_t',
    rcCaret: RECT,
  });
  const EnumProc = koffi.proto('bool __stdcall EnumProc(uintptr_t hwnd, intptr_t lParam)');

  const f = {
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ RECT *rect)'),
    GetClientRect: user32.func('bool __stdcall GetClientRect(uintptr_t hWnd, _Out_ RECT *rect)'),
    SetParent: user32.func('uintptr_t __stdcall SetParent(uintptr_t child, uintptr_t parent)'),
    GetParent: user32.func('uintptr_t __stdcall GetParent(uintptr_t hWnd)'),
    GetAncestor: user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hWnd, uint32 flags)'),
    GetWindow: user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 cmd)'),
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hWnd, int index)'),
    SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(uintptr_t hWnd, int index, intptr_t value)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(uintptr_t hWnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(uintptr_t hWnd)'),
    GetForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
    GetGUIThreadInfo: user32.func('bool __stdcall GetGUIThreadInfo(uint32 thread, _Inout_ GUITHREADINFO *info)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *pid)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, uint16_t *name, int max)'),
    GetDpiForWindow: user32.func('uint32 __stdcall GetDpiForWindow(uintptr_t hWnd)'),
    EnumWindows: user32.func('bool __stdcall EnumWindows(EnumProc *proc, intptr_t lParam)'),
    EnumChildWindows: user32.func('bool __stdcall EnumChildWindows(uintptr_t parent, EnumProc *proc, intptr_t lParam)'),
    SetCursorPos: user32.func('bool __stdcall SetCursorPos(int x, int y)'),
    mouse_event: user32.func('void __stdcall mouse_event(uint32 flags, int dx, int dy, int data, uintptr_t extra)'),
    keybd_event: user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
    SetProcessDpiAwarenessContext: user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)'),
    SystemParametersGet: user32.func('bool __stdcall SystemParametersInfoW(uint32 action, uint32 param, _Out_ int32 *value, uint32 ini)'),
    SystemParametersSet: user32.func('bool __stdcall SystemParametersInfoW(uint32 action, uint32 param, void *value, uint32 ini)'),
    DwmGetWindowAttribute: dwmapi.func('int __stdcall DwmGetWindowAttribute(uintptr_t hWnd, uint32 attr, _Out_ uint32 *value, uint32 size)'),
  };

  const GWL_STYLE = -16;
  const GWL_EXSTYLE = -20;
  const GWLP_HWNDPARENT = -8;
  const WS = { CHILD: 0x40000000, POPUP: 0x80000000, CAPTION: 0x00c00000, THICKFRAME: 0x00040000, SYSMENU: 0x00080000, CLIPSIBLINGS: 0x04000000, VISIBLE: 0x10000000, MINIMIZEBOX: 0x20000, MAXIMIZEBOX: 0x10000 };
  const WS_EX = { TOOLWINDOW: 0x80, APPWINDOW: 0x40000, NOACTIVATE: 0x08000000, TOPMOST: 0x8 };
  const SWP = { NOSIZE: 0x1, NOMOVE: 0x2, NOZORDER: 0x4, NOACTIVATE: 0x10, FRAMECHANGED: 0x20, SHOWWINDOW: 0x40, NOOWNERZORDER: 0x200, ASYNCWINDOWPOS: 0x4000 };

  const rect = (h) => {
    const r = {};
    return f.GetWindowRect(h, r) ? r : null;
  };
  const className = (h) => {
    const buf = new Uint16Array(256);
    const n = f.GetClassNameW(h, buf, 256);
    return String.fromCharCode(...buf.subarray(0, n));
  };
  const pidOf = (h) => {
    const pid = [0];
    f.GetWindowThreadProcessId(h, pid);
    return pid[0];
  };
  const big = (v) => BigInt.asUintN(64, BigInt(v));

  return {
    koffi,
    f,
    rect,
    className,
    pidOf,
    clientRect(h) {
      const r = {};
      return f.GetClientRect(h, r) ? r : null;
    },
    /** The HWND in an Electron getNativeWindowHandle() buffer. */
    hwndOf(buffer) {
      return Number(buffer.readBigUInt64LE(0));
    },
    style: (h) => big(f.GetWindowLongPtrW(h, GWL_STYLE)),
    exStyle: (h) => big(f.GetWindowLongPtrW(h, GWL_EXSTYLE)),
    owner: (h) => f.GetWindow(h, 4 /* GW_OWNER */),
    dpi: (h) => f.GetDpiForWindow(h),
    cloaked(h) {
      const v = [0];
      return f.DwmGetWindowAttribute(h, 14 /* DWMWA_CLOAKED */, v, 4) === 0 ? v[0] : null;
    },
    /** Top-level windows, topmost first. */
    topLevel() {
      const list = [];
      f.EnumWindows((h) => {
        list.push(h);
        return true;
      }, 0);
      return list;
    },
    children(parent) {
      const list = [];
      f.EnumChildWindows(parent, (h) => {
        list.push({ hwnd: h, class: className(h), pid: pidOf(h), parent: f.GetParent(h), visible: f.IsWindowVisible(h), rect: rect(h) });
        return true;
      }, 0);
      return list;
    },
    /** Which window has keyboard focus, system-wide (the foreground thread's). */
    focus() {
      const zero = { left: 0, top: 0, right: 0, bottom: 0 };
      const info = { cbSize: koffi.sizeof(GUITHREADINFO), flags: 0, hwndActive: 0, hwndFocus: 0, hwndCapture: 0, hwndMenuOwner: 0, hwndMoveSize: 0, hwndCaret: 0, rcCaret: zero };
      try {
        if (!f.GetGUIThreadInfo(0, info)) return null;
      } catch (error) {
        return { error: error.message };
      }
      return { active: info.hwndActive, focus: info.hwndFocus, focusClass: info.hwndFocus ? className(info.hwndFocus) : null, focusPid: info.hwndFocus ? pidOf(info.hwndFocus) : null };
    },
    /**
     * Would Alt+Tab list it? Its rules: visible, not cloaked, and either unowned without
     * WS_EX_TOOLWINDOW, or carrying WS_EX_APPWINDOW. The taskbar uses the same test.
     */
    inAltTab(h) {
      const ex = big(f.GetWindowLongPtrW(h, GWL_EXSTYLE));
      const visible = f.IsWindowVisible(h);
      const owned = f.GetWindow(h, 4) !== 0;
      const tool = (ex & BigInt(WS_EX.TOOLWINDOW)) !== 0n;
      const app = (ex & BigInt(WS_EX.APPWINDOW)) !== 0n;
      return { visible, owned, toolWindow: tool, appWindow: app, cloaked: this.cloaked(h), listed: visible && (app || (!owned && !tool)) };
    },
    /** Makes `child` a real child window of `parent` (approach c), at x, y in the parent's client pixels. */
    adopt(child, parent, x, y, w, h) {
      const before = big(f.GetWindowLongPtrW(child, GWL_STYLE));
      const style = (before & ~BigInt(WS.POPUP | WS.CAPTION | WS.THICKFRAME | WS.SYSMENU | WS.MINIMIZEBOX | WS.MAXIMIZEBOX)) | BigInt(WS.CHILD | WS.CLIPSIBLINGS);
      f.SetWindowLongPtrW(child, GWL_STYLE, BigInt.asIntN(64, style));
      const previous = f.SetParent(child, parent);
      const ok = f.SetWindowPos(child, 0 /* HWND_TOP */, x, y, w, h, SWP.FRAMECHANGED | SWP.SHOWWINDOW | SWP.NOACTIVATE);
      return { previousParent: previous, styleBefore: `0x${before.toString(16)}`, styleAfter: `0x${style.toString(16)}`, ok };
    },
    /** Undoes adopt: back to a top-level popup window. */
    release(child, style) {
      f.SetParent(child, 0);
      f.SetWindowLongPtrW(child, GWL_STYLE, BigInt.asIntN(64, BigInt(style)));
      f.SetWindowPos(child, 0, 0, 0, 0, 0, SWP.NOMOVE | SWP.NOSIZE | SWP.NOZORDER | SWP.FRAMECHANGED | SWP.NOACTIVATE);
    },
    move(h, x, y, w, hgt, flags = 0) {
      return f.SetWindowPos(h, 0, x, y, w, hgt, SWP.NOZORDER | SWP.NOACTIVATE | flags);
    },
    /** Sets the window's owner (cross-process allowed): it then stays above the owner, minimizes with it, and leaves the taskbar. */
    setOwner(h, owner) {
      return f.SetWindowLongPtrW(h, GWLP_HWNDPARENT, owner);
    },
    SWP,
    WS,
    WS_EX,
  };
}

/** Real input, as a person's: absolute mouse moves and button presses, and keys (virtual-key codes). */
export function input(w) {
  const { f } = w;
  const MOVE = 0x1, LEFTDOWN = 0x2, LEFTUP = 0x4, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
  const vx = () => [f.GetSystemMetrics(76), f.GetSystemMetrics(77), f.GetSystemMetrics(78), f.GetSystemMetrics(79)];
  const to = (x, y) => {
    const [left, top, width, height] = vx();
    return [Math.round(((x - left) * 65535) / (width - 1)), Math.round(((y - top) * 65535) / (height - 1))];
  };
  return {
    moveTo(x, y) {
      const [ax, ay] = to(x, y);
      f.mouse_event(MOVE | ABSOLUTE | VIRTUALDESK, ax, ay, 0, 0);
    },
    down() {
      f.mouse_event(LEFTDOWN, 0, 0, 0, 0);
    },
    up() {
      f.mouse_event(LEFTUP, 0, 0, 0, 0);
    },
    key(vk, up = false) {
      f.keybd_event(vk, 0, up ? 0x2 : 0, 0);
    },
    /** e.g. chord(['CONTROL', 'T']) */
    chord(keys) {
      const VK = { CONTROL: 0x11, SHIFT: 0x10, MENU: 0x12 };
      const codes = keys.map((k) => VK[k] ?? k.toUpperCase().charCodeAt(0));
      for (const c of codes) f.keybd_event(c, 0, 0, 0);
      for (const c of codes.reverse()) f.keybd_event(c, 0, 0x2, 0);
    },
  };
}
