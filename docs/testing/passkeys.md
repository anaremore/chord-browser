# Passkeys: checking by hand

E2E covers Chord's part with Chromium's virtual authenticator (`test/e2e/passkeys.spec.ts`):
- making a passkey and signing in with it;
- the card that chooses between several;
- Cancel;
- passkey autofill switched off (`web.spec.ts`).

What it can't reach is each OS's own authenticators. Check those by hand before a release, and when Electron changes its WebAuthn support (ARCHITECTURE.md §9, Passkeys).

Use [webauthn.io](https://webauthn.io) (register, then authenticate, with "Discoverable credential: required") and one real account per OS: Google, GitHub or Microsoft, in a chord of its own.

## Windows

Windows' own dialog handles every kind; Chord's card never shows here.

| Check | Expected |
|---|---|
| Make a passkey with Windows Hello (PIN, face or fingerprint) | Saved; the site says registered |
| Sign in with it | Windows Hello, then signed in |
| A security key with a PIN | Windows asks for the PIN and a touch |
| "Use a phone or tablet" | Windows shows a QR code; the phone signs in |
| Clicking an email field on Google's sign-in | No dialog by itself (passkey autofill is off) |

## macOS

| Check | Expected |
|---|---|
| A security key without a PIN | Touch it; signed in. With several passkeys on it, Chord's card chooses |
| A security key with a PIN | Not yet: Electron has no PIN entry, and declines |
| Touch ID, iCloud Keychain, 1Password | Not yet: Touch ID needs a signed build with a keychain entitlement; iCloud Keychain needs Apple's browser entitlement (see ARCHITECTURE.md) |

## Linux

| Check | Expected |
|---|---|
| A security key without a PIN | Touch it; signed in. With several passkeys on it, Chord's card chooses |
| A security key with a PIN, a phone, the computer itself | Not yet: Electron declines these on Linux |
