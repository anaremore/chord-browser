# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for security problems.

Report privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include steps to reproduce, the affected platform (Windows, macOS, or Linux), and the Chord version.

You'll get an acknowledgement within 3 days. We'll keep you updated until the issue is fixed, and credit you in the release notes if you'd like.

## Supported versions

Chord is in early development. Only the latest release receives fixes.

## Chromium security updates

Chord is built on Electron, which ships Chromium. When Electron publishes a release with Chromium security fixes, Chord aims to ship an updated build on every platform within 72 hours. The process is described in [ARCHITECTURE.md §14](ARCHITECTURE.md#14-security-updates-and-the-72-hour-patch-process).
