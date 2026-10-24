// Spike S11's test page: a heavy news article, served locally.
//
// Every host is mapped to 127.0.0.1 with --host-resolver-rules, so the page's
// ad and tracker requests use their real host names and paths (what the lists
// match) and still never leave the machine. A request the server sees is one
// that wasn't blocked.
//
// The page has about 370 requests when nothing is blocked: 150 of its own
// (scripts, styles, fonts, 100 photos, API calls), a video embed, a library
// CDN, and the ad and tracking stack of a big news site: Google Publisher Tag
// with eight safeframes, AdSense, Prebid with ten bidders and a cookie-sync
// iframe of 24 pixels, Amazon, Google Analytics, Meta, comScore, Chartbeat,
// Hotjar, Taboola, Outbrain, Segment and others. Ad scripts that load create
// the requests they would on a real page, so blocking a loader also saves
// everything it would have loaded.
import { createServer } from 'node:http';

const PAGE_HOST = 'www.news.s11.test';

/** A small, fixed pseudo-random sequence, so every run builds the same page. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Each host answers after its own fixed delay, 5 to 34 ms, like a real network. */
export function hostDelay(host) {
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 5 + (h % 30);
}

/**
 * The page as a tree: each entry is something loaded, with the type webRequest
 * reports, and what it loads in turn when it isn't blocked.
 */
function tree(port) {
  const rnd = seeded(11);
  const u = (host, path) => `http://${host}:${port}${path}`;
  const n = () => Math.floor(rnd() * 1e9);
  const img = (host, path) => ({ type: 'image', url: u(host, path) });
  const xhr = (host, path) => ({ type: 'xmlhttprequest', url: u(host, path) });
  const script = (host, path, children = []) => ({ type: 'script', url: u(host, path), children });
  const frame = (host, path, children = []) => ({ type: 'sub_frame', url: u(host, path), children });
  const times = (count, make) => Array.from({ length: count }, (_, i) => make(i));

  const own = [
    ...times(6, (i) => ({ type: 'stylesheet', url: u(PAGE_HOST, `/static/css/main-${i}.css`) })),
    ...times(4, (i) => ({ type: 'font', url: u('fonts.s11cdn.test', `/onest/onest-${i}.woff2`) })),
    ...times(18, (i) => script(PAGE_HOST, `/static/js/chunk-${i}.js`)),
    ...times(12, (i) => script('cdn.s11cdn.test', `/libs/lib-${i}/1.0.${i}/lib.min.js`)),
    ...times(100, (i) => img(`img.news.s11.test`, `/photos/2026/10/${i}.jpg?w=480`)),
    ...times(10, (i) => xhr(PAGE_HOST, `/api/article/${i}/comments`)),
    frame('player.s11video.test', '/embed/4821', [
      script('player.s11video.test', '/player.js'),
      ...times(7, (i) => img('player.s11video.test', `/thumbs/${i}.jpg`)),
    ]),
    // First-party files that generic rules catch by their paths.
    script(PAGE_HOST, '/static/js/advertisement.js'),
    script(PAGE_HOST, '/ads/header-bidding.js'),
    img(PAGE_HOST, '/ads/banner-728x90.gif'),
  ];

  const gpt = script('securepubads.g.doubleclick.net', '/tag/js/gpt.js', [
    ...times(12, (i) => xhr('securepubads.g.doubleclick.net', `/gampad/ads?iu=/1234/news/slot${i}&sz=300x250&correlator=${n()}`)),
    ...times(8, (i) =>
      frame('tpc.googlesyndication.com', `/safeframe/1-0-41/html/container.html?slot=${i}`, [
        img('tpc.googlesyndication.com', `/simgad/${n()}`),
        img('tpc.googlesyndication.com', `/simgad/${n()}`),
        img('s0.2mdn.net', `/simgad/${n()}`),
        img('ad.doubleclick.net', `/ddm/trackimp/N${n()};dc_trk_aid=${n()};ord=${n()}`),
        img('pagead2.googlesyndication.com', `/pcs/activeview?xai=${n()}&sig=${n()}`),
        script('pagead2.googlesyndication.com', `/bg/${n()}.js`),
      ]),
    ),
  ]);
  const adsense = script('pagead2.googlesyndication.com', '/pagead/js/adsbygoogle.js?client=ca-pub-1234567890', [
    ...times(4, (i) =>
      frame('googleads.g.doubleclick.net', `/pagead/ads?client=ca-pub-1234567890&slot=${i}&output=html`, [
        ...times(3, () => img('tpc.googlesyndication.com', `/simgad/${n()}`)),
        img('pagead2.googlesyndication.com', `/pcs/activeview?xai=${n()}`),
      ]),
    ),
  ]);
  const bidders = [
    ['ib.adnxs.com', '/ut/v3/prebid', 4],
    ['hbopenbid.pubmatic.com', '/translator?source=prebid-client', 4],
    ['fastlane.rubiconproject.com', '/a/api/fastlane.json?account_id=1', 4],
    ['htlb.casalemedia.com', '/cygnus?s=1&v=8', 3],
    ['rtb.openx.net', '/openrtbb/prebidjs', 3],
    ['bidder.criteo.com', '/cdb?profileId=207', 3],
    ['tlx.3lift.com', '/header/auction?inv_code=news', 3],
    ['ap.lijit.com', '/rtb/bid?src=prebid', 2],
    ['prebid.media.net', '/rtb/prebid?cid=1', 2],
    ['c2shb.pubgw.yahoo.com', '/bidRequest', 2],
  ];
  const syncs = [
    ['pixel.rubiconproject.com', '/exchange/sync.php?p=prebid'],
    ['cm.g.doubleclick.net', '/pixel?google_nid=news&google_cm'],
    ['ups.analytics.yahoo.com', '/ups/58784/sync?uid=1'],
    ['match.adsrvr.org', '/track/cmf/generic?ttd_pid=news'],
    ['x.bidswitch.net', '/sync?ssp=news'],
    ['eb2.3lift.com', '/sync?gdpr=0'],
    ['ssum-sec.casalemedia.com', '/usermatchredir?s=1'],
    ['image8.pubmatic.com', '/AdServer/ImgSync?p=1'],
    ['us-u.openx.net', '/w/1.0/pd?ph=1'],
    ['sync.outbrain.com', '/cookie-sync?p=news'],
    ['ib.adnxs.com', '/getuid?http%3A%2F%2Fexample.test'],
    ['dis.criteo.com', '/dis/usersync.aspx?r=1'],
    ['cs.media.net', '/cksync.php?cs=1'],
    ['sync.taboola.com', '/sg/news/1/rtb-h/'],
    ['pixel.tapad.com', '/idsync/ex/receive?partner_id=1'],
    ['dpm.demdex.net', '/ibs:dpid=411&dpuuid=1'],
    ['sync.crwdcntrl.net', '/map/c=1/tp=NEWS'],
    ['idsync.rlcdn.com', '/1000.gif?partner_uid=1'],
    ['pixel-sync.sitescout.com', '/connectors/news/usersync'],
    ['token.rubiconproject.com', '/token?pid=1'],
    ['simage2.pubmatic.com', '/AdServer/Pug?vcode=bz0y'],
    ['cms.quantserve.com', '/dpixel?a=1'],
    ['sync.mathtag.com', '/sync/img?mt_exid=1'],
    ['px.ads.linkedin.com', '/setuid?partner=1'],
  ];
  const prebid = script(PAGE_HOST, '/static/js/prebid8.js', [
    ...bidders.flatMap(([host, path, count]) => times(count, (i) => xhr(host, `${path}&imp=${i}`))),
    frame('acdn.adnxs.com', '/dmp/async_usersync.html', syncs.map(([host, path]) => img(host, path))),
  ]);
  const trackers = [
    script('c.amazon-adsystem.com', '/aax2/apstag.js', times(3, () => xhr('aax.amazon-adsystem.com', `/e/dtb/bid?src=3&u=${n()}`))),
    script('www.googletagmanager.com', '/gtag/js?id=G-S11TEST', [
      ...times(3, (i) => img('www.google-analytics.com', `/g/collect?v=2&tid=G-S11TEST&en=page_view&_s=${i}`)),
      img('region1.google-analytics.com', '/g/collect?v=2&tid=G-S11TEST&en=scroll'),
      img('stats.g.doubleclick.net', '/g/collect?v=2&tid=G-S11TEST'),
    ]),
    script('connect.facebook.net', '/en_US/fbevents.js', [script('connect.facebook.net', '/signals/config/123456789?v=2.9.200'), img('www.facebook.com', '/tr/?id=123456789&ev=PageView&noscript=1')]),
    script('sb.scorecardresearch.com', '/beacon.js', [img('sb.scorecardresearch.com', `/b?c1=2&c2=1234567&ns__t=${n()}`)]),
    script('static.chartbeat.com', '/js/chartbeat.js', times(3, (i) => img('ping.chartbeat.net', `/ping?h=news.s11.test&x=${i}`))),
    script('static.hotjar.com', '/c/hotjar-1234567.js?sv=6', [script('script.hotjar.com', '/modules.4c7cfb9d.js')]),
    script('cdn.taboola.com', '/libtrc/news-s11/loader.js', [
      xhr('trc.taboola.com', '/news-s11/trc/3/json?tim=1'),
      ...times(10, () => img('images.taboola.com', `/taboola/image/fetch/f_jpg,q_auto/${n()}.jpg`)),
      img('trc-events.taboola.com', '/news-s11/log/3/available?tim=1'),
    ]),
    script('widgets.outbrain.com', '/outbrain.js', [
      xhr('widgets.outbrain.com', '/outbrain/request?url=news'),
      ...times(8, () => img('images.outbrainimg.com', `/transform/v3/eyJ${n()}.jpg`)),
      img('log.outbrainimg.com', '/loggerServices/widgetGlobalEvent?p=1'),
    ]),
    script('cdn.segment.com', '/analytics.js/v1/abc123/analytics.min.js', times(2, () => xhr('api.segment.io', '/v1/p'))),
    script('js-sec.indexww.com', '/ht/p/185901-159836282584097.js'),
    script('z.moatads.com', '/newsanalytics/moatad.js', [img('px.moatads.com', '/pixel.gif?e=17&i=NEWS')]),
    script('cdn.krxd.net', '/controltag/abc123.js', [img('beacon.krxd.net', '/pixel.gif?source=smarttag')]),
    script('tags.crwdcntrl.net', '/lt/c/1234/lt.min.js'),
    img('pixel.quantserve.com', '/pixel/p-abc123.gif'),
    script('bat.bing.com', '/bat.js', [img('bat.bing.com', '/action/0?ti=1234567&evt=pageLoad')]),
    // Consent and embeds the lists leave alone.
    script('cdn.cookielaw.org', '/scripttemplates/otSDKStub.js'),
    script('www.youtube.com', '/iframe_api'),
    script('platform.twitter.com', '/widgets.js'),
  ];
  return [...own, gpt, adsense, prebid, ...trackers];
}

/** The page's address. */
export const pageUrl = (port) => `http://${PAGE_HOST}:${port}/article`;

/** Every request the page makes when nothing is blocked: { url, type, source } (source = the document that asks). */
export function fixtureRequests(port) {
  const out = [];
  const walk = (entries, source) => {
    for (const e of entries) {
      out.push({ url: e.url, type: e.type, source });
      if (e.children) walk(e.children, e.type === 'sub_frame' ? e.url : source);
    }
  };
  walk(tree(port), pageUrl(port));
  return out;
}

/** How each child is made from a script or an iframe's document. */
const LOAD_CHILDREN = `(function (children) {
  var body = document.body || document.documentElement;
  children.forEach(function (c) {
    var el;
    if (c[0] === 'xmlhttprequest') { fetch(c[1], { mode: 'no-cors', cache: 'no-store' }).catch(function () {}); return; }
    if (c[0] === 'image') { el = new Image(); el.src = c[1]; return; }
    if (c[0] === 'script') { el = document.createElement('script'); el.src = c[1]; el.async = true; }
    else if (c[0] === 'sub_frame') { el = document.createElement('iframe'); el.src = c[1]; el.width = 300; el.height = 250; }
    if (el) body.appendChild(el);
  });
})`;

const tag = (e) => {
  if (e.type === 'stylesheet') return `<link rel="stylesheet" href="${e.url}">`;
  if (e.type === 'font') return `<link rel="preload" as="font" type="font/woff2" crossorigin href="${e.url}">`;
  if (e.type === 'script') return `<script async src="${e.url}"></script>`;
  if (e.type === 'image') return `<img src="${e.url}" width="160" height="90" alt="">`;
  if (e.type === 'sub_frame') return `<iframe src="${e.url}" width="300" height="250"></iframe>`;
  return '';
};

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * The server: the page, its files, and every host it talks to. Every answer
 * is no-store, so each load asks again. `hits` counts what reached it.
 */
export function startServer(port) {
  const entries = tree(port);
  const byUrl = new Map();
  const index = (list) => {
    for (const e of list) {
      byUrl.set(e.url, e);
      if (e.children) index(e.children);
    }
  };
  index(entries);
  const state = { hits: 0, lastHitAt: 0, hosts: new Map(), paths: new Set() };
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Spike S11: a news article</title>
${entries.filter((e) => e.type === 'stylesheet' || e.type === 'font').map(tag).join('\n')}
</head><body><h1>A heavy news article</h1>
${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>'.repeat(40)}
<div class="ad-slot adsbygoogle" id="div-gpt-ad-1">ad</div>
${entries.filter((e) => e.type !== 'stylesheet' && e.type !== 'font' && e.type !== 'xmlhttprequest').map(tag).join('\n')}
<script>${LOAD_CHILDREN}(${JSON.stringify(entries.filter((e) => e.type === 'xmlhttprequest').map((e) => [e.type, e.url]))});</script>
</body></html>`;
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    state.hits++;
    state.lastHitAt = performance.now();
    state.hosts.set(host, (state.hosts.get(host) ?? 0) + 1);
    if (req.url?.includes('probe=')) state.paths.add(`${host}${req.url}`);
    const url = `http://${host}:${port}${req.url}`;
    const entry = byUrl.get(url);
    const send = (type, body) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        res.end(body);
      }, hostDelay(host));
    };
    const path = (req.url ?? '').split('?')[0];
    if (host === PAGE_HOST && path === '/article') return send('text/html; charset=utf-8', page);
    if (path === '/probe') return send('text/html; charset=utf-8', '<!doctype html><title>Probe</title>');
    const children = (entry?.children ?? []).map((c) => [c.type, c.url]);
    if (entry?.type === 'sub_frame') {
      return send('text/html; charset=utf-8', `<!doctype html><body>${(entry.children ?? []).map(tag).join('')}</body>`);
    }
    if (entry?.type === 'script' || /\.js(\?|$)/.test(req.url ?? '')) {
      return send('text/javascript', children.length ? `${LOAD_CHILDREN}(${JSON.stringify(children)});` : '/* ok */');
    }
    if (entry?.type === 'stylesheet') return send('text/css', 'body { margin: 0 }');
    if (entry?.type === 'image') return send('image/gif', GIF);
    if (entry?.type === 'font') return send('font/woff2', Buffer.alloc(64));
    if (entry?.type === 'xmlhttprequest') return send('application/json', '{}');
    return send('text/plain', '');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, state })));
}
