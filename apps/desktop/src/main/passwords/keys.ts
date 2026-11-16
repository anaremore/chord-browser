/**
 * *Keep unlocked on this computer* (docs/decisions/S17-passwords.md §7): the
 * vault key's second copy, wrapped by the OS through safeStorage's async API
 * (the Keychain, DPAPI, the secret service), as sync's root key is kept
 * (main/sync.ts). Only main can call safeStorage, so the key passes through
 * here on its way in and out, as bytes zeroed once they're used; the string
 * safeStorage itself takes and returns can't be wiped (S17's honest limits).
 *
 * Linux without a keyring (`basic_text`) keeps nothing: any program could
 * read it there, which is no protection at all.
 */
import { safeStorage } from 'electron';
import type { PasswordKeys } from './service';

export function osKeys(platform: NodeJS.Platform, options: { noKeyring?: boolean } = {}): PasswordKeys {
  const available = async () => {
    if (options.noKeyring) return false;
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
      return platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
    } catch {
      return false;
    }
  };
  return {
    available,
    async wrap(key) {
      if (!(await available())) throw new Error('no keyring');
      const encoded = Buffer.from(key).toString('base64');
      return (await safeStorage.encryptStringAsync(encoded)).toString('base64');
    },
    async unwrap(blob) {
      if (!(await available())) throw new Error('no keyring');
      const opened = await safeStorage.decryptStringAsync(Buffer.from(blob, 'base64'));
      const key = new Uint8Array(Buffer.from(opened.result, 'base64'));
      if (key.length !== 32) {
        key.fill(0);
        throw new Error('not a key');
      }
      return key;
    },
  };
}
