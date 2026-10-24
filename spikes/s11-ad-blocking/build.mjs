// Spike S11, step 2: compile EasyList + EasyPrivacy both ways, from the same text.
//   - engine.bin: the Ghostery engine, serialized (approach a).
//   - extension/: a component-style MV3 extension whose static rulesets are the
//     lists as declarativeNetRequest rules (approach b), compiled by Chord's
//     converter (apps/desktop/src/main/ad-blocking/rules.ts).
// Writes spikes/s11-ad-blocking/results/build/ and prints the compile numbers.
//
//   node spikes/s11-ad-blocking/build.mjs <folder with easylist.txt and easyprivacy.txt>
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { compileList } from '../../apps/desktop/src/main/ad-blocking/rules.ts';

const require = createRequire(join(import.meta.dirname, '..', '..', 'apps', 'desktop', 'package.json'));
const { FiltersEngine } = require('@ghostery/adblocker');

const lists = process.argv[2];
if (!lists) throw new Error('Usage: node build.mjs <lists folder>');
const out = join(import.meta.dirname, 'results', 'build');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'extension', 'rules'), { recursive: true });

const report = { lists: {} };
const texts = {};
for (const name of ['easylist', 'easyprivacy']) {
  const text = readFileSync(join(lists, `${name}.txt`), 'utf8');
  texts[name] = text;
  const t = performance.now();
  const { rules, stats } = compileList(text);
  const ms = performance.now() - t;
  const json = JSON.stringify(rules);
  writeFileSync(join(out, 'extension', 'rules', `${name}.json`), json);
  report.lists[name] = {
    version: /^! Version: (\d+)/m.exec(text)?.[1] ?? null,
    compileMs: Math.round(ms),
    jsonBytes: json.length,
    regexRules: rules.filter((r) => r.condition.regexFilter).length,
    biggestDomainList: Math.max(...rules.map((r) => r.condition.requestDomains?.length ?? 0)),
    ...stats,
  };
}

const t = performance.now();
const engine = FiltersEngine.parse(`${texts.easylist}\n${texts.easyprivacy}`, { loadCosmeticFilters: true, loadNetworkFilters: true, enableCompression: true });
const parseMs = performance.now() - t;
const bytes = engine.serialize();
writeFileSync(join(out, 'engine.bin'), bytes);
report.engine = { parseMs: Math.round(parseMs), bytes: bytes.length };

// No key: an unpacked extension's ID comes from its folder, which stays the same.
const manifest = {
  manifest_version: 3,
  name: 'Chord blocker (spike S11)',
  version: '1.0.0',
  permissions: ['declarativeNetRequest'],
  declarative_net_request: {
    rule_resources: ['easylist', 'easyprivacy'].map((id) => ({ id, enabled: true, path: `rules/${id}.json` })),
  },
};
writeFileSync(join(out, 'extension', 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join(out, 'extension', 'control.html'), '<!doctype html><meta charset="utf-8"><title>Chord blocker</title>');
writeFileSync(join(out, 'build.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
