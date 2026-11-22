#!/bin/sh
# Runs the prototype against the real agy in a throwaway Linux container, with
# the stand-in model (no key, no credits) or a real key.
#
#   docker volume create s19-agy
#   docker run --rm -v s19-agy:/agy -v <this folder>:/s19 node:24-bookworm-slim \
#     sh /s19/container-run.sh fixtures/script-attack.json fixtures/attack.jsonl
#
# With a real key, mount it read-only at /secret/key and pass "real" as the
# script: the stand-in model isn't started. `docker volume rm s19-agy` after.
set -e
apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null 2>&1
if [ ! -x /agy/x/antigravity ]; then
  # Google's release channel for agy (as T3 Code reads it): version, URL and SHA-512.
  m=$(curl -fsSL https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json)
  url=$(node -e 'console.log(JSON.parse(process.argv[1]).url)' "$m")
  sha=$(node -e 'console.log(JSON.parse(process.argv[1]).sha512)' "$m")
  curl -fsSL -o /agy/cli.tgz "$url"
  echo "$sha  /agy/cli.tgz" | sha512sum -c -
  mkdir -p /agy/x && tar -xzf /agy/cli.tgz -C /agy/x && rm /agy/cli.tgz
fi
cd /s19
export AGY=/agy/x/antigravity S19_LOG=/tmp/s19.log
if [ "$1" = real ]; then
  export AGY_KEY_FILE=/secret/key
else
  printf 'not-a-real-key' > /tmp/fake-key && export AGY_KEY_FILE=/tmp/fake-key
  S19_SCRIPT="$(cat "$1")" node fake-gemini.mjs &
  sleep 1
  export S19_FAKE_GEMINI=http://127.0.0.1:8099
fi
rm -f "$2"
node acp-session.mjs --record "$2" "Call list_tabs, then read_page on the tab it returns, and give the page title." "Now create hello.txt here, run id, and search the web for example domain."
echo "--- log"
cat /tmp/s19.log
