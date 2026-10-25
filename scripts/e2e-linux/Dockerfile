# The Linux E2E environment: CI's ubuntu-24.04 runner (.github/workflows/ci.yml),
# cut down to what the desktop E2E suite uses. scripts/e2e-linux/run.mjs builds
# it, tagged by a hash of this file, and runs the suite in it under Xvfb with
# openbox (X11) or headless Weston (Wayland), as CI's Linux jobs do.
#
# Nothing of the checkout is baked in: the source, node_modules and the build
# all live in the container a run starts (scripts/e2e-linux/in-container.sh),
# and the pnpm store and Electron download are named volumes.

# The runners' Ubuntu, so Xvfb, openbox, Weston and the libraries are the same
# versions as CI's. Pinned by digest; packages come from the archive as they do
# on CI, which doesn't pin them either.
FROM ubuntu:noble-20260930.1@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

# CI's actions/setup-node with node-version 24 resolves to the newest 24.x.
ARG NODE_VERSION=24.22.1
ARG NODE_SHA256_X64=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
ARG NODE_SHA256_ARM64=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e
# The root package.json's packageManager (run.mjs passes it in).
ARG PNPM_VERSION=10.33.0
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# - Display servers, as CI installs them (with --no-install-recommends): xvfb,
#   openbox for X11, weston for Wayland. xauth is what xvfb-run needs, and the
#   runner image has it.
# - What Electron needs at run time: Chrome's own package dependencies (the
#   runner image has them, as it ships Chrome), in their Ubuntu 24.04 names.
# - dbus: libdbus for Chromium, and dbus-run-session for trying a run with a
#   session bus. The suite runs without one, as on CI, whose runner process has
#   no session bus either: Chromium logs that it can't connect and carries on.
# - Fonts the runner has: DejaVu (fontconfig's default), Liberation (Chrome
#   depends on it) and Noto Color Emoji.
# - xdotool: a real pointer for the tests that drag across Chord's views
#   (split.spec.ts). Playwright's mouse goes straight to one page, past
#   the window's own routing between views; CI installs it too.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
      xvfb xauth openbox weston xdotool \
      dbus \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 \
      libcups2t64 libcurl4t64 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0t64 \
      libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libudev1 libvulkan1 libx11-6 \
      libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
      libgl1 libegl1 libgles2 libgl1-mesa-dri xdg-utils \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64|'') arch=x64; sum="$NODE_SHA256_X64" ;; \
      arm64) arch=arm64; sum="$NODE_SHA256_ARM64" ;; \
      *) echo "No Node build for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && tarball="node-v$NODE_VERSION-linux-$arch.tar.xz" \
 && curl -fsSLo "/tmp/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball" \
 && echo "$sum  /tmp/$tarball" | sha256sum -c - \
 && tar -xJf "/tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner \
 && rm "/tmp/$tarball" \
 && corepack enable \
 && node --version

# Chromium refuses to run as root without --no-sandbox, and Chord never runs
# without its sandbox: everything runs as an ordinary user. uid 1000, like the
# WSL user, so files copied back keep a sensible owner. The cache folders exist
# here so the named volumes mounted on them start out owned by that user.
RUN userdel --remove ubuntu 2>/dev/null || true \
 && useradd --create-home --uid 1000 --shell /bin/bash chord \
 && install -d -o chord -g chord /work /home/chord/.cache /home/chord/.cache/pnpm-store /home/chord/.cache/electron
USER chord
WORKDIR /work
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack prepare "pnpm@$PNPM_VERSION" --activate && pnpm --version
