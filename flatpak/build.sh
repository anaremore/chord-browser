#!/usr/bin/env bash
# Builds Chord's Flatpak from this checkout in a throwaway Fedora container, so
# the host needs only Docker or Podman (docs/releasing/flathub.md).
#
#   flatpak/build.sh          # build; writes apps/desktop/release/flatpak/
#   flatpak/build.sh --test   # also lint it and run test:packaged against it
#
# What goes in: this checkout's files, minus what .gitignore ignores. What comes
# out, in apps/desktop/release/flatpak/: the .flatpak bundle, the
# generated-sources.json it was built with, and logs.
#
# The container is --privileged because flatpak-builder runs each build step in
# a bubblewrap sandbox, as Flathub's own CI does. A named volume
# (chord-flatpak-cache) keeps the runtimes and download caches between runs;
# `docker volume rm chord-flatpak-cache` clears it.
set -euo pipefail

test=0
for arg in "$@"; do
  case "$arg" in
    --test) test=1 ;;
    *) echo "usage: $0 [--test]" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
engine="${CONTAINER_ENGINE:-$(command -v podman || command -v docker || true)}"
if [ -z "$engine" ]; then
  echo "Needs podman or docker (or set CONTAINER_ENGINE)." >&2
  exit 1
fi
image="${FLATPAK_BUILD_IMAGE:-registry.fedoraproject.org/fedora:44}"
out="$root/apps/desktop/release/flatpak"
mkdir -p "$out"

cd "$root"
git ls-files -z --cached --others --exclude-standard |
  tar --null --files-from=- --ignore-failed-read -cf - |
  "$engine" run --rm -i --privileged \
    --volume chord-flatpak-cache:/cache \
    --volume "$out:/out" \
    --env CHORD_FLATPAK_TEST="$test" \
    "$image" \
    bash -c 'mkdir -p /src && tar -xf - -C /src && exec bash /src/flatpak/in-container.sh'
