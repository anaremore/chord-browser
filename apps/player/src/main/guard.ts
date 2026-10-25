/**
 * Imported first: an uncaught error or rejection in the player's main
 * process logs and exits, so Electron never shows its "JavaScript error" box
 * (a native dialog that beeps on Windows), and a broken player never lingers.
 * Chord sees the channel close and the tab's "Playing in Chord Player" ends.
 * The message is written synchronously: a pipe's console output is
 * asynchronous on macOS and Linux, and would be lost as the process exits.
 */
import { app } from 'electron';
import { writeSync } from 'node:fs';

function fail(kind: string) {
  return (error: unknown) => {
    try {
      writeSync(2, `[chord-player] ${kind}: ${String((error as Error)?.stack ?? error)}\n`);
    } catch {
      // No stderr to write to.
    } finally {
      app.exit(70);
    }
  };
}

process.on('uncaughtException', fail('uncaught exception'));
process.on('unhandledRejection', fail('unhandled rejection'));
