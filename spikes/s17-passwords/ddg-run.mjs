#!/usr/bin/env node
// Spike S17 M0, question 4, step 2: DuckDuckGo's own classifier on its own corpus, through
// its own harness (src/Form/input-classifiers.test.js, Jest + jsdom), at the pinned commit.
// Their test already computes, for every labelled field, what their matcher inferred; it
// only keeps the mismatches. This copies their tree to a scratch folder, adds one line so
// the harness also writes every score (and the unlabelled fields their matcher typed) to a
// JSON file, installs their dependencies without install scripts, and runs that one file.
//
// Their code runs, so this runs only in the Linux container (run-linux.mjs ddg), never on
// the desktop. Output: results/ddg-scores.json.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCorpus } from './corpus.mjs';

const here = import.meta.dirname;
const { repoDir } = await ensureCorpus();
const work = mkdtempSync(join(tmpdir(), 'chord-s17-ddg-'));
const out = join(here, 'results', 'ddg-scores.json');
mkdirSync(join(here, 'results'), { recursive: true });
try {
  cpSync(repoDir, work, { recursive: true });
  const testFile = join(work, 'src', 'Form', 'input-classifiers.test.js');
  let test = readFileSync(testFile, 'utf8');
  const push = 'testResults.push({ testCase, scores, submitButtonScores });';
  if (!test.includes(push) || !test.includes('afterAll(() => {')) throw new Error('The harness changed: update ddg-run.mjs');
  test = test.replace(push, 'testResults.push({ testCase, scores, falseScores, submitButtonScores });');
  test = test.replace(
    'afterAll(() => {',
    `afterAll(() => {
    require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(testResults.map(({ testCase, scores, falseScores }) => ({
        html: testCase.html,
        scores: scores.map((s) => ({ manualType: s.manualType, manualVariant: s.manualVariant || null, inferredType: s.inferredType || null, inferredVariant: s.inferredVariant || null, id: s.attrs.id, name: s.attrs.name })),
        unlabelled: falseScores.map((s) => ({ inferredType: s.inferredType || null, inferredVariant: s.inferredVariant || null, id: s.attrs.id, name: s.attrs.name })),
    }))));`,
  );
  writeFileSync(testFile, test);
  const run = (cmd, args) => {
    console.log(`[ddg] ${cmd} ${args.join(' ')}`);
    const r = spawnSync(cmd, args, { cwd: work, stdio: 'inherit', env: { ...process.env, CI: '1' } });
    return r.status;
  };
  if (run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']) !== 0) throw new Error('npm ci failed');
  // The harness fails a file whose failures differ from the index's; that's their check, not ours.
  run('npx', ['jest', 'src/Form/input-classifiers.test.js', '--silent', '--verbose=false']);
  if (!existsSync(out)) throw new Error('No scores written');
  console.log(`[ddg] scores in ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
