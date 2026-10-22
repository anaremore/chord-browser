/**
 * Renders the static tokens as CSS custom properties. Components use only
 * these variables (enforced by stylelint), never raw values.
 */
import { durations, easing, springs, springToCss } from './motion';
import { fontFamily, frameRadius, radius, shadow, size, space, type, zIndex, type Platform } from './scale';

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const px = (n: number) => `${n}px`;

function rootVars(): Record<string, string> {
  const root: Record<string, string> = { '--font-family': fontFamily };
  for (const [k, v] of Object.entries(space)) root[`--space-${k}`] = px(v);
  for (const [k, v] of Object.entries(size)) root[`--size-${kebab(k)}`] = px(v);
  for (const [k, v] of Object.entries(radius)) root[`--radius-${k}`] = px(v);
  for (const [k, v] of Object.entries(type)) {
    root[`--text-${k}`] = `${v.weight} ${v.size}px/${v.line}px var(--font-family)`;
    root[`--text-${k}-tracking`] = `${v.tracking}em`;
  }
  for (const [k, v] of Object.entries(durations)) root[`--duration-${kebab(k)}`] = `${v}ms`;
  for (const [k, v] of Object.entries(easing)) root[`--ease-${k}`] = v;
  for (const [k, v] of Object.entries(springs)) {
    const css = springToCss(v);
    root[`--spring-${k}`] = css.easing;
    root[`--spring-${k}-duration`] = `${css.durationMs}ms`;
  }
  for (const [k, v] of Object.entries(zIndex)) root[`--z-${k}`] = String(v);
  return root;
}

const shadowVars = (appearance: 'light' | 'dark') =>
  Object.fromEntries(Object.entries(shadow[appearance]).map(([k, v]) => [`--shadow-${k}`, v]));

/**
 * The token variables that apply on one platform in one appearance. The
 * renderer sets these through the CSSOM, which works under Chord's strict
 * Content-Security-Policy (no inline `<style>`).
 */
export function tokenVars(platform: Platform, appearance: 'light' | 'dark'): Record<string, string> {
  return { ...rootVars(), '--radius-frame': px(frameRadius[platform]), ...shadowVars(appearance) };
}

function block(selector: string, vars: Record<string, string>): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `${selector} {\n${body}\n}\n`;
}

/** All tokens as one stylesheet, for documentation and tooling. */
export function tokenCss(): string {
  let out = block(':root', rootVars());
  for (const platform of Object.keys(frameRadius) as Platform[]) {
    out += block(`:root[data-platform='${platform}']`, { '--radius-frame': px(frameRadius[platform]) });
  }
  for (const appearance of ['light', 'dark'] as const) {
    out += block(`:root[data-appearance='${appearance}']`, shadowVars(appearance));
  }
  return out;
}
