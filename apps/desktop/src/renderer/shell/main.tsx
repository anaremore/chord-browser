import type { SystemInfo } from '@chord/ipc';
import { tokenVars } from '@chord/tokens';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import './global.css';
import { App } from './App';

/**
 * Tokens are applied through the CSSOM rather than an injected <style>, which
 * Chord's Content-Security-Policy forbids. Platform and appearance also set
 * data attributes so CSS can adapt without JavaScript checks.
 */
function applySystem(info: SystemInfo): void {
  const root = document.documentElement;
  root.dataset['platform'] = info.platform;
  root.dataset['appearance'] = info.appearance;
  root.dataset['material'] = info.material;
  for (const [name, value] of Object.entries(tokenVars(info.platform, info.appearance))) {
    root.style.setProperty(name, value);
  }
  const chrome = info.windowChrome;
  root.style.setProperty('--chrome-reserved-left', chrome.kind === 'traffic-lights' || chrome.side === 'left' ? `${chrome.reservedWidth}px` : '0px');
  root.style.setProperty('--chrome-reserved-right', chrome.kind === 'overlay' && chrome.side === 'right' ? `${chrome.reservedWidth}px` : '0px');
  if (info.accentColor) root.style.setProperty('--color-focus-ring', info.accentColor);
  else root.style.removeProperty('--color-focus-ring');
}

const info = await window.chord.system.info();
applySystem(info);
window.chord.system.onChange(applySystem);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialInfo={info} />
  </StrictMode>,
);
