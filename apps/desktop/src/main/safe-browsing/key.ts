/**
 * Google's Safe Browsing API key, put in at build time from the
 * `CHORD_SAFE_BROWSING_KEY` environment variable (electron.vite.config.ts).
 * Release builds get it from the `release` environment's secret of the same
 * name; development, CI and forks build without one, and then Safe Browsing
 * is unavailable and Chord never contacts the service. The key is never
 * logged, and only ever sent to Google, in a header.
 */
declare const __CHORD_SAFE_BROWSING_KEY__: string | undefined;

export const SAFE_BROWSING_KEY: string = typeof __CHORD_SAFE_BROWSING_KEY__ === 'string' ? __CHORD_SAFE_BROWSING_KEY__.trim() : '';
