// A stand-in for Claude Code, for the Duet screenshot only (shots.spec.ts).
// It speaks the same stream-json protocol as the E2E fake (test/e2e/fake-claude.mjs)
// and reads the attached tab through Chord's real read_tab tool. Its answer is the page's own
// first sentence about chords, cited, so nothing on screen is invented about the page.
// Started by Duet through CHORD_DUET_CLAUDE (development builds only).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

process.on('uncaughtException', (e) => {
  process.stderr.write(String(e?.stack ?? e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  process.stderr.write(String(e?.stack ?? e));
  process.exit(1);
});

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args[0] === '--version') {
  process.stdout.write('2.1.309 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  process.exit(0);
}

const projects = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(projects, { recursive: true });
const session = flag('--resume') ?? flag('--session-id');
const sessionFile = join(projects, `${session}.jsonl`);

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
let next = 0;
const waiting = new Map();
let inited = false;

const callTool = (name, input) =>
  new Promise((resolve) => {
    const id = `demo-${++next}`;
    waiting.set(id, resolve);
    write({ type: 'control_request', request_id: id, request: { subtype: 'mcp_message', server_name: 'chord', message: { jsonrpc: '2.0', id: next, method: 'tools/call', params: { name, arguments: input } } } });
  });
const toolText = (response) => response?.mcp_response?.result?.content?.[0]?.text ?? '';
const say = async (text) => {
  for (const word of text.split(/(?<= )/)) {
    write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } }, session_id: session });
    await new Promise((r) => setTimeout(r, 12));
  }
};

async function turn(text) {
  const ref = /Attached: tab (t\d+)/.exec(text)?.[1];
  let answer = 'Attach a tab and I can tell you what it says.';
  if (ref) {
    const page = JSON.parse(toolText(await callTool('read_tab', { tab_id: ref })) || '{}');
    const content = String(page.content ?? '').replace(/\s+/g, ' ');
    const sentences = content.split(/(?<=[.!?])\s+/);
    const first = sentences.find((s) => /\bchord is\b/i.test(s)) ?? sentences.find((s) => s.length > 40) ?? '';
    const quote = first.split(' ').slice(0, 12).join(' ');
    answer = first
      ? `In the article's own words: ${first} [[${ref}:"${quote}"]]`
      : 'I couldn’t find the article’s text on this tab.';
  }
  await say(answer);
  appendFileSync(sessionFile, `${JSON.stringify({ at: Date.now() })}\n`);
  write({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: session });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request.subtype === 'initialize') {
    return write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [] } } });
  }
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
    return write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  }
  if (m.type === 'control_response') {
    const resolve = waiting.get(m.response.request_id);
    waiting.delete(m.response.request_id);
    return resolve?.(m.response.response);
  }
  if (m.type === 'user') {
    if (!inited) {
      inited = true;
      write({ type: 'system', subtype: 'init', session_id: session, tools: ['mcp__chord__read_tab'], capabilities: ['interrupt_receipt_v1'], claude_code_version: '2.1.309' });
    }
    void turn(m.message.content.map((c) => c.text).join(''));
  }
});
process.stdin.on('end', () => process.exit(0));
