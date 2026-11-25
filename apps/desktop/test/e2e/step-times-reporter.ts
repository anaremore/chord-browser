/**
 * CI's step-times reporter (playwright.config.ts, on CI): where each shard's time goes, by kind of step. Playwright's
 * own calls (launching the app, finding its windows, clicks, waits, closing it), expect()s by matcher, hooks and
 * fixtures, each counted once (a call inside another isn't counted again), summed by kind across every test, retries
 * included. Playwright's JSON
 * report leaves its own calls out, so this writes playwright-report/step-times.json, which ci.yml uploads with the
 * report and `node scripts/ci/e2e-step-times.mjs <run-id>` compares by platform.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

/**
 * A step's kind: its title without what varies per call (a URL, a selector, a number). An expect() keeps its
 * matcher (`Expect "toBeVisible"`), which is what tells one kind of wait from another.
 */
export function stepKind(step: Pick<TestStep, 'category' | 'title'>): string {
  const title = step.title
    .replace(/\s*\(.*$/, '')
    .replace(/(["'`]).*?\1/g, (quoted) => (step.category === 'expect' ? quoted : '…'))
    .replace(/\d+/g, 'N')
    .slice(0, 60);
  return `${step.category}: ${title}`;
}

const COUNTED = new Set(['pw:api', 'expect', 'hook', 'fixture']);

/** A step that's counted: one of Playwright's calls, a hook or a fixture, not inside another counted step. */
export function counted(step: Pick<TestStep, 'category' | 'parent'>): boolean {
  if (!COUNTED.has(step.category)) return false;
  for (let parent = step.parent; parent; parent = parent.parent) if (COUNTED.has(parent.category)) return false;
  return true;
}

export default class StepTimesReporter implements Reporter {
  private readonly steps: Record<string, { seconds: number; count: number }> = {};
  private total = 0;
  private tests = 0;

  constructor(private readonly options: { outputFile?: string } = {}) {}

  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
    if (!counted(step)) return;
    const entry = (this.steps[stepKind(step)] ??= { seconds: 0, count: 0 });
    entry.seconds += step.duration / 1000;
    entry.count += 1;
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    this.tests += 1;
    this.total += result.duration / 1000;
  }

  onEnd(): void {
    const file = this.options.outputFile ?? join('playwright-report', 'step-times.json');
    mkdirSync(dirname(file), { recursive: true });
    const round = (n: number) => Math.round(n * 10) / 10;
    const steps = Object.fromEntries(
      Object.entries(this.steps)
        .sort((a, b) => b[1].seconds - a[1].seconds)
        .map(([kind, { seconds, count }]) => [kind, { seconds: round(seconds), count }]),
    );
    writeFileSync(file, `${JSON.stringify({ tests: this.tests, seconds: round(this.total), steps }, null, 2)}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
