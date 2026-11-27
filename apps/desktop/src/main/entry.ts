/**
 * Main's entry: `chord mcp` (S18, the stdio relay for outside agents) or the browser.
 * It has to choose before anything else loads: the browser's main (index.ts) takes
 * the single-instance lock and opens windows, and the relay must do neither.
 */
import { resolve } from 'node:path';
import { isMcpArgv } from '@chord/core/agent-tools';
import { app } from 'electron';
// Development and tests: the E2E harness's gate, there before index.ts loads (#321).
import './first-pages-gate';

// Packaged: [Chord, …args]. Development: [electron, …Electron's switches, the app's folder, …args].
const args = process.argv.slice(1).filter((arg) => app.isPackaged || arg.startsWith('-') || resolve(arg) !== app.getAppPath());
if (isMcpArgv(args)) void import('./agents/mcp-main');
else void import('./index');
