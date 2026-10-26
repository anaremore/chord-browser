/**
 * Node's crypto for Your data's encrypted files (core's data-file.ts): scrypt,
 * HKDF-SHA256, AES-256-GCM and raw DEFLATE, all built into Electron 45's Node
 * (BoringSSL; S15 §3 checked which are). Only utility processes use it: the
 * export process now, the import process and sync's worker later.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { DataCrypto } from '@chord/core';

const TAG = 16;

export const nodeCrypto: DataCrypto = {
  random: (length) => new Uint8Array(randomBytes(length)),
  scrypt: (passphrase, salt, { N, r, p }, length) =>
    new Promise((resolve, reject) =>
      // Node's default memory cap (32 MiB) refuses S15's parameters, which take 128 MiB: allow what they need.
      scrypt(passphrase, salt, length, { N, r, p, maxmem: 2 * 128 * N * r }, (error, key) => (error ? reject(error) : resolve(new Uint8Array(key)))),
    ),
  hkdf: (key, salt, info, length) => new Uint8Array(hkdfSync('sha256', key, salt, info, length)),
  sha256: (data) => new Uint8Array(createHash('sha256').update(data).digest()),
  seal(key, nonce, plaintext, aad) {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
    cipher.setAAD(aad);
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  },
  open(key, nonce, sealed, aad) {
    if (sealed.length < TAG) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    try {
      return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]);
    } catch {
      return null;
    }
  },
  deflate: (data) => deflateRawSync(data, { level: 6 }),
  inflate(data, maxLength) {
    try {
      return inflateRawSync(data, { maxOutputLength: maxLength });
    } catch {
      return null;
    }
  },
};

/** SHA-256 as hex: an icon's id (core's iconId). */
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
