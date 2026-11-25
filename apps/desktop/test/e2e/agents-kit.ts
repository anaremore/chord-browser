/**
 * What an agent's E2E needs (S18): Chord with its endpoint on, `chord mcp` (the relay) started as an agent starts it,
 * the connect card and the first action's site card answered as you would, and a snapshot's refs by their line.
 * agents-spa.spec.ts uses these; agents.spec.ts has its own copies until it moves over (it's being changed by #117).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { watchForMainErrors } from './main-errors';
import { isPopover, pageWhere } from './a11y-kit';

const appDir = resolve(import.meta.dirname, '../..');

type Hooks = { chordTestHooks: { agents(): Promise<{ serving: string | null; connections: number; restricted: number | null }> } };

/** Chord on a throwaway profile, with the E2E hooks. */
export async function launch(profile: string, env: Record<string, string>): Promise<ElectronApplication> {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, CHORD_E2E_HOOKS: '1', ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
}

/** Whether Chord serves its endpoint yet (the hooks are set once main has started its services). */
export async function serving(app: ElectronApplication): Promise<string | null> {
  await expect.poll(() => app.evaluate(() => Boolean((globalThis as unknown as Partial<Hooks>).chordTestHooks))).toBe(true);
  return (await app.evaluate(() => (globalThis as unknown as Hooks).chordTestHooks.agents())).serving;
}

/** The development build's executable: the electron package's main export is its path. */
function resolveElectron(): string {
  return process.getBuiltinModule('module').createRequire(join(appDir, 'package.json'))('electron') as string;
}

export const CODEX = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.160.1' } };

/** `chord mcp`, as an agent starts it (the profile by CHORD_USER_DATA, as in development), and calls through it. */
export function relay(profile: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile };
  delete env['ELECTRON_RUN_AS_NODE'];
  const child: ChildProcess = spawn(resolveElectron(), [appDir, ...(process.platform === 'linux' ? ['--ozone-platform=headless'] : []), 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<number, (m: { result: Record<string, unknown> }) => void>();
  let buffer = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) {
        const m = JSON.parse(line) as { id: number; result: Record<string, unknown> };
        waiting.get(m.id)?.(m);
      }
    }
  });
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<{ result: Record<string, unknown> }>((done) => {
      const n = ++id;
      waiting.set(n, done);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await request('tools/call', { name, arguments: args });
    const content = r.result['content'] as { text: string }[];
    return { isError: r.result['isError'], text: content[0]!.text };
  };
  return { child, request, call, exited: new Promise<number | null>((done) => child.once('exit', (code) => done(code))) };
}

/** Answer a card in the window's popover as you would: once it's shown (its buttons wait a moment before they take a click). */
async function press(app: ElectronApplication, card: (popover: Page) => ReturnType<Page['getByRole']>, button: string): Promise<void> {
  const popover = await pageWhere(app, isPopover);
  const shown = card(popover);
  await expect(shown).toBeVisible({ timeout: 15_000 });
  await popover.waitForTimeout(600);
  await shown.getByRole('button', { name: button, exact: true }).click();
  await expect(shown).toHaveCount(0);
}

/** The connect card: "<name> wants to use Chord". */
export const answerConnect = (app: ElectronApplication, name: string, button: 'Deny' | 'Allow once' | 'Always allow') =>
  press(app, (popover) => popover.getByRole('alertdialog', { name: `${name} wants to use Chord` }), button);

/** The first action on a site: "Let <name> click and type on <site>?". */
export const answerSite = (app: ElectronApplication, name: string, button: 'Allow for now') =>
  press(app, (popover) => popover.getByRole('alertdialog', { name: new RegExp(`^Let ${name} click and type on `) }), button);

/** A ref from a snapshot's outline, by its line's start (`button "Save profile"`). */
export function refOf(outline: string, line: string): string {
  const found = outline.split('\n').find((l) => l.trim().startsWith(`- ${line} [ref=`));
  if (!found) throw new Error(`No "${line}" in\n${outline}`);
  return /\[ref=(e\d+)\]/.exec(found)![1]!;
}
