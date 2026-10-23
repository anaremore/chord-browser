// A stand-in for `codex app-server` in Duet's adapter tests: JSON-RPC without the "jsonrpc"
// field, one message per line (research §3.2). It calls Chord's dynamic tool, asks to change a
// file (Chord must decline), and, for "run", produces a commandExecution item (the tripwire).
import { createInterface } from 'node:readline';

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

async function runTurn(text, turnId) {
  write({ method: 'turn/started', params: { threadId: thread, turn: { id: turnId } } });
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
