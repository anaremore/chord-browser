#!/usr/bin/env node
// The sweep's list of sites (README.md): the top of the public Tranco list, downloaded into the
// sweep's folder (never the repo), with what can't have a sign-in page taken out.
//
//   node scripts/dev/signin-sweep/list.mjs --out <dir> [--top 1500] [--count 400] [--exclude <file>]
//
// Writes <dir>/tranco/<list id>.csv once (a list is fixed once published), then <dir>/sites.txt:
// one https://<domain>/ a line, best ranked first, and <dir>/sites.json with each one's rank.
//
// What's taken out:
// - infrastructure that has no pages of its own (CDNs, DNS, ad and analytics hosts, APIs), by the
//   words in its name (INFRA);
// - adult, gambling and similar sites, by the words in their names (UNWANTED), and every domain in
//   --exclude (one a line, # for comments), which holds what the words miss: kept beside the
//   results, since it names sites;
// - a second domain of a brand already listed (amazon.de after amazon.com): the same sign-in.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** Names of hosts that serve no sign-in page: CDNs, DNS, ads, analytics, telemetry, APIs, captive-portal checks. */
export const INFRA =
  /(^|[.-])(cdn|cdns|dns|ns\d*|edge|static|img|images|media|assets|api|apis|sdk|ads?|adserver|adsystem|adservice|adservices|analytics|metrics|telemetry|tracking|pixel|tag|tags|sync|rpc|relay|ntp|ocsp|crl|pki|cert|certs|update|updates|gslb|lb|cache|proxy|push|mirror|captive|connecttest|ncsi)([.-]|\d|$)|cdn|dns\b|akam|msedge|cloudfront|fastly|gstatic|googleapis|googlevideo|googleusercontent|googlesyndication|googletagmanager|googleadservices|doubleclick|ytimg|fbcdn|fbsbx|twimg|licdn|pinimg|scdn\.co|nflx|mzstatic|ggpht|gvt\d|usercontent|amazonaws|azureedge|azurefd|trafficmanager|windowsupdate|cloudapp|workers\.dev|pages\.dev|vercel-dns|herokudns|\.arpa$|root-servers|gtld|tiktokv|tiktokcdn|byteoversea|bytefcdn|ibyteimg|captive|portal-detection|adnxs|criteo|pubmatic|rubiconproject|casalemedia|taboola|outbrain|scorecardresearch|demdex|omtrdc|everesttech|adsrvr|openx|lijit|3lift|smartadserver|bidswitch|crwdcntrl|rlcdn|agkn|quantserve|flashtalking|doubleverify|adsafeprotected|moloco|applovin|appsflyer|adjust\.com|branch\.io|onelink|braze|amplitude|mixpanel|segment|sentry|bugsnag|datadoghq|newrelic|nr-data|hotjar|clarity\.ms|app-measurement|crashlytics|launchdarkly|statsig|optimizely|onetrust|cookielaw|privacy-mgmt|imrworldwide|conviva|teads|seedtag|sharethrough|33across|yieldmo|inmobi|vungle|unity3d|liftoff|smaato|presage|btloader|id5-sync|liadm|a-mo\.net|px-cloud|online-metrix|forter|awswaf|hcaptcha|recaptcha|lencr|digicert|globalsign|verisign|amazontrust|pki\.goog|icanhazip|ipify|ip-api|gandi-ns|domaincontrol|registrar-servers|name-services|dnsowl|ui-dns|nstld|markmonitor/i;

/** Adult, gambling, betting and similar: never visited. --exclude holds what these words miss. */
export const UNWANTED = /porn|xxx|sex|xvideo|xnxx|xhamster|hentai|erome|eporner|chaturbate|stripchat|onlyfans|livejasmin|bongacams|cam4|camsoda|nude|adult|escort|casino|gambl|poker|slots?\b|bet(s|ting|365|way|fair)?\b|1xbet|stake\.|lotter|bingo|sportsbook|bookmaker|draftkings|fanduel/i;

/** Brands listed under several domains (google.com, google.de): the first label of the domain, which is enough here. */
export const brandOf = (domain) => domain.replace(/^www\./, '').split('.')[0];

/** Tranco's CSV (rank,domain) to the sweep's list. */
export function chooseSites(csv, { top = 1500, count = 400, exclude = new Set() } = {}) {
  const brands = new Set();
  const sites = [];
  for (const line of csv.split(/\r?\n/)) {
    const [rankText, raw] = line.split(',');
    const rank = Number(rankText);
    const domain = raw?.trim().toLowerCase();
    if (!domain || !Number.isInteger(rank)) continue;
    if (rank > top || sites.length >= count) break;
    if (INFRA.test(domain) || UNWANTED.test(domain) || exclude.has(domain)) continue;
    const brand = brandOf(domain);
    if (brands.has(brand)) continue;
    brands.add(brand);
    sites.push({ rank, domain, url: `https://${domain}/` });
  }
  return sites;
}

/** The first file of a zip (Tranco's has one): enough of the format for that. */
export function firstFileOfZip(zip) {
  if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip file');
  const method = zip.readUInt16LE(8);
  let size = zip.readUInt32LE(18);
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const start = 30 + nameLength + extraLength;
  // A size of 0 here means it's in the data descriptor: read up to the central directory instead.
  if (size === 0) size = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), start) - start;
  const data = zip.subarray(start, start + size);
  return method === 0 ? data : inflateRawSync(data);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const out = value('--out');
  if (!out) {
    console.error('Usage: list.mjs --out <dir> [--top 1500] [--count 400] [--exclude <file>]');
    return 2;
  }
  const dir = resolve(out);
  mkdirSync(join(dir, 'tranco'), { recursive: true });
  const id = (await (await fetch('https://tranco-list.eu/top-1m-id')).text()).trim();
  if (!/^[A-Z0-9]{3,10}$/.test(id)) throw new Error(`Tranco's list id looks wrong: ${id.slice(0, 40)}`);
  const csvPath = join(dir, 'tranco', `${id}.csv`);
  if (!existsSync(csvPath)) {
    console.log(`[list] downloading Tranco list ${id}`);
    // The list by its id, which comes zipped; the day's own zip if that fails.
    let response = await fetch(`https://tranco-list.eu/download_daily/${id}`).catch(() => null);
    if (!response?.ok) response = await fetch('https://tranco-list.eu/top-1m.csv.zip');
    if (!response.ok) throw new Error(`Tranco answered ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const csv = (body.readUInt32LE(0) === 0x04034b50 ? firstFileOfZip(body) : body).toString('utf8');
    if (!/^1,[a-z0-9.-]+\r?\n/.test(csv)) throw new Error("Tranco's list isn't rank,domain CSV");
    writeFileSync(csvPath, csv);
  }
  const excludeFile = value('--exclude');
  const exclude = new Set(
    excludeFile
      ? readFileSync(excludeFile, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.replace(/#.*/, '').trim().toLowerCase())
          .filter(Boolean)
      : [],
  );
  const sites = chooseSites(readFileSync(csvPath, 'utf8'), { top: Number(value('--top', 1500)), count: Number(value('--count', 400)), exclude });
  writeFileSync(join(dir, 'sites.txt'), sites.map((s) => s.url).join('\n') + '\n');
  writeFileSync(join(dir, 'sites.json'), JSON.stringify({ tranco: id, made: new Date().toISOString(), sites }, null, 2));
  console.log(`[list] ${sites.length} sites from Tranco ${id} in ${join(dir, 'sites.txt')}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
