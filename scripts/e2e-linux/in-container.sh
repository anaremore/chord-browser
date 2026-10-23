#!/usr/bin/env bash
# The container half of scripts/e2e-linux/run.mjs: runs in the chord-e2e-runner
# image (scripts/e2e-linux/Dockerfile) with a copy of the checkout in /work, as
# the unprivileged user chord. Not meant to run on your own machine.
#
# Installs, builds and runs the desktop E2E suite the way CI's Linux jobs do
# (.github/workflows/ci.yml): the display setup below is CI's, line for line.
# Arguments go to Playwright. CHORD_E2E_DISPLAY is x11 (Xvfb with openbox, the
# default) or wayland (headless Weston).
set -euo pipefail

display="${CHORD_E2E_DISPLAY:-x11}"
# Seconds are counted from when run.mjs started, like its own.
started="${CHORD_E2E_STARTED:-$(date +%s)}"
step() { echo "[e2e-linux] $1 ($(($(date +%s) - started)) s)"; }

cd /work
step "pnpm install (store and Electron download cached in volumes)"
# The store is a volume and /work isn't, so pnpm copies packages out of it rather than linking them.
pnpm install --frozen-lockfile --prefer-offline --store-dir "$HOME/.cache/pnpm-store" --package-import-method copy
step "pnpm build"
pnpm build
step "E2E on $display"

case "$display" in
  x11)
    # CI's "E2E (X11, Xvfb with openbox)" step.
    exec xvfb-run -a sh -c '
      ready="$(mktemp -u)"
      openbox --startup "touch $ready" &
      for i in $(seq 1 100); do [ -e "$ready" ] && break; sleep 0.1; done
      [ -e "$ready" ] || { echo "openbox did not start"; exit 1; }
      pnpm --filter @chord/desktop test:e2e "$@"
    ' sh "$@"
    ;;
  wayland)
    # CI's "E2E (Wayland, headless Weston)" step.
    export XDG_RUNTIME_DIR="$(mktemp -d)"
    chmod 700 "$XDG_RUNTIME_DIR"
    weston --backend=headless --socket=wayland-chord --idle-time=0 &
    for i in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/wayland-chord" ] && break; sleep 0.1; done
    [ -S "$XDG_RUNTIME_DIR/wayland-chord" ] || { echo "weston did not start"; exit 1; }
    unset DISPLAY
    export WAYLAND_DISPLAY=wayland-chord XDG_SESSION_TYPE=wayland
    pnpm --filter @chord/desktop test:e2e "$@"
    ;;
  *)
    echo "CHORD_E2E_DISPLAY must be x11 or wayland, not $display" >&2
    exit 2
    ;;
esac
