/**
 * Whether the computer is low on memory (ARCHITECTURE.md §9, sleeping tabs).
 * Electron has no memory-pressure event, so main asks every 30 seconds how
 * much the OS could hand out without swapping. No Electron imports, so it's
 * unit-testable.
 */

/** `process.getSystemMemoryInfo()`, in kilobytes; each OS fills in different fields. */
export interface MemoryInfo {
  total: number;
  free: number;
  /** Linux: MemAvailable, the kernel's own estimate (free there leaves out the page cache). */
  available?: number;
  /** macOS: file-backed and purgeable memory, which the system takes back under pressure. */
  fileBacked?: number;
  purgeable?: number;
}

/** What the OS could hand out without swapping, in kilobytes. */
export function availableKb(info: MemoryInfo, os: NodeJS.Platform): number {
  if (os === 'linux' && info.available !== undefined) return info.available;
  // macOS's free leaves out caches it would drop at once; Windows' is already available physical memory.
  if (os === 'darwin') return info.free + (info.fileBacked ?? 0) + (info.purgeable ?? 0);
  return info.free;
}

/** Low: under a tenth of the memory, or under 2 GB on bigger machines. */
const LOW_SHARE = 0.1;
const LOW_CAP_KB = 2 * 1024 * 1024;

export function memoryLow(info: MemoryInfo, os: NodeJS.Platform): boolean {
  if (info.total <= 0) return false;
  return availableKb(info, os) < Math.min(info.total * LOW_SHARE, LOW_CAP_KB);
}
