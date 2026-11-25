import { describe, expect, it } from 'vitest';
import { counted, stepKind } from '../../apps/desktop/test/e2e/step-times-reporter';
import { add, differences, platformOf } from '../ci/e2e-step-times.mjs';

type Step = Parameters<typeof counted>[0];
const step = (category: string, parent?: Step): Step => ({ category, parent } as Step);

describe('the step-times reporter', () => {
  it('names a kind of step without what varies per call, and keeps an expect()’s matcher', () => {
    expect(stepKind({ category: 'pw:api', title: 'Click locator(\'button\').nth(3)' })).toBe('pw:api: Click locator');
    expect(stepKind({ category: 'pw:api', title: 'Type "hello 42"' })).toBe('pw:api: Type …');
    expect(stepKind({ category: 'pw:api', title: 'Wait for timeout' })).toBe('pw:api: Wait for timeout');
    expect(stepKind({ category: 'expect', title: 'Expect "toBeVisible"' })).toBe('expect: Expect "toBeVisible"');
  });

  it('counts each call, expect, hook or fixture once: not one inside another', () => {
    expect(counted(step('pw:api'))).toBe(true);
    expect(counted(step('expect', step('test.step')))).toBe(true);
    expect(counted(step('pw:api', step('expect')))).toBe(false);
    expect(counted(step('pw:api', step('test.step', step('hook'))))).toBe(false);
    expect(counted(step('test.step'))).toBe(false);
  });
});

describe('e2e-step-times', () => {
  it('names an artifact’s platform without its shard', () => {
    expect(platformOf('e2e-report-macos-26-1of2')).toBe('macos-26');
    expect(platformOf('e2e-report-ubuntu-24.04-x11-3of4')).toBe('ubuntu-24.04-x11');
    expect(platformOf('e2e-report-ubuntu-24.04-x11-perfof1')).toBe('ubuntu-24.04-x11');
  });

  it('adds shards up, and ranks the kinds of step by how much longer they took', () => {
    const linux = add(add({ tests: 0, seconds: 0, steps: {} }, { tests: 2, seconds: 10, steps: { launch: { seconds: 2, count: 2 } } }), {
      tests: 1,
      seconds: 5,
      steps: { launch: { seconds: 1, count: 1 }, click: { seconds: 1, count: 4 } },
    });
    expect(linux).toEqual({ tests: 3, seconds: 15, steps: { launch: { seconds: 3, count: 3 }, click: { seconds: 1, count: 4 } } });
    const mac = { tests: 3, seconds: 30, steps: { launch: { seconds: 9, count: 3 }, click: { seconds: 2, count: 4 }, close: { seconds: 3, count: 3 } } };
    expect(differences(linux, mac).map((d) => [d.kind, d.extra])).toEqual([
      ['launch', 6],
      ['close', 3],
      ['click', 1],
    ]);
  });
});
