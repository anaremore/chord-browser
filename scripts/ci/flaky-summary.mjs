// Flaky E2E tests, made visible (Neon's factory audit, 2026-11-24, item 4).
//
// On CI each E2E test gets one retry (apps/desktop/playwright.config.ts). A test that fails and then passes is
// "flaky": the job stays green, and until now nothing said so, so a test flaked unseen until it failed twice in one
// run and blocked a merge. Playwright's JSON reporter writes every test's tries; this reads that report and writes
// each flaky test to the job's step summary, with its first try's error, plus a warning annotation on the run.
//
//   node scripts/ci/flaky-summary.mjs apps/desktop/playwright-report/results.json "Windows arm64 · 3/3"
//
// It never fails the job: a missing or unreadable report (the run was cancelled, or never started) says so and exits 0.
// Pure parts are unit-tested in scripts/test/flaky-summary.test.ts.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every test in a Playwright JSON report, with where it is and its tries. */
export function testsOf(report) {
  const out = [];
  const walk = (suite, titles) => {
    const here = suite.title && !suite.title.endsWith('.ts') ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        out.push({ file: spec.file ?? suite.file ?? '', line: spec.line ?? 0, title: [...here, spec.title].join(' › '), status: test.status, results: test.results ?? [] });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return out;
}

/** Terminal colors (ESC [ … m) in Playwright's messages. */
const COLORS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The first line of a try's error, without terminal colors, cut to `max` characters. */
export function firstLine(error, max = 200) {
  const text = String(error?.message ?? error?.value ?? '')
    .replace(COLORS, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A try's `[diagnostic]` lines (a test's own words about what it saw when it failed, #327: the popover's view), without
 * terminal colors: kept whole, as the first line alone would lose them, and shown even when the retry passed.
 */
export function diagnosticLines(error) {
  return String(error?.message ?? error?.value ?? '')
    .replace(COLORS, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('[diagnostic] '));
}

/** The flaky tests: failed (or timed out) on a try, then passed; with that try's diagnostics, if it said any. */
export function flakyTests(report) {
  return testsOf(report)
    .filter((t) => t.status === 'flaky')
    .map((t) => {
      const failed = t.results.find((r) => r.status !== 'passed' && r.status !== 'skipped');
      const error = failed?.error ?? failed?.errors?.[0];
      const diagnostics = diagnosticLines(error);
      return { where: `${t.file}:${t.line}`, title: t.title, error: firstLine(error), ...(diagnostics.length ? { diagnostics } : {}) };
    });
}

/** Markdown for the step summary: a table, or a line saying there were none. */
export function summary(flaky, job) {
  const heading = `### Flaky E2E tests${job ? ` · ${job}` : ''}`;
  if (flaky.length === 0) return `${heading}\n\nNone: every test passed on its first try, or failed both.\n`;
  const cell = (s) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = flaky.map((f) => `| \`${cell(f.where)}\` | ${cell(f.title)} | ${cell(f.error) || '—'} |`);
  // What a test said about its failed try, under the table: each one's lines, as they were.
  const said = flaky.filter((f) => f.diagnostics?.length).flatMap((f) => [`\`${f.where}\`:`, '', '```', ...f.diagnostics, '```', '']);
  return [heading, '', `${flaky.length} passed only on the retry:`, '', '| Where | Test | First try’s error |', '| --- | --- | --- |', ...rows, '', ...said].join('\n');
}

/** A GitHub warning annotation for each flaky test, so it shows on the run and the pull request's checks. */
export function annotations(flaky, job) {
  const esc = (s) => s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  return flaky.map(
    (f) =>
      `::warning title=${esc(`Flaky${job ? ` (${job})` : ''}: ${f.where}`).replaceAll(',', '%2C').replaceAll(':', '%3A')}::${esc(`${f.title}${f.error ? ` — ${f.error}` : ''}${f.diagnostics?.length ? `\n${f.diagnostics.join('\n')}` : ''}`)}`,
  );
}

export function run(path, job, env = process.env, log = console.log) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    log(`No E2E report to read at ${path} (${existsSync(path) ? 'unreadable' : 'missing'}): the run may not have finished.`);
    return [];
  }
  const flaky = flakyTests(report);
  const text = summary(flaky, job);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  log(text);
  for (const line of annotations(flaky, job)) log(line);
  return flaky;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [path = 'apps/desktop/playwright-report/results.json', job = ''] = process.argv.slice(2);
  run(path, job);
}
