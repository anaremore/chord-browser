#!/usr/bin/env node
// Runs the desktop E2E suite in a Linux container, on a virtual display, so no
// Chord window ever opens on your desktop (CONTRIBUTING.md, "Running E2E
// without windows"). On Windows it drives Docker Engine in WSL 2; on Linux and
// macOS, the docker on the PATH.
//
//   pnpm test:e2e:linux                          the whole suite, X11 (Xvfb with openbox)
//   pnpm test:e2e:linux --wayland                headless Weston instead
//   pnpm test:e2e:linux launch.spec.ts -g Peek --repeat-each 3
//
// Every argument but these goes to Playwright:
//   --wayland / --x11   which display server (x11 by default)
//   --rebuild           rebuild the image from scratch (fresh Ubuntu packages)
// CHORD_E2E_WSL_DISTRO picks the WSL distro that has Docker (WSL's default otherwise).
// CHORD_NO_MINIFY, CHORD_PERF_ENFORCE and CHORD_PERF_PROFILE, when set, are passed into the container (PASSED_ENV).
//
// What's tested is this working tree as it is: tracked files and untracked ones
// that aren't ignored, uncommitted changes included, copied into a container of
// its own. node_modules and the build are made in there (never the Windows
// ones), the pnpm store and Electron download are cached in the named volumes
// chord-e2e-pnpm-store and chord-e2e-electron-cache, and test-results (and a
// report, if a reporter wrote one) are copied back to apps/desktop as a local
// run leaves them. Every Docker object is named chord-e2e-*; each run's
// container has a name of its own, so runs from several worktrees don't collide.
//
// The pure parts are exported for scripts/test/e2e-linux.test.ts.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORE_VOLUME = 'chord-e2e-pnpm-store';
export const ELECTRON_VOLUME = 'chord-e2e-electron-cache';
/** What a run can leave in apps/desktop: Playwright's outputDir, and the html and blob reporters' folders. */
export const OUTPUTS = ['test-results', 'playwright-report', 'blob-report'];

/** A spec path, maybe with :line, typed with Windows separators (test\e2e\launch.spec.ts:12). */
const WINDOWS_SPEC_PATH = /^[^-][^\\]*\\.*\.[cm]?[jt]sx?(:\d+)*$/;

/** The runner's own options, and the arguments that go to Playwright. */
export function parseArgs(argv) {
  const options = { display: 'x11', rebuild: false, help: false, playwright: [] };
  // `pnpm test:e2e:linux -- -g x` hands the script the `--` too.
  for (const arg of argv[0] === '--' ? argv.slice(1) : argv) {
    if (arg === '--wayland' || arg === '--x11') options.display = arg.slice(2);
    else if (arg === '--rebuild') options.rebuild = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options.playwright.push(WINDOWS_SPEC_PATH.test(arg) ? arg.replaceAll('\\', '/') : arg);
  }
  return options;
}

/** The image's tag: a hash of the Dockerfile and the pnpm version it bakes in, so a change to either builds a new one. */
export function imageTag(dockerfile, pnpmVersion) {
  return `chord-e2e-runner:${createHash('sha256').update(dockerfile).update(`\0${pnpmVersion}`).digest('hex').slice(0, 12)}`;
}

/** A name of its own for each run's container: chord-e2e-run-<worktree folder>-<random>. */
export function containerName(root, random = randomBytes(3).toString('hex')) {
  const slug = basename(root).toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, '-').slice(0, 40);
  return `chord-e2e-run-${slug}-${random}`;
}

/** A run copies its results out within seconds of its container stopping; one stopped longer than this is nobody's. */
export const STALE_MS = 10 * 60_000;

/**
 * Containers left by runs that were killed before they could remove them (Task Manager, WSL
 * shutting down), from `docker inspect` lines of name|status|finished|created. Only stopped ones,
 * and only long enough ago that no run is still copying results out of them.
 */
export function staleRuns(inspected, now = Date.now()) {
  return inspected
    .split('\n')
    .map((line) => line.trim().split('|'))
    .filter(([name, status, finished, created]) => {
      if (!name || !['exited', 'dead', 'created'].includes(status)) return false;
      // A container that never started has no finish time (0001-01-01).
      const stopped = Date.parse(finished) > 0 ? Date.parse(finished) : Date.parse(created);
      return now - stopped > STALE_MS;
    })
    .map(([name]) => name.replace(/^\//, ''));
}

/**
 * Variables a run takes into the container from the caller's environment when they're set: an
 * unminified build to profile (CHORD_NO_MINIFY), and the performance spec's enforcement and CPU profiles.
 */
export const PASSED_ENV = ['CHORD_NO_MINIFY', 'CHORD_PERF_ENFORCE', 'CHORD_PERF_PROFILE'];

/** `docker run`'s arguments: the tar of the working tree arrives on stdin and is unpacked in /work. */
export function dockerRunArgs({ name, image, display, root, startedAt, playwright, env = {} }) {
  return [
    'run',
    '--interactive',
    '--name', name,
    '--label', 'chord-e2e=run',
    '--label', `chord-e2e.tree=${root}`,
    // tini as PID 1, so the many processes each Electron leaves behind are reaped.
    '--init',
    // Chromium keeps its shared memory in /dev/shm; Docker's default 64 MB isn't enough for a browser.
    '--shm-size', '2g',
    // No core dumps. WSL 2 pipes every Linux crash, a container's included, to Windows' %TEMP%\wsl-crashes,
    // and a renderer's core can be gigabytes (two forced crashes filled a disk). The kernel ignores a
    // limit of 0 for a piped core_pattern; 1 is the value that makes it give up on the dump.
    '--ulimit', 'core=1:1',
    // Chromium's sandbox. On Linux it puts each renderer in new user, PID and network namespaces,
    // which an ordinary desktop user may create (and seccomp-bpf on top). The container allows the
    // same and nothing more:
    // - An unprivileged user (chord, uid 1000) with no capabilities at all, and no-new-privileges, so
    //   no setuid binary can get any back. That rules out chrome-sandbox, the setuid fallback, too: if
    //   namespaces didn't work, Chromium would refuse to start rather than run unsandboxed.
    // - seccomp=unconfined, because Docker's default profile allows the namespace flags of clone and
    //   unshare only to containers holding CAP_SYS_ADMIN. The alternatives are worse: CAP_SYS_ADMIN
    //   (Puppeteer's advice) is a privilege nothing here needs; the well-known chrome.json profile is
    //   unmaintained and blocks syscalls newer than it with EPERM (clone3, which glibc only falls
    //   back from on ENOSYS); a copy of Docker's own profile with those flags allowed is 800 lines to
    //   keep in step with Docker. Chromium installs its own seccomp-bpf filters on renderers either way.
    // - Nothing to do for AppArmor: WSL 2's kernel has none, so unprivileged user namespaces aren't
    //   restricted (CI's Ubuntu 24.04 runners need kernel.apparmor_restrict_unprivileged_userns=0).
    '--user', 'chord',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--security-opt', 'seccomp=unconfined',
    '--volume', `${STORE_VOLUME}:/home/chord/.cache/pnpm-store`,
    '--volume', `${ELECTRON_VOLUME}:/home/chord/.cache/electron`,
    '--env', `CHORD_E2E_DISPLAY=${display}`,
    '--env', `CHORD_E2E_STARTED=${Math.round(startedAt / 1000)}`,
    ...PASSED_ENV.filter((key) => env[key]).flatMap((key) => ['--env', `${key}=${env[key]}`]),
    image,
    'bash', '-c', 'tar -xf - -C /work && exec bash /work/scripts/e2e-linux/in-container.sh "$@"', 'bash',
    ...playwright,
  ];
}

/* ---------- tar ---------- */

const octal = (header, offset, length, value) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
const padding = (length) => Buffer.alloc((512 - (length % 512)) % 512);

function tarHeader(path, { size = 0, mode = 0o644, mtime = 0, type = '0', link = '' }) {
  const header = Buffer.alloc(512);
  // ustar holds up to 255 bytes of path, as a prefix and a name split at a slash. A longer path, or
  // one that isn't ASCII (ustar has no encoding; pax is UTF-8), goes in a pax header before the entry.
  const bytes = Buffer.byteLength(path);
  const ascii = bytes === path.length;
  const cut = bytes > 100 ? path.lastIndexOf('/', 155) : -1;
  const split = ascii && cut > 0 && path.slice(cut + 1).length <= 100;
  const [prefix, name] = !ascii ? ['', 'pax-path'] : bytes <= 100 ? ['', path] : split ? [path.slice(0, cut), path.slice(cut + 1)] : ['', 'long-path'];
  header.write(name, 0, 100);
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 1000);
  octal(header, 116, 8, 1000);
  octal(header, 124, 12, size);
  octal(header, 136, 12, mtime);
  header.fill(' ', 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(link, 157, 100);
  header.write('ustar\u000000', 257, 8, 'ascii');
  header.write('chord', 265, 32);
  header.write('chord', 297, 32);
  header.write(prefix, 345, 155);
  octal(header, 148, 7, header.reduce((sum, byte) => sum + byte, 0));
  if (ascii && (bytes <= 100 || split)) return [header];
  // A pax record is "<its own length in bytes> path=<path>\n".
  const record = ` path=${path}\n`;
  let length = Buffer.byteLength(record);
  while (String(length).length + Buffer.byteLength(record) !== length) length = String(length).length + Buffer.byteLength(record);
  const pax = Buffer.from(`${length}${record}`);
  return [...tarHeader('pax-header', { size: pax.length, type: 'x' }), pax, padding(pax.length), header];
}

/**
 * A tar archive of files ({ path, body, mode, mtime }) and symlinks ({ path, link }),
 * owned by uid 1000. Parent folders aren't listed: tar makes them as it unpacks.
 */
export function tarArchive(entries) {
  const chunks = [];
  for (const { path, body, link, mode = 0o644, mtime = 0 } of entries) {
    if (link !== undefined) chunks.push(...tarHeader(path, { type: '2', link, mode: 0o777, mtime }));
    else chunks.push(...tarHeader(path, { size: body.length, mode, mtime }), body, padding(body.length));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/* ---------- The run ---------- */

async function main() {
  const startedAt = Date.now();
  const log = (message) => console.log(`[e2e-linux] ${message} (${Math.round((Date.now() - startedAt) / 1000)} s)`);
  const fail = (message) => {
    console.error(`[e2e-linux] ${message}`);
    process.exit(1);
  };

  const here = import.meta.dirname;
  const root = resolve(here, '../..');
  const appDir = join(root, 'apps', 'desktop');
  const onWindows = process.platform === 'win32';
  const distro = process.env['CHORD_E2E_WSL_DISTRO'];
  const wsl = (args) => ['wsl.exe', [...(distro ? ['-d', distro] : []), '-e', ...args]];

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readFileSync(import.meta.filename, 'utf8').split('\nimport ')[0].replace(/^#!.*\n/, '').replaceAll(/^\/\/ ?/gm, ''));
    return 0;
  }

  // Every spawn has windowsHide: started without a console (an editor's task, a background shell),
  // each wsl.exe and git would flash a console window of its own.
  /** docker, through WSL on Windows. */
  const dockerCommand = (args) => (onWindows ? wsl(['docker', ...args]) : ['docker', args]);
  /** A short docker command: its output, or null when it fails. */
  const docker = (args, { quiet = false } = {}) => {
    const [command, argv] = dockerCommand(args);
    const result = spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true, stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'] });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  /**
   * A long docker command fed `input`, its output shown as it comes: its exit code. The output is
   * passed on rather than inherited because wsl.exe writes each stream at file offsets of its own,
   * so with both sent to one file (> log 2>&1) stderr overwrote stdout.
   */
  const dockerLive = (args, input) => {
    const [command, argv] = dockerCommand(args);
    const child = spawn(command, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.stdin.on('error', () => {}); // The container can exit (a bad image, say) before reading it all.
    child.stdin.end(input);
    return new Promise((done) => child.on('close', (status, signal) => done(signal ? 128 : (status ?? 1))));
  };
  /** Where Docker sees a host path: under /mnt in WSL. */
  const dockerPath = (path) => {
    if (!onWindows) return path;
    const [command, argv] = wsl(['wslpath', '-a', path]);
    const result = spawnSync(command, argv, { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) fail(`WSL can't see ${path}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  const git = (args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 << 20, windowsHide: true });
    if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };

  if (!docker(['version', '--format', '{{.Server.Version}}'], { quiet: true })) {
    fail(
      onWindows
        ? `Docker isn't reachable in WSL${distro ? ` (${distro})` : ''}. It needs a WSL 2 distro running Docker Engine, with your user in its docker group; set CHORD_E2E_WSL_DISTRO if that isn't WSL's default distro.`
        : "Docker isn't reachable: is it installed and running?",
    );
  }

  // Each container holds a copy of a tree with its node_modules and build: sweep up any a killed run left.
  const runs = docker(['ps', '--all', '--quiet', '--filter', 'label=chord-e2e=run'], { quiet: true })?.split(/\s+/).filter(Boolean) ?? [];
  const stale = runs.length ? staleRuns(docker(['inspect', '--format', '{{.Name}}|{{.State.Status}}|{{.State.FinishedAt}}|{{.Created}}', ...runs], { quiet: true }) ?? '') : [];
  if (stale.length) {
    docker(['rm', '--force', ...stale], { quiet: true });
    log(`Removed what killed runs left: ${stale.join(', ')}`);
  }

  // The image: built once per version of the Dockerfile. It copies nothing in, so it needs no context.
  const dockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8');
  const pnpmVersion = /^pnpm@(.+)$/.exec(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager ?? '')?.[1];
  if (!pnpmVersion) fail('The root package.json names no pnpm version in packageManager');
  const image = imageTag(dockerfile, pnpmVersion);
  const haveImage = () => docker(['image', 'inspect', '--format', '{{.Id}}', image], { quiet: true }) !== null;
  if (options.rebuild || !haveImage()) {
    log(`Building ${image} (once per change to scripts/e2e-linux/Dockerfile)`);
    const build = ['build', ...(options.rebuild ? ['--pull', '--no-cache'] : []), '--build-arg', `PNPM_VERSION=${pnpmVersion}`, '--tag', image, '-'];
    if ((await dockerLive(build, dockerfile)) !== 0) {
      // Two runs that start together both build; the one that tags second fails with "already exists".
      if (!haveImage()) fail(`Building ${image} failed`);
      log(`Another run built ${image} first`);
    }
  }

  // The working tree: tracked files and untracked ones that aren't ignored, as they are on disk.
  // git's index says which are executables and symlinks, which a Windows checkout can't show.
  const indexModes = new Map(
    git(['ls-files', '--stage', '-z'])
      .split('\0')
      .filter(Boolean)
      .map((entry) => [entry.slice(entry.indexOf('\t') + 1), entry.split(' ')[0]]),
  );
  const entries = [];
  for (const path of new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))) {
    const full = join(root, path);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (!stat) continue; // Deleted in the working tree.
    const mtime = Math.floor(stat.mtimeMs / 1000);
    const recorded = indexModes.get(path);
    if (stat.isSymbolicLink()) entries.push({ path, link: readlinkSync(full), mtime });
    else if (recorded === '120000' && stat.isFile()) entries.push({ path, link: readFileSync(full, 'utf8'), mtime });
    else if (stat.isFile()) {
      const executable = recorded ? recorded === '100755' : !onWindows && (stat.mode & 0o111) !== 0;
      entries.push({ path, body: readFileSync(full), mode: executable ? 0o755 : 0o644, mtime });
    }
    // Anything else is a submodule's folder, which isn't part of this tree.
  }
  const tar = tarArchive(entries);
  log(`Copying ${entries.length} files (${(tar.length / 1e6).toFixed(1)} MB) from ${root}`);

  const name = containerName(root);
  let removed = false;
  const removeContainer = () => {
    if (removed) return;
    removed = true;
    docker(['rm', '--force', name], { quiet: true });
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      console.error(`[e2e-linux] ${signal}: removing ${name}`);
      removeContainer();
      process.exit(130);
    });
  }

  const where = options.display === 'x11' ? 'X11 (Xvfb with openbox)' : 'Wayland (headless Weston)';
  log(`Running in ${name} on ${where}${options.playwright.length ? `: playwright test ${options.playwright.join(' ')}` : ''}`);
  const code = await dockerLive(dockerRunArgs({ name, image, display: options.display, root, startedAt, playwright: options.playwright, env: process.env }), tar);

  // Results, back where a local run leaves them. A folder the run didn't write isn't touched.
  const appInDocker = dockerPath(appDir);
  const copied = [];
  for (const output of OUTPUTS) {
    const staging = `${output}.e2e-linux-copy`;
    rmSync(join(appDir, staging), { recursive: true, force: true });
    if (docker(['cp', `${name}:/work/apps/desktop/${output}`, `${appInDocker}/${staging}`], { quiet: true }) === null) continue;
    rmSync(join(appDir, output), { recursive: true, force: true });
    renameSync(join(appDir, staging), join(appDir, output));
    copied.push(`apps/desktop/${output}`);
  }
  if (copied.length) log(`Copied ${copied.join(', ')} back`);
  else if (existsSync(join(appDir, 'test-results'))) log('The run wrote no results; apps/desktop/test-results is an earlier run’s');

  removeContainer();
  log(code === 0 ? 'Passed' : `Failed (exit ${code})`);
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
