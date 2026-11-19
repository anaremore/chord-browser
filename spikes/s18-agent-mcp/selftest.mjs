// Spike S18 M0: every path, with the fake client and the fake Chord, no real agent.
// Usage: node selftest.mjs   (exits 1 on a failure). The shape M1's unit tests take.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpClient } from './fake-client.mjs';
import { fakeChord } from './fake-chord.mjs';
import { REFUSALS } from './tools.mjs';

const bridge = (ud) => mcpClient(process.execPath, [join(import.meta.dirname, 'mcp.mjs'), ud]);
const text = (r) => r.result.content[0].text;
const results = [];
async function test(name, fn) {
  const ud = mkdtempSync(join(tmpdir(), 'chord-s18-test-'));
  const t0 = performance.now();
  try {
    await fn(ud);
    results.push(`ok   ${name} (${Math.round(performance.now() - t0)} ms)`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
}
const quiet = () => {};

await test('Chord not running: initialize and tools/list still work, calls say so', async (ud) => {
  const c = bridge(ud);
  assert.equal((await c.initialize()).result.serverInfo.name, 'chord');
  assert.ok((await c.request('tools/list', {})).result.tools.some((t) => t.name === 'open_tab'));
  const r = await c.call('list_tabs');
  assert.equal(r.result.isError, true);
  assert.equal(text(r), REFUSALS.closed);
  // Chord opens later: the next call reaches it, without restarting the agent.
  const chord = await fakeChord({ userData: ud, log: quiet });
  assert.equal((await c.call('list_tabs')).result.isError, false);
  c.close();
  chord.close();
});

await test('allowed: open_tab then read_tab, untrusted JSON with its origin', async (ud) => {
  const chord = await fakeChord({ userData: ud, log: quiet });
  const c = bridge(ud);
  await c.initialize();
  const open = JSON.parse(text(await c.call('open_tab', { url: 'https://example.com/' })));
  const read = JSON.parse(text(await c.call('read_tab', { tab_id: open.tab_id })));
  assert.equal(read.trust, 'untrusted');
  assert.equal(read.origin, 'https://example.com');
  assert.equal(text(await c.call('close_tab', { tab_id: 's1' })), 'That tab is the user’s.');
  c.close();
  chord.close();
});

await test('denied: every call says so', async (ud) => {
  const chord = await fakeChord({ userData: ud, approve: 'deny', log: quiet });
  const c = bridge(ud);
  await c.initialize();
  for (let i = 0; i < 2; i++) assert.equal(text(await c.call('list_tabs')), REFUSALS.denied);
  c.close();
  chord.close();
});

await test('waiting: a call held past waitMs answers "waiting"; after the yes, calls work', async (ud) => {
  const chord = await fakeChord({ userData: ud, approve: 'delay:600', waitMs: 200, log: quiet });
  const c = bridge(ud);
  await c.initialize();
  assert.equal(text(await c.call('list_tabs')), REFUSALS.waiting);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await c.call('list_tabs')).result.isError, false);
  c.close();
  chord.close();
});

await test('a slow card inside waitMs: the call just waits', async (ud) => {
  const chord = await fakeChord({ userData: ud, approve: 'delay:500', waitMs: 2000, log: quiet });
  const c = bridge(ud);
  await c.initialize();
  assert.equal((await c.call('list_tabs')).result.isError, false);
  c.close();
  chord.close();
});

await test('stopped: Stop refuses every later call', async (ud) => {
  const chord = await fakeChord({ userData: ud, log: quiet });
  const c = bridge(ud);
  await c.initialize();
  assert.equal((await c.call('list_tabs')).result.isError, false);
  chord.stopAll();
  assert.equal(text(await c.call('list_tabs')), REFUSALS.stopped);
  c.close();
  chord.close();
});

await test('Chord quits mid-call: the call in flight and the next one say "not open"', async (ud) => {
  const chord = await fakeChord({ userData: ud, approve: 'delay:5000', waitMs: 10000, log: quiet });
  const c = bridge(ud);
  await c.initialize();
  const inFlight = c.call('list_tabs');
  await new Promise((r) => setTimeout(r, 300));
  chord.close();
  assert.equal(text(await inFlight), REFUSALS.closed);
  assert.equal(text(await c.call('list_tabs')), REFUSALS.closed);
  c.close();
});

await test('no token or a wrong one: the endpoint sends nothing and hangs up', async (ud) => {
  const chord = await fakeChord({ userData: ud, log: quiet });
  for (const hello of [null, { type: 'hello', token: '00' }]) {
    const got = await new Promise((resolve) => {
      let bytes = '';
      const s = connect(chord.path);
      s.on('connect', () => hello && s.write(`${JSON.stringify(hello)}\n`));
      s.on('data', (d) => (bytes += d));
      s.on('close', () => resolve(bytes));
      s.on('error', () => resolve(bytes));
    });
    assert.equal(got, '');
  }
  chord.close();
});

console.log(results.join('\n'));
