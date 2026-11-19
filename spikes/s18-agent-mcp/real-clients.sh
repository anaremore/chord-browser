#!/usr/bin/env bash
# Spike S18 M0: the user's real `claude` and `codex` against the spike endpoint (Windows, Git Bash).
# Starts the windowless Electron host, registers `chord` in a throwaway way, runs one cheap turn
# each that calls open_tab and read_tab, and removes everything. Never opens a credential file.
# Usage: bash real-clients.sh [claude|codex|both] [toolDelayMs]
set -u
HERE="$(cd "$(dirname "$0")" && pwd -W)"
E="$(cd "$HERE/../.." && pwd -W)/node_modules/electron/dist/electron.exe"
T="$(cygpath -m "$LOCALAPPDATA/Temp")"
UD="$T/chord-s18-real-ud"
EMPTY="$T/chord-s18-empty"
HL="$T/chord-s18-real-host.log"
WHICH="${1:-both}"
rm -rf "$UD" "$UD-mcp-scratch" "$EMPTY"; mkdir -p "$EMPTY"
APPROVE="${2:-once}"; [[ "$APPROVE" =~ ^[0-9]+$ ]] && APPROVE="delay:$APPROVE"
S18_APPROVE="$APPROVE" "$E" "$HERE/electron-main.mjs" "--spike-user-data=$UD" > "$HL" 2>&1 &
HOST=$!
sleep 4
PROMPT='Use the chord tools only. Call open_tab with url https://example.com/ then read_tab on the tab it returns. Reply with just the page heading.'

if [ "$WHICH" != codex ]; then
  echo "== claude $(claude --version)"
  # The setup line from Settings → Agents, in project scope inside the empty folder (writes only its .mcp.json).
  (cd "$EMPTY" && claude mcp add -s project chord -- "$E" "$HERE/electron-main.mjs" mcp "--spike-user-data=$UD" && cat .mcp.json && claude mcp get chord; claude mcp remove -s project chord)
  # The turn: only Chord's server and tools, a cheap model, the empty folder.
  printf '{"mcpServers":{"chord":{"command":"%s","args":["%s","mcp","--spike-user-data=%s","--spike-log=%s"]}}}' "$E" "$HERE/electron-main.mjs" "$UD" "$T/chord-s18-bridge-claude.log" > "$EMPTY/chord-mcp.json"
  (cd "$EMPTY" && time claude -p --model haiku --strict-mcp-config --mcp-config "$EMPTY/chord-mcp.json" --tools "" --allowedTools 'mcp__chord__*' --output-format stream-json --verbose "$PROMPT" \
    | node -e "require('readline').createInterface({input:process.stdin}).on('line',l=>{try{const m=JSON.parse(l);if(m.type==='system'&&m.subtype==='init')console.log('init mcp_servers',JSON.stringify(m.mcp_servers),'tools',m.tools.filter(t=>t.startsWith('mcp__')).join(','));if(m.type==='assistant')for(const c of m.message.content)if(c.type==='tool_use')console.log('tool_use',c.name,JSON.stringify(c.input));if(m.type==='user')for(const c of m.message.content||[])if(c.type==='tool_result')console.log('tool_result',c.is_error?'ERROR':'ok',JSON.stringify(c.content).slice(0,160));if(m.type==='result')console.log('result',m.subtype,JSON.stringify(m.result).slice(0,200))}catch{}})")
fi

if [ "$WHICH" != claude ]; then
  echo "== codex $(codex --version)"
  # codex mcp add writes the user's config; the turn instead passes the server with -c, which changes nothing on disk.
  codex mcp add --help | sed -n 1,12p
  (cd "$EMPTY" && time codex exec --skip-git-repo-check --json -s read-only \
     -c "mcp_servers.chord.command=\"$E\"" -c "mcp_servers.chord.args=[\"$HERE/electron-main.mjs\",\"mcp\",\"--spike-user-data=$UD\",\"--spike-log=$T/chord-s18-bridge-codex.log\"]" \
     -c "mcp_servers.chord.tool_timeout_sec=${CODEX_TOOL_TIMEOUT:-600}" -c 'web_search="disabled"' \
     -m "${CODEX_MODEL:-gpt-6-luna}" -c 'model_reasoning_effort="low"' --disable shell_tool --disable unified_exec \
     "$PROMPT" < /dev/null \
    | node -e "require('readline').createInterface({input:process.stdin}).on('line',l=>{try{const m=JSON.parse(l);const i=m.item;if(i&&i.type==='mcp_tool_call')console.log(m.type,i.server,i.tool,i.status,JSON.stringify(i.error||i.result||'').slice(0,160));else if(i&&i.type==='agent_message')console.log('agent_message',JSON.stringify(i.text).slice(0,200));else if(m.type==='turn.completed'||m.type==='turn.failed'||m.type==='error')console.log(m.type,JSON.stringify(m.error||m.usage||'').slice(0,200))}catch{}})")
fi

echo "--- host"; grep -v '^\s*$' "$HL"
taskkill //PID "$(powershell -NoProfile -Command "(Get-CimInstance Win32_Process | ? { \$_.CommandLine -like '*chord-s18-real-ud*' -and \$_.CommandLine -notlike '* mcp *' } | Select-Object -First 1).ProcessId")" //T //F > /dev/null 2>&1
kill $HOST 2>/dev/null
rm -rf "$UD" "$UD-mcp-scratch" "$EMPTY"
