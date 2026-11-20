# Apple's password-manager-resources, vendored

From [apple/password-manager-resources](https://github.com/apple/password-manager-resources) at commit
`410bea26abe112dc3fe161a35e936e824316afdb` (main, 2026-11-17), unchanged:

- `password-rules.json`: `quirks/password-rules.json`, each site's password rules in Apple's language. Read by
  `packages/core/src/password-quirks.ts` for the generator (S17 §6, *Generating*).
- `change-password-URLs.json`: `quirks/change-password-URLs.json`, where each site changes a password. Read by
  the same file for Settings → Passwords' *Change password on the site* (S17 §9).
- `websites-that-append-2fa-to-password.json`: `quirks/websites-that-append-2fa-to-password.json`, sites that take a
  one-time code typed after the password in the same field. Read by the same file (`appendsCodeToPassword`), so a
  code after the saved password is no new password (S17 §6, phase 3D).

The rules parser, `tools/PasswordRulesParser/PasswordRulesParser.js`, is transliterated in
`packages/core/src/password-rules-parser.ts` at the same commit.

MIT, © 2019–2026 Apple Inc.: [LICENSES/MIT-Apple-password-manager-resources.txt](../../../../LICENSES/MIT-Apple-password-manager-resources.txt).

To update: fetch the three files and the parser at a newer commit, name it here and in both source files' headers, and
run `pnpm test` (`password-generator.test.ts` generates a password for every site in the list and checks it).
