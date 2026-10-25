/**
 * The bar's page (DESIGN.md §7.13): the service's name, Widevine's state
 * while it's getting ready, and Back to Chord, in the chord's colors. Chord's
 * token variables and colors go in through the CSSOM (the page's CSP has no
 * inline styles). The main process checked every theme value before it got
 * here (player-protocol's parseTheme). Until Chord sends the chord's colors,
 * Chord's default theme in the system's appearance.
 */
import { createChordTheme, presetStops, tokenVars, type Platform } from '@chord/tokens';

interface BarState {
  service: string;
  status: 'starting' | 'cdm' | 'ready' | 'failed';
  theme: { appearance: 'light' | 'dark'; vars: Record<string, string> } | null;
  appearance: 'light' | 'dark';
  controls: { side: 'left' | 'right'; width: number };
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    player: { onState(listener: (state: BarState) => void): void; back(): void };
  }
}

const STATUS: Record<BarState['status'], string> = {
  starting: '',
  cdm: 'Getting Widevine ready…',
  ready: '',
  failed: 'Widevine couldn’t be installed. Check your connection, then open it again from Chord.',
};

const root = document.documentElement;
const service = document.getElementById('service')!;
const status = document.getElementById('status')!;

window.player.onState((state) => {
  service.textContent = state.service || 'Chord Player';
  document.title = state.service ? `${state.service} · Chord Player` : 'Chord Player';
  status.textContent = STATUS[state.status] ?? '';
  const platform = (['darwin', 'win32', 'linux'].includes(state.platform) ? state.platform : 'linux') as Platform;
  const fallback = createChordTheme({ stops: presetStops('dusk'), grain: 0, appearance: state.appearance }, { systemAppearance: state.appearance, material: 'solid' }).vars;
  const vars: Record<string, string> = { ...tokenVars(platform, state.appearance), ...fallback, ...(state.theme?.vars ?? {}) };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.style.colorScheme = state.appearance;
  // Room for the window's controls: the traffic lights on the left (macOS), the caption buttons on the right.
  root.style.setProperty('--controls-left', `${state.controls.side === 'left' ? state.controls.width : 12}px`);
  root.style.setProperty('--controls-right', `${state.controls.side === 'right' ? state.controls.width + 8 : 8}px`);
});

document.getElementById('back')!.addEventListener('click', () => window.player.back());

export {};
