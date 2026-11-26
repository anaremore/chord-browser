/** Whether two byte arrays hold the same bytes (a checksum against the one expected, a log's bytes against what was written). */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);
