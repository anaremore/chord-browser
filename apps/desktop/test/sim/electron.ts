/**
 * Electron, as the sync simulation needs it (a test's `vi.mock('electron', ...)`
 * uses this): chord-data's process is the simulation's own (`hooks.fork`),
 * the folder picker answers with the folder the simulation says, and
 * safeStorage keeps the key as it is (a profile copied on the same computer
 * reads it, as S15 §13 says such a copy can).
 */
export const hooks: { fork: () => unknown; folder: () => string } = {
  fork: () => {
    throw new Error('No chord-data for the simulation');
  },
  folder: () => '/sim/folder',
};

export const electron = {
  utilityProcess: { fork: () => hooks.fork() },
  MessageChannelMain: class {},
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [hooks.folder()] }) },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(`sim:${text}`),
    decryptStringAsync: async (blob: Buffer) => {
      const text = Buffer.from(blob).toString();
      if (!text.startsWith('sim:')) throw new Error('Not this computer’s');
      return { result: text.slice(4), shouldReEncrypt: false };
    },
  },
};
