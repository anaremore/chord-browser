# apt and dnf repositories (Cloudsmith)

Chord's `.deb` and `.rpm` packages go into signed apt and dnf repositories on [Cloudsmith](https://cloudsmith.com), so Linux users get updates through `apt upgrade` and `dnf upgrade` (ARCHITECTURE.md [§14.4](../../ARCHITECTURE.md#144-auto-updates), [§15.1](../../ARCHITECTURE.md#151-targets)). Cloudsmith hosts open-source projects for free and signs the repository metadata with a GPG key it keeps for the repository.

**Status (2026-10-23): built, switched off.** The workflow is ready and skips itself until the maintainer creates the Cloudsmith repository and the `CLOUDSMITH_API_KEY` secret. The README's install steps say "coming soon" until then.

✅ = verified against docs or real data on 2026-10-23. ⚠ = unverified.

## How it works

[`.github/workflows/linux-repos.yml`](../../.github/workflows/linux-repos.yml) runs when a GitHub release is **published** (not when the draft is created), and by hand from *Actions → Linux package repos → Run workflow*.

1. **Gate.** If the repository secret `CLOUDSMITH_API_KEY` is missing, it writes a notice and the upload job is skipped. The run is green.
2. **Download** the release's `.deb` and `.rpm` files and `SHA256SUMS.txt` with `gh release download`.
3. **Check** every package against `SHA256SUMS.txt`, which the release workflow wrote next to the builds it smoke-tested. A release without a `.deb` fails; one without an `.rpm` warns and updates only apt.
4. **Upload** each file with the Cloudsmith CLI (`cloudsmith-io/cloudsmith-cli-action` v3.1.1, pinned by commit; CLI 1.30.0) to `any-distro/any-version`: one package serves every Debian, Ubuntu, Fedora and RHEL release ✅. The CLI waits until Cloudsmith has processed each package, and fails if it can't.

Run by hand, it takes a **tag** and two switches:
- **dry run:** logs in and checks each file, uploads nothing (`cloudsmith push --dry-run`).
- **republish:** replaces packages Cloudsmith already has for that version. Use it only to repair a failed upload of the same files.

**Settings:**
- Secret `CLOUDSMITH_API_KEY`: switches it on.
- Variable `CLOUDSMITH_REPOSITORY`: `workspace/repository`, default `chord-browser/chord`. The README's repository lines must use the same names.

## Switching it on

Everything here needs the maintainer's own accounts; nothing in the repo creates accounts, keys or secrets.

1. **Cloudsmith account.** Sign up at [cloudsmith.com](https://cloudsmith.com) (GitHub sign-in works) and create a **workspace** named `chord-browser`. If that name is taken, pick another and use it everywhere below and in the README.
2. **Repository.** *Repositories → New repository*, name `chord`:
   - turn on **Broadcast** and choose the **Open source** visibility;
   - license **GPL-3.0-only** (the packages are the GPL-3.0 combined work, ARCHITECTURE.md §16 D1);
   - project URL `https://github.com/anaremore/chord-browser`;
   - accept the open-source terms.

   Open-source repositories need no approval in advance, get at least 50 GB of storage and 200 GB of downloads a month, and must credit Cloudsmith with a link ✅ ([policy](https://docs.cloudsmith.com/open-source-hosting-policy)). Step 7 adds the credit.
3. **GPG key.** Cloudsmith creates the repository's signing key itself; no key is made or stored anywhere else. Under the repository's *Settings → GPG keys*, note the **fingerprint**. Users fetch the public key from `https://dl.cloudsmith.io/public/chord-browser/chord/gpg.key` ✅ (the same URL form serves other projects' keys).
4. **API key**, least privilege: in the workspace, *Settings → Service accounts → Create*, named `github-actions`, with **write** access to the `chord` repository only. Copy its API key. (A personal API key also works, but it can do anything your account can.)
5. **GitHub secret.** *Settings → Secrets and variables → Actions → New repository secret*: `CLOUDSMITH_API_KEY` = that key. If the workspace or repository isn't `chord-browser/chord`, also add the **variable** `CLOUDSMITH_REPOSITORY`.
6. **Try it.** Pick the newest *published* release and run *Actions → Linux package repos → Run workflow* with its tag and **dry run** ticked. The *Upload* step logs each file it would push. Then run it again without dry run, or wait for the next release.
7. **README.** Once a package installs in a VM with the steps below:
   - remove the "coming soon" note in *Linux*;
   - add the key fingerprint;
   - add the credit, for example: "Package repository hosting is provided for free by [Cloudsmith](https://cloudsmith.com)."
8. **ARCHITECTURE.md and ROADMAP.md:** mark the repositories live.

**Optional, later:** Cloudsmith also accepts GitHub's OIDC tokens instead of a stored key (`oidc-namespace` and `oidc-service-slug` inputs, `id-token: write`) ✅. Switching would mean gating the workflow on a variable rather than the secret.

## What users run

The README carries these (until the repository is live, behind a "coming soon" note).

**Debian, Ubuntu and derivatives:**
```sh
curl -fsSL https://dl.cloudsmith.io/public/chord-browser/chord/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/chord-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/chord-archive-keyring.gpg] https://dl.cloudsmith.io/public/chord-browser/chord/deb/any-distro any-version main" | sudo tee /etc/apt/sources.list.d/chord.list
sudo apt update && sudo apt install chord
```

**Fedora, RHEL and derivatives:**
```sh
sudo tee /etc/yum.repos.d/chord.repo <<'EOF'
[chord]
name=Chord
baseurl=https://dl.cloudsmith.io/public/chord-browser/chord/rpm/any-distro/any-version/$basearch
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://dl.cloudsmith.io/public/chord-browser/chord/gpg.key
EOF
sudo dnf install chord
```

The line formats match what Cloudsmith's own `config.deb.txt` and `config.rpm.txt` endpoints produce for `any-distro`/`any-version` ✅ (checked against a live Cloudsmith repository). `signed-by` limits the key to this repository. ⚠ That Cloudsmith also signs each RPM, as `gpgcheck=1` requires, is how its public RPM repositories work today; check it with the first upload (`rpm -K` on the downloaded file). The release's own `.rpm` files carry no signature, so if Cloudsmith doesn't add one, `dnf` refuses them.

Someone who installed a `.deb` or `.rpm` from GitHub Releases moves to the repository without reinstalling: the package name (`chord`) is the same, so `apt upgrade` or `dnf upgrade` takes over.

## Day to day

- **Every published release** goes up by itself. Check the run on the release's day ([patch runbook](patch-runbook.md#8-publish)).
- **A bad package:** don't delete it. Ship a higher version ([pulling a bad release](patch-runbook.md#11-pulling-a-bad-release)). Deleting a version users already have makes `apt` complain about a missing file, and package managers never downgrade by themselves.
- **Key rotation:** Cloudsmith can regenerate the repository key. Users then need the new `gpg.key`, so announce it in the release notes first.
- **Usage:** Cloudsmith's dashboard shows downloads against the free allowance.
