/**
 * The assistant's acting in a preview installer (S18 M2e): only a build made with CHORD_PREVIEW_ACTING=1 (the
 * chord-preview skill) turns it on before its release flag; a release never does.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Acting in a preview installer, never in a release (S18 M2e)', () => {
  it('the build turns it on only for CHORD_PREVIEW_ACTING=1, and no workflow sets it', () => {
    expect(read('apps/desktop/electron.vite.config.ts')).toContain("__CHORD_PREVIEW_ACTING__: JSON.stringify(process.env['CHORD_PREVIEW_ACTING'] === '1')");
    for (const workflow of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) expect(read(workflow), workflow).not.toContain('CHORD_PREVIEW_ACTING');
  });

  it('a packaged build acts only with the preview define or the release flag; a development build always', async () => {
    // [packaged, the preview define, what the build does]
    const rows: [boolean, boolean | undefined, boolean][] = [
      [true, undefined, false],
      [true, false, false],
      [true, true, true],
      [false, undefined, true],
    ];
    for (const [packaged, preview, acts] of rows) {
      vi.resetModules();
      vi.doMock('electron', () => ({ app: { isPackaged: packaged } }));
      vi.doMock('@chord/core', async () => ({ ...(await vi.importActual<Record<string, unknown>>('@chord/core')), ASSISTANT_ACTING_RELEASED: false }));
      if (preview === undefined) delete (globalThis as { __CHORD_PREVIEW_ACTING__?: boolean }).__CHORD_PREVIEW_ACTING__;
      else (globalThis as { __CHORD_PREVIEW_ACTING__?: boolean }).__CHORD_PREVIEW_ACTING__ = preview;
      const { buildActs } = await import('../../src/main/assistant/preview');
      expect(buildActs(), `packaged ${packaged}, preview ${String(preview)}`).toBe(acts);
    }
    delete (globalThis as { __CHORD_PREVIEW_ACTING__?: boolean }).__CHORD_PREVIEW_ACTING__;
  });
});
