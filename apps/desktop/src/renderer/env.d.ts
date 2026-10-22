import type { ShellApi } from '@chord/ipc';

declare global {
  interface Window {
    /** Exposed by the shell preload (src/preload/shell.ts). */
    readonly chord: ShellApi;
  }
}

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
