/**
 * Everything OS-specific about the window lives here (ARCHITECTURE.md §13).
 * Renderers learn about the platform only through `SystemInfo`.
 */
import { release } from 'node:os';
import type { SystemInfo } from '@chord/ipc';
import { hexToRgb, oklchToRgb, rgbToHex, size, windowBackground } from '@chord/tokens';
import { nativeTheme, systemPreferences, type BaseWindow, type BaseWindowConstructorOptions } from 'electron';
import { windowIcon } from './app-icon';

export type OsPlatform = 'darwin' | 'win32' | 'linux';
export const platform = process.platform as OsPlatform;

/** Windows 11 caption buttons are 46 px wide each. */
const WIN_CAPTION_WIDTH = 3 * 46;
/** ⚠ Linux caption width depends on the desktop theme; measured per DE in M1.6. */
const LINUX_CAPTION_WIDTH = 120;
/** Space the macOS traffic lights occupy, plus margin, in the sidebar header. */
const TRAFFIC_LIGHTS_WIDTH = 76;

/** Mica needs Windows 11 22H2 (build 22621) or later. */
function windowsSupportsMica(): boolean {
  const build = Number.parseInt(release().split('.')[2] ?? '0', 10);
  return platform === 'win32' && build >= 22621;
}

/** `forced`: a window that's always one appearance (a private window is always dark). */
export type ForcedAppearance = 'light' | 'dark' | null;

const appearance = (forced: ForcedAppearance = null): 'light' | 'dark' => forced ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

export const backgroundHex = (forced: ForcedAppearance = null): string => rgbToHex(oklchToRgb(windowBackground[appearance(forced)]));

function captionSymbolColor(forced: ForcedAppearance): string {
  return appearance(forced) === 'dark' ? rgbToHex(oklchToRgb({ l: 0.96, c: 0, h: 0 })) : rgbToHex(oklchToRgb({ l: 0.24, c: 0, h: 0 }));
}

/** A transparent overlay lets the window material show behind the caption buttons. */
export const titleBarOverlay = (forced: ForcedAppearance = null) => ({ color: '#00000000', symbolColor: captionSymbolColor(forced), height: size.strip });

export function usesTranslucentMaterial(): boolean {
  if (nativeTheme.prefersReducedTransparency) return false;
  return platform === 'darwin' || windowsSupportsMica();
}

/**
 * Reduce transparency (DESIGN.md §10), turned on or off while Chord runs:
 * the window drops its OS material for a solid background, or takes it back.
 * (The renderers re-theme from `systemInfo().material` at the same time.)
 */
export function applyMaterial(window: BaseWindow, forced: ForcedAppearance = null): void {
  if (window.isDestroyed()) return;
  const translucent = usesTranslucentMaterial();
  if (platform === 'darwin') {
    window.setVibrancy(translucent ? 'sidebar' : null);
  } else if (windowsSupportsMica()) {
    window.setBackgroundMaterial(translucent ? 'mica' : 'none');
  }
  if (!translucent) window.setBackgroundColor(backgroundHex(forced));
}

export function windowChromeOptions(forced: ForcedAppearance = null): BaseWindowConstructorOptions {
  if (platform === 'darwin') {
    return {
      ...windowIcon(),
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: (size.header - 12) / 2 },
      ...(usesTranslucentMaterial()
        ? { vibrancy: 'sidebar', visualEffectState: 'followWindow' }
        : { backgroundColor: backgroundHex(forced) }),
    };
  }
  return {
    ...windowIcon(),
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(forced),
    ...(usesTranslucentMaterial() ? { backgroundMaterial: 'mica' } : { backgroundColor: backgroundHex(forced) }),
  };
}

/** A mini window (DESIGN.md §7.9): the same material, with the caption controls in its 36 px bar. */
export function miniWindowChromeOptions(): BaseWindowConstructorOptions {
  const options = windowChromeOptions();
  if (platform === 'darwin') return { ...options, trafficLightPosition: { x: 12, y: (size.miniBar - 12) / 2 } };
  return { ...options, titleBarOverlay: { ...titleBarOverlay(), height: size.miniBar } };
}

function accentColor(): string | null {
  try {
    const raw = systemPreferences.getAccentColor();
    return raw ? (hexToRgb(`#${raw}`) ? `#${raw.slice(0, 6)}` : null) : null;
  } catch {
    return null;
  }
}

export function systemInfo(): SystemInfo {
  return {
    platform,
    appearance: appearance(),
    accentColor: accentColor(),
    prefersReducedMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
    forcedColors: nativeTheme.inForcedColorsMode,
    material: usesTranslucentMaterial() ? 'translucent' : 'solid',
    windowChrome:
      platform === 'darwin'
        ? { kind: 'traffic-lights', reservedWidth: TRAFFIC_LIGHTS_WIDTH }
        : {
            kind: 'overlay',
            height: size.strip,
            reservedWidth: platform === 'win32' ? WIN_CAPTION_WIDTH : LINUX_CAPTION_WIDTH,
            side: 'right',
          },
  };
}
