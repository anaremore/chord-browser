// Electron security watch (ARCHITECTURE.md §14.3, runbook docs/SECURITY-PATCHING.md).
//
// Electron's security advisories cover only Electron's own bugs. Fixes from
// Chromium, V8, Skia, ANGLE and PDFium show up only in release notes, so no
// vulnerability alert fires for them. This finds stable releases on Chord's
// Electron major that are newer than apps/desktop/package.json, reads their
// notes on GitHub, and flags security content. For a new one it opens a P0
// issue (once per version) and asks the Mend-hosted Renovate app to run.
//
// .github/workflows/electron-watch.yml calls run(). Everything else is pure
// and unit-tested in scripts/test/electron-watch.test.ts.
//
// Local dry run (read-only; writes nothing to GitHub):
//   node scripts/ci/electron-watch.mjs                  # against package.json
//   node scripts/ci/electron-watch.mjs --current 44.9.0 # rehearse against an older version

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every Electron version with its date and Chromium version, but no notes. ✅ 2026-10-22 */
export const RELEASES_URL = 'https://releases.electronjs.org/releases.json';
/** Per-major stable and end-of-life dates. ✅ 2026-10-22 */
export const SCHEDULE_URL = 'https://releases.electronjs.org/schedule.json';
const NOTES_URL = 'https://api.github.com/repos/electron/electron/releases/tags/';
const PACKAGE_JSON = 'apps/desktop/package.json';
const RUNBOOK = 'docs/SECURITY-PATCHING.md';

export const LABELS = [
  { name: 'security', color: 'b60205', description: 'Security fix or security process' },
  { name: 'p0', color: 'd93f0b', description: 'Drop everything: 72-hour security SLA' },
];
const SLA_HOURS = 72;
const EOL_WARNING_DAYS = 30;
/** Cap on release-notes requests per run. */
const MAX_NOTES = 20;
const WATCH_BOT = 'github-actions[bot]';
const RENOVATE_BOT = 'renovate[bot]';
/** The Mend-hosted app's "run again" checkbox at the foot of the Dependency Dashboard. */
export const MANUAL_JOB = '<!-- manual job -->';

// ── Versions ────────────────────────────────────────────────────────────────

/** Parses `45.0.1` or `46.0.0-beta.2` (optional leading v); null for anything else. */
export function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? '' };
}

/** Orders two version strings by major.minor.patch; a prerelease sorts before its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Not a version: ${x ? b : a}`);
  for (const part of ['major', 'minor', 'patch']) {
    if (x[part] !== y[part]) return x[part] - y[part];
  }
  if (x.prerelease === y.prerelease) return 0;
  if (!x.prerelease) return 1;
  if (!y.prerelease) return -1;
  return x.prerelease < y.prerelease ? -1 : 1;
}

/** The exact Electron version in apps/desktop/package.json (Renovate pins it). */
export function electronVersionFrom(pkg) {
  const spec = pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron;
  const version = typeof spec === 'string' ? spec.trim().replace(/^[\^~=]+/, '') : '';
  if (!parseVersion(version)) {
    throw new Error(`${PACKAGE_JSON}: expected an exact electron version, got ${JSON.stringify(spec)}`);
  }
  return version;
}

/** Stable releases on `current`'s major that are newer than it, newest first. */
export function newerOnMajor(releases, current) {
  const { major } = parseVersion(current);
  return releases
    .filter((release) => {
      const v = parseVersion(release.version);
      return v !== null && !v.prerelease && v.major === major && compareVersions(release.version, current) > 0;
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Highest major with a stable release. */
export function latestStableMajor(releases) {
  let latest = 0;
  for (const release of releases) {
    const v = parseVersion(release.version);
    if (v && !v.prerelease && v.major > latest) latest = v.major;
  }
  return latest;
}

/** Support window for `major` from schedule.json, or null if it isn't listed. */
export function supportStatus(schedule, major, now = new Date()) {
  const row = schedule.find((entry) => parseVersion(entry.version)?.major === major);
  if (!row?.eolDate) return null;
  const daysLeft = Math.floor((Date.parse(`${row.eolDate}T00:00:00Z`) - now.getTime()) / 86_400_000);
  return { major, status: row.status, eolDate: row.eolDate, daysLeft };
}

// ── Release notes ───────────────────────────────────────────────────────────

/**
 * What counts as security content, checked line by line. Seen in real notes:
 *   "Security: backported fix for CVE-2024-0519."          (to ~2025)
 *   "Backported fix for 524628213." / "Backported fixes from upstream ANGLE,
 *    Chromium, PDFium, Skia and V8."                         (2026; no CVE ids)
 *   "Updated Chromium to 138.0.7204.97."                     (37.2.0, the V8
 *    zero-day fix for CVE-2025-6554, said nothing else)
 *   "This release contains the fix for …/advisories/GHSA-…" (Electron's own)
 * A false alarm costs a minute of triage; a miss costs the 72-hour SLA, so any
 * backport or Chromium roll counts.
 */
const SECURITY_RULES = [
  { reason: 'CVE', pattern: /\bCVE-\d{4}-\d{4,}\b/i },
  { reason: 'Electron advisory', pattern: /\bGHSA(?:-[0-9a-z]{4}){3}\b/i },
  { reason: 'Security fix', pattern: /^\W*security\W*:/i },
  { reason: 'Backport', pattern: /^\W*backported\b/i },
  {
    reason: 'Chromium update',
    pattern: /\b(?:updated|upgraded|bumped|rolled)\s+(?:chromium|v8)\s+to\b|^\W*chromium\W+\d+\.\d+\.\d+\.\d+/i,
  },
];

/** Strips list markers and "(Also in …)" tags; avoids backlinks and @-pings. */
function tidy(line) {
  return line
    .replace(/^(?:>\s*)?(?:[-*+]\s+)?/, '')
    .replace(/<sup>[\s\S]*?<\/sup>|<span\b[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(
      /https:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+\/(?:issues|pull|discussions)\/\d+)/gi,
      'https://redirect.github.com/$1',
    )
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1@​')
    .trim()
    .slice(0, 500);
}

/** Security-relevant lines in one release's notes, with the rule that matched. */
export function findSecurityLines(notes) {
  const found = [];
  for (const raw of String(notes ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const rule = SECURITY_RULES.find(({ pattern }) => pattern.test(line));
    if (rule) found.push({ reason: rule.reason, line: tidy(line) });
  }
  return found;
}

// ── Issues and the Renovate dashboard ───────────────────────────────────────

export const securityMarker = (version) => `<!-- electron-watch:security:${version} -->`;
export const eolMarker = (major) => `<!-- electron-watch:eol:${major} -->`;

const releasePage = (version) => `https://releases.electronjs.org/release/v${version}`;
const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const releasedAt = (release) => Date.parse(release.fullDate ?? `${release.date}T00:00:00Z`);

/**
 * Issue for the newest security release. `findings` are newest first:
 * { version, date, fullDate, chrome, lines }. `newest` is the newest stable
 * release on our major, which may be a later one with no security lines.
 */
export function securityIssue({ current, newest, findings, repoUrl, branch = 'main', renovate, runUrl }) {
  const target = findings[0];
  const oldest = findings.at(-1);
  const deadline = releasedAt(oldest) + SLA_HOURS * 3_600_000;
  const upgradeTo = newest?.version ?? target.version;
  const chrome = newest?.chrome ?? target.chrome;
  const notes = findings.flatMap((release) => [
    `#### [${release.version}](${releasePage(release.version)}) · ${release.date}${release.chrome ? ` · Chromium ${release.chrome}` : ''}`,
    '',
    ...release.lines.map(({ line }) => `- ${line}`),
    '',
  ]);
  const runbook = `${repoUrl}/blob/${branch}/${RUNBOOK}`;
  return {
    title: `P0: Electron ${target.version} has security fixes (Chord is on ${current})`,
    body: [
      securityMarker(target.version),
      `Electron **${target.version}** ships security fixes. Chord is on **${current}** (\`${PACKAGE_JSON}\`).`,
      `Upgrade to **${upgradeTo}**${upgradeTo === target.version ? '' : `, the newest ${parseVersion(upgradeTo).major}.x, which includes everything below`}.`,
      '',
      `**Ship by ${utc(deadline)}**: ${SLA_HOURS} hours after Electron ${oldest.version} was released.`,
      '',
      '### What the release notes say',
      '',
      ...notes,
      "Electron doesn't say which Chromium bugs a backport fixes. Chrome's matching notes are on the [Chrome Releases blog](https://chromereleases.googleblog.com/search/label/Stable%20updates).",
      '',
      `### Checklist ([runbook](${runbook}))`,
      '',
      `- [ ] **T+1 h** Renovate PR for \`electron\` ${upgradeTo} is open. ${renovate}`,
      '- [ ] **T+8 h** CI is green on every OS and the PR is merged (automerge, or merge by hand)',
      `- [ ] **T+8 h** Smoke test on \`main\`: Chord starts; Settings → About shows Electron ${upgradeTo}${chrome ? ` and Chromium ${chrome}` : ''}`,
      '- [ ] **T+12 h** Release tagged; the release workflow built it',
      '- [ ] **T+24 h** Release published; the update check offers it',
      '- [ ] **T+72 h** Every channel has it; close this issue with a link to the release',
      '',
      `<sub>Opened by [electron-watch](${runUrl}). One issue per Electron version; closing it doesn't reopen.</sub>`,
    ].join('\n'),
  };
}

/** Issue when our major is out of support, or close to it. */
export function eolIssue({ current, support, latestMajor, repoUrl, runUrl }) {
  const ended = support.status === 'eol' || support.daysLeft < 0;
  return {
    title: ended
      ? `P0: Electron ${support.major} is end-of-life and gets no more security fixes`
      : `Electron ${support.major} reaches end-of-life on ${support.eolDate}`,
    labels: ended ? ['security', 'p0'] : ['security'],
    body: [
      eolMarker(support.major),
      `Chord is on Electron **${current}**. Electron ${support.major} ${ended ? 'reached' : 'reaches'} end-of-life on **${support.eolDate}**${ended ? '' : ` (${support.daysLeft} days)`}.`,
      `Electron supports only the latest three stable majors ([timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)); the newest is ${latestMajor}. After end-of-life there are no more Chromium backports, so this watcher has nothing to report.`,
      '',
      `- [ ] Merge Renovate's Electron major PR (majors are manual; see \`renovate.json\`)`,
      `- [ ] Ship a release on the new major ([runbook](${repoUrl}/blob/main/${RUNBOOK}))`,
      '',
      `<sub>Opened by [electron-watch](${runUrl}).</sub>`,
    ].join('\n'),
  };
}

/** Ticks the dashboard's "run again" checkbox; null if it isn't there unticked. */
export function tickManualJob(body) {
  const unticked = /^(\s*[-*] )\[ \]( <!-- manual job -->)/m;
  return unticked.test(body ?? '') ? body.replace(unticked, '$1[x]$2') : null;
}

// ── I/O ─────────────────────────────────────────────────────────────────────

const consoleCore = {
  info: (message) => console.log(message),
  notice: (message) => console.log(`notice: ${message}`),
  warning: (message) => console.warn(`warning: ${message}`),
};

async function getJson(fetch, url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response.json();
}

/** Release notes from GitHub, or null if the release isn't on GitHub yet. */
async function releaseNotes(fetch, version, token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'chord-electron-watch',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(`${NOTES_URL}v${version}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release v${version}: HTTP ${response.status}`);
  return (await response.json()).body ?? '';
}

async function ensureLabels(github, repo, names) {
  for (const label of LABELS.filter(({ name }) => names.includes(name))) {
    try {
      await github.rest.issues.getLabel({ ...repo, name: label.name });
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        await github.rest.issues.createLabel({ ...repo, ...label });
      } catch (createError) {
        if (createError.status !== 422) throw createError; // created meanwhile
      }
    }
  }
}

async function openIssue(github, repo, { title, body, labels }, assignees, core) {
  await ensureLabels(github, repo, labels);
  const { data: issue } = await github.rest.issues.create({ ...repo, title, body, labels });
  if (assignees.length) {
    try {
      await github.rest.issues.addAssignees({ ...repo, issue_number: issue.number, assignees });
    } catch (error) {
      core.warning(`Couldn't assign ${assignees.join(', ')} to #${issue.number}: ${error.message}`);
    }
  }
  core.notice(`Opened #${issue.number}: ${title}`);
  return issue;
}

/**
 * Asks the Mend-hosted Renovate app to run now by ticking its Dependency
 * Dashboard checkbox, the same edit a person makes. Mend runs a repo about
 * every 4 hours otherwise.
 */
async function requestRenovateRun(github, repo) {
  const open = await github.paginate(github.rest.issues.listForRepo, {
    ...repo,
    state: 'open',
    creator: RENOVATE_BOT,
    per_page: 100,
  });
  const dashboard = open.find((issue) => !issue.pull_request && issue.body?.includes(MANUAL_JOB));
  if (!dashboard) return 'No Renovate Dependency Dashboard found; Renovate runs on its own schedule (about every 4 hours).';
  const body = tickManualJob(dashboard.body);
  if (!body) return `A Renovate run was already requested on the [Dependency Dashboard](${dashboard.html_url}).`;
  await github.rest.issues.update({ ...repo, issue_number: dashboard.number, body });
  return `Requested a Renovate run on the [Dependency Dashboard](${dashboard.html_url}).`;
}

/**
 * The whole check. Pass `github`, `context` and `core` from actions/github-script;
 * leave `github` out (or set dryRun) to only report. Returns what it found and did.
 */
export async function run({
  github,
  context,
  core = consoleCore,
  fetch = globalThis.fetch,
  token = process.env.GITHUB_TOKEN,
  current,
  root = process.cwd(),
  dryRun = !github,
  oncall = process.env.SECURITY_ONCALL,
  now = new Date(),
} = {}) {
  current ??= electronVersionFrom(JSON.parse(await readFile(resolve(root, PACKAGE_JSON), 'utf8')));
  const { major } = parseVersion(current);
  const releases = await getJson(fetch, RELEASES_URL);
  const newer = newerOnMajor(releases, current);
  const latestMajor = latestStableMajor(releases);

  const findings = [];
  const missingNotes = [];
  for (const release of newer.slice(0, MAX_NOTES)) {
    const notes = await releaseNotes(fetch, release.version, token);
    if (notes === null) {
      missingNotes.push(release.version);
      continue;
    }
    const lines = findSecurityLines(notes);
    if (lines.length) findings.push({ ...release, lines });
  }

  let support = null;
  try {
    support = supportStatus(await getJson(fetch, SCHEDULE_URL), major, now);
  } catch (error) {
    core.warning(`Skipped the end-of-life check: ${error.message}`);
  }

  const report = [
    `Chord is on Electron ${current}. Newer on ${major}.x: ${newer.map((r) => r.version).join(', ') || 'none'}.`,
    findings.length
      ? `Security content in: ${findings.map((f) => `${f.version} (${[...new Set(f.lines.map((l) => l.reason))].join(', ')})`).join('; ')}.`
      : 'No security content found.',
  ];
  if (newer.length > MAX_NOTES) report.push(`Read notes for the newest ${MAX_NOTES} of ${newer.length} releases only.`);
  if (missingNotes.length) report.push(`No GitHub release notes yet for ${missingNotes.join(', ')}; checking again next run.`);
  if (latestMajor > major) report.push(`Electron ${latestMajor} is the newest stable major. Renovate opens major PRs for a person to merge.`);
  if (support) report.push(`Electron ${major} support ends ${support.eolDate} (${support.status}).`);
  for (const line of report) core.info(line);
  for (const version of missingNotes) core.warning(`Electron ${version} has no GitHub release yet.`);

  const result = { current, newer: newer.map((r) => r.version), findings, missingNotes, latestMajor, support, opened: [] };
  const wantEol = support && (support.status === 'eol' || support.daysLeft <= EOL_WARNING_DAYS);

  const repoInfo = context?.repo;
  const repoUrl = repoInfo ? `${context.serverUrl}/${repoInfo.owner}/${repoInfo.repo}` : 'https://github.com/OWNER/REPO';
  const runUrl = repoInfo ? `${repoUrl}/actions/runs/${context.runId}` : 'local dry run';
  const branch = context?.payload?.repository?.default_branch ?? 'main';

  if (dryRun) {
    if (findings.length) {
      const issue = securityIssue({ current, newest: newer[0], findings, repoUrl, branch, renovate: '(dry run: Renovate not asked)', runUrl });
      core.info(`\nWould open (unless one exists for ${findings[0].version}): ${issue.title}\n\n${issue.body}`);
    }
    if (wantEol) core.info(`\nWould open: ${eolIssue({ current, support, latestMajor, repoUrl, runUrl }).title}`);
    await writeSummary(core, report);
    return result;
  }

  const repo = { owner: repoInfo.owner, repo: repoInfo.repo };
  const assignees = (oncall || repo.owner).split(',').map((s) => s.trim()).filter(Boolean);
  const ours = (await github.paginate(github.rest.issues.listForRepo, { ...repo, state: 'all', creator: WATCH_BOT, per_page: 100 }))
    .filter((issue) => !issue.pull_request && issue.body?.includes('<!-- electron-watch:'));
  const exists = (marker) => ours.find((issue) => issue.body.includes(marker));

  if (findings.length) {
    const version = findings[0].version;
    const existing = exists(securityMarker(version));
    if (existing) {
      report.push(`Issue #${existing.number} already covers ${version}.`);
    } else {
      let renovate;
      try {
        renovate = await requestRenovateRun(github, repo);
      } catch (error) {
        renovate = `Couldn't ask Renovate to run (${error.message}); tick "run again" on the Dependency Dashboard.`;
        core.warning(renovate);
      }
      const issue = await openIssue(
        github,
        repo,
        { ...securityIssue({ current, newest: newer[0], findings, repoUrl, branch, renovate, runUrl }), labels: ['security', 'p0'] },
        assignees,
        core,
      );
      result.opened.push(issue.number);
      report.push(`Opened #${issue.number}. ${renovate}`);
      for (const older of ours.filter((i) => i.state === 'open' && i.body.includes('<!-- electron-watch:security:'))) {
        await github.rest.issues.createComment({
          ...repo,
          issue_number: older.number,
          body: `Electron ${version} also has security fixes; #${issue.number} tracks the upgrade. Close this one when that ships.`,
        });
      }
    }
  }

  if (wantEol && !exists(eolMarker(major))) {
    const issue = await openIssue(github, repo, eolIssue({ current, support, latestMajor, repoUrl, runUrl }), assignees, core);
    result.opened.push(issue.number);
    report.push(`Opened #${issue.number} about Electron ${major} end-of-life.`);
  }

  await writeSummary(core, report);
  return result;
}

async function writeSummary(core, lines) {
  if (core.summary) await core.summary.addRaw(lines.map((line) => `- ${line}`).join('\n')).write();
}

// ── CLI (local dry run) ─────────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--current');
  run({
    root: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    current: flag > 0 ? process.argv[flag + 1] : undefined,
    dryRun: true,
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
