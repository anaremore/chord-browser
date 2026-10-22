// Spike S9: print a compact comparison of results/*.json.
// Run: node spikes/s9-extensions/summary.mjs [builtin lib lib-relaunch fork]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, 'results');
const labels = process.argv.slice(2).length ? process.argv.slice(2) : ['builtin', 'lib', 'lib-relaunch', 'fork', 'fork-relaunch'];
for (const label of labels) {
  const file = join(dir, `${label}.json`);
  if (!existsSync(file)) continue;
  const r = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\n=== ${label}: Electron ${r.electron} / Chromium ${r.chrome} (${r.platform}) ok=${r.ok} ${r.error ? `error at "${r.stage}": ${r.error.split('\n')[0]}` : ''}`);
  if (r.library) console.log('library', JSON.stringify({ version: r.library.version, preloadScripts: r.library.preloadScripts }));
  for (const [id, e] of Object.entries(r.extensions)) {
    if (!e.name) {
      if (e.swConsole.length) console.log(`- probe extension ${id}: ${JSON.stringify(e.swConsole)}`);
      continue;
    }
    const page = (k) => (e[k] ? `${k}: ${e[k].loaded ? 'loaded' : `FAILED ${e[k].error}`} ${e[k].preferredSize ? `${e[k].preferredSize.width}x${e[k].preferredSize.height}` : ''} missing=[${e[k].missingApis ?? ''}] errors=${e[k].consoleErrors?.length ?? 0}` : null);
    console.log(`- ${e.name} ${e.version}: loaded=${e.loaded} sw=${e.serviceWorkerRunning} contentScriptWorlds=${e.contentScriptWorlds}`);
    for (const line of e.swConsole) console.log(`    sw ${line}`);
    for (const k of ['popup', 'options']) if (e[k]) console.log(`    ${page(k)}`);
    const p = e.popup?.probe;
    if (p) {
      const keys = Object.keys(p).filter((k) => /\(|\.|^dnr|^xs/.test(k) && typeof p[k] === 'object' && p[k] && 'ok' in p[k]);
      console.log(`    popup calls: ${keys.map((k) => `${k}=${p[k].ok ? 'ok' + (p[k].value !== undefined ? ` ${p[k].value}` : '') : `ERR ${p[k].error}`}`).join(' | ')}`);
    }
    for (const err of e.popup?.consoleErrors ?? []) console.log(`    popup console ${err.slice(0, 200)}`);
  }
  for (const key of ['page', 'pageAfterDnrEnable']) {
    const pg = r[key];
    if (!pg) continue;
    console.log(`${key}: probes=${JSON.stringify(pg.probes)} bg=${pg.bodyBackground} darkReaderStyles=${pg.darkReaderStyles} adSlot=${pg.adSlotDisplay}`);
    console.log(`  serverHits=${JSON.stringify(pg.serverHits)}`);
    console.log(`  cdpFailed=${JSON.stringify(pg.cdpFailed)}`);
    console.log(`  contentScriptWorlds=${JSON.stringify(pg.contentScriptWorlds)}`);
  }
  console.log('inMemorySessionLoad:', r.inMemorySessionLoad);
  console.log('sessionFetch:', JSON.stringify(r.sessionFetch));
  console.log('uiSessionRequestToBlockedHost:', r.uiSessionRequestToBlockedHost);
  console.log('uiView:', JSON.stringify(r.uiViewAfterExtensionCalls), 'webPageFetchOfUiScheme:', r.webPageFetchOfUiScheme);
  console.log('otherProfile:', JSON.stringify(r.otherProfile));
  console.log('serviceWorkersRunningAtEnd:', JSON.stringify(r.serviceWorkersRunningAtEnd));
  for (const [type, events] of Object.entries(r.probeWorkers ?? {})) console.log(`probe worker (${type}):`, JSON.stringify(events));
  if (r.extensionFrame) console.log('extension frame:', JSON.stringify(r.extensionFrame));
  console.log(
    'popup text length / title:',
    JSON.stringify(Object.values(r.extensions).filter((e) => e.popup?.probe).map((e) => [e.name, e.popup.probe.textLength, e.popup.probe.title])),
  );
  if (r.library?.contextMenus) console.log('contextMenus:', JSON.stringify(r.library.contextMenus));
  if (r.library?.popups) console.log('library popups:', JSON.stringify(r.library.popups));
  if (r.library?.tabsCreatedByExtensions) console.log('tabs/windows created by extensions:', JSON.stringify(r.library.tabsCreatedByExtensions));
  const warn = r.chromiumLogExtensionLines.filter((l) => /Permission '|not supported in Electron|is unknown|Unrecognized/.test(l));
  console.log('load/log warnings:', JSON.stringify([...new Set(warn.map((l) => l.trim()))]));
}
