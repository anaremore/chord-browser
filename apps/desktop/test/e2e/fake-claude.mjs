// A stand-in for Claude Code in Duet's E2E tests: it speaks the same stream-json protocol, calls
// Chord's tools over the control channel, keeps "session files" under CLAUDE_CONFIG_DIR the way
// Claude does (projects/<cwd as dashes>/<session>.jsonl), and logs how it was launched to
// CLAUDE_CONFIG_DIR/fake-log.jsonl. Started by Duet through CHORD_DUET_CLAUDE (development only).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  // FAKE_CLAUDE_SLOW_VERSION=<ms>: answer late, the way a slow machine does, so Duet is open before it has found Claude.
  await new Promise((done) => setTimeout(done, Number(process.env.FAKE_CLAUDE_SLOW_VERSION ?? 0)));
  // FAKE_CLAUDE_VERSION plays an older Claude Code (1.x has no `auth` command).
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.309'} (Claude Code)\n`);
  process.exit(0);
}
// Logged where the tests can see it; the folder may not exist yet (inside WSL it's a fresh /tmp one).
if (args[0] === 'auth' && process.env.CLAUDE_CONFIG_DIR) {
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  appendFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'auth-asked'), `${args.join(' ')}\n`);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  process.exit(0);
}

const config = process.env.CLAUDE_CONFIG_DIR;
const projects = join(config, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(projects, { recursive: true });
const resume = flag('--resume');
const session = resume ?? flag('--session-id');
const instructions = flag('--append-system-prompt-file');
appendFileSync(
  join(config, 'fake-log.jsonl'),
  `${JSON.stringify({ resume: resume ?? null, session, summary: instructions ? readFileSync(instructions, 'utf8').includes('summary of it') : false, restricted: args.includes('--restricted'), tools: flag('--tools') })}\n`,
);
const sessionFile = join(projects, `${session}.jsonl`);
if (resume && !existsSync(sessionFile)) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
let next = 0;
const waiting = new Map();
let interrupted = false;
let inited = false;

/** A request to Chord's MCP server, over the control channel as Claude Code sends them. */
const mcp = (method, params) =>
  new Promise((resolve) => {
    const id = `fake-${++next}`;
    waiting.set(id, resolve);
    write({ type: 'control_request', request_id: id, request: { subtype: 'mcp_message', server_name: 'chord', message: { jsonrpc: '2.0', id: next, method, params } } });
  });
const callTool = (name, input) => mcp('tools/call', { name, arguments: input });
const toolText = (response) => response?.mcp_response?.result?.content?.[0]?.text ?? '';
const say = async (text, slow = false) => {
  for (const word of text.split(/(?<= )/)) {
    if (interrupted) return false;
    write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } }, session_id: session });
    if (slow) await new Promise((r) => setTimeout(r, 25));
  }
  return true;
};
// Usage as Claude Code 2.1.309 reports it: the turn's requests in usage.iterations, the window in modelUsage.
const MODEL = 'claude-fake-1';
let turns = 0;
const usage = () => {
  const used = { input_tokens: 2, cache_creation_input_tokens: 1998, cache_read_input_tokens: 120_000 + 4000 * (turns - 1), output_tokens: 2000 };
  return {
    usage: { ...used, iterations: [{ ...used, type: 'message' }] },
    modelUsage: { [MODEL]: { inputTokens: 2, outputTokens: 2000, cacheReadInputTokens: used.cache_read_input_tokens, cacheCreationInputTokens: 1998, contextWindow: 200_000, maxOutputTokens: 32_000 } },
  };
};
const finish = (ok) => {
  appendFileSync(sessionFile, `${JSON.stringify({ at: Date.now() })}\n`);
  if (ok) write({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: session, ...usage() });
  else write({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', session_id: session, ...usage() });
};

/** A JPEG's size, from its frame header: what the test checks Chord sent. */
function jpegSize(data) {
  const b = Buffer.from(data, 'base64');
  if (b[0] !== 0xff || b[1] !== 0xd8) return 'not a JPEG';
  for (let i = 2; i + 9 < b.length; i += 2 + b.readUInt16BE(i + 2)) {
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return `${b.readUInt16BE(i + 7)}×${b.readUInt16BE(i + 5)}`;
  }
  return 'no size';
}

async function turn(text, images = []) {
  interrupted = false;
  turns++;
  const ref = /Attached: tab (t\d+)/.exec(text)?.[1];
  if (images.length) {
    const sizes = images.map((i) => `${i.source.media_type} ${jpegSize(i.source.data)}`).join(', ');
    return finish(await say(`I see ${images.length === 1 ? 'one image' : `${images.length} images`}: ${sizes}. You asked: ${text.split('\n')[0]}`));
  }
  // An Effects request (main/effects): it reads the page's outline through Chord's one tool, keeps what it got
  // where the test can see it, and answers in Effects' fixed shape. Its patch tries a fetch too
  // (FAKE_CLAUDE_EVIL: a server that counts requests), which Chord has to take out.
  if (/^Restyle /.test(text)) {
    const result = toolText(await callTool('read_page_outline', {}));
    writeFileSync(join(config, 'effects-outline.json'), result);
    if (/nothing/i.test(text)) return finish(await say(JSON.stringify({ css: '', summary: "CSS can't do that." })));
    const evil = process.env.FAKE_CLAUDE_EVIL ?? 'https://evil.invalid';
    const css = `main h1 { color: rgb(0, 128, 0) } body { background-image: url(${evil}/duet.png) }`;
    return finish(await say(`Here it is:\n\`\`\`json\n${JSON.stringify({ css, summary: 'Green headline' })}\n\`\`\``));
  }
  // What it was given (Duet set to read nothing): the tools Chord lists, the words it was sent, a read it tries
  // anyway (as a page's injected instructions might make it), and its instructions; kept where the test can see them.
  if (/what can you see/i.test(text)) {
    const tools = (await mcp('tools/list', {}))?.mcp_response?.result?.tools ?? [];
    const tried = toolText(await callTool('read_tab', { tab_id: 't1' }));
    writeFileSync(join(config, 'seen.json'), JSON.stringify({ tools: tools.map((t) => t.name), text, images: images.length, tried, instructions: instructions ? readFileSync(instructions, 'utf8') : '' }));
    return finish(await say(tools.length ? `I have ${tools.length} tools.` : 'I have no tools.'));
  }
  // Asked for an image, it says it can't and leaves the mark for Codex's button, as Duet's instructions ask.
  if (/draw|cartoon/i.test(text)) return finish(await say("Claude can't make images.\n\n[[make-image]]"));
  // Writes a tab's handle in its own words, as Duet is asked not to.
  if (/which tab/i.test(text) && ref) return finish(await say(`That's tab ${ref}, the one you attached. Not to be confused with a t2.micro.`));
  if (/long/i.test(text)) return finish(await say(Array.from({ length: 400 }, (_, i) => `word${i} `).join(''), true));
  if (/pdf/i.test(text) && ref) {
    // Quotes the second line of page 2: Chord, not the model, works out which page that is.
    const result = JSON.parse(toolText(await callTool('read_tab', { tab_id: ref })) || '{}');
    if (!result.content) return finish(await say(`I couldn't read it: ${result.data?.refused ?? 'no text'}`));
    const page2 = (String(result.content).split('[Page 2]')[1] ?? '').trim().split('\n');
    const quote = (page2[1] ?? page2[0] ?? '').split(/\s+/).slice(0, 5).join(' ');
    return finish(await say(`The PDF has ${result.pages?.total} pages. Triads sound bright. [[${ref}:"${quote}"]]`));
  }
  if (/summar/i.test(text) && ref) {
    const page = JSON.parse(toolText(await callTool('read_tab', { tab_id: ref })) || '{}');
    const quote = String(page.content ?? '').split(/\s+/).slice(0, 4).join(' ');
    return finish(await say(`Here is the gist. [[${ref}:"${quote}"]]`));
  }
  if (/secret/i.test(text) && ref) {
    const page = JSON.parse(toolText(await callTool('read_tab', { tab_id: ref })) || '{}');
    return finish(await say(`The page says: ${page.content ?? page.refused ?? ''}`));
  }
  if (/list/i.test(text)) {
    const listed = toolText(await callTool('list_tabs', {}));
    return finish(await say(listed.includes('refused') ? 'You said no.' : `I can see ${(JSON.parse(listed).data?.tabs ?? []).length} tabs.`));
  }
  return finish(await say('Hello from the fake.'));
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request.subtype === 'initialize') {
    return write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [] } } });
  }
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
    interrupted = true;
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
      write({ type: 'system', subtype: 'init', session_id: session, model: MODEL, tools: ['mcp__chord__read_tab'], capabilities: ['interrupt_receipt_v1'], claude_code_version: '2.1.309' });
    }
    const content = m.message.content;
    void turn(
      content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
      content.filter((c) => c.type === 'image'),
    );
  }
});
process.stdin.on('end', () => process.exit(0));
writeFileSync(join(config, 'fake-alive'), String(process.pid));
