// A stand-in Gemini API: agy 1.5.14 sends its model requests to
// GOOGLE_GEMINI_BASE_URL, so the spike watches agy's tools and permissions
// without model credits. Each request is logged (the tools agy declares, the
// system prompt's size, the last turn) and answered with the next function
// call from S19_SCRIPT (a JSON list of {tool, args}), then with plain text.
//
//   S19_SCRIPT="$(cat fixtures/script-attack.json)" S19_LOG=run.log node fake-gemini.mjs
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const log = (s) => process.env.S19_LOG && appendFileSync(process.env.S19_LOG, `[model] ${s}\n`);
const SCRIPT = JSON.parse(process.env.S19_SCRIPT ?? '[]');
const PORT = Number(process.env.S19_PORT ?? 8099);
let step = 0;
let n = 0;

/** The declared tool a script step means: an exact name, else the first containing it. */
function pick(names, want) {
  for (const w of [].concat(want)) {
    const hit = names.find((x) => x === w) ?? names.find((x) => x.includes(w));
    if (hit) return hit;
  }
  return null;
}

createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    n++;
    let j = {};
    try {
      j = JSON.parse(body);
    } catch {
      // Not JSON: logged as such.
    }
    const names = (j.tools ?? []).flatMap((t) => (t.functionDeclarations ?? []).map((f) => f.name));
    const system = JSON.stringify(j.systemInstruction ?? '');
    log(`#${n} ${req.method} ${req.url}: ${names.length} tools${names.length ? ` (${names.join(', ')})` : ''}; system prompt ${system.length} chars`);
    log(`   last turn: ${JSON.stringify((j.contents ?? []).at(-1) ?? {}).slice(0, 400)}`);
    let part = { text: 'Done.' };
    if (step < SCRIPT.length && names.length) {
      const s = SCRIPT[step++];
      const name = pick(names, s.tool);
      part = name ? { functionCall: { name, args: s.args } } : { text: `No tool like ${s.tool}.` };
    }
    log(`   answer: ${JSON.stringify(part)}`);
    const payload = {
      candidates: [
        {
          content: { role: 'model', parts: [part] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    };
    if (req.url.includes('alt=sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(payload)}\r\n\r\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    }
  });
}).listen(PORT, '127.0.0.1', () => log(`listening on ${PORT}`));
