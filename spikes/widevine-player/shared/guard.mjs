// Imported first by every Electron entry point of the spike: an uncaught error
// or rejection logs and exits, so Electron never shows its error dialog (no
// native modal dialogs, ever). A hard timeout stops a stuck run the same way.
import electron from 'electron';

const { app } = electron;

function die(kind) {
  return (error) => {
    try {
      console.error(`[guard] ${kind}:`, error?.stack ?? error);
    } finally {
      app.exit(70);
    }
  };
}

process.on('uncaughtException', die('uncaughtException'));
process.on('unhandledRejection', die('unhandledRejection'));

/** Exits with code 2 after `ms`, whatever is going on. */
export function deadline(ms, label) {
  const timer = setTimeout(() => {
    console.error(`[guard] ${label}: timed out after ${ms} ms`);
    app.exit(2);
  }, ms);
  timer.unref();
  return timer;
}
