// Chooses how the release workflow signs one build (docs/releasing/signing.md).
// Signing turns on by itself once every secret it needs is in the protected
// `release` environment. Until then builds are unsigned, as before. A set that's
// only partly there is a mistake, so it fails instead of quietly building unsigned.
//
// The workflow passes only whether each secret or variable is set
// (HAS_<NAME>=true|false), never its value, plus:
//   PLATFORM         mac | win | linux
//   IS_TAG           true for a v* tag build
//   REQUIRE_SIGNING  the CHORD_REQUIRE_SIGNING variable: once releases are signed, a tag
//                    build that would come out unsigned fails (signed copies on Windows
//                    refuse unsigned updates, ARCHITECTURE.md §14.4)
// It appends CHORD_SIGNING=<mode> to $GITHUB_ENV, which electron-builder.config.ts reads:
//   none | developer-id | artifact-signing | certificate
import { appendFileSync } from 'node:fs';

/** Each platform's ways to sign, preferred first, with the names each needs. */
const WAYS = {
  mac: [{ mode: 'developer-id', label: 'Developer ID signing and notarization', names: ['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] }],
  win: [
    {
      mode: 'artifact-signing',
      label: 'Azure Artifact Signing',
      names: ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'WIN_PUBLISHER_NAME'],
    },
    { mode: 'certificate', label: 'a .pfx certificate', names: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'] },
  ],
  linux: [],
};

const env = process.env;
const platform = env.PLATFORM ?? '';
const has = (name) => env[`HAS_${name}`] === 'true';

function fail(message) {
  console.log(`::error title=Signing::${message}`);
  process.exit(1);
}

if (!(platform in WAYS)) fail(`PLATFORM is '${platform}'; expected mac, win or linux.`);
const ways = WAYS[platform];
const ready = ways.find((way) => way.names.every(has));
// WIN_PUBLISHER_NAME is also an optional setting for a certificate, so on its own it doesn't make a set.
const partial = ways.filter((way) => way !== ready && way.names.some((name) => name !== 'WIN_PUBLISHER_NAME' && has(name)));

let mode = 'none';
if (ready) {
  mode = ready.mode;
  console.log(`Signing with ${ready.label}.`);
  for (const way of partial) console.log(`::warning title=Signing::Only some of ${way.label}'s secrets are set; signing with ${ready.label} instead.`);
} else if (partial.length > 0) {
  const way = partial[0];
  fail(`${way.label} is half set up: ${way.names.filter((name) => !has(name)).join(', ')} missing from the release environment. Add them, or remove the rest to build unsigned.`);
} else if (ways.length > 0 && env.IS_TAG === 'true' && env.REQUIRE_SIGNING === 'true') {
  fail('CHORD_REQUIRE_SIGNING is on, but no signing secrets reached this build. Copies already installed would refuse an unsigned update.');
} else if (ways.length > 0) {
  console.log('No signing secrets: building unsigned, with an ad-hoc signature on macOS.');
}

if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `CHORD_SIGNING=${mode}\n`);
else console.log(`CHORD_SIGNING=${mode}`);
