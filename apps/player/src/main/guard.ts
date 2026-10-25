/**
 * Imported first: an uncaught error or rejection in the player's main
 * process logs and exits, so Electron never shows its "JavaScript error" box
 * (a native dialog that beeps on Windows), and a broken player never lingers.
 * Chord sees the channel close and the tab's "Playing in Chord Player" ends.
 */
import { app } from 'electron';

function fail(kind: string) {
  return (error: unknown) => {
    try {
      console.error(`[chord-player] ${kind}:`, (error as Error)?.stack ?? error);
    } finally {
      app.exit(70);
    }
  };
}

process.on('uncaughtException', fail('uncaught exception'));
process.on('unhandledRejection', fail('unhandled rejection'));
