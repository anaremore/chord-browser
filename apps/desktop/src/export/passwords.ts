/**
 * The export process's one rule about passwords (docs/decisions/S17-passwords.md, decision 6): the port to
 * chord-data's `login` records is used only for an encrypted file that asked for them. Anything else closes it
 * unread, whatever main sent: a plain file never holds a password.
 */
export function passwordsPort<Port extends { close(): void }>(job: { passwords: boolean; passphrase: string | null }, port: Port | null): Port | null {
  if (port && job.passwords && job.passphrase !== null) return port;
  port?.close();
  return null;
}
