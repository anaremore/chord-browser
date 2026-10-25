// Glue by polling: the player reads the host window's rectangle from the OS
// itself, every few milliseconds, instead of waiting for the host's move
// events, which macOS barely sends during a drag. Through koffi: CoreGraphics
// on macOS, user32 on Windows. Returns a function that reads the rectangle in
// screen coordinates (points on macOS, physical pixels on Windows), or null.
import { createRequire } from 'node:module';

export function hostRectReader(koffiPath, handle) {
  const koffi = createRequire(import.meta.url)(koffiPath);
  if (process.platform === 'darwin') {
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const CGRect = koffi.struct('CGRect', { x: 'double', y: 'double', w: 'double', h: 'double' });
    const copyInfo = cg.func('void *CGWindowListCopyWindowInfo(uint32 option, uint32 window)');
    const rectFrom = cg.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ CGRect *rect)');
    const count = cf.func('long CFArrayGetCount(void *array)');
    const at = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)');
    const get = cf.func('void *CFDictionaryGetValue(void *dict, void *key)');
    const release = cf.func('void CFRelease(void *object)');
    const string = cf.func('void *CFStringCreateWithCString(void *allocator, const char *text, uint32 encoding)');
    const BOUNDS = string(null, 'kCGWindowBounds', 0x08000100);
    const INCLUDING_WINDOW = 8;
    return () => {
      const list = copyInfo(INCLUDING_WINDOW, handle);
      if (!list) return null;
      try {
        if (count(list) < 1) return null;
        const bounds = get(at(list, 0), BOUNDS);
        const r = {};
        return bounds && rectFrom(bounds, r) ? { x: r.x, y: r.y, width: r.w, height: r.h } : null;
      } finally {
        release(list);
      }
    };
  }
  if (process.platform === 'win32') {
    const user32 = koffi.load('user32.dll');
    const RECT = koffi.struct('FOLLOW_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const getRect = user32.func('bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ FOLLOW_RECT *rect)');
    return () => {
      const r = {};
      return getRect(handle, r) ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null;
    };
  }
  return null;
}
