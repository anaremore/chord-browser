import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RELEASES_URL,
  SCHEDULE_URL,
  compareVersions,
  electronVersionFrom,
  eolIssue,
  findSecurityLines,
  latestStableMajor,
  newerOnMajor,
  parseVersion,
  run,
  securityIssue,
  securityMarker,
  supportStatus,
  tickManualJob,
} from '../ci/electron-watch.mjs';

// Shapes and note lines copied from releases.electronjs.org/releases.json and
// GitHub release notes on 2026-10-22.
const releases = [
  { version: '46.0.0-nightly.20261021', date: '2026-10-21', fullDate: '2026-10-21T13:00:17.000Z', chrome: '158.0.8111.0' },
  { version: '45.0.0', date: '2026-10-21', fullDate: '2026-10-21T05:00:00.000Z', chrome: '156.0.8078.48' },
  { version: '44.9.3', date: '2026-10-21', fullDate: '2026-10-21T03:20:00.000Z', chrome: '152.0.7977.180' },
  { version: '44.9.2', date: '2026-10-20', fullDate: '2026-10-20T17:40:00.000Z', chrome: '152.0.7977.167' },
  { version: '44.9.1', date: '2026-10-20', fullDate: '2026-10-20T00:48:00.000Z', chrome: '152.0.7977.167' },
  { version: '44.9.0', date: '2026-10-17', fullDate: '2026-10-17T00:00:00.000Z', chrome: '152.0.7977.167' },
  { version: '45.0.0-beta.6', date: '2026-10-08', fullDate: '2026-10-08T00:00:00.000Z', chrome: '156.0.8078.36' },
  { version: '43.8.3', date: '2026-10-21', fullDate: '2026-10-21T02:00:00.000Z', chrome: '150.0.7871.300' },
];

const notes: Record<string, string> = {
  '44.9.3':
    '# Release Notes for v44.9.3\n\n## Other Changes\n\n* Backported fixes from upstream ANGLE, Chromium, PDFium, Skia and V8. [#55149](https://github.com/electron/electron/pull/55149)',
  '44.9.2': '# Release Notes for v44.9.2\n\n',
  '44.9.1':
    '# Release Notes for v44.9.1\n\n> [!NOTE]\n> This release contains the fix for https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9, the mitigation for compromised eMudhra intermediate certificates',
};

const schedule = [
  { version: '46.0.0', status: 'nightly', eolDate: '2027-06-22' },
  { version: '45.0.0', status: 'stable', eolDate: '2027-04-27' },
  { version: '44.0.0', status: 'stable', eolDate: '2027-03-02' },
  { version: '42.0.0', status: 'eol', eolDate: '2026-10-20' },
];

describe('versions', () => {
  it('parses stable and prerelease versions', () => {
    expect(parseVersion('45.0.1')).toEqual({ major: 45, minor: 0, patch: 1, prerelease: '' });
    expect(parseVersion('v46.0.0-beta.2')).toEqual({ major: 46, minor: 0, patch: 0, prerelease: 'beta.2' });
    expect(parseVersion('^45.0.0')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it('compares numerically, prereleases first', () => {
    expect(compareVersions('44.10.0', '44.9.3')).toBeGreaterThan(0);
    expect(compareVersions('45.0.0-beta.6', '45.0.0')).toBeLessThan(0);
    expect(compareVersions('45.0.0', '45.0.0')).toBe(0);
  });

  it('reads the pinned electron version from package.json', () => {
    expect(electronVersionFrom({ devDependencies: { electron: '45.0.0' } })).toBe('45.0.0');
    expect(electronVersionFrom({ devDependencies: { electron: '^45.0.1' } })).toBe('45.0.1');
    expect(() => electronVersionFrom({ devDependencies: {} })).toThrow(/exact electron version/);
  });

  it('reads the real apps/desktop/package.json', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../apps/desktop/package.json', import.meta.url)), 'utf8'));
    expect(parseVersion(electronVersionFrom(pkg))).not.toBeNull();
  });

  it('lists newer stable releases on our major only, newest first', () => {
    expect(newerOnMajor(releases, '44.9.0').map((r) => r.version)).toEqual(['44.9.3', '44.9.2', '44.9.1']);
    expect(newerOnMajor(releases, '45.0.0')).toEqual([]);
    expect(newerOnMajor(releases, '45.0.0-beta.6').map((r) => r.version)).toEqual(['45.0.0']);
  });

  it('finds the newest stable major, ignoring nightlies', () => {
    expect(latestStableMajor(releases)).toBe(45);
  });

  it('computes the support window', () => {
    const now = new Date('2026-10-22T00:00:00Z');
    expect(supportStatus(schedule, 45, now)).toEqual({ major: 45, status: 'stable', eolDate: '2027-04-27', daysLeft: 187 });
    expect(supportStatus(schedule, 42, now)?.status).toBe('eol');
    expect(supportStatus(schedule, 30, now)).toBeNull();
  });
});

describe('findSecurityLines', () => {
  it.each([
    ['* Backported fixes from upstream ANGLE, Chromium, PDFium, Skia and V8. [#55149](https://github.com/electron/electron/pull/55149)', 'Backport'],
    ['* Backported fix for 524628213. [#52868](https://github.com/electron/electron/pull/52868) ', 'Backport'],
    ['* Backported fix for chromium:475877320. [#50438](https://github.com/electron/electron/pull/50438) ', 'Backport'],
    ['* Security: backported fix for CVE-2024-0519. [#40972](https://github.com/electron/electron/pull/40972) ', 'CVE'],
    ['* Security: backported 20 High-severity fixes from Chrome 148 stable release. [#51618](https://github.com/electron/electron/pull/51618) ', 'Security fix'],
    // 37.2.0 fixed the V8 zero-day CVE-2025-6554 and said only this:
    ['* Updated Chromium to 138.0.7204.97. [#47619](https://github.com/electron/electron/pull/47619) ', 'Chromium update'],
    ['> This release contains the fix for https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9, the mitigation for compromised eMudhra intermediate certificates', 'Electron advisory'],
  ])('flags %s', (line, reason) => {
    expect(findSecurityLines(`## Other Changes\n\n${line}`)).toEqual([expect.objectContaining({ reason })]);
  });

  it.each([
    '* Fixed a crash when a WebAuthn request used a security key that required its PIN. [#54403](https://github.com/electron/electron/pull/54403) <sup>(Also in [45](https://github.com/electron/electron/pull/54389))</sup>',
    '* Fixed an issue where saving edited PDF files would fail with a cross-origin SecurityError. [#51042](https://github.com/electron/electron/pull/51042)',
    '* Updated Node.js to v22.17.0. [#47555](https://github.com/electron/electron/pull/47555) ',
    '## Security',
    '',
  ])('ignores %s', (line) => {
    expect(findSecurityLines(line)).toEqual([]);
  });

  it('tidies lines: no list marker, no backlinks, no pings, no "Also in"', () => {
    const [found] = findSecurityLines(
      '* Backported fix for 1. [#40541](https://github.com/electron/electron/pull/40541) thanks @someone <sup>(Also in [26](https://github.com/electron/electron/pull/40540))</sup>',
    );
    expect(found.line).toBe('Backported fix for 1. [#40541](https://redirect.github.com/electron/electron/pull/40541) thanks @​someone');
  });
});

describe('issues', () => {
  const findings = ['44.9.3', '44.9.1'].map((version) => ({
    ...releases.find((r) => r.version === version)!,
    lines: findSecurityLines(notes[version]),
  }));

  it('builds a P0 issue with the deadline from the oldest unpatched release', () => {
    const issue = securityIssue({
      current: '44.9.0',
      newest: releases[2],
      findings,
      repoUrl: 'https://github.com/anaremore/chord-browser',
      renovate: 'Requested a Renovate run.',
      runUrl: 'https://github.com/anaremore/chord-browser/actions/runs/1',
    });
    expect(issue.title).toBe('P0: Electron 44.9.3 has security fixes (Chord is on 44.9.0)');
    expect(issue.body.startsWith(securityMarker('44.9.3'))).toBe(true);
    expect(issue.body).toContain('**Ship by 2026-10-23 00:48 UTC**');
    expect(issue.body).toContain('Chromium 152.0.7977.180');
    expect(issue.body).toContain('https://github.com/anaremore/chord-browser/blob/main/docs/releasing/patch-runbook.md');
    expect(issue.body).not.toMatch(/https:\/\/github\.com\/electron\/electron\/pull/);
  });

  it('points at the newest release when it is newer than the security one', () => {
    const issue = securityIssue({ current: '44.9.0', newest: { version: '44.9.4', chrome: '152.0.7977.190' }, findings, repoUrl: 'x', renovate: '', runUrl: 'x' });
    expect(issue.body).toContain('Upgrade to **44.9.4**, the newest 44.x');
  });

  it('labels an ended major P0 and an upcoming end-of-life as security only', () => {
    const base = { current: '42.1.0', latestMajor: 45, repoUrl: 'x', runUrl: 'x' };
    expect(eolIssue({ ...base, support: { major: 42, status: 'eol', eolDate: '2026-10-20', daysLeft: -2 } }).labels).toEqual(['security', 'p0']);
    expect(eolIssue({ ...base, support: { major: 42, status: 'stable', eolDate: '2026-11-01', daysLeft: 10 } }).labels).toEqual(['security']);
  });

  it('ticks only the unticked Renovate run-again checkbox', () => {
    const body = ' - [ ] <!-- approve-branch=renovate/x -->x\n\n---\n\n- [ ] <!-- manual job -->Check this box to trigger a request for Renovate to run again on this repository';
    const ticked = tickManualJob(body);
    expect(ticked).toContain('- [x] <!-- manual job -->Check this box');
    expect(ticked).toContain(' - [ ] <!-- approve-branch=renovate/x -->');
    expect(tickManualJob(ticked)).toBeNull();
    expect(tickManualJob('no checkbox')).toBeNull();
  });
});

interface Issue {
  number: number;
  state: string;
  user: { login: string };
  title?: string;
  body?: string;
  labels?: string[];
  html_url?: string;
}
interface Params {
  issue_number?: number;
  body?: string;
  assignees?: string[];
  name?: string;
  state?: string;
  creator?: string;
  title?: string;
  labels?: string[];
}

// A minimal stand-in for actions/github-script's `github` client.
function fakeGithub(seed: Issue[] = []) {
  const issues: Issue[] = seed.map((issue) => ({ ...issue }));
  const labels = new Set<string>();
  const calls = { created: [] as Issue[], updated: [] as Params[], comments: [] as Params[], assigned: [] as Params[], labels: [] as string[] };
  const github = {
    paginate: async (fn: (params: Params) => Promise<{ data: Issue[] }>, params: Params) => (await fn(params)).data,
    rest: {
      issues: {
        listForRepo: async ({ state, creator }: Params) => ({
          data: issues.filter((i) => i.user.login === creator && (state === 'all' || i.state === state)),
        }),
        getLabel: async ({ name = '' }: Params) => {
          if (!labels.has(name)) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: {} };
        },
        createLabel: async ({ name = '' }: Params) => {
          labels.add(name);
          calls.labels.push(name);
          return { data: {} };
        },
        create: async ({ title, body, labels: issueLabels }: Params) => {
          const number = 100 + issues.length;
          const issue: Issue = { number, title, body, labels: issueLabels, state: 'open', html_url: `https://github.com/o/r/issues/${number}`, user: { login: 'github-actions[bot]' } };
          issues.push(issue);
          calls.created.push(issue);
          return { data: issue };
        },
        update: async (params: Params) => {
          calls.updated.push(params);
          const issue = issues.find((i) => i.number === params.issue_number);
          if (issue && params.body) issue.body = params.body;
          return { data: {} };
        },
        createComment: async (params: Params) => {
          calls.comments.push(params);
          return { data: {} };
        },
        addAssignees: async (params: Params) => {
          calls.assigned.push(params);
          return { data: {} };
        },
      },
    },
  };
  return { github, calls, issues };
}

function fakeFetch(extraSchedule = schedule) {
  return async (url: string) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url === RELEASES_URL) return json(200, releases);
    if (url === SCHEDULE_URL) return json(200, extraSchedule);
    const version = /\/tags\/v(.+)$/.exec(url)?.[1];
    return version && version in notes ? json(200, { body: notes[version] }) : json(404, {});
  };
}

const quiet = { info() {}, notice() {}, warning() {} };
const context = { repo: { owner: 'anaremore', repo: 'chord-browser' }, serverUrl: 'https://github.com', runId: 7, payload: {} };
const dashboard: Issue = {
  number: 1,
  state: 'open',
  title: 'Dependency Dashboard',
  user: { login: 'renovate[bot]' },
  html_url: 'https://github.com/anaremore/chord-browser/issues/1',
  body: 'Dashboard\n\n---\n\n- [ ] <!-- manual job -->Check this box to trigger a request for Renovate to run again on this repository',
};
const now = new Date('2026-10-22T00:00:00Z');

describe('run', () => {
  it('opens one labeled, assigned P0 issue and asks Renovate to run', async () => {
    const { github, calls } = fakeGithub([dashboard]);
    const result = await run({ github, context, core: quiet, fetch: fakeFetch(), current: '44.9.0', oncall: '', now });

    expect(result.findings.map((f: { version: string }) => f.version)).toEqual(['44.9.3', '44.9.1']);
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0].labels).toEqual(['security', 'p0']);
    expect(calls.created[0].body).toContain('Requested a Renovate run');
    expect(calls.labels).toEqual(['security', 'p0']);
    expect(calls.assigned[0].assignees).toEqual(['anaremore']);
    expect(calls.updated[0].body).toContain('- [x] <!-- manual job -->');
  });

  it("doesn't open a second issue for the same version, even once closed", async () => {
    const { github, calls, issues } = fakeGithub([dashboard]);
    await run({ github, context, core: quiet, fetch: fakeFetch(), current: '44.9.0', now });
    issues.find((i) => i.number === 101)!.state = 'closed';
    await run({ github, context, core: quiet, fetch: fakeFetch(), current: '44.9.0', now });
    expect(calls.created).toHaveLength(1);
    expect(calls.updated).toHaveLength(1);
  });

  it('points an older open issue at the new one', async () => {
    const older = { number: 50, state: 'open', user: { login: 'github-actions[bot]' }, body: `${securityMarker('44.9.1')}\nold` };
    const { github, calls } = fakeGithub([older]);
    await run({ github, context, core: quiet, fetch: fakeFetch(), current: '44.9.0', now });
    expect(calls.comments).toEqual([expect.objectContaining({ issue_number: 50, body: expect.stringContaining('#101') })]);
  });

  it('does nothing when Chord is on the newest release', async () => {
    const { github, calls } = fakeGithub([dashboard]);
    const result = await run({ github, context, core: quiet, fetch: fakeFetch(), current: '45.0.0', now });
    expect(result.newer).toEqual([]);
    expect(calls.created).toEqual([]);
    expect(calls.updated).toEqual([]);
  });

  it('opens an end-of-life issue once', async () => {
    const { github, calls } = fakeGithub();
    const ended = [{ version: '43.0.0', status: 'eol', eolDate: '2026-10-20' }];
    await run({ github, context, core: quiet, fetch: fakeFetch(ended), current: '43.8.3', now });
    await run({ github, context, core: quiet, fetch: fakeFetch(ended), current: '43.8.3', now });
    expect(calls.created.map((i) => i.title)).toEqual(['P0: Electron 43 is end-of-life and gets no more security fixes']);
  });

  it('writes nothing in a dry run', async () => {
    const result = await run({ core: quiet, fetch: fakeFetch(), current: '44.9.0', now });
    expect(result.findings).toHaveLength(2);
    expect(result.opened).toEqual([]);
  });
});
