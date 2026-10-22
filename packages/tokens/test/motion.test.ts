import { describe, expect, it } from 'vitest';
import { simulateSpring, springToCss, springs, tokenCss } from '../src';

/** The table in DESIGN.md §6.2. If a spring changes, update the doc with it. */
const documented = {
  press: { overshoot: 0, t90: 95, settle: 172 },
  snappy: { overshoot: 0, t90: 137, settle: 243 },
  overlay: { overshoot: 0.005, t90: 132, settle: 196 },
  smooth: { overshoot: 0.002, t90: 160, settle: 256 },
  bouncy: { overshoot: 0.057, t90: 114, settle: 305 },
  release: { overshoot: 0.002, t90: 179, settle: 287 },
  gentle: { overshoot: 0, t90: 230, settle: 417 },
  playful: { overshoot: 0.185, t90: 140, settle: 769 },
} as const;

describe('springs', () => {
  it.each(Object.keys(documented) as (keyof typeof documented)[])('%s matches DESIGN.md §6.2', (name) => {
    const profile = simulateSpring(springs[name]);
    const doc = documented[name];
    expect(profile.overshoot).toBeCloseTo(doc.overshoot, 2);
    expect(Math.abs(profile.t90 - doc.t90)).toBeLessThanOrEqual(2);
    expect(Math.abs(profile.settle - doc.settle)).toBeLessThanOrEqual(2);
  });

  it('keeps every functional spring under 400 ms to arrive (DESIGN.md §6.1 rule 8)', () => {
    for (const [name, s] of Object.entries(springs)) {
      if (name === 'playful') continue;
      expect(simulateSpring(s).t90).toBeLessThan(400);
    }
  });

  it('renders springs as CSS linear() easings that end at rest', () => {
    const css = springToCss(springs.bouncy);
    expect(css.easing).toMatch(/^linear\(0, /);
    expect(css.easing).toMatch(/, 1\)$/);
    // bouncy overshoots, so some sample must exceed 1
    expect(css.easing.split(', ').some((v) => Number.parseFloat(v.replace('linear(', '')) > 1)).toBe(true);
  });
});

describe('tokenCss', () => {
  it('emits platform and appearance blocks', () => {
    const css = tokenCss();
    expect(css).toContain("--space-2: 8px;");
    expect(css).toContain("--size-sidebar-width: 248px;");
    expect(css).toContain(":root[data-platform='win32']");
    expect(css).toContain(":root[data-appearance='dark']");
    expect(css).toContain('--spring-snappy: linear(');
  });
});
