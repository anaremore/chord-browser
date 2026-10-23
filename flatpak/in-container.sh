#!/usr/bin/env bash
# The container half of flatpak/build.sh: runs in a throwaway Fedora
# container with the checkout in /src, a cache volume in /cache and the output
# folder in /out. Not meant to run on your own machine.
set -euo pipefail

app_id=io.github.anaremore.chord-browser
# flatpak-node-generator from flatpak/flatpak-builder-tools, at a reviewed
# commit (2026-10-22: pnpm 10 stores, --no-playwright-browsers).
generator="git+https://github.com/flatpak/flatpak-builder-tools.git@3d6ff6697785b52ae34db8078e0ad5188a710b1f#subdirectory=node"

if [ "$(id -u)" = 0 ]; then
  started=$(date +%s)
  dnf -y -q install --setopt=install_weak_deps=False \
    flatpak flatpak-builder git-core python3 python3-pip desktop-file-utils \
    dbus-daemon xorg-x11-server-Xvfb xorg-x11-xauth weston which tar xz >/dev/null
  echo "[chord] packages installed in $(( $(date +%s) - started )) s"
  # Chromium won't start as root, and nothing here needs to be: build and test as a user.
  useradd --create-home builder
  mkdir -p /cache/flatpak /cache/work /cache/pip /cache/generator /cache/pnpm
  chown -R builder: /src /out /cache
  install -d -o builder -m 700 /run/user/"$(id -u builder)"
  exec runuser -u builder -- env XDG_RUNTIME_DIR=/run/user/"$(id -u builder)" CHORD_FLATPAK_TEST="${CHORD_FLATPAK_TEST:-0}" bash "$0"
fi

step() { echo "[chord] $1 ($(( $(date +%s) - started )) s)"; }
started=$(date +%s)
trap 'echo "[chord] exit $? after $(( $(date +%s) - started )) s"' EXIT
mkdir -p ~/.local/share ~/.cache
ln -sfn /cache/flatpak ~/.local/share/flatpak
ln -sfn /cache/generator ~/.cache/flatpak-node-generator
export PIP_CACHE_DIR=/cache/pip

# flatpak-builder wants its download cache on the same filesystem as the build,
# so both live on the cache volume; the checkout is copied in fresh every time.
work=/cache/work
rm -rf "$work/src" "$work/build-dir" "$work/repo"
mkdir -p "$work/state"
cp -a /src "$work/src"
src="$work/src"

flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

step 'Generating the offline npm sources'
python3 -m venv ~/generator
~/generator/bin/pip install -q "$generator"
~/generator/bin/flatpak-node-generator pnpm "$src/pnpm-lock.yaml" --no-playwright-browsers \
  -o "$src/flatpak/generated-sources.json"
cp "$src/flatpak/generated-sources.json" /out/

step 'Building the Flatpak (no network inside the build)'
cd "$src/flatpak"
flatpak-builder --user --install-deps-from=flathub --disable-rofiles-fuse --force-clean \
  --state-dir="$work/state" --repo="$work/repo" --install \
  "$work/build-dir" "$app_id.yml" 2>&1 | tee /out/build.log

version=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$src/apps/desktop/package.json")
bundle="/out/Chord-$version-linux-$(uname -m).flatpak"
flatpak build-bundle --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo "$work/repo" "$bundle" "$app_id"
step "Built $(basename "$bundle"), $(du -h "$bundle" | cut -f1)"
flatpak info --user "$app_id" | tee /out/info.txt

[ "${CHORD_FLATPAK_TEST:-0}" = 1 ] || exit 0

step 'Validating the desktop file and metainfo'
desktop-file-validate "$app_id.desktop" 2>&1 | tee /out/lint.log || true
flatpak install --user -y --noninteractive flathub org.flatpak.Builder >/dev/null
flatpak run --command=appstreamcli org.flatpak.Builder validate --no-net "$app_id.metainfo.xml" 2>&1 | tee -a /out/lint.log || true
step "Flathub's linter (expected to flag what docs/releasing/flathub.md lists)"
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest "$app_id.yml" 2>&1 | tee -a /out/lint.log || true
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo "$work/repo" 2>&1 | tee -a /out/lint.log || true

step 'Smoke test: test:packaged against the installed Flatpak, under Xvfb'
# The test only needs Node and Playwright's client; Chord itself runs from the Flatpak.
curl -fsSL "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" -o ~/node-sums.txt
node_tar=$(grep -o "node-v24[^ ]*-linux-$( [ "$(uname -m)" = aarch64 ] && echo arm64 || echo x64).tar.xz" ~/node-sums.txt | head -1)
curl -fsSL "https://nodejs.org/dist/latest-v24.x/$node_tar" -o ~/"$node_tar"
(cd ~ && grep " $node_tar\$" node-sums.txt | sha256sum -c -)
mkdir -p ~/node && tar -xJf ~/"$node_tar" -C ~/node --strip-components=1
export PATH="$HOME/node/bin:$PATH"
# Fetch the tools once, with timeouts: a stalled registry request shouldn't hang the run.
export npm_config_fetch_timeout=60000 npm_config_fetch_retries=3
npm install --global --no-fund --no-audit pnpm@10.33.0 @electron/fuses@2.1.3 >/dev/null
cd "$src"
pnpm install --frozen-lockfile --ignore-scripts --store-dir=/cache/pnpm >/dev/null

step 'Checking what the build put in the app'
asar="$(flatpak info --user --show-location "$app_id")/files/chord/resources/app.asar"
desktop_name=$(node -p "JSON.parse(require('@electron/asar').extractFile(process.argv[1], 'package.json')).desktopName" "$asar")
echo "desktopName in app.asar: $desktop_name" | tee /out/checks.txt
[ "$desktop_name" = "$app_id.desktop" ]
electron-fuses read --app "$(dirname "$asar")/../chord" 2>&1 | tee -a /out/checks.txt
dbus-run-session -- flatpak run --user --command=sh "$app_id" -c 'echo "xdg-settings in the sandbox: $(command -v xdg-settings || echo none)"' 2>&1 | tee -a /out/checks.txt

# Chord runs inside the sandbox, so its throwaway profile has to be somewhere both sides
# see at the same path: the app's own folder under ~/.var/app.
export TMPDIR="$HOME/.var/app/$app_id/cache/tmp"
mkdir -p "$TMPDIR"
cat > ~/chord-flatpak <<EOF
#!/bin/sh
exec flatpak run --user $app_id "\$@"
EOF
chmod +x ~/chord-flatpak
dbus-run-session -- xvfb-run -a env CHORD_APP="$HOME/chord-flatpak" \
  pnpm --filter @chord/desktop test:packaged 2>&1 | tee /out/smoke-x11.log

step 'Smoke test again on Wayland (headless Weston), which Electron prefers when it is there'
weston --backend=headless --socket=wayland-chord --idle-time=0 >/out/weston.log 2>&1 &
weston_pid=$!
for _ in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/wayland-chord" ] && break; sleep 0.1; done
dbus-run-session -- env -u DISPLAY WAYLAND_DISPLAY=wayland-chord XDG_SESSION_TYPE=wayland CHORD_APP="$HOME/chord-flatpak" \
  pnpm --filter @chord/desktop test:packaged 2>&1 | tee /out/smoke-wayland.log
kill "$weston_pid"
step 'Done'
