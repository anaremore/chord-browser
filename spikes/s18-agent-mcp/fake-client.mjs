// Spike S18 M0: a fake MCP client (what M1's tests use instead of Claude Code or Codex).
// Usage: node fake-client.mjs <command> [args…]   e.g. node fake-client.mjs node mcp.mjs <userData>
// Speaks MCP's stdio transport (one JSON-RPC message per line), times initialize, and runs
// tools/list, list_tabs, open_tab and read_tab. CALLS='[…]' (JSON) replaces the default calls.
import { spawn } from 'node:child_process';
import { lines } from './endpoint.mjs';

export function mcpClient(command, args, { env = process.env, clientInfo = { name: 'fake-client', version: '1' } } = {}) {
  const t0 = performance.now();
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
  const waiting = new Map();
  let id = 0;
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  lines(child.stdout, (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return; // Electron or Chromium noise on stdout would land here: none expected.
    }
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  return {
    child,
    t0,
    get stderr() {
      return stderr;
    },
    request,
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    async initialize() {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo });
      this.notify('notifications/initialized');
      return r;
    },
    call: (name, args = {}) => request('tools/call', { name, arguments: args }),
    close: () => child.stdin.end(),
  };
}

if (process.argv[1]?.endsWith('fake-client.mjs')) {
  const [command, ...args] = process.argv.slice(2);
  const c = mcpClient(command, args);
  const ms = () => `${(performance.now() - c.t0).toFixed(0)} ms`;
  const init = await c.initialize();
  console.log('initialize', ms(), JSON.stringify(init.result?.serverInfo));
  const list = await c.request('tools/list', {});
  console.log('tools/list', ms(), list.result?.tools.map((t) => t.name).join(', '));
  const calls = process.env.CALLS ? JSON.parse(process.env.CALLS) : [['list_tabs', {}], ['open_tab', { url: 'https://example.com/' }], ['read_tab', { tab_id: 'a1', length: 200 }]];
  for (const [name, a] of calls) {
    const r = await c.call(name, a);
    console.log(name, ms(), r.result?.isError ? 'ERROR' : 'ok', JSON.stringify(r.result?.content?.[0]?.text ?? r.result?.content?.[0]?.mimeType ?? r.error).slice(0, 240));
  }
  c.close();
  if (c.stderr.trim()) console.log('stderr:', c.stderr.trim().slice(0, 600));
}
