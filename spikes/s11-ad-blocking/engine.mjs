// Spike S11, step 1: the Ghostery engine on its own, in plain Node (no Electron).
// How long EasyList + EasyPrivacy take to parse, how big the serialized engine
// is, how long it takes to load back, and what one request's match and one
// page's cosmetic lookup cost.
//
// Run from the repo root, after `pnpm install`:
//   node spikes/s11-ad-blocking/engine.mjs <folder with easylist.txt and easyprivacy.txt>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixtureRequests } from './fixture.mjs';

const require = createRequire(join(import.meta.dirname, '..', '..', 'apps', 'desktop', 'package.json'));
const { FiltersEngine, Request } = require('@ghostery/adblocker');

const lists = process.argv[2];
if (!lists) throw new Error('Usage: node engine.mjs <lists folder>');
const text = ['easylist.txt', 'easyprivacy.txt'].map((f) => readFileSync(join(lists, f), 'utf8')).join('\n');

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
const time = (fn, runs) => {
  const out = [];
  let value;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    value = fn();
    out.push(performance.now() - t);
  }
  return { value, ms: out };
};

const results = { node: process.version, lines: text.split('\n').length };

const parsed = time(() => FiltersEngine.parse(text, { loadCosmeticFilters: true, loadNetworkFilters: true, enableCompression: true }), 3);
const engine = parsed.value;
results.parseMs = { median: median(parsed.ms), all: parsed.ms };
const bytes = engine.serialize();
results.serializedBytes = bytes.length;
const loaded = time(() => FiltersEngine.deserialize(bytes), 20);
results.deserializeMs = { median: median(loaded.ms), p95: pct(loaded.ms, 95), first: loaded.ms[0] };

const networkOnly = FiltersEngine.parse(text, { loadCosmeticFilters: false, loadNetworkFilters: true, enableCompression: true });
const netBytes = networkOnly.serialize();
results.networkOnlyBytes = netBytes.length;
const netLoaded = time(() => FiltersEngine.deserialize(netBytes), 20);
results.networkOnlyDeserializeMs = { median: median(netLoaded.ms), p95: pct(netLoaded.ms, 95), first: netLoaded.ms[0] };

// Matching: the fixture page's requests, each matched cold once, then 20 more rounds.
const requests = fixtureRequests(8080);
const fresh = FiltersEngine.deserialize(bytes);
const firstRound = [];
const later = [];
let blocked = 0;
for (let round = 0; round < 21; round++) {
  for (const r of requests) {
    const t = performance.now();
    const result = fresh.match(Request.fromRawDetails({ url: r.url, sourceUrl: r.source, type: r.type }));
    const took = performance.now() - t;
    (round === 0 ? firstRound : later).push(took);
    if (round === 0 && result.match) blocked++;
  }
}
results.match = {
  requests: requests.length,
  blocked,
  firstRoundMs: { median: median(firstRound), p99: pct(firstRound, 99), total: firstRound.reduce((a, b) => a + b, 0) },
  warmMs: { median: median(later), p99: pct(later, 99) },
};

// Cosmetics for one page: hostname-specific and the generic base rules, no DOM scan.
const cosmetic = time(
  () =>
    fresh.getCosmeticsFilters({
      url: 'https://www.cnn.com/',
      hostname: 'www.cnn.com',
      domain: 'cnn.com',
      getBaseRules: true,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromDOM: false,
      getRulesFromHostname: true,
    }),
  20,
);
results.cosmetic = { ms: { first: cosmetic.ms[0], median: median(cosmetic.ms) }, cssBytes: cosmetic.value.styles.length, sample: cosmetic.value.styles.slice(0, 300) };
const hostOnly = fresh.getCosmeticsFilters({
  url: 'https://www.cnn.com/',
  hostname: 'www.cnn.com',
  domain: 'cnn.com',
  getBaseRules: false,
  getInjectionRules: false,
  getExtendedRules: false,
  getRulesFromDOM: false,
  getRulesFromHostname: true,
});
results.cosmeticHostOnlyBytes = hostOnly.styles.length;

const out = join(import.meta.dirname, 'results');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'engine.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
