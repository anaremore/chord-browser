// Regenerates types/ (committed) from src/ after a change to the vendored code.
// Chord's own typecheck reads these declarations rather than the vendored
// source, which follows upstream's compiler settings, not Chord's stricter ones.
// Run: pnpm --filter @chord/chrome-extensions types
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const here = import.meta.dirname;
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
rmSync(join(here, 'types'), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [tsc, '-p', 'tsconfig.json', '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--rootDir', 'src', '--outDir', 'types'],
  { cwd: here, stdio: 'inherit' },
);
// The declarations use Chrome's extension types (the global `chrome` namespace).
const index = join(here, 'types', 'index.d.ts');
writeFileSync(index, `/// <reference types="chrome" />\n${readFileSync(index, 'utf8')}`);
