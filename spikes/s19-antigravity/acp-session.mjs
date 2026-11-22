// S19 prototype: one locked-down `agy acp` session with Chord's read tools.
// A throwaway, never in the app: it runs from this folder only.
//
//   AGY=<path to agy> AGY_KEY_FILE=<file holding a Gemini API key> \
//     node acp-session.mjs [--record out.jsonl] "Your message" ["Next message" ...]
//
// It makes a private GEMINI_HOME and an empty folder under the temp folder,
// signs in with the key (never a cached Google login), offers `list_tabs` and
// `read_page` from stand-in-chord.mjs, allows only those, rejects every other
// permission request and stops the turn on any other tool call. It removes
// the private home afterwards. The key is never printed or recorded.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agyArgs, agyEnv, checkInitialize, outOfTurn, permissionAnswer, privateSettings, trips } from './policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const recordAt = argv[0] === '--record' ? argv.splice(0, 2)[1] : null;
const messages = argv.length ? argv : ['Call list_tabs, then read_page on the tab it returns, and give the page title.'];
const BIN = process.env.AGY ?? 'agy';
const KEY = readFileSync(process.env.AGY_KEY_FILE ?? '', 'utf8').trim();
if (!KEY) throw new Error('Set AGY_KEY_FILE to a file holding a Gemini API key.');
const OFFERED = ['list_tabs', 'read_page'];

const root = mkdtempSync(join(tmpdir(), 'chord-s19-'));
const geminiHome = join(root, 'gemini');
const work = join(root, 'empty');
const temp = join(root, 'tmp');
for (const d of [join(geminiHome, 'antigravity-acp'), work, temp]) mkdirSync(d, { recursive: true, mode: 0o700 });
writeFileSync(join(geminiHome, 'antigravity-acp', 'settings.json'), JSON.stringify(privateSettings('gemini-api-key'), null, 2), { mode: 0o600 });

const redact = (s) => s.split(KEY).join('<key>');
const record = (dir, m) => recordAt && appendFileSync(recordAt, redact(JSON.stringify({ dir, m })) + '\n');
const say = (...a) => console.log(redact(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));

const env = agyEnv(process.env, { geminiHome, tempDir: temp });
if (process.env.S19_FAKE_GEMINI) env.GOOGLE_GEMINI_BASE_URL = process.env.S19_FAKE_GEMINI; // the self-test's stand-in model
const child = spawn(BIN, agyArgs(geminiHome), {
  cwd: work,
  env,
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '',
  nextId = 0,
  promptRunning = false,
  tripped = null,
  sessionId = null;
const pending = new Map();
const write = (m) => {
  record('out', m);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
};
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    write({ id, method, params });
  });

child.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    record('in', m);
    if (m.id != null && !m.method && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      continue;
    }
    if (m.method === 'session/request_permission') {
      const answer = permissionAnswer(m.params, OFFERED);
      say(answer.allow ? '  allowed' : '  rejected', m.params?.toolCall?.name ?? m.params?.toolCall?.title);
      write({ id: m.id, result: { outcome: answer.outcome } });
      continue;
    }
    if (m.method === 'session/update') {
      const u = m.params?.update;
      if (outOfTurn(m, promptRunning) || (promptRunning && trips(u, OFFERED))) {
        tripped ??= u?.name ?? u?.title;
        say(`  tripwire: ${tripped}`);
        if (sessionId) write({ method: 'session/cancel', params: { sessionId } });
      } else if (u?.sessionUpdate === 'agent_message_chunk') process.stdout.write(redact(u.content?.text ?? ''));
      else if (u?.sessionUpdate === 'tool_call') say(`  tool: ${u.name ?? u.title}`);
      continue;
    }
    // Chord advertises no fs or terminal: anything else agy asks for is refused.
    if (m.method && m.id != null)
      write({
        id: m.id,
        error: { code: -32601, message: 'Chord does not offer this.' },
      });
  }
});

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'chord', title: 'Chord', version: 'spike' },
  });
  const seen = checkInitialize(init.result);
  say('agy:', seen);
  if (!seen.offersAllowed.includes('gemini-api-key')) throw new Error('This agy offers no API-key sign-in.');
  const auth = await request('authenticate', {
    methodId: 'gemini-api-key',
    _meta: { apiKey: KEY },
  });
  if (auth.error) throw new Error(`Sign-in failed: ${auth.error.message}`);
  const created = await request('session/new', {
    cwd: work,
    mcpServers: [
      {
        name: 'chord',
        command: process.execPath,
        args: [join(here, 'stand-in-chord.mjs')],
        env: [],
      },
    ],
  });
  if (created.error) throw new Error(`No session: ${created.error.message}`);
  sessionId = created.result.sessionId;
  say(
    'modes:',
    created.result.modes?.availableModes?.map((m) => m.id),
    'current:',
    created.result.modes?.currentModeId,
  );
  for (const text of messages) {
    say(`\n> ${text}`);
    promptRunning = true;
    const r = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    promptRunning = false;
    say(`\n< ${r.result?.stopReason ?? r.error?.message}${tripped ? ` (tripwire: ${tripped})` : ''}`);
    if (tripped) break;
  }
  const left = readdirSync(work);
  say(left.length ? `The empty folder isn't empty: ${left.join(', ')}` : 'The empty folder is still empty.');
} finally {
  child.stdin.end();
  setTimeout(() => {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }, 1000);
}
