/**
 * The public half of Chord's update-signing key (ARCHITECTURE.md §14.4), in
 * PEM. An installed Chord installs an update only when the release's manifest
 * carries a valid Ed25519 signature from the matching private key, which lives
 * only in the release workflow's `CHORD_UPDATE_SIGNING_KEY` secret.
 *
 * Empty means no key has been made yet: every copy stays notify-only.
 * docs/releasing/patch-runbook.md ("Update signing key") says how to make one.
 */
export const UPDATE_PUBLIC_KEY = '';
