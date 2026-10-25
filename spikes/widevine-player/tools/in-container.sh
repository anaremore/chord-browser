#!/bin/sh
# Inside the Linux E2E image (run-linux.mjs): download and verify the runtimes,
# then run run.mjs under Xvfb with openbox (x11) or headless Weston (wayland).
#   sh tools/in-container.sh x11|wayland [run.mjs options]
set -e
display="$1"
shift
spike=/work/spikes/widevine-player
node "$spike/tools/fetch.mjs" --dest /tmp/wv-runtime --cache /home/chord/.cache/wv-spike >/tmp/fetch.log 2>&1 || { cat /tmp/fetch.log; exit 3; }
ulimit -c 0
if [ "$display" = x11 ]; then
  exec xvfb-run -a -s "-screen 0 1920x1080x24" sh -c '
    ready="$(mktemp -u)"
    openbox --startup "touch $ready" &
    for i in $(seq 1 100); do [ -e "$ready" ] && break; sleep 0.1; done
    exec node /work/spikes/widevine-player/run.mjs --runtime /tmp/wv-runtime --out /work/results --work /tmp/wv-work "$@"' sh "$@"
else
  XDG_RUNTIME_DIR="$(mktemp -d)"
  export XDG_RUNTIME_DIR
  chmod 700 "$XDG_RUNTIME_DIR"
  weston --backend=headless --socket=wayland-s14 --idle-time=0 --width=1920 --height=1080 >/tmp/weston.log 2>&1 &
  for i in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/wayland-s14" ] && break; sleep 0.1; done
  unset DISPLAY
  export WAYLAND_DISPLAY=wayland-s14 XDG_SESSION_TYPE=wayland
  exec node "$spike/run.mjs" --runtime /tmp/wv-runtime --out /work/results --work /tmp/wv-work "$@"
fi
