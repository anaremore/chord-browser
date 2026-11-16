import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TOOLS,
  assistantInstructions,
  cut,
  DIAGNOSTICS_MAX_ENTRIES,
  DIAGNOSTICS_MAX_FRAMES,
  DIAGNOSTICS_MAX_TEXT,
  diagnosticsEntries,
  diagnosticsResult,
  diagnosticsSummary,
  readNeedsApproval,
  redactAddress,
  redactText,
  shrinkEvent,
  stackFrames,
  type DiagnosticsEvent,
} from '../src';

describe('page_diagnostics: addresses lose what carries tokens', () => {
  it.each([
    ['a query', 'https://shop.example/cart?session=abc123', 'https://shop.example/cart'],
    ['a fragment', 'https://app.example/#access_token=xyz', 'https://app.example/'],
    ['both', 'https://a.example/p?q=1#frag', 'https://a.example/p'],
    ['a user and password', 'https://ada:hunter2@a.example/x', 'https://a.example/x'],
    ['a port', 'http://127.0.0.1:8080/api?k=v', 'http://127.0.0.1:8080/api'],
    ['a line and column after the query', 'https://a.example/app.js?v=9:12:7', 'https://a.example/app.js:12:7'],
    ['a line and column, no query', 'https://a.example/app.js:12:7', 'https://a.example/app.js:12:7'],
    ['a data: address', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/png,…'],
    ['a websocket', 'wss://live.example/socket?token=t', 'wss://live.example/socket'],
    ['a file', 'file:///C:/site/index.html?x', 'file:///C:/site/index.html'],
    ['not an address', 'about-ish?secret=1', 'about-ish'],
    ['nothing', '', ''],
  ])('%s', (_, input, expected) => expect(redactAddress(input)).toBe(expected));

  it.each([
    ['in a message', "Access to fetch at 'https://api.example/v1?key=SECRET' from origin 'https://a.example' has been blocked", "Access to fetch at 'https://api.example/v1' from origin 'https://a.example' has been blocked"],
    ['in a stack', 'Error: boom\n    at load (https://a.example/app.js?token=SECRET:3:9)', 'Error: boom\n    at load (https://a.example/app.js:3:9)'],
    ['several', 'https://a.example/?a=1 and http://b.example/x#y', 'https://a.example/ and http://b.example/x'],
    ['a data: address', 'bad image data:image/gif;base64,R0lGOD', 'bad image data:image/gif,…'],
    ['no address', 'TypeError: x is undefined', 'TypeError: x is undefined'],
    ['protocol-relative', 'Failed to load //cdn.example/lib.js?token=SECRET', 'Failed to load //cdn.example/lib.js'],
    ['relative, in quotes', "fetch('/api/items?key=SECRET') failed", "fetch('/api/items') failed"],
    ['relative, with a fragment', 'went to /callback#access_token=SECRET', 'went to /callback'],
    ['relative, in a stack', '    at load (/static/app.js?v=SECRET:3:9)', '    at load (/static/app.js:3:9)'],
    ['relative after a colon', 'Not found:/missing?sig=SECRET', 'Not found:/missing'],
    ['another scheme', 'ftp://files.example/a.zip?t=SECRET', 'ftp://files.example/a.zip'],
    ['a path with no query stays', 'see /docs/setup and a/b?c', 'see /docs/setup and a/b?c'],
    ['a query with brackets', 'fetch failed https://api.x/v1?ids[]=1&api_key=SECRET', 'fetch failed https://api.x/v1'],
    ['a relative query with brackets', 'GET /api?filter[user]=1&token=SECRET', 'GET /api'],
    ['a query holding JSON', 'https://x.com/a?q={"t":"SECRET"} failed', 'https://x.com/a failed'],
    ['brackets in the path', 'https://x.com/a(1)?token=SECRET', 'https://x.com/a(1)'],
    ['relative with ./', 'load ./api?token=SECRET', 'load ./api'],
    ['relative with ../', 'load ../x?token=SECRET', 'load ../x'],
    ['a bare host', 'cdn.example.com/a.js?token=SECRET failed', 'cdn.example.com/a.js failed'],
    ['a password in another scheme', 'ftp://u:SECRET@h.example/x', 'ftp://h.example/x'],
    ['in double quotes with JSON after', 'GET "https://a.example/x?k=SECRET" {"ok":false}', 'GET "https://a.example/x" {"ok":false}'],
    ['in parentheses with brackets', 'at f (https://a.example/a.js?x[0]=SECRET:3:9)', 'at f (https://a.example/a.js:3:9)'],
    // Review round 3: a closing mark inside the query.
    ["a quote inside a quoted query", "'https://api.x.com/u?name=O'Brien&token=SECRET' from", "'https://api.x.com/u' from"],
    ['parentheses inside a query in a stack', 'at f (https://x.com/a.js?q=f(1)&token=SECRET:3:9)', 'at f (https://x.com/a.js:3:9)'],
    ['a markdown link with parentheses', '[x](https://x.com/a?q=(S)&token=SECRET)', '[x](https://x.com/a)'],
    ['an escaped quote in JSON', '{"url":"https://x.com/a?q=\\"v\\"&token=SECRET"}', '{"url":"https://x.com/a"}'],
    ['a bracket inside a bracketed query', '[https://x.com/a?q=]&token=SECRET]', '[https://x.com/a]'],
    ['a space inside a quoted query', "'https://x.com/a?q=hello world&token=SECRET' ok", "'https://x.com/a' ok"],
    // An address inside a query doesn't hide the next one.
    ['an address inside a query, then another', '(https://a.x/login?next=http://b.x/c),https://c.x/d?token=SECRET', '(https://a.x/login),https://c.x/d'],
    ['a relative path inside a query, then a path', '(https://a.x/p?r=/x)/y?token=SECRET', '(https://a.x/p'],
    // User names and passwords on every path.
    ['credentials, protocol-relative', 'load //u:SECRET@cdn.x.com/a.js', 'load //cdn.x.com/a.js'],
    ['credentials after a tag', '<td>https://u:SECRET@x.com/a</td>', '<td>https://x.com/a</td>'],
    ['credentials after a semicolon', 'x;https://u:SECRET@x.com/a', 'x;https://x.com/a'],
    ['credentials on a bare host', 'u:SECRET@cdn.x.com/a', 'cdn.x.com/a'],
    ['credentials with a bad port', 'https://u:SECRET@x.com:99999/a', 'https://x.com:99999/a'],
    ['credentials with a bad escape', 'https://u:SECRET@x%zz.com/a', 'https://x%zz.com/a'],
    // Hosts without a dotted name.
    ['localhost', 'fetch localhost:3000/api?token=SECRET failed', 'fetch localhost:3000/api failed'],
    ['an IP address', 'fetch 192.168.0.1/api?token=SECRET failed', 'fetch 192.168.0.1/api failed'],
    ['an IP address and port', 'fetch 10.0.0.2:8080/api?token=SECRET', 'fetch 10.0.0.2:8080/api'],
    // After other marks.
    ['data: after a tag', '<i>data:text/plain;base64,SECRET</i>', '<i>data:text/plain,…</i>'],
    // Nothing to close after a tag, so the query reads to the next space: more goes, never less.
    ['a bare host after a tag', '<b>cdn.x.com/a?token=SECRET</b> ok', '<b>cdn.x.com/a ok'],
    ['relative in curly quotes', 'load “/a?t=SECRET” failed', 'load “/a” failed'],
    // Hosts of schemes the URL standard doesn't know, and positions.
    ['an extension keeps its id', 'chrome-extension://abcdefgh/a.js?t=S:1:2', 'chrome-extension://abcdefgh/a.js:1:2'],
    ["an app's scheme loses its user", 'myapp://u:S@host/a', 'myapp://host/a'],
    ['a number after a colon in a query is not a position', 'https://x.com/a?otp=x:123456', 'https://x.com/a'],
    // Prose stays.
    ['a question about a path', 'Did you mean /docs?', 'Did you mean /docs?'],
    ['a question in parentheses', 'see (/help)? or not', 'see (/help)? or not'],
    ['and/or', 'and/or? 1/2? a/b?c', 'and/or? 1/2? a/b?c'],
  ])('%s', (_, input, expected) => expect(redactText(input)).toBe(expected));
});

describe('page_diagnostics: bounds', () => {
  it.each([
    ['short', 'abc', 3],
    ['exactly the most', 'a'.repeat(DIAGNOSTICS_MAX_TEXT), DIAGNOSTICS_MAX_TEXT],
    ['one over', 'a'.repeat(DIAGNOSTICS_MAX_TEXT + 1), DIAGNOSTICS_MAX_TEXT],
    ['far over', 'a'.repeat(100_000), DIAGNOSTICS_MAX_TEXT],
    ['a huge single entry (5,000,000 characters)', 'x'.repeat(5_000_000), DIAGNOSTICS_MAX_TEXT],
    ['exactly the most, with astral characters', '😀'.repeat(DIAGNOSTICS_MAX_TEXT), DIAGNOSTICS_MAX_TEXT],
    ['astral characters count as one', '😀'.repeat(DIAGNOSTICS_MAX_TEXT + 5), DIAGNOSTICS_MAX_TEXT],
  ])('text: %s', (_, input, length) => {
    const out = cut(input);
    expect([...out].length).toBe(length);
    if (length < [...input].length) expect(out.endsWith('…')).toBe(true);
  });

  it('a stack is file, line and function only, at most the frames kept', () => {
    const callFrames = Array.from({ length: 30 }, (_, i) => ({ functionName: i ? `f${i}` : '', url: `https://a.example/app.js?t=${i}`, lineNumber: i, columnNumber: 99, scriptId: '7' }));
    const frames = stackFrames({ callFrames })!;
    expect(frames).toHaveLength(DIAGNOSTICS_MAX_FRAMES);
    expect(frames[0]).toEqual({ file: 'https://a.example/app.js', line: 1, function: '(anonymous)' });
    expect(frames[3]).toEqual({ file: 'https://a.example/app.js', line: 4, function: 'f3' });
    expect(stackFrames({ callFrames: [] })).toBeUndefined();
    expect(stackFrames(undefined)).toBeUndefined();
  });

  it.each<[string, DiagnosticsEvent]>([
    ['a console call', { kind: 'console', call: { type: 'error', args: [{ type: 'string', value: 'x'.repeat(5_000_000) }, { type: 'object', description: 'd'.repeat(5_000_000), preview: { properties: Array.from({ length: 500 }, (_, i) => ({ name: `p${i}`, type: 'string', value: 'v'.repeat(10_000) })) } }, ...Array.from({ length: 500 }, () => ({ type: 'string', value: 'y' }))], stackTrace: { callFrames: Array.from({ length: 1000 }, () => ({ functionName: 'f'.repeat(10_000), url: `https://a.example/${'u'.repeat(1_000_000)}`, lineNumber: 1 })) } } }],
    ['a log entry', { kind: 'log', entry: { source: 'network', level: 'error', text: 't'.repeat(5_000_000), url: `https://a.example/${'u'.repeat(5_000_000)}` } }],
    ['an exception', { kind: 'exception', thrown: { exceptionDetails: { text: 't'.repeat(5_000_000), url: 'u'.repeat(5_000_000), exception: { type: 'object', subtype: 'error', description: 'e'.repeat(5_000_000) } } } }],
  ])('a huge single entry is cut as it arrives: %s', (_, event) => {
    const kept = shrinkEvent(event);
    expect(JSON.stringify(kept).length).toBeLessThan(80_000);
    expect(diagnosticsEntries([kept]).entries).toEqual(diagnosticsEntries([event]).entries);
  });

  it('keeps the newest entries, oldest first, and says how many there were', () => {
    const events: DiagnosticsEvent[] = Array.from({ length: 450 }, (_, i) => ({ kind: 'console', call: { type: 'error', timestamp: 1000 + i, args: [{ type: 'string', value: `e${i}` }] } }));
    const { entries, total } = diagnosticsEntries(events.slice().reverse());
    expect(total).toBe(450);
    expect(entries).toHaveLength(DIAGNOSTICS_MAX_ENTRIES);
    expect(entries[0]).toMatchObject({ text: 'e250' });
    expect(entries.at(-1)).toMatchObject({ text: 'e449' });
  });
});

describe('page_diagnostics: what each kind of event becomes', () => {
  const at = Date.UTC(2026, 10, 15, 12);
  it.each<[string, DiagnosticsEvent, unknown]>([
    [
      'a 404',
      { kind: 'log', entry: { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', url: 'http://127.0.0.1/missing.png?sig=SECRET', timestamp: at } },
      { kind: 'request', url: 'http://127.0.0.1/missing.png', status: 404, type: 'image', time: '2026-11-15T12:00:00.000Z' },
    ],
    [
      'a refused connection, typed by the page’s timing',
      { kind: 'log', entry: { source: 'network', level: 'error', text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED', url: 'http://127.0.0.1:9/api?k=1', timestamp: at } },
      { kind: 'request', url: 'http://127.0.0.1:9/api', error: 'net::ERR_CONNECTION_REFUSED', type: 'fetch' },
    ],
    [
      'console.error with an object and a number',
      { kind: 'console', call: { type: 'error', timestamp: at, args: [{ type: 'string', value: 'Bad state' }, { type: 'object', preview: { properties: [{ name: 'id', type: 'number', value: '7' }, { name: 'who', type: 'string', value: 'ada' }] } }, { type: 'number', value: 3 }] } },
      { kind: 'console', level: 'error', source: 'console', text: 'Bad state {id: 7, who: "ada"} 3' },
    ],
    ['console.warn', { kind: 'console', call: { type: 'warning', timestamp: at, args: [{ type: 'string', value: 'Deprecated' }] } }, { kind: 'console', level: 'warning', text: 'Deprecated' }],
    ['a failed console.assert', { kind: 'console', call: { type: 'assert', timestamp: at, args: [] } }, { kind: 'console', level: 'error', text: 'Assertion failed' }],
    [
      'an uncaught exception',
      {
        kind: 'exception',
        thrown: { timestamp: at, exceptionDetails: { text: 'Uncaught', exception: { type: 'object', subtype: 'error', description: 'Error: kaboom\n    at go (http://h/x.js?q=1:2:3)' }, stackTrace: { callFrames: [{ functionName: 'go', url: 'http://h/x.js?q=1', lineNumber: 1 }] } } },
      },
      { kind: 'exception', text: 'Uncaught Error: kaboom', stack: [{ file: 'http://h/x.js', line: 2, function: 'go' }] },
    ],
    [
      'a security message from the log',
      { kind: 'log', entry: { source: 'security', level: 'error', text: "Refused to load 'https://cdn.example/x.js?t=1'", timestamp: at } },
      { kind: 'console', level: 'error', source: 'security', text: "Refused to load 'https://cdn.example/x.js'" },
    ],
  ])('%s', (_, event, expected) => {
    const types = { 'http://127.0.0.1:9/api?k=1': 'fetch' };
    expect(diagnosticsEntries([event], types).entries[0]).toMatchObject(expected as object);
  });

  it.each<[string, DiagnosticsEvent]>([
    ['console.log', { kind: 'console', call: { type: 'log', args: [{ type: 'string', value: 'hi' }] } }],
    ['console.info', { kind: 'console', call: { type: 'info', args: [{ type: 'string', value: 'hi' }] } }],
    ['a verbose log entry', { kind: 'log', entry: { source: 'violation', level: 'verbose', text: 'slow handler' } }],
    ['an info log entry', { kind: 'log', entry: { source: 'other', level: 'info', text: 'note' } }],
  ])('leaves out %s', (_, event) => expect(diagnosticsEntries([event]).entries).toEqual([]));

  // A readable page holding a frame of a *Never read* site (mail.example.com inside www.example.com): that frame's problems stay out.
  describe('a Never read site’s frame inside the page', () => {
    const page = { origin: 'https://www.example.com', frameId: 'top' };
    const contexts = {
      1: page,
      7: { origin: 'https://mail.example.com', frameId: 'mail' },
      // An extension's content script in the mail frame: the frame's, whatever its own origin.
      8: { origin: 'chrome-extension://abc', frameId: 'mail' },
      // The same extension in the page: the page's.
      9: { origin: 'chrome-extension://abc', frameId: 'top' },
    };
    const never = { sites: ['mail.example.com'], contexts };
    const error = (extra: object): DiagnosticsEvent => ({ kind: 'console', call: { type: 'error', args: [{ type: 'string', value: 'x' }], executionContextId: 1, ...extra } });
    const thrown = (extra: object): DiagnosticsEvent => ({ kind: 'exception', thrown: { exceptionDetails: { text: 'Uncaught', executionContextId: 1, ...extra } } });
    const failed = (url: string): DiagnosticsEvent => ({ kind: 'log', entry: { source: 'network', level: 'error', text: 'net::ERR_FAILED', url } });
    it.each<[string, DiagnosticsEvent, boolean]>([
      ['the page’s own console call', error({}), true],
      ['the page’s own exception', thrown({}), true],
      ['an extension’s content script in the page', error({ executionContextId: 9 }), true],
      ['a console call in the frame (its script context)', error({ executionContextId: 7 }), false],
      ['an extension’s content script in the frame', error({ executionContextId: 8 }), false],
      ['a console call whose stack runs through the frame’s script', error({ stackTrace: { callFrames: [{ url: 'https://www.example.com/a.js' }, { url: 'https://mail.example.com/inbox.js?s=1' }] } }), false],
      ['an exception in the frame', thrown({ executionContextId: 7 }), false],
      ['an exception at the frame’s address', thrown({ url: 'https://mail.example.com/x.js' }), false],
      ['a blob the frame made', error({ stackTrace: { callFrames: [{ url: 'blob:https://mail.example.com/1f2e' }] } }), false],
      // Fails closed: a removed or reloaded frame's replayed exception has a context nobody named, and could be the frame's.
      ['an exception in a context Chord wasn’t told about, at a CDN', thrown({ executionContextId: 99, url: 'https://cdn.example.net/lib.js' }), false],
      ['an exception in context 0', thrown({ executionContextId: 0 }), false],
      ['a console call with no context', error({ executionContextId: undefined }), false],
      ['eval’d code and an extension’s script in the page: not a site', error({ stackTrace: { callFrames: [{ url: '' }, { url: 'chrome-extension://abc/c.js' }] } }), true],
      // No Log entry says which frame it came from: the frame's failed request to another host looks like the page's.
      ['a failed request to the site', failed('https://mail.example.com/api'), false],
      ['a failed request to another host, with the frame in the page', failed('https://api.mailcdn.net/v1/messages/123'), false],
    ])('%s', (_, event, kept) => {
      expect(diagnosticsEntries([event], {}, never).entries).toHaveLength(kept ? 1 : 0);
      // With no Never read sites, nothing is left out.
      expect(diagnosticsEntries([event], {}, { sites: [], contexts }).entries).toHaveLength(1);
    });

    it('without such a frame in the page, its Log entries are kept', () => {
      const pageOnly = { sites: ['mail.example.com'], contexts: { 1: page } };
      expect(diagnosticsEntries([failed('https://api.mailcdn.net/v1/messages/123')], {}, pageOnly).entries).toHaveLength(1);
      expect(diagnosticsEntries([failed('https://mail.example.com/api')], {}, pageOnly).entries).toHaveLength(0);
    });

    it('keeps the context through shrinkEvent', () => {
      expect(diagnosticsEntries([shrinkEvent(error({ executionContextId: 7 }))], {}, never).entries).toEqual([]);
      expect(diagnosticsEntries([shrinkEvent(error({}))], {}, never).entries).toHaveLength(1);
      expect(diagnosticsEntries([shrinkEvent(thrown({ executionContextId: 7 }))], {}, never).entries).toEqual([]);
    });
  });

  it('summarizes for the activity line', () => {
    const { entries } = diagnosticsEntries([
      { kind: 'console', call: { type: 'error', args: [{ type: 'string', value: 'a' }] } },
      { kind: 'exception', thrown: { exceptionDetails: { text: 'Uncaught' } } },
      { kind: 'console', call: { type: 'warning', args: [{ type: 'string', value: 'b' }] } },
      { kind: 'log', entry: { source: 'network', level: 'error', text: 'net::ERR_FAILED', url: 'http://h/a' } },
    ]);
    expect(diagnosticsSummary(entries)).toBe('2 errors · 1 warning · 1 failed request');
    expect(diagnosticsSummary([])).toBe('No problems');
  });

  it('the result is untrusted, with its provenance, and the page’s address cut too', () => {
    const result = JSON.parse(diagnosticsResult({ ref: 't1', url: 'https://a.example/p?token=SECRET#x', retrievedAt: 0, entries: [], total: 0, note: 'n' }));
    expect(result).toEqual({ source: 'page_diagnostics', tab_id: 't1', origin: 'https://a.example', url: 'https://a.example/p', retrieved_at: '1970-01-01T00:00:00.000Z', trust: 'untrusted', shown: 0, total: 0, note: 'n', entries: [] });
  });
});

describe('page_diagnostics: the assistant’s rules', () => {
  it('is a read-only tool the assistant is told about, and Nothing has none', () => {
    expect(ASSISTANT_TOOLS.find((t) => t.name === 'page_diagnostics')).toMatchObject({ tier: 0 });
    expect(assistantInstructions('claude')).toContain('page_diagnostics');
    expect(assistantInstructions('claude', false)).not.toContain('page_diagnostics');
  });

  it.each([
    ['every', false, true, true],
    ['every', true, true, false],
    ['ask', false, true, true],
    ['ask', true, true, false],
    ['chord', false, true, false],
    ['chord', false, false, true],
    ['all', false, true, false],
    ['all', false, false, false],
  ] as const)('scope %s, attached %s, same chord %s: asks first %s', (scope, attached, sameChord, asks) => {
    expect(readNeedsApproval({ scope, attached, sameChord, tool: 'page_diagnostics', granted: false })).toBe(asks);
  });
});
