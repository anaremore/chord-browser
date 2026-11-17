#!/usr/bin/env node
// The sign-in sweep's report (README.md): <dir>/results/*.json into <dir>/report.md and
// <dir>/report.json. One line per site (OK, problem and what, couldn't load and why), and the
// problems grouped by pattern, most sites first.
//
//   node scripts/dev/signin-sweep/report.mjs --dir <dir>
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A problem's pattern: its words before the field details (after the first colon), with "step 2: " kept. */
export const patternOf = (problem) => {
  const step = problem.match(/^(step 2: )?(later: )?/)[0];
  const rest = problem.slice(step.length);
  const cut = rest.indexOf(': ');
  return step + (cut >= 0 ? rest.slice(0, cut) : rest).replace(/\(.*?\)/g, (m) => (/phase|refused|sends/.test(m) ? m : '')).trim();
};
/** Why a site couldn't be swept, with the specifics (an address, an error's text) left out. */
export const reasonOf = (why) =>
  why
    .replace(/^(load(?: of the sign-in link)?): .*?(net::[A-Z_]+|Timeout|timeout).*$/, '$1: $2')
    .replace(/^(load(?: of the sign-in link)?): (?!net::|Timeout|timeout).*$/, '$1: other error')
    .replace(/ \(“.*”\)$/, '');

export function summarize(results) {
  const sorted = [...results].sort((a, b) => a.host.localeCompare(b.host));
  const count = (o) => sorted.filter((r) => r.outcome === o).length;
  const patterns = new Map();
  for (const r of sorted)
    for (const p of new Set(r.problems.map(patternOf))) {
      const list = patterns.get(p) ?? [];
      list.push(r.host);
      patterns.set(p, list);
    }
  const reasons = new Map();
  for (const r of sorted.filter((x) => x.outcome === 'unreachable')) {
    const k = reasonOf(r.why ?? '?');
    reasons.set(k, [...(reasons.get(k) ?? []), r.host]);
  }
  const byCount = (m) => [...m].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([pattern, hosts]) => ({ pattern, count: hosts.length, hosts }));
  return {
    total: sorted.length,
    ok: count('ok'),
    problem: count('problem'),
    unreachable: count('unreachable'),
    patterns: byCount(patterns),
    reasons: byCount(reasons),
    sites: sorted.map((r) => ({ host: r.host, url: r.url, outcome: r.outcome, problems: r.problems, why: r.why, followed: r.followed, next: r.next, notes: r.notes })),
  };
}

export function markdown(s, { title = 'Sign-in sweep' } = {}) {
  const lines = [`# ${title}`, '', `${s.total} sites: **${s.ok} OK**, **${s.problem} with a problem**, **${s.unreachable} couldn't be swept**.`, ''];
  lines.push('## Problems by pattern', '', '| Sites | Pattern | Where |', '|---:|---|---|');
  for (const p of s.patterns) lines.push(`| ${p.count} | ${p.pattern} | ${p.hosts.join(', ')} |`);
  lines.push('', "## Couldn't be swept, by reason", '', '| Sites | Reason | Where |', '|---:|---|---|');
  for (const p of s.reasons) lines.push(`| ${p.count} | ${p.pattern} | ${p.hosts.join(', ')} |`);
  lines.push('', '## Every site', '');
  for (const r of s.sites) {
    const what = r.outcome === 'ok' ? 'OK' : r.outcome === 'problem' ? `problem: ${r.problems.join('; ')}` : `couldn't be swept: ${r.why}`;
    const extra = [r.followed && `followed “${r.followed}”`, r.next && `Next ${r.next}`].filter(Boolean).join('; ');
    lines.push(`- **${r.host}**: ${what}${extra ? ` (${extra})` : ''}`);
  }
  return lines.join('\n') + '\n';
}

function main() {
  const i = process.argv.indexOf('--dir');
  const dir = i > 0 ? resolve(process.argv[i + 1]) : null;
  if (!dir || !existsSync(join(dir, 'results'))) {
    console.error('Usage: report.mjs --dir <dir with results/>');
    return 2;
  }
  const results = readdirSync(join(dir, 'results'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, 'results', f), 'utf8')));
  const s = summarize(results);
  writeFileSync(join(dir, 'report.json'), JSON.stringify(s, null, 2));
  writeFileSync(join(dir, 'report.md'), markdown(s));
  console.log(`[report] ${s.total} sites: ${s.ok} OK, ${s.problem} problem, ${s.unreachable} couldn't be swept → ${join(dir, 'report.md')}`);
  for (const p of s.patterns.slice(0, 12)) console.log(`  ${String(p.count).padStart(3)}  ${p.pattern}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
