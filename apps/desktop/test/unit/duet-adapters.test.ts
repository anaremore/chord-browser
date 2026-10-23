/**
 * Duet's provider adapters against fake CLIs that speak each protocol
 * (Claude's stream-json with the control channel, Codex's app-server), so CI
 * never needs the real CLIs or the network.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DUET_TOOLS } from '@chord/core';
import { describe, expect, it } from 'vitest';
import type { ProviderError, SessionEvents, SessionOptions, ToolOutput } from '../../src/main/duet/adapter';
import { ClaudeSession, claudeArgs, claudeError } from '../../src/main/duet/claude';
import { CodexSession, codexArgs, codexError } from '../../src/main/duet/codex';

const fakeClaude = resolve(import.meta.dirname, '../e2e/fake-claude.mjs');
const fakeCodex = resolve(import.meta.dirname, 'fixtures/fake-codex.mjs');

function options(script: string, extra: Partial<SessionOptions> = {}): SessionOptions {
  const dir = mkdtempSync(join(tmpdir(), 'chord-duet-unit-'));
  const instructionsFile = join(dir, 'instructions.md');
  writeFileSync(instructionsFile, 'Duet test instructions');
  return {
    launch: { command: process.execPath, prefix: [script], env: { ...process.env, CLAUDE_CONFIG_DIR: dir } },
    cwd: dir,
    model: null,
    instructions: 'Duet test instructions',
    instructionsFile,
    resumeId: null,
    newSessionId: '11111111-2222-4333-8444-555555555555',
    tools: DUET_TOOLS,
    ...extra,
  };
}

function recorder(tool: (name: string, args: Record<string, unknown>) => ToolOutput = () => ({ text: '{"content":"from chord"}' })) {
  const seen = { text: '', tools: [] as { name: string; args: Record<string, unknown> }[], ends: [] as { status: string; error?: ProviderError }[], exits: [] as (ProviderError | null)[], session: '' };
  let ended: () => void = () => undefined;
  const turnEnded = () => new Promise<void>((done) => (ended = done));
  const events: SessionEvents = {
    onSessionId: (id) => (seen.session = id),
    onText: (delta) => (seen.text += delta),
    onTool: async (name, args) => {
      seen.tools.push({ name, args });
      return tool(name, args);
    },
    onTurnEnd: (outcome) => {
      seen.ends.push(outcome);
      ended();
    },
    onExit: (error) => {
      seen.exits.push(error);
      ended();
    },
  };
  return { seen, events, turnEnded };
}

describe('Claude Code adapter', () => {
  it('starts browse mode with no built-in tools and none of the user’s settings', () => {
    const args = claudeArgs({ model: 'sonnet', instructionsFile: 'x.md', resumeId: null, newSessionId: 'abc' });
    expect(args).toEqual(expect.arrayContaining(['--restricted', '--disable-slash-commands', '--strict-mcp-config', '--permission-prompts', 'none', '--session-id', 'abc', '--model', 'sonnet']));
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--bare');
    expect(claudeArgs({ model: null, instructionsFile: 'x.md', resumeId: 'old', newSessionId: 'abc' })).toEqual(expect.arrayContaining(['--resume', 'old']));
  });

  it('answers Chord’s tools on the control channel and streams the reply', async () => {
    const { seen, events, turnEnded } = recorder((name) => (name === 'read_tab' ? { text: JSON.stringify({ content: 'Chords are three notes' }) } : {}));
    const session = new ClaudeSession(options(fakeClaude), events);
    const ended = turnEnded();
    session.send('Summarize this page\n\nAttached: tab t1 · example.com');
    await ended;
    expect(seen.tools).toEqual([{ name: 'read_tab', args: { tab_id: 't1' } }]);
    expect(seen.text).toBe('Here is the gist. [[t1:"Chords are three notes"]]');
    expect(seen.ends).toEqual([{ status: 'done' }]);
    expect(seen.session).toBe('11111111-2222-4333-8444-555555555555');
    session.close();
  });

  it('stops a reply with the control-channel interrupt', async () => {
    const { seen, events, turnEnded } = recorder();
    const session = new ClaudeSession(options(fakeClaude), events);
    const ended = turnEnded();
    session.send('write something long');
    await new Promise((r) => setTimeout(r, 150));
    session.stop();
    await ended;
    expect(seen.ends.at(-1)?.status).toBe('interrupted');
    expect(seen.text.length).toBeLessThan(400 * 6);
    session.close();
  });

  it('reports a session it can’t resume, so Duet can start over from a summary', async () => {
    const { seen, events, turnEnded } = recorder();
    const ended = turnEnded();
    new ClaudeSession(options(fakeClaude, { resumeId: '99999999-0000-4000-8000-000000000000' }), events);
    await ended;
    expect(seen.exits[0]?.kind).toBe('resume-failed');
  });

  it('maps provider errors to plain causes and fixes', () => {
    expect(claudeError('authentication_failed', '').message).toContain('claude auth login');
    expect(claudeError('rate_limit', '').kind).toBe('rate-limit');
  });
});

describe('Codex adapter', () => {
  it('turns off every model-callable feature it can and disables web search', () => {
    const args = codexArgs();
    for (const feature of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use']) expect(args.join(' ')).toContain(`--disable ${feature}`);
    expect(args).toContain('web_search="disabled"');
  });

  it('calls Chord’s dynamic tools and declines file changes without asking', async () => {
    const { seen, events, turnEnded } = recorder(() => ({ text: 'page text' }));
    const session = new CodexSession(options(fakeCodex), events);
    const ended = turnEnded();
    session.send('summarize');
    await ended;
    expect(seen.tools).toEqual([{ name: 'read_tab', args: { tab_id: 't1' } }]);
    expect(seen.text).toBe('tool:page text file:decline');
    expect(seen.ends).toEqual([{ status: 'done' }]);
    expect(seen.session).toBe('thr_fake');
    session.close();
  });

  it('stops a turn that produces anything outside browse mode (the tripwire)', async () => {
    const { seen, events, turnEnded } = recorder();
    const session = new CodexSession(options(fakeCodex), events);
    const ended = turnEnded();
    session.send('run dir');
    await ended;
    expect(seen.ends.at(-1)).toMatchObject({ status: 'error', error: { kind: 'tripwire' } });
    session.close();
  });

  it('maps usage limits, including when they reset', () => {
    const error = codexError('usageLimitExceeded', 'You’ve hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Nov 16th, 2026 5:07 PM.');
    expect(error.kind).toBe('usage-limit');
    expect(error.message).toContain('Nov 16th, 2026 5:07 PM');
  });
});
