/**
 * The public half of Chord's update-signing key (ARCHITECTURE.md §14.4), in
 * PEM. An installed Chord installs an update only when the release's manifest
 * carries a valid Ed25519 signature from the matching private key, which lives
 * only in the release workflow's `CHORD_UPDATE_SIGNING_KEY` secret.
 *
 * Made 2026-10-25; fingerprint 0376333e86170a62 (the first 16 hex digits of
 * the SHA-256 of its DER). Empty would mean every copy stays notify-only.
 * docs/releasing/patch-runbook.md ("Update signing key") says how to make one,
 * and how to rotate it.
 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA574ehWKrNoRKVd0mWVWykDSahuaXYuFReJ+s8fmPCiA=
-----END PUBLIC KEY-----
`;
