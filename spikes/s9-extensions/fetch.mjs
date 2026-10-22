// Spike S9, step 1: download extensions from the Chrome Web Store the way
// Chrome does, verify the CRX3 signatures, and unpack them for
// `session.extensions.loadExtension` (which only takes unpacked folders).
//
// Run: node spikes/s9-extensions/fetch.mjs
// Output: spikes/s9-extensions/.cache/{crx,ext}/<id> (gitignored) and
//         spikes/s9-extensions/results/fetch.json
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const here = import.meta.dirname;
const cache = join(here, '.cache');
const out = join(here, 'results');

// Electron 45's Chromium. The store serves the build that this version supports.
const PRODVERSION = '156.0.8078.48';

export const EXTENSIONS = {
  ddkjiahejlhfcafbddmgiahcphecmpfh: 'uBlock Origin Lite',
  eimadpbcbfnmbkopoojfekhnkhdbieeh: 'Dark Reader',
  nngceckbapebfimnlniiiahkandclblb: 'Bitwarden',
  aeblfdkhhhdcdjpifhhbdiojplfjncoa: '1Password',
  ghmbeldphafepmbegfdlkpapadhbakde: 'Proton Pass',
  aapbdbdomjkkjkaonfhkkikfgjllcleb: 'Google Translate',
};

// SHA-256 of the Chrome Web Store's publisher key ("ecdsa_2017_public"),
// from components/crx_file/crx_verifier.cc. Every store-published CRX carries
// a proof signed by this key in addition to the developer's own.
const PUBLISHER_KEY_HASH = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf';
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'latin1');

/** Extension IDs are the first 128 bits of SHA-256(SPKI), hex digits mapped to a–p. */
export function idFromKey(spki) {
  const hex = createHash('sha256').update(spki).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** Just enough protobuf: length-delimited fields by number, everything else skipped. */
function protoFields(buf) {
  const fields = [];
  let i = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint');
      const b = buf[i++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const len = Number(varint());
      if (i + len > buf.length) throw new Error('truncated field');
      fields.push({ field, bytes: buf.subarray(i, i + len) });
      i += len;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

/**
 * Verify a CRX3 the way Chromium's crx_verifier.cc does: every proof must
 * verify over [context][signed-header-size][signed-header][archive], one key
 * must hash to the declared ID (the developer key), and one must be the
 * store's publisher key.
 */
export function verifyCrx3(crx, expectedId) {
  if (crx.toString('latin1', 0, 4) !== 'Cr24') throw new Error('not a CRX');
  const version = crx.readUInt32LE(4);
  if (version !== 3) throw new Error(`CRX version ${version} (only CRX3 is accepted)`);
  const headerSize = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerSize);
  const archive = crx.subarray(12 + headerSize);
  // Chromium refuses headers containing ZIP end-of-directory tokens.
  for (const token of ['PK\x05\x06', 'PK\x06\x07', 'PK\x06\x06']) {
    if (header.includes(Buffer.from(token, 'latin1'))) throw new Error('ZIP token inside CRX header');
  }
  const fields = protoFields(header);
  const signedHeader = fields.find((f) => f.field === 10000)?.bytes;
  if (!signedHeader) throw new Error('no signed header');
  const crxIdBytes = protoFields(signedHeader).find((f) => f.field === 1)?.bytes;
  if (!crxIdBytes || crxIdBytes.length !== 16) throw new Error('no crx_id');
  const declaredId = [...crxIdBytes.toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

  const sizeLe = Buffer.alloc(4);
  sizeLe.writeUInt32LE(signedHeader.length);
  const signedData = Buffer.concat([SIGNATURE_CONTEXT, sizeLe, signedHeader, archive]);

  const proofs = [];
  for (const f of fields.filter((x) => x.field === 2 || x.field === 3)) {
    const parts = protoFields(f.bytes);
    const spki = parts.find((p) => p.field === 1)?.bytes;
    const sig = parts.find((p) => p.field === 2)?.bytes;
    if (!spki || !sig) throw new Error('incomplete proof');
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const kind = f.field === 2 ? 'rsa' : 'ecdsa';
    if ((kind === 'rsa') !== (key.asymmetricKeyType === 'rsa')) throw new Error('proof/key type mismatch');
    const ok = verify('sha256', signedData, key, sig); // PKCS#1 v1.5 for RSA, DER for ECDSA
    proofs.push({
      kind,
      ok,
      developerKey: idFromKey(spki) === declaredId,
      publisherKey: createHash('sha256').update(spki).digest('hex') === PUBLISHER_KEY_HASH,
      spki,
    });
  }
  const developer = proofs.find((p) => p.developerKey);
  const result = {
    declaredId,
    proofs: proofs.map(({ kind, ok, developerKey, publisherKey }) => ({ kind, ok, developerKey, publisherKey })),
    allSignaturesValid: proofs.length > 0 && proofs.every((p) => p.ok),
    hasDeveloperProof: Boolean(developer),
    hasPublisherProof: proofs.some((p) => p.publisherKey && p.ok),
    idMatchesRequest: declaredId === expectedId,
  };
  result.verified = result.allSignaturesValid && result.hasDeveloperProof && result.hasPublisherProof && result.idMatchesRequest;
  return { ...result, archive, publicKey: developer?.spki };
}

/** Minimal ZIP reader (stored + deflate, no ZIP64) that refuses paths escaping `dest`. */
export function extractZip(zip, dest) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const root = resolve(dest) + sep;
  let files = 0;
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new Error('ZIP64 not supported');
    if (name.endsWith('/')) continue;
    const target = resolve(dest, name);
    if (!target.startsWith(root)) throw new Error(`path escapes destination: ${name}`);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported compression ${method} for ${name}`);
    if (data.length !== usize) throw new Error(`size mismatch for ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    files++;
  }
  return files;
}

/** The update check Chrome sends (gupdate XML): latest version, CRX URL and its SHA-256. */
async function updateCheck(id) {
  const x = new URLSearchParams({ id, v: '0.0.0.0', installsource: 'ondemand', uc: '' }).toString();
  const url = `https://clients2.google.com/service/update2/crx?prodversion=${PRODVERSION}&acceptformat=crx3&x=${encodeURIComponent(x)}`;
  const xml = await (await fetch(url)).text();
  const attr = (name) => xml.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
  return { status: attr('status'), version: attr('version'), codebase: attr('codebase')?.replaceAll('&amp;', '&') ?? null, sha256: attr('hash_sha256') };
}

async function main() {
  mkdirSync(out, { recursive: true });
  const results = [];
  for (const [id, label] of Object.entries(EXTENSIONS)) {
    const r = { id, label };
    try {
      const update = await updateCheck(id);
      r.update = { status: update.status, version: update.version, hasSha256: Boolean(update.sha256) };
      if (!update.codebase) throw new Error(`no codebase in update response (status ${update.status})`);
      const response = await fetch(update.codebase);
      if (!response.ok) throw new Error(`download ${response.status}`);
      const crx = Buffer.from(await response.arrayBuffer());
      r.crxBytes = crx.length;
      r.sha256MatchesUpdateResponse = update.sha256 ? createHash('sha256').update(crx).digest('hex') === update.sha256 : null;
      const crxDir = join(cache, 'crx');
      mkdirSync(crxDir, { recursive: true });
      writeFileSync(join(crxDir, `${id}.crx`), crx);

      const v = verifyCrx3(crx, id);
      const { archive, publicKey, ...summary } = v;
      r.signature = summary;
      if (!v.verified) throw new Error('CRX failed verification; not unpacking');

      const dest = join(cache, 'ext', id);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      r.files = extractZip(archive, dest);
      // Keep the store ID: Electron derives the ID from `key` if present, else from the path.
      const manifestPath = join(dest, 'manifest.json');
      // Some manifests start with a byte-order mark, which JSON.parse rejects (\s matches U+FEFF).
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\s+/, ''));
      manifest.key = publicKey.toString('base64');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      r.name = manifest.name;
      r.version = manifest.version;
      r.manifestVersion = manifest.manifest_version;
      r.permissions = manifest.permissions ?? [];
      r.optionalPermissions = manifest.optional_permissions ?? [];
      r.hostPermissions = manifest.host_permissions ?? [];
      r.background = manifest.background ?? null;
      r.action = manifest.action ?? manifest.browser_action ?? null;
      r.optionsPage = manifest.options_ui?.page ?? manifest.options_page ?? null;
      r.contentScripts = (manifest.content_scripts ?? []).length;
      r.commands = Object.keys(manifest.commands ?? {});
      r.dnrRulesets = (manifest.declarative_net_request?.rule_resources ?? []).map((x) => ({ id: x.id, enabled: x.enabled }));
      r.ok = true;
    } catch (error) {
      r.ok = false;
      r.error = String(error?.message ?? error);
    }
    console.log('[S9 fetch]', id, r.label, r.ok ? `${r.version} verified` : r.error);
    results.push(r);
  }
  writeFileSync(join(out, 'fetch.json'), JSON.stringify(results, null, 2));
  console.log('[S9 fetch] wrote', join(out, 'fetch.json'));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
