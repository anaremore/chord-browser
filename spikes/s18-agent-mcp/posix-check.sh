#!/usr/bin/env bash
# Spike S18 M0: the Unix-socket endpoint on Linux (run as root, e.g. `wsl -u root bash posix-check.sh <node> <user>`).
# <user> runs "Chord" and the bridge; `nobody` plays another OS user. Creates no users;
# everything lives under /tmp/chord-s18-posix and is removed at the end.
set -u
NODE="$1"; ME="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
W=/tmp/chord-s18-posix
rm -rf "$W"; mkdir -p "$W"; cp "$HERE"/*.mjs "$W"/; chmod 755 "$W"; chmod 644 "$W"/*.mjs
as() { local u="$1"; shift; setpriv --reuid="$u" --regid="$(id -g "$u")" --clear-groups env HOME=/tmp "$@"; }
# A per-user runtime dir, as systemd-logind makes it (0700, owned by the user).
RT="$W/run-$ME"; mkdir -p "$RT"; chown "$ME:" "$RT"; chmod 700 "$RT"
UD="$W/ud"; mkdir -p "$UD"; chown "$ME:" "$UD"; chmod 700 "$UD"

as "$ME" XDG_RUNTIME_DIR="$RT" "$NODE" "$W/fake-chord.mjs" "$UD" once > "$W/chord.log" 2>&1 &
sleep 1.5
SOCK=$(sed -n 's/^listening //p' "$W/chord.log")
echo "socket: $SOCK"; stat -c '%A %U %n' "$(dirname "$SOCK")" "$SOCK" "$UD/agent-endpoint.json"

echo "== the same user, through the bridge"
(cd /tmp && as "$ME" "$NODE" "$W/fake-client.mjs" "$NODE" "$W/mcp.mjs" "$UD" | cut -c1-160)
grep hello "$W/chord.log" | cut -c1-400

echo "== another user (nobody)"
as nobody "$NODE" -e "require('net').connect(process.argv[1]).on('connect',()=>{console.log('connect: CONNECTED (!)');process.exit()}).on('error',e=>console.log('connect:',e.code))" "$SOCK"
as nobody cat "$UD/agent-endpoint.json" 2>&1 | sed 's/^/read endpoint file: /' | cut -c1-120
# Even if the folder were opened up, the socket file itself:
chmod 755 "$(dirname "$SOCK")"
as nobody "$NODE" -e "require('net').connect(process.argv[1]).on('connect',()=>{console.log('connect with the folder opened up: CONNECTED (socket mode decides)');process.exit()}).on('error',e=>console.log('connect with the folder opened up:',e.code))" "$SOCK"

echo "== bad token, same user"
as "$ME" "$NODE" -e "const c=require('net').connect(process.argv[1]);c.on('connect',()=>c.write(JSON.stringify({type:'hello',token:'00'})+'\n'));c.on('data',d=>console.log('got bytes (!)',String(d)));c.on('close',()=>console.log('bad token: closed by the endpoint, nothing sent'))" "$SOCK"
sleep 0.5
pkill -u "$ME" -f "fake-chord.mjs $UD"
rm -rf "$W"
