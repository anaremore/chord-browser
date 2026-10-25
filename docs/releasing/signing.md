# Code signing and notarization

**Status (2026-10-23): built, and off until the certificates exist.** Releases stay unsigned until the secrets below are in the `release` environment. After that, the next `v*` tag signs, notarizes and checks itself, with no code change. Design: [ARCHITECTURE.md §15.2](../../ARCHITECTURE.md#152-code-signing).

✅ = checked against electron-builder 26.18's source or the vendor's docs on 2026-10-23. ⚠ = unverified until the first signed release.

---

## What turns on with what

Each platform switches on by itself once **every** name in its row is set. A row that's only partly set stops the build (*Choose how to sign*), so a typo can't quietly ship an unsigned release. Manual runs from a branch never see these secrets, so they always build unsigned.

| Platform | Secrets in `release` | Variables in `release` | What the build does | What checks it |
|---|---|---|---|---|
| macOS | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | | Developer ID signature with the hardened runtime and [Chord's entitlements](../../apps/desktop/build/entitlements.developer-id.plist), then notarized with notarytool and the ticket stapled. arm64 and x64, `.dmg` and `.zip`. | `codesign --verify --deep --strict`, a `Developer ID Application` authority and the `runtime` flag; `spctl -a -vv` must say `source=Notarized Developer ID`; `stapler validate`. Run on the built app and on the copies inside the `.dmg` and the `.zip`. |
| Windows (preferred) | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, `WIN_PUBLISHER_NAME` | Azure Artifact Signing signs `Chord.exe`, its DLLs, the installer and its uninstaller, on x64 and arm64. Installed copies then accept only updates signed by `WIN_PUBLISHER_NAME`. | `Get-AuthenticodeSignature` on the installer and on the installed `Chord.exe`, `Uninstall Chord.exe` and DLLs: `Valid`, timestamped, and signed by the publisher that `app-update.yml` pins. |
| Windows (fallback) | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | `WIN_PUBLISHER_NAME` (optional) | The same, with signtool and a `.pfx`. The publisher defaults to the certificate's CN. Used only when Artifact Signing isn't set up. | The same. |
| Linux | none | | No OS code signing. Updates are covered by the Ed25519 manifest key ([patch-runbook.md](patch-runbook.md#update-signing-key)). Package repos and Flathub do their own GPG signing ([below](#linux)). | |

Unsigned Windows builds pin no publisher, and *Check the signatures (Windows)* fails the release if one ever does, so unsigned copies keep installing unsigned updates.

**How it's wired:**
- [`scripts/signing-mode.mjs`](../../apps/desktop/scripts/signing-mode.mjs) only learns whether each name is set and picks `CHORD_SIGNING`.
- One *Package* step per mode runs, and gets only the secrets it needs.
- [`electron-builder.config.ts`](../../apps/desktop/electron-builder.config.ts) turns `CHORD_SIGNING` into electron-builder options. It throws if anything is missing.

## First: the `release` environment

The `release` environment may already exist: [patch-runbook.md, *Update signing key*](patch-runbook.md#update-signing-key), step 1, creates it. If it doesn't:

1. *Settings → Environments → New environment*, named `release`.
2. Under *Required reviewers*, add yourself.
3. Under *Deployment branches and tags*, add the tag rule `v*`.

Put every name on this page under that environment's **Environment secrets** or **Environment variables**. Never use repository secrets: those reach every workflow and every manual run.

With signing secrets there, the build jobs run in `release` too, so a tag now waits for approval twice: once before the six builds, then once before the draft. ⚠ One approval should release all six waiting builds together. An empty environment name for manual runs is assumed to mean "no environment"; the first manual run after this change shows whether it does.

---

## macOS: Developer ID and notarization

**Cost and time:**
- **Fee:** the Apple Developer Program is US$99 a year. Notarization is free.
- **Individual:** enrollment usually completes within about two days.
- **Organization:** needs a D-U-N-S number first. That's free, but can take one to two weeks ⚠.

**Decide first:** enroll as an individual or as an organization. Gatekeeper shows the certificate's name (*Developer ID Application: Name (TEAMID)*). A Mac copy can only update in place to a build signed by the same Team ID, so changing teams later means everyone reinstalls once by hand.

1. **Enroll** at [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/) with the Apple ID that will own Chord.
2. **Make the Developer ID Application certificate.** Only the team's Account Holder can. On your Mac:
   1. In *Keychain Access*, choose *Certificate Assistant → Request a Certificate From a Certificate Authority*. Use your email, choose *Saved to disk*, and save the `.certSigningRequest`.
   2. In [Certificates, IDs & Profiles](https://developer.apple.com/account/resources/certificates/list), click **+** and choose **Developer ID Application** (the G2 Sub-CA). Upload the request and download the `.cer`.
   3. Double-click the `.cer` to add it to your login keychain.
   4. In *Keychain Access → My Certificates*, right-click *Developer ID Application: … (TEAMID)* and choose **Export**. Save a `.p12` with a strong password.
   5. Run `base64 -i chord-developer-id.p12 | pbcopy`. That text is `MAC_CSC_LINK`; the password is `MAC_CSC_KEY_PASSWORD`.
   6. Keep the `.p12` and its password in your password manager, then delete the file. The certificate lasts 5 years.
3. **Make an App Store Connect API key.** electron-builder recommends this over an Apple ID for CI ✅: it isn't tied to a person's password or two-factor prompts, and you can revoke it.
   1. In [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api), open *Users and Access → Integrations → App Store Connect API*. The Account Holder may need to *Request Access* first.
   2. Under *Team Keys*, click **+**. Name it "Chord notarization" and give it the **Developer** role.
   3. Download `AuthKey_<KEYID>.p8`. Apple offers the download only once.
   4. Store three secrets:
      - `APPLE_API_KEY`: the `.p8` file's whole text, from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`. The workflow writes it back to a file, because electron-builder 26 hands notarytool a path ✅.
      - `APPLE_API_KEY_ID`: the key's ID.
      - `APPLE_API_ISSUER`: the *Issuer ID* shown above the key list.
4. **Add the five secrets** to `release`.
5. **Tag a release** and approve it. Check the log:
   - *Choose how to sign* says "Signing with Developer ID signing and notarization".
   - *Check the Developer ID signature and notarization* prints `source=Notarized Developer ID` three times: the app, the `.dmg` copy and the `.zip` copy.
   - Notarization usually takes minutes. A new team's first submissions can take hours, and the macOS jobs allow 90 minutes. If one times out, re-run it.
6. **Check by hand on your Mac**, with the `.dmg` downloaded in Safari so it carries the quarantine flag:
   - It opens without *Open Anyway*.
   - A site can use the camera, the microphone and your location once you allow it. Screen sharing works after you grant *Screen Recording*.
   - macOS asks **once** about *Chord Safe Storage*, because the keychain item still trusts the old ad-hoc signature. Click *Always Allow*. Later signed updates don't ask again ([entitlements notes](../../apps/desktop/build/entitlements.developer-id.plist)).

**Without a Mac:** you can make the request on Windows or WSL with OpenSSL:
```sh
openssl req -new -newkey rsa:2048 -nodes -keyout developer-id.key -out developer-id.csr -subj "/emailAddress=you@example.com/CN=Your Name/C=US"
```
After step 2.2:
```sh
openssl x509 -inform DER -in developerID_application.cer -out developer-id.pem
openssl pkcs12 -export -legacy -inkey developer-id.key -in developer-id.pem -out chord-developer-id.p12
```
macOS's `security import` may reject OpenSSL 3's default `.p12` encryption, hence `-legacy` ⚠.

---

## Windows: Azure Artifact Signing (preferred)

Artifact Signing is Microsoft's managed signing, formerly called Trusted Signing. electron-builder 26.18 drives it through `win.azureSignOptions` ✅. It installs the `TrustedSigning` PowerShell module and calls `Invoke-TrustedSigning` for each file. The key never leaves Azure, and nothing on this page expires except the client secret.

**Cost and time:**
- **Basic:** US$9.99 a month for 5,000 signatures ✅ (ARCHITECTURE.md §15.2). A release uses about 25: `Chord.exe`, 7 DLLs, the installer and the uninstaller, for each architecture.
- **Eligibility:** individuals must be in the US or Canada; organizations can be in more countries.
- **Validation:** identity validation takes 1–20 business days.

1. **An Azure subscription** (pay-as-you-go) in your name or your organization's.
2. **Register the provider:** *Subscriptions → your subscription → Resource providers* → `Microsoft.CodeSigning` → **Register**.
3. **Create the account:** search the portal for *Artifact Signing* (or *Trusted Signing*) → **Create**.
   - Pick a resource group, a name (e.g. `chord-signing`), the **Basic** tier and a region.
   - The region fixes the endpoint. East US is `https://eus.codesigning.azure.net/`, and the account's *Overview* shows yours.
   - The account name is `AZURE_SIGNING_ACCOUNT`; the endpoint is `AZURE_SIGNING_ENDPOINT`.
4. **Validate your identity:**
   1. On the account's *Access control (IAM)*, give yourself the **Artifact Signing Identity Verifier** role (older portals: *Trusted Signing Identity Verifier*).
   2. Under *Identity validation*, choose **New → Public**, as an individual or an organization, and submit. Wait for *Completed*.
5. **Make a certificate profile:** *Certificate profiles → Create → Public Trust*, with the validated identity. Name it, e.g. `chord-public`; that's `AZURE_SIGNING_PROFILE`.
   - The profile shows its **Subject name**. The value after `CN=` is `WIN_PUBLISHER_NAME`, exactly, including capitals and punctuation.
   - Installed copies pin it, and the certificates behind the profile renew daily with the same subject. Changing it later means signed copies refuse updates and fall back to "a new version is out", so keep one identity forever.
6. **Give CI a sign-in:**
   1. In *Microsoft Entra ID → App registrations → New registration*, create `chord-release-signing` (single tenant, no redirect URI).
   2. Its *Overview* shows the **Application (client) ID** (`AZURE_CLIENT_ID`) and the **Directory (tenant) ID** (`AZURE_TENANT_ID`).
   3. Under *Certificates & secrets → New client secret*, make one lasting up to 24 months. Copy its **Value**: that's `AZURE_CLIENT_SECRET`. Put a reminder in your calendar to rotate it before it expires.
   4. Back on the signing account, under *Access control (IAM) → Add role assignment*, give `chord-release-signing` the **Artifact Signing Certificate Profile Signer** role (older portals: *Trusted Signing Certificate Profile Signer*).
7. **In `release`:** the three `AZURE_*` IDs and the secret as **secrets**; `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` and `WIN_PUBLISHER_NAME` as **variables**. Variables aren't masked in logs, so the check step can print the publisher.
8. **Tag a release.** *Check the signatures (Windows)* lists each file as `Valid`, signed by `WIN_PUBLISHER_NAME`, with a timestamp.
   - On a Windows PC, the installer's *Properties → Digital Signatures* shows the same name.
   - SmartScreen can still warn about a new publisher's first releases until they build reputation; a signature doesn't skip that ✅ (ARCHITECTURE.md §15.2).

⚠ **Windows on Arm:** that the `TrustedSigning` module runs on the `windows-11-arm` runner is unverified. If it doesn't, sign the arm64 build from an x64 runner instead (electron-builder can cross-build `--arm64` there), and run its smoke test on `windows-11-arm` as now.

Later, a federated credential (OIDC) could replace the client secret. It isn't built.

## Windows: a `.pfx` certificate (fallback)

Use this only if Artifact Signing isn't available to you. Since June 2023, certificate authorities must keep the private keys of publicly trusted code-signing certificates in hardware (a token or an HSM), so new OV and EV certificates don't come as `.pfx` files ✅. The cloud-HSM services that replace them (DigiCert KeyLocker, SSL.com eSigner and others) have their own signing tools. They would need a custom `signtoolOptions.sign` hook, which isn't built. OV certificates cost roughly US$200–500 a year, and validation takes days to weeks. **SignPath Foundation** signs open-source projects for free, but it needs its own workflow integration, manual approval of each release, and a certificate that names "SignPath Foundation" (ARCHITECTURE.md §15.2).

If you do have a `.pfx`:
1. Run `base64 -w0 chord.pfx` (or `[Convert]::ToBase64String([IO.File]::ReadAllBytes('chord.pfx'))` in PowerShell). The output is `WIN_CSC_LINK`; the password is `WIN_CSC_KEY_PASSWORD`. Add both as secrets.
2. Optionally set the variable `WIN_PUBLISHER_NAME`. Otherwise electron-builder pins the certificate's CN.
3. Tag a release and check the same steps as above.

## Linux

Nothing for this workflow to provide:
- AppImage, `.deb` and `.rpm` files carry no OS code signature.
- In-app AppImage updates are covered by the Ed25519 manifest key.
- The apt and dnf repositories will be signed by Cloudsmith: by default it makes and keeps a GPG key for each repository, so its own upload step needs only a Cloudsmith API key ⚠.
- Flathub signs what it builds.

If the Cloudsmith work ends up using your own GPG key, that key belongs in the same `release` environment, not in this workflow's signing steps.

---

## Chord Player: castLabs VMP

Chord Player (ARCHITECTURE.md §9, `apps/player`) runs on castLabs ECS. The streaming services play only in a build that castLabs' EVS service has **VMP-signed** for production. This is separate from code signing: a build can have either, both or neither.

**Turns on with:** the secrets `EVS_ACCOUNT_NAME` and `EVS_PASSWD` (your castLabs EVS account, S14 §5). They're set (2026-10-25) as **repository** secrets.
- `.github/workflows/player.yml` VMP-signs the Windows and macOS builds when they're there and signing is asked for:
  - always for a `player-v*` tag (`player-release.yml`), which fails without them;
  - when CI is started by hand (`gh workflow run ci.yml --ref <branch>`);
  - never on ordinary pushes and pull requests.
- **Linux has no VMP.**

**How it runs:**
1. *Install castLabs EVS*: `castlabs-evs` 1.3.2, pinned by its wheel's hash (`apps/player/build/evs-requirements.txt`), in a venv of its own, run with `python -I`.
2. *Sign in to castLabs EVS*, the only step that sees the two secrets: `castlabs_evs.account --no-ask reauth`, once.
   - An expired or wrong login fails here, and nothing retries: castLabs asks accounts not to repeat requests needlessly.
   - EVS's tokens (`EVS_CONFIG_FILE`) and signature cache (`EVS_CACHE_FILE`) live in the runner's temp folder, never in the workspace or an artifact. *Forget the EVS tokens* deletes them, even after a failure.
3. *Package* (`apps/player/scripts/package.mjs`, non-interactive with `EVS_NO_ASK`), in castLabs' order:
   - **macOS:** the fuses are flipped, then VMP signing (`sign-pkg`), all in electron-builder's `afterPack`. Then code signing: ad-hoc today, Developer ID once it's set up for Chord.
   - **The fuses** must be exactly the set castLabs accepts (castLabs' FAQ; `apps/player/scripts/after-pack.mjs`). Any other change to the binary makes EVS answer *Binary signature denied*.
   - **Windows:** code signing (by electron-builder, once a certificate is set up), then VMP signing. Nothing touches the `.exe` after it.
   - `verify-pkg` then checks the signature, and the job fails if it doesn't hold.

**Without the secrets** (forks, pull requests), the Windows and macOS binaries stay as castLabs built them, so ECS's development signature stays valid. Only Widevine's test servers accept that, so such builds are for tests, not for release.

**Your steps:**
- **Move the secrets into the `release` environment** for releases.
  - Add `player-v*` to its *Deployment branches and tags*, and run `player.yml`'s package job for tags in that environment, as `release.yml` does for Chord.
  - Until then, every workflow on any branch can read the two secrets.
  - CI's hand-started runs sign with them too; decide whether those should stop once releases sign from the environment.
- **Tokens expire about monthly.** CI signs in afresh each run (`reauth`). If castLabs changes how that works, *Sign in to castLabs EVS* is where it fails.
- **Check a released player** with docs/testing/widevine-player.md, and its VMP status offline with `castlabs_evs.vmp verify-pkg`.
- **A release** needs Chord's update key too (`CHORD_UPDATE_SIGNING_KEY` in `release`, and the public half in `apps/desktop/src/main/update-key.ts`). Chord installs a player only from a manifest that key signed.

---

## After the first signed release

- **Set the variable `CHORD_REQUIRE_SIGNING` to `true`** in `release`. From then on, a tag build whose secrets went missing fails, instead of shipping:
  - Windows builds that signed copies refuse to install (they fall back to "a new version is out");
  - macOS builds that Gatekeeper blocks.
- **Edit the draft's notes:** the workflow writes "Signed for Windows, and signed and notarized for macOS" in place of the unsigned warning.
- **Update the status** in ARCHITECTURE.md §15.2 and ROADMAP.md *Where we are*. The README's install steps already say they go away once a release is signed.

**Renewing:**
- **Apple:** a new Developer ID certificate from the same team is accepted as is (same Team ID). Replace `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`. API keys don't expire.
- **Azure:** the certificates renew themselves. Rotate `AZURE_CLIENT_SECRET` before it expires.
- **`.pfx`:** a renewed certificate must keep the same CN, or pin both names for one release first.

---

## macOS in-app updates: not built yet

A signed Mac copy can replace itself, but Chord doesn't do that yet. Today every Mac copy says a new version is out and links to it. What it would take, on the existing Ed25519-signed manifest flow (`src/main/update-installer.ts`, `update-signing.ts`):

1. **A manifest per architecture.** Each Mac runner writes its own `latest-mac.yml`, so the workflow would rename them `latest-mac-<arch>.yml`, as it does for Windows, and upload them with the `.zip` files. Squirrel.Mac installs from the `.zip`, never the `.dmg`.
2. **Sign them:** widen `sign-update-manifests.mjs`'s file pattern to `latest-mac-(x64|arm64).yml`.
3. **Trust them:** `manifestFor('darwin', arch)` returns `latest-mac-${arch}.yml`.
4. **Only where it can work:** `installable()` on macOS should hold only for a packaged, Developer ID-signed copy (for example, a flag the signed config writes into `extraMetadata`) that runs from a writable location. `app.isInApplicationsFolder()` is a fair test; a copy launched from the mounted `.dmg` or under App Translocation can't replace itself.
5. **What electron-updater then does:** its MacUpdater checks the `.zip` against the signed manifest's sha512 and hands it to Squirrel.Mac through a local proxy. Squirrel.Mac installs it only if the new app satisfies the running app's designated requirement: the same Team ID and bundle ID ✅ (electron-builder's key-rotation docs).
6. **Ad-hoc copies can't make the jump.** Their designated requirement is their own hash, so the first signed release is a one-time manual install for them. The notify-only path already covers that.
7. **Tests:** a packaged macOS test that installs a signed update would need two signed builds, so it can only run in a tag build. The E2E suite can cover the provider and manifest choice, as it does for Windows.

---

## Microsoft Store (optional, off)

`electron-builder.config.ts` has a drafted `appx` block that nothing builds by default.

- **What the Store handles:** it signs the packages it distributes and updates its copies itself. A Store copy needs no certificate and never uses Chord's updater: it has no uninstaller beside it, so `update-installer.ts` leaves it notify-only.
- **Cost:** registration is free for individual developers since September 2025; companies pay a one-time US$99 ✅.

1. **Register** at [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com). In Partner Center, choose *Apps and games → New product → MSIX or PWA app* and reserve "Chord".
2. **Copy the product identity** (the product's *Product identity* page) into the shell that builds:
   - `CHORD_STORE_IDENTITY_NAME`: *Package/Identity/Name*.
   - `CHORD_STORE_PUBLISHER`: *Package/Identity/Publisher*, the `CN=…` GUID.
   - `CHORD_STORE_PUBLISHER_DISPLAY_NAME`: *Package/Properties/PublisherDisplayName*.

   None of these are secret, so once they're known they can go straight into the config instead.
3. **Tiles:** add `apps/desktop/build/appx/` with `StoreLogo.png` (50×50), `Square44x44Logo.png`, `Square150x150Logo.png` and `Wide310x150Logo.png`, drawn from the icon masters. Without them electron-builder uses its placeholder art.
4. **Build on Windows:** `pnpm --filter @chord/desktop package --win appx --x64`, then `--arm64`. The packages land in `apps/desktop/release/`.
5. **Submit:** upload both packages in a new submission. Certification usually takes a few days. The `runFullTrust` capability needs a one-line reason ("a desktop web browser"). ⚠ Read the Store's current policies for browsers first.

Still to check before a Store release:
- Links reach Chord through `build/appx-extensions.xml` (uap3 protocols, with `--single-argument` as in the installer).
- Settings → General → *Make default* deep-links to the installer's `registeredAppUser=Chord` entry, which a Store copy doesn't have.
- MSIX gives each package its own AppData, so a Store copy and an installer copy keep separate profiles.
- The "new version is out" toast links to GitHub, which a Store copy shouldn't show.
