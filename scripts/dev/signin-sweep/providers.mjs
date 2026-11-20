#!/usr/bin/env node
// The providers' sweep (S17, phase 3D): the sign-in sweep (README.md), read only, on the public sign-in pages of the
// providers Chord has recipes for (packages/core/src/password-recipes.ts). Run by hand when a provider changes its
// markup, to check each recipe's selectors still match, and then update its `verified` date. Never in CI.
//
//   node scripts/dev/signin-sweep/providers.mjs --dir <dir> [other sweep.mjs arguments]
//
// <dir> is a folder outside the repo (the scratchpad). It gets sites.txt (the pages below) and a `read-only` file: the
// sweep loads each page, reads its fields, focuses them and records what the agent says, and never types into a page,
// presses Next or submits anything. No account is used. Results and screenshots stay in <dir>; only the selectors a
// recipe needs go into the repo.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** The providers' own public sign-in pages: the identifier step each starts with. */
export const PROVIDER_PAGES = [
  // Google's identifier step.
  'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn',
  // Microsoft's: a work or school account (Microsoft 365's sign-in, which sends you to login.microsoftonline.com), and a
  // personal one.
  'https://www.office.com/login',
  'https://login.live.com/',
  // Okta's: its own org's identifier-first page (the Identity Engine widget), and the classic widget.
  'https://okta.okta.com/',
  'https://login.okta.com/signin',
  // Auth0's Universal Login: its own dashboard's sign-in.
  'https://manage.auth0.com/login',
];

const args = process.argv.slice(2);
const i = args.indexOf('--dir');
if (i < 0 || !args[i + 1]) {
  console.error('Usage: providers.mjs --dir <dir outside the repo> [sweep.mjs arguments]');
  process.exit(2);
}
const dir = resolve(args[i + 1]);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'sites.txt'), `${PROVIDER_PAGES.join('\n')}\n`);
writeFileSync(join(dir, 'read-only'), 'Load and look only: no fill, no Next, nothing submitted.\n');
const status = spawnSync(process.execPath, [join(import.meta.dirname, 'sweep.mjs'), ...args, '--workers', '1'], { stdio: 'inherit', windowsHide: true }).status;
process.exit(status ?? 1);
