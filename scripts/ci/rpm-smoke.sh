#!/usr/bin/env bash
# Installs Chord's .rpm in a throwaway Fedora container and smoke-tests that
# copy (release.yml, ARCHITECTURE.md §15.3). Needs Docker, Node 24 and this
# checkout's node_modules (pnpm install); run it as a user, not root:
#
#   scripts/ci/rpm-smoke.sh apps/desktop/release/Chord-<version>-linux-<arch>.rpm
#
# As root in the container:
# - `dnf install` the file before anything else, so its own dependencies have
#   to bring every library Chord's binaries link;
# - chrome-sandbox is setuid root, `rpm -V` finds nothing changed, and the
#   .desktop file, icons and /usr/bin/chord are where desktops look;
# - a reinstall, which runs the scripts an upgrade runs, keeps /usr/bin/chord.
# Then as a user, because Chromium won't run as root: test:packaged under Xvfb.
#
# The container can't make user namespaces (its seccomp filter refuses them),
# but root in it keeps CAP_SYS_ADMIN, as root on a real machine has. So Chord
# can only start on its setuid sandbox helper, as on a Fedora or RHEL machine
# with user namespaces turned off. Chord never runs unsandboxed: if it starts,
# that sandbox works. Where user namespaces work, Chromium uses them instead;
# the .deb's smoke test on the Ubuntu runner covers that path.
set -euo pipefail

rpm_file=$(realpath "${1:?usage: $0 <Chord-*.rpm>}")
root=$(cd "$(dirname "$0")/../.." && pwd)
image=${RPM_SMOKE_IMAGE:-registry.fedoraproject.org/fedora:44}
node_home=$(dirname "$(dirname "$(command -v node)")")
uid=$(id -u)
if [ "$uid" = 0 ]; then
  echo "Run this as a user: Chord runs in the container under the same user ID." >&2
  exit 1
fi

name="chord-rpm-smoke-$$"
tmp=$(mktemp -d)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# Everything is allowed except making a user namespace: clone and unshare with
# CLONE_NEWUSER (0x10000000) fail, and clone3 reports ENOSYS so glibc uses clone.
cat > "$tmp/seccomp.json" <<'EOF'
{
  "defaultAction": "SCMP_ACT_ALLOW",
  "syscalls": [
    { "names": ["clone", "unshare"], "action": "SCMP_ACT_ERRNO", "errnoRet": 1,
      "args": [{ "index": 0, "value": 268435456, "valueTwo": 268435456, "op": "SCMP_CMP_MASKED_EQ" }] },
    { "names": ["clone3"], "action": "SCMP_ACT_ERRNO", "errnoRet": 38 }
  ]
}
EOF

# No AppArmor, as on Fedora. The checkout is mounted at the same path, so test
# results land in it, owned by this user.
docker run --detach --name "$name" \
  --cap-add SYS_ADMIN --security-opt seccomp="$tmp/seccomp.json" --security-opt apparmor=unconfined \
  --volume "$root:$root" --volume "$rpm_file:/tmp/chord.rpm:ro" --volume "$node_home:/opt/node:ro" \
  --env CI --env GITHUB_ACTIONS --env TEST_UID="$uid" \
  --workdir "$root" "$image" sleep infinity >/dev/null

docker exec -i "$name" bash -euo pipefail -s <<'EOF'
step() { echo "[rpm] $1"; }
step "$(cat /etc/fedora-release), $(uname -m)"

step 'dnf install, on a bare Fedora image'
dnf -y -q install --setopt=install_weak_deps=False /tmp/chord.rpm
rpm -qi chord | grep -E '^(Name|Version|Architecture|Summary|License|URL) *:'

step 'Every library that Chord and its helpers link is installed'
missing=$(for file in /opt/Chord/chord /opt/Chord/chrome-sandbox /opt/Chord/chrome_crashpad_handler /opt/Chord/*.so*; do
  ldd "$file" | sed "s|^|$file:|"
done | grep 'not found' || true)
if [ -n "$missing" ]; then echo "$missing"; exit 1; fi

step 'chrome-sandbox is setuid root, and nothing differs from the package'
stat -c '%A %U:%G %n' /opt/Chord/chrome-sandbox
[ "$(stat -c '%a %U:%G' /opt/Chord/chrome-sandbox)" = '4755 root:root' ]
rpm -V chord

step 'The .desktop file, icons and command'
desktop=/usr/share/applications/com.chordbrowser.Chord.desktop
cat "$desktop"
grep -qE '^MimeType=.*x-scheme-handler/https' "$desktop"
grep -qE '^Exec=.* %U$' "$desktop"
grep -qx 'Icon=chord' "$desktop"
grep -qx 'StartupWMClass=com.chordbrowser.Chord' "$desktop"
for size in 16 24 32 48 64 128 256 512; do
  test -s "/usr/share/icons/hicolor/${size}x${size}/apps/chord.png"
done
ls /usr/share/icons/hicolor/*/apps/chord.png
[ "$(readlink -f /usr/bin/chord)" = /opt/Chord/chord ]
[ "$(cat /opt/Chord/resources/package-type)" = rpm ]

step 'A reinstall, which runs the same scripts as an upgrade, keeps /usr/bin/chord'
dnf -y -q reinstall /tmp/chord.rpm
[ "$(readlink -f /usr/bin/chord)" = /opt/Chord/chord ]
[ "$(stat -c '%a' /opt/Chord/chrome-sandbox)" = 4755 ]

step 'Xvfb, and a user to run Chord'
dnf -y -q install --setopt=install_weak_deps=False xorg-x11-server-Xvfb xorg-x11-xauth
useradd --create-home --uid "$TEST_UID" tester
EOF

echo '[rpm] test:packaged against /opt/Chord/chord, on the setuid sandbox'
docker exec -i --user tester --workdir "$root/apps/desktop" \
  --env HOME=/home/tester --env PATH=/opt/node/bin:/usr/bin:/bin --env CHORD_APP=/opt/Chord/chord \
  "$name" xvfb-run -a npm run --silent test:packaged

docker exec -i "$name" bash -euo pipefail -s <<'EOF'
echo '[rpm] dnf remove takes everything with it'
dnf -y -q remove chord
for path in /usr/bin/chord /opt/Chord /usr/share/applications/com.chordbrowser.Chord.desktop /usr/share/icons/hicolor/512x512/apps/chord.png; do
  if [ -e "$path" ] || [ -L "$path" ]; then echo "$path is still there"; exit 1; fi
done
EOF
