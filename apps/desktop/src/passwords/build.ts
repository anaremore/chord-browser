/**
 * Builds the passwords agent (S17 §4) into one self-contained script: an IIFE with the
 * classifier from @chord/core compiled in, as `executeJavaScriptInIsolatedWorld` runs it.
 * Used by the build (electron.vite.config.ts emits it as out/main/passwords/agent.js, which
 * main reads the first time a sentinel asks) and by the corpus suite (test/forms), which runs
 * the same scan and classifier in Playwright's Chromium.
 */
import { rolldown } from 'rolldown';

/**
 * The agent's source from `entry` (src/passwords/agent/index.ts; the corpus suite passes its own),
 * minified unless `minify` is false. The entry is always given: the build config that calls this
 * is itself bundled, so this file can't find its own folder.
 */
export async function bundleAgent(options: { entry: string; minify?: boolean; name?: string }): Promise<string> {
  const bundle = await rolldown({
    input: options.entry,
    platform: 'browser',
    // Nothing in core's password modules or the agent runs on import but the agent's own entry.
    treeshake: { moduleSideEffects: (id) => !/[\\/]packages[\\/]core[\\/]/.test(id) },
    logLevel: 'warn',
  });
  try {
    const { output } = await bundle.generate({ format: 'iife', name: options.name, minify: options.minify ?? true, codeSplitting: false });
    return output[0].code;
  } finally {
    await bundle.close();
  }
}
