/**
 * Duet's provider adapters against fake CLIs that speak each protocol
 * (Claude's stream-json with the control channel, Codex's app-server), so CI
 * never needs the real CLIs or the network.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DUET_TOOLS, type DuetContextUsage } from '@chord/core';
import { describe, expect, it } from 'vitest';
import type { MadeImage, ProviderError, SessionEvents, SessionOptions, ToolOutput } from '../../src/main/duet/adapter';
import { ClaudeSession, claudeArgs, claudeContextUsage, claudeError } from '../../src/main/duet/claude';
import { CodexSession, codexArgs, codexContextUsage, codexError, imageLimitError } from '../../src/main/duet/codex';

const fakeClaude = resolve(import.meta.dirname, '../e2e/fake-claude.mjs');
const fakeCodex = resolve(import.meta.dirname, 'fixtures/fake-codex.mjs');

function options(script: string, extra: Partial<SessionOptions> = {}): SessionOptions {
  const dir = mkdtempSync(join(tmpdir(), 'chord-duet-unit-'));
  const instructionsFile = join(dir, 'instructions.md');
  writeFileSync(instructionsFile, 'Duet test instructions');
  return {
    launch: { command: process.execPath, prefix: [script], env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CODEX_HOME: dir } },
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
  const seen = {
    text: '',
    tools: [] as { name: string; args: Record<string, unknown> }[],
    ends: [] as { status: string; error?: ProviderError }[],
    exits: [] as (ProviderError | null)[],
    session: '',
    usage: [] as DuetContextUsage[],
    images: [] as (MadeImage | null)[],
    imageStarts: 0,
  };
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
    onUsage: (usage) => seen.usage.push(usage),
    onImageStart: () => seen.imageStarts++,
    onImage: (_callId, image) => seen.images.push(image),
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
    // The result's usage feeds the context meter: 124,000 of a 200,000-token window.
    expect(seen.usage).toEqual([{ used: 124_000, window: 200_000 }]);
    session.close();
  });

  it('sends an image as a base64 block, before the words', async () => {
    const { seen, events, turnEnded } = recorder(() => ({}));
    const session = new ClaudeSession(options(fakeClaude), events);
    const ended = turnEnded();
    // A 2 × 1 JPEG's header is enough for the fake to read its size.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x02, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]).toString('base64');
    session.send('What is this?', [{ mime: 'image/jpeg', data: jpeg }]);
    await ended;
    expect(seen.text).toBe('I see one image: image/jpeg 2×1. You asked: What is this?');
    session.close();
  });

  it('reads how full the context is from the result, as 2.1.309 reports it', () => {
    // Shapes copied from a real 2.1.309 run (haiku), trimmed.
    const result = {
      type: 'result',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 420,
        cache_read_input_tokens: 2527,
        output_tokens: 6,
        iterations: [
          { input_tokens: 3, cache_creation_input_tokens: 400, cache_read_input_tokens: 1000, output_tokens: 50, type: 'message' },
          { input_tokens: 2, cache_creation_input_tokens: 420, cache_read_input_tokens: 2527, output_tokens: 6, type: 'message' },
        ],
      },
      modelUsage: {
        'claude-haiku-5-5': { inputTokens: 1175, outputTokens: 181, cacheReadInputTokens: 3176, cacheCreationInputTokens: 2677, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      },
    };
    // The last request of the turn is what's in the context now.
    expect(claudeContextUsage(result, 'claude-haiku-5-5')).toEqual({ used: 2955, window: 1_000_000 });
    // Without iterations, the last message's usage (from its message_delta).
    const { iterations: _, ...flat } = result.usage;
    expect(claudeContextUsage({ ...result, usage: flat }, 'claude-haiku-5-5', { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 })).toEqual({ used: 105, window: 1_000_000 });
    // Two models (a background helper): only the chat's own model's window counts.
    const two = { ...result, modelUsage: { ...result.modelUsage, 'claude-sonnet-5': { contextWindow: 200_000 } } };
    expect(claudeContextUsage(two, 'claude-sonnet-5')?.window).toBe(200_000);
    expect(claudeContextUsage(two, 'unknown-model')).toBeNull();
    // No window reported: no meter, never a guess.
    expect(claudeContextUsage({ ...result, modelUsage: { 'claude-haiku-5-5': { inputTokens: 1 } } }, 'claude-haiku-5-5')).toBeNull();
    expect(claudeContextUsage({ type: 'result', usage: result.usage }, 'claude-haiku-5-5')).toBeNull();
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
    for (const feature of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'image_generation']) expect(args.join(' ')).toContain(`--disable ${feature}`);
    expect(args).toContain('web_search="disabled"');
    // Making images allowed: only the image tool stays on.
    const withImages = codexArgs(true).join(' ');
    expect(withImages).not.toContain('image_generation');
    expect(withImages).toContain('--disable shell_tool');
  });

  it('makes an image when allowed: Duet gets its bytes, what it was made from, and where Codex saved its copy', async () => {
    const { seen, events, turnEnded } = recorder();
    const opts = options(fakeCodex, { images: true });
    const session = new CodexSession(opts, events);
    const ended = turnEnded();
    session.send('draw a cartoon of this');
    await ended;
    expect(seen.ends).toEqual([{ status: 'done' }]);
    expect(seen.imageStarts).toBe(1);
    const image = seen.images[0]!;
    expect(Buffer.from(image.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(image.prompt).toBe('A cartoon of the page');
    expect(image.savedPath && existsSync(image.savedPath)).toBe(true);
    expect(seen.text).toBe('Here it is.');
    session.close();
  });

  it('keeps the image tool off, and its item a tripwire, unless allowed; a plan’s image limit is the turn’s error', async () => {
    let { seen, events, turnEnded } = recorder();
    let session = new CodexSession(options(fakeCodex), events);
    let ended = turnEnded();
    session.send('draw a cartoon of this');
    await ended;
    expect(seen.text).toBe('images:off');
    expect(seen.images).toEqual([]);
    session.close();

    ({ seen, events, turnEnded } = recorder());
    session = new CodexSession(options(fakeCodex, { images: true }), events);
    ended = turnEnded();
    session.send('draw one past the limit');
    await ended;
    expect(seen.images).toEqual([null]);
    expect(seen.ends[0]).toMatchObject({ status: 'error', error: { kind: 'usage-limit', message: expect.stringMatching(/^Codex has reached your plan's limit for making images\. It resets /) } });
    expect(imageLimitError(null).message).toBe("Codex has reached your plan's limit for making images.");
    session.close();
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
    expect(seen.usage).toEqual([{ used: 25_840, window: 258_400 }]);
    session.close();
  });

  it('sends an image as a data URL, before the words', async () => {
    const { seen, events, turnEnded } = recorder(() => ({}));
    const session = new CodexSession(options(fakeCodex), events);
    const ended = turnEnded();
    session.send('What is this?', [{ mime: 'image/jpeg', data: '/9j/4AAQ' }]);
    await ended;
    expect(seen.text).toBe('images:data:image/jpeg first:image');
    session.close();
  });

  it('reads how full the context is from thread/tokenUsage/updated (0.160.1’s schema)', () => {
    const breakdown = (totalTokens: number) => ({ totalTokens, inputTokens: totalTokens - 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 });
    const params = { threadId: 'thr', turnId: 'turn', tokenUsage: { total: breakdown(90_000), last: breakdown(30_000), modelContextWindow: 272_000 } };
    expect(codexContextUsage(params)).toEqual({ used: 30_000, window: 272_000 });
    // The window is nullable: then there's no meter.
    expect(codexContextUsage({ ...params, tokenUsage: { ...params.tokenUsage, modelContextWindow: null } })).toBeNull();
    expect(codexContextUsage({ threadId: 'thr' })).toBeNull();
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
