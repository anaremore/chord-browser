// castLabs VMP signing through EVS (docs/decisions/S14-widevine-player.md §5,
// https://github.com/castlabs/electron-releases/wiki/EVS), for production
// builds of Chord Player. CI signs in first (`account reauth`, in a step of
// its own that alone sees EVS_ACCOUNT_NAME and EVS_PASSWD) and keeps EVS's
// tokens in EVS_CONFIG_FILE under the runner's temp folder, never in the
// workspace or an artifact. Packaging then only needs those tokens.
//
// Non-interactive throughout (`--no-ask`, EVS_NO_ASK): a missing or expired
// login is an error, never a prompt, and nothing here retries. castLabs asks
// accounts not to request signatures needlessly; EVS itself keeps a valid
// signature rather than asking for a new one.
//
// CHORD_EVS_PYTHON names the Python (a venv with castlabs-evs, installed by
// the workflow from build/evs-requirements.txt). It runs isolated (-I).
import { spawnSync } from 'node:child_process';

function python() {
  const exe = process.env.CHORD_EVS_PYTHON;
  if (!exe) throw new Error('CHORD_EVS_PYTHON must name the Python that has castlabs-evs (the workflow sets it)');
  return exe;
}

/** EVS's environment: its token and signature caches, non-interactive; never the account's password. */
function evsEnv() {
  const env = { ...process.env, EVS_NO_ASK: '1' };
  delete env.EVS_PASSWD;
  if (!env.EVS_CONFIG_FILE || !env.EVS_CACHE_FILE) throw new Error('EVS_CONFIG_FILE and EVS_CACHE_FILE must point outside the workspace (the workflow sets them)');
  return env;
}

function vmp(args) {
  const result = spawnSync(python(), ['-I', '-m', 'castlabs_evs.vmp', '--no-ask', ...args], { env: evsEnv(), stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`castlabs_evs.vmp ${args[0]} failed (exit ${result.status ?? result.signal}); not retrying`);
}

/** VMP-signs the package in `dir` (the folder that holds the .app or .exe), streaming signature (S14 §5). */
export function vmpSign(dir) {
  console.log(`[evs] VMP-signing ${dir}`);
  vmp(['sign-pkg', '--name-hint', 'Chord Player', dir]);
}

/** Checks the package in `dir` carries a valid production VMP signature. */
export function vmpVerify(dir) {
  console.log(`[evs] Checking the VMP signature in ${dir}`);
  vmp(['verify-pkg', '--name-hint', 'Chord Player', dir]);
}
