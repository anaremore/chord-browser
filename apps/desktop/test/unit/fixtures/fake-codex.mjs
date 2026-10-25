// A stand-in for `codex app-server` in Duet's adapter tests: JSON-RPC without the "jsonrpc"
// field, one message per line (research §3.2). It calls Chord's dynamic tool, asks to change a
// file (Chord must decline), and, for "run", produces a commandExecution item (the tripwire).
// Asked to draw, it makes an image as Codex's image tool does (when Chord left the tool on),
// saving its own copy under CODEX_HOME/generated_images. Duet's E2E tests run it as Codex too
// (CHORD_DUET_CODEX), so it answers `--version` and `login status` the way codex-cli does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { crc32, deflateSync } from 'node:zlib';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.160.1\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}
/** Chord leaves the image tool on only when Settings allows it. */
const imagesOn = !args.includes('image_generation');

process.on('uncaughtException', (e) => {
  process.stderr.write(String(e?.stack ?? e));
  process.exit(1);
});

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
let serverId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = serverId++;
    waiting.set(id, resolve);
    write({ id, method, params });
  });
const thread = 'thr_fake';
let turn = 0;
let interrupted = false;

/** A solid 64 × 48 PNG, as the image tool returns one (base64). */
function png(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

async function makeImage(text, turnId) {
  const say = (delta) => write({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId, itemId: 'm1', delta } });
  if (!imagesOn) {
    say('images:off');
    return write({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } });
  }
  const id = `ig_${turnId}`;
  write({ method: 'item/started', params: { threadId: thread, turnId, item: { type: 'imageGeneration', id, status: 'in_progress', revisedPrompt: null, result: '', failure: null } } });
  // Long enough for the panel's placeholder to be seen.
  await new Promise((r) => setTimeout(r, 800));
  if (/limit/.test(text)) {
    write({ method: 'item/completed', params: { threadId: thread, turnId, item: { type: 'imageGeneration', id, status: 'failed', revisedPrompt: null, result: '', failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: 1_800_000_000 } } } });
    return write({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } });
  }
  const image = png(64, 48, [230, 120, 40]);
  let savedPath;
  if (process.env.CODEX_HOME) {
    const dir = join(process.env.CODEX_HOME, 'generated_images', thread);
    mkdirSync(dir, { recursive: true });
    savedPath = join(dir, `${id}.png`);
    writeFileSync(savedPath, image);
  }
  write({ method: 'item/completed', params: { threadId: thread, turnId, item: { type: 'imageGeneration', id, status: 'completed', revisedPrompt: 'A cartoon of the page', result: image.toString('base64'), failure: null, ...(savedPath ? { savedPath } : {}) } } });
  say('Here it is.');
  write({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } });
}

async function runTurn(text, turnId) {
  write({ method: 'turn/started', params: { threadId: thread, turn: { id: turnId } } });
  if (/draw|cartoon/i.test(text)) return makeImage(text, turnId);
  if (/run/.test(text)) {
    write({ method: 'item/started', params: { threadId: thread, turnId, item: { type: 'commandExecution', id: 'cmd_1' } } });
    await new Promise((r) => setTimeout(r, 50));
    write({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: interrupted ? 'interrupted' : 'completed' } } });
    return;
  }
  const tool = await ask('item/tool/call', { threadId: thread, turnId, callId: 'c1', namespace: 'chord', tool: 'read_tab', arguments: { tab_id: 't1' } });
  const decision = await ask('item/fileChange/requestApproval', { threadId: thread, turnId, itemId: 'fc_1' });
  write({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId, itemId: 'm1', delta: `tool:${tool.contentItems?.[0]?.text ?? ''} ` } });
  write({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId, itemId: 'm1', delta: `file:${decision.decision}` } });
  // codex-cli 0.160.1's shape: the last request's tokens, the thread's total, and the window (null when unknown).
  const breakdown = (totalTokens) => ({ totalTokens, inputTokens: totalTokens - 840, cachedInputTokens: 20_000, cacheWriteInputTokens: 0, outputTokens: 840, reasoningOutputTokens: 0 });
  write({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId, tokenUsage: { total: breakdown(51_680), last: breakdown(25_840), modelContextWindow: 258_400 } } });
  write({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    const resolve = waiting.get(m.id);
    waiting.delete(m.id);
    return resolve?.(m.result ?? {});
  }
  switch (m.method) {
    case 'initialize':
      return write({ id: m.id, result: { userAgent: 'fake', platformOs: process.platform } });
    case 'initialized':
      return;
    case 'mcpServerStatus/list':
      return write({ id: m.id, result: { data: [{ name: 'users_own_server' }], nextCursor: null } });
    case 'model/list':
      return write({ id: m.id, result: { data: [{ id: 'fake-model', isDefault: true, hidden: false }] } });
    case 'thread/start':
      // Echo what Chord asked for, so the test can check the browse-mode restrictions.
      process.stderr.write(`THREAD_START ${JSON.stringify(m.params)}\n`);
      return write({ id: m.id, result: { thread: { id: thread } } });
    case 'thread/resume':
      return write({ id: m.id, error: { code: -1, message: 'no rollout found' } });
    case 'turn/start': {
      const turnId = `turn_${++turn}`;
      interrupted = false;
      write({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      const pictures = m.params.input.filter((i) => i.type === 'image');
      if (pictures.length) {
        // An image goes as a data URL, before the words.
        const said = `images:${pictures.map((i) => i.url.slice(0, i.url.indexOf(';'))).join(',')} first:${m.params.input[0].type}`;
        write({ method: 'turn/started', params: { threadId: thread, turn: { id: turnId } } });
        write({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId, itemId: 'm1', delta: said } });
        write({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } });
        return;
      }
      void runTurn(m.params.input.map((i) => i.text).join(''), turnId);
      return;
    }
    case 'turn/interrupt':
      interrupted = true;
      return write({ id: m.id, result: {} });
    default:
      return write({ id: m.id, error: { code: -32601, message: `no ${m.method}` } });
  }
});
