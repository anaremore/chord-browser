// Signs a release's update manifests (ARCHITECTURE.md §14.4). For each
// manifest Chord installs from (latest-win-<arch>.yml, latest-linux*.yml) in
// the folder, writes <manifest>.sig: the base64 Ed25519 signature of the file's
// exact bytes. The release workflow runs it with the private key from the
// CHORD_UPDATE_SIGNING_KEY secret.
//
//   CHORD_UPDATE_SIGNING_KEY="$(cat key.pem)" node apps/desktop/scripts/sign-update-manifests.mjs dist
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const folder = process.argv[2];
const pem = process.env.CHORD_UPDATE_SIGNING_KEY ?? '';
if (!folder) {
  console.error('Usage: sign-update-manifests.mjs <folder>');
  process.exit(2);
}
if (!pem.trim()) {
  console.error('CHORD_UPDATE_SIGNING_KEY is empty: nothing signed.');
  process.exit(1);
}

const privateKey = createPrivateKey(pem);
if (privateKey.asymmetricKeyType !== 'ed25519') {
  console.error(`CHORD_UPDATE_SIGNING_KEY is a ${privateKey.asymmetricKeyType} key; Chord's update key is Ed25519.`);
  process.exit(1);
}
const publicKey = createPublicKey(privateKey);
const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

const manifests = readdirSync(folder).filter((name) => /^latest-(win-(x64|arm64)|linux(-arm64)?)\.yml$/.test(name));
if (manifests.length === 0) {
  console.error(`No update manifests in ${folder}.`);
  process.exit(1);
}
for (const name of manifests) {
  const bytes = readFileSync(join(folder, name));
  const signature = sign(null, bytes, privateKey);
  // Check it the way Chord will, before it ships.
  if (!verify(null, bytes, publicKey, signature)) throw new Error(`Signing ${name} didn't verify`);
  writeFileSync(join(folder, `${name}.sig`), `${signature.toString('base64')}\n`);
  console.log(`Signed ${name} (key ${fingerprint})`);
}
