import type { SystemInfo } from '@chord/ipc';
import { tokenVars } from '@chord/tokens';

/**
 * Tokens are applied through the CSSOM rather than an injected <style>, which
 * Chord's Content-Security-Policy forbids. Platform and appearance also set
 * data attributes so CSS can adapt without JavaScript checks.
 */
export function applySystem(info: SystemInfo): void {
  const root = document.documentElement;
  root.dataset['platform'] = info.platform;
  root.dataset['appearance'] = info.appearance;
  root.dataset['material'] = info.material;
  for (const [name, value] of Object.entries(tokenVars(info.platform, info.appearance))) {
    root.style.setProperty(name, value);
  }
  const chrome = info.windowChrome;
  const left = chrome.kind === 'traffic-lights' || chrome.side === 'left' ? chrome.reservedWidth : 0;
  const right = chrome.kind === 'overlay' && chrome.side === 'right' ? chrome.reservedWidth : 0;
  root.style.setProperty('--chrome-reserved-left', `${left}px`);
  root.style.setProperty('--chrome-reserved-right', `${right}px`);
  if (info.accentColor) root.style.setProperty('--color-focus-ring', info.accentColor);
  else root.style.removeProperty('--color-focus-ring');
}
