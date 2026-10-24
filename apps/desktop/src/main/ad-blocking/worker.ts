/**
 * Ad blocking's worker thread (ARCHITECTURE.md §9): it holds Ghostery's
 * engine, so element hiding for pages and private windows' request checks
 * never touch main beyond a message. A second, short-lived one compiles
 * refreshed lists (half a second of parsing) and writes them, so the first
 * keeps answering meanwhile. It never touches the network: main fetches.
 */
import { FiltersEngine, Request } from '@ghostery/adblocker';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { compileLists } from './compile';
import { FILTER_LISTS, type ListId } from './lists';
import type { CompileResult, WorkerMessage, WorkerReply, WorkerRequest } from './protocol';

let engine: FiltersEngine | null = null;

/**
 * Whether a selector is only a selector: outside quoted attribute values, no
 * at-rule (`@import` fetches), no `;` that could end it early, no comment,
 * no `url(`.
 */
function plainSelector(selector: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    // An escaped character is part of a name (`.ad\:banner`), whatever it is.
    if (c === '\\') i++;
    else if (quote) {
      if (c === quote) quote = null;
      else if (c === '\n') return false;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '@' || c === ';' || c === '{' || c === '}' || (c === '/' && selector[i + 1] === '*')) return false;
    else if (selector.startsWith('url(', i)) return false;
  }
  return quote === null;
}

/** Only `display: none` rules: nothing in a page's stylesheet from the lists can fetch, run or restyle. */
export function hidingOnly(css: string): string {
  const out: string[] = [];
  for (const block of css.split('}')) {
    const match = /^\s*([^{}]+?)\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*$/.exec(block);
    if (match && plainSelector(match[1]!)) out.push(`${match[1]} { display: none !important; }`);
  }
  return out.join('\n');
}

/** A page's element hiding: the rules for its site, and the lists' generic ones that need nothing from the page. */
function css(url: string): string {
  if (!engine) return '';
  const request = Request.fromRawDetails({ url, type: 'main_frame' });
  if (!request.hostname) return '';
  const { styles } = engine.getCosmeticsFilters({
    url,
    hostname: request.hostname,
    domain: request.domain || request.hostname,
    getBaseRules: true,
    getInjectionRules: false,
    getExtendedRules: false,
    getRulesFromDOM: false,
    getRulesFromHostname: true,
  });
  return styles ? hidingOnly(styles) : '';
}

/** Lists that came back unchanged (304) are read from the last set that has them. */
async function compile(message: Extract<WorkerRequest, { type: 'compile' }>): Promise<CompileResult> {
  const started = performance.now();
  const texts = {} as Record<ListId, string>;
  for (const list of FILTER_LISTS) {
    const bytes = message.lists[list.id];
    if (bytes) {
      texts[list.id] = new TextDecoder().decode(bytes);
      continue;
    }
    const from = message.from.map((dir) => join(dir, `${list.id}.txt`)).find((file) => existsSync(file));
    if (!from) throw new Error(`No copy of ${list.name} to compile`);
    texts[list.id] = await readFile(from, 'utf8');
  }
  const compiled = compileLists(texts);
  // Written beside the old set, then swapped in, so a crash mid-write leaves the old set whole.
  const next = `${message.out}.new`;
  await rm(next, { recursive: true, force: true });
  await mkdir(join(next, 'rules'), { recursive: true });
  for (const list of FILTER_LISTS) {
    await writeFile(join(next, `${list.id}.txt`), texts[list.id]);
    await writeFile(join(next, 'rules', `${list.id}.json`), JSON.stringify(compiled.rules[list.id]));
  }
  await writeFile(join(next, 'engine.bin'), compiled.engine);
  await writeFile(join(next, 'lists.json'), JSON.stringify(compiled.info));
  await rm(`${message.out}.old`, { recursive: true, force: true });
  if (existsSync(message.out)) await rename(message.out, `${message.out}.old`);
  await rename(next, message.out);
  await rm(`${message.out}.old`, { recursive: true, force: true });
  return { info: compiled.info, rules: FILTER_LISTS.reduce((n, l) => n + compiled.rules[l.id].length, 0), took: performance.now() - started };
}

/** One request, answered (exported for unit tests, which run it without a thread). */
export async function handle(message: WorkerRequest): Promise<unknown> {
  switch (message.type) {
    case 'open':
      engine = FiltersEngine.deserialize(message.bytes);
      return null;
    case 'css':
      return css(message.url);
    case 'match': {
      if (!engine) return false;
      const { match } = engine.match(Request.fromRawDetails({ url: message.url, sourceUrl: message.sourceUrl, type: message.resourceType as never }));
      return match;
    }
    case 'compile':
      return await compile(message);
  }
}

// Requests are answered in order: anything sent after `open` waits for the engine.
let queue: Promise<void> = Promise.resolve();
parentPort?.on('message', (message: WorkerMessage) => {
  queue = queue.then(async () => {
    let reply: WorkerReply;
    try {
      reply = { id: message.id, ok: true, result: await handle(message) };
    } catch (error) {
      reply = { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    parentPort?.postMessage(reply);
  });
});
