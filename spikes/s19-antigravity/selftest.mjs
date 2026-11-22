// S19 self-test: the lockdown policy against recorded agy 1.5.14 streams
// (fixtures/*.jsonl, made by container-run.sh with the stand-in model) and a
// few hand cases. No agy, no network: `node selftest.mjs`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agyEnv, checkInitialize, chordTool, outOfTurn, permissionAnswer, privateSettings, trips } from './policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OFFERED = ['list_tabs', 'read_page'];
let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};
const load = (name) =>
  readFileSync(join(here, 'fixtures', name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

for (const [file, firstForeign] of [
  ['attack.jsonl', 'write_file'],
  ['search.jsonl', 'search_web'],
]) {
  const stream = load(file);
  test(`${file}: Chord's tools are allowed, nothing else`, () => {
    for (const { dir, m } of stream) {
      if (dir !== 'in' || m.method !== 'session/request_permission') continue;
      const answer = permissionAnswer(m.params, OFFERED);
      assert.equal(answer.allow, m.params.toolCall.name.startsWith('mcp_chord_'), m.params.toolCall.name);
      assert.equal(answer.outcome.optionId, answer.allow ? 'allow' : 'deny');
    }
  });
  test(`${file}: the tripwire fires on the first foreign tool call (${firstForeign})`, () => {
    const tripped = stream.filter(({ dir, m }) => dir === 'in' && trips(m.params?.update, OFFERED)).map(({ m }) => m.params.update.name);
    assert.equal(tripped[0], firstForeign);
  });
  test(`${file}: the key never reaches the record`, () => {
    const auth = stream.find(({ m }) => m.method === 'authenticate');
    assert.equal(auth.m.params._meta.apiKey, '<key>');
  });
  test(`${file}: agy says who it is and offers an allowed sign-in`, () => {
    const init = stream.find(({ dir, m }) => dir === 'in' && m.id === 1).m.result;
    assert.deepEqual(checkInitialize(init), {
      name: 'Antigravity ACP Server',
      version: '1.5.14',
      offersAllowed: ['gemini-api-key', 'oauth-business', 'agent-platform'],
      http: false,
    });
  });
}

test("a lookalike or unoffered tool is not Chord's", () => {
  for (const name of ['mcp_chord_open_tab', 'mcp_chordx_list_tabs', 'chord_list_tabs', 'mcp_chord_', 'list_tabs', undefined]) assert.equal(chordTool(name, OFFERED), null, String(name));
  assert.equal(chordTool('mcp_chord_read_page', OFFERED), 'read_page');
});

test('never allow_always, even for Chord', () => {
  const answer = permissionAnswer(
    {
      toolCall: { name: 'mcp_chord_list_tabs' },
      options: [
        { optionId: 'a', kind: 'allow_always' },
        { optionId: 'd', kind: 'reject_once' },
      ],
    },
    OFFERED,
  );
  assert.equal(answer.allow, false);
  assert.deepEqual(answer.outcome, { outcome: 'cancelled' });
});

test('a request with no reject option is cancelled', () => {
  assert.deepEqual(
    permissionAnswer(
      {
        toolCall: { name: 'run_command' },
        options: [{ optionId: 'a', kind: 'allow_once' }],
      },
      OFFERED,
    ).outcome,
    { outcome: 'cancelled' },
  );
});

test('a tool call while no message is running trips (a schedule timer)', () => {
  const m = {
    method: 'session/update',
    params: {
      update: { sessionUpdate: 'tool_call', name: 'mcp_chord_list_tabs' },
    },
  };
  assert.equal(outOfTurn(m, false), true);
  assert.equal(outOfTurn(m, true), false);
});

test('personal Google sign-in is refused', () => {
  assert.throws(() => privateSettings('oauth-personal'));
  assert.equal(privateSettings('gemini-api-key').toolPermission, 'strict');
});

test("the user's Google variables never reach agy", () => {
  const env = agyEnv(
    {
      PATH: '/bin',
      gemini_api_key: 'x',
      GOOGLE_APPLICATION_CREDENTIALS: '/c.json',
      GEMINI_HOME: '/home/u/.gemini',
      AGY_ADC_AUTH: 'true',
    },
    { geminiHome: '/p', tempDir: '/t' },
  );
  assert.equal(env.gemini_api_key, undefined);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.AGY_ADC_AUTH, undefined);
  assert.equal(env.GEMINI_HOME, '/p');
  assert.equal(env.PATH, '/bin');
});

console.log(`${passed} passed`);
