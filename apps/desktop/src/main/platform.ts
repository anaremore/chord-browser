/**
 * Everything OS-specific about the window lives here (ARCHITECTURE.md §13).
 * Renderers learn about the platform only through `SystemInfo`.
 */
import { release } from 'node:os';
import type { SystemInfo } from '@chord/ipc';
import { hexToRgb, oklchToRgb, rgbToHex, size, windowBackground } from '@chord/tokens';
import { nativeTheme, systemPreferences, type BaseWindowConstructorOptions } from 'electron';

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

const appearance = (): 'light' | 'dark' => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

export const backgroundHex = (): string => rgbToHex(oklchToRgb(windowBackground[appearance()]));

function captionSymbolColor(): string {
  return appearance() === 'dark' ? rgbToHex(oklchToRgb({ l: 0.96, c: 0, h: 0 })) : rgbToHex(oklchToRgb({ l: 0.24, c: 0, h: 0 }));
}

/** A transparent overlay lets the window material show behind the caption buttons. */
export const titleBarOverlay = () => ({ color: '#00000000', symbolColor: captionSymbolColor(), height: size.strip });

export function usesTranslucentMaterial(): boolean {
  if (nativeTheme.prefersReducedTransparency) return false;
  return platform === 'darwin' || windowsSupportsMica();
}

export function windowChromeOptions(): BaseWindowConstructorOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: (size.header - 12) / 2 },
      ...(usesTranslucentMaterial()
        ? { vibrancy: 'sidebar', visualEffectState: 'followWindow' }
        : { backgroundColor: backgroundHex() }),
    };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    ...(usesTranslucentMaterial() ? { backgroundMaterial: 'mica' } : { backgroundColor: backgroundHex() }),
  };
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
