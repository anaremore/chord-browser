# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for security problems.

Report privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include steps to reproduce, the affected platform (Windows, macOS, or Linux), and the Chord version.

You'll get an acknowledgement within 3 days. We'll keep you updated until the issue is fixed, and credit you in the release notes if you'd like.

## Supported versions

Chord is in early development. Only the **latest preview release** gets fixes, security fixes included. Older previews don't, so please update before reporting.

## Chromium security updates

Chord is built on Electron, which ships Chromium. When Electron publishes a release with Chromium security fixes, Chord aims to ship an updated build on every platform within 72 hours.

- An hourly workflow watches Electron's releases and opens a P0 issue when one carries security fixes.
- Renovate raises the Electron update right away, and merges it once CI passes on every OS.
- The steps from there to a published release are in the runbook, [docs/releasing/patch-runbook.md](docs/releasing/patch-runbook.md). The design is in [ARCHITECTURE.md §14](ARCHITECTURE.md#14-security-updates-and-the-72-hour-patch-process).

Signed builds and staged rollouts don't exist yet, and the Linux package repositories and Flathub aren't live yet, so for now the fix ships as a GitHub release.
