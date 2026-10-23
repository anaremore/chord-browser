// Makes Chord's update-signing key pair (ARCHITECTURE.md §14.4,
// docs/releasing/patch-runbook.md "Update signing key"). Prints both halves; writes
// nothing to disk, so the private half never lands in a file by accident.
//
//   node apps/desktop/scripts/update-key.mjs
//
// The private half goes into the GitHub secret CHORD_UPDATE_SIGNING_KEY (in the
// `release` environment). The public half goes into src/main/update-key.ts.
import { createHash, generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

console.log(`Public key (fingerprint ${fingerprint}). Paste it into apps/desktop/src/main/update-key.ts:\n`);
console.log(publicPem);
console.log('Private key. Paste it into the CHORD_UPDATE_SIGNING_KEY secret, then clear your terminal. Never commit it:\n');
console.log(privatePem);
