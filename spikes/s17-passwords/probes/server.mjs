// Spike S17 M0: the fixture server. One port; the site is the Host header, so with
// Chromium's host-resolver-rules mapping every name to 127.0.0.1, login.test, other.test
// and ad7.test are different sites, each with its own renderer under site isolation.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(join(import.meta.dirname, '..', '..', '..', 'apps', 'desktop', 'package.json'));
// React 19 as a real page would have it: its CommonJS production builds behind a tiny module shim.
const reactBundle = () => {
  const dir = (name) => dirname(require.resolve(`${name}/package.json`));
  const files = { react: join(dir('react'), 'cjs', 'react.production.js'), scheduler: join(dir('scheduler'), 'cjs', 'scheduler.production.js'), 'react-dom': join(dir('react-dom'), 'cjs', 'react-dom.production.js'), 'react-dom/client': join(dir('react-dom'), 'cjs', 'react-dom-client.production.js') };
  let out = 'var process = { env: { NODE_ENV: "production" } }; var __mods = {}, __defs = {};\nfunction __req(n) { if (!__mods[n]) { var m = { exports: {} }; __mods[n] = m; __defs[n](m, m.exports, __req); } return __mods[n].exports; }\n';
  for (const [name, file] of Object.entries(files)) out += `__defs[${JSON.stringify(name)}] = function (module, exports, require) {\n${readFileSync(file, 'utf8')}\n};\n`;
  return out + 'window.React = __req("react"); window.ReactDOMClient = __req("react-dom/client");\n';
};
let reactSource;

/** A sign-in form, controlled by React 19, that logs what the page itself sees. */
const reactLogin = (heading) => `<!doctype html><meta charset="utf-8"><title>${heading}</title>
<style>body { font: 16px sans-serif; margin: 40px; } input { display: block; margin: 8px 0 24px; width: 260px; height: 28px; }</style>
<h1>${heading}</h1><div id="root"></div><div style="height: 2000px"></div>
<script src="/react.js"></script><script src="/app.js"></script>`;
const app = `
const e = React.createElement;
window.seen = { keys: [], events: [], clicks: [], blurs: 0, focuses: 0 };
window.reactState = { user: '', pass: '', renders: 0 };
function Login() {
  const [user, setUser] = React.useState('');
  const [pass, setPass] = React.useState('');
  window.reactState = { user, pass, renders: window.reactState.renders + 1 };
  return e('form', { id: 'login', onSubmit: (ev) => ev.preventDefault() },
    e('label', { htmlFor: 'user' }, 'Email'), e('input', { id: 'user', name: 'email', type: 'email', autoComplete: 'username', value: user, onChange: (ev) => setUser(ev.target.value) }),
    e('label', { htmlFor: 'pass' }, 'Password'), e('input', { id: 'pass', name: 'password', type: 'password', autoComplete: 'current-password', value: pass, onChange: (ev) => setPass(ev.target.value) }),
    e('button', { type: 'submit' }, 'Sign in'));
}
ReactDOMClient.createRoot(document.getElementById('root')).render(e(Login));
for (const t of ['input', 'change']) document.addEventListener(t, (ev) => window.seen.events.push(t + ':' + ev.target.id), true);
document.addEventListener('keydown', (ev) => window.seen.keys.push(ev.key), true);
document.addEventListener('click', (ev) => window.seen.clicks.push({ id: ev.target.id || ev.target.tagName, x: ev.clientX, y: ev.clientY }), true);
document.addEventListener('focusout', (ev) => { if (ev.target.id) window.seen.blurs++; }, true);
document.addEventListener('focusin', (ev) => { if (ev.target.id) window.seen.focuses++; }, true);
// Question 7: what the page's own requests return, and (the control) what the page's own observer sees.
window.pageSaw = [];
new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') pageSaw.push(new URL(e.name).pathname + ' ' + e.initiatorType + ' ' + e.responseStatus); }).observe({ type: 'resource' });
window.tryRequests = async (other, read) => {
  const take = async (r) => { if (read) await r.text(); return r; };
  const out = [];
  out.push((await take(await fetch('/api/login', { method: 'POST', body: 'x' }))).status);
  out.push((await take(await fetch('/api/login?ok=1', { method: 'POST', body: 'x' }))).status);
  await new Promise((done) => { const x = new XMLHttpRequest(); x.open('POST', '/api/xhr'); x.onloadend = () => { out.push(x.status); done(); }; x.send('x'); });
  out.push((await take(await fetch(other + '/api/cors', { method: 'POST', body: 'x' }))).status);
  out.push((await take(await fetch(other + '/api/nocors', { mode: 'no-cors' }))).type);
  return out;
};
`;

const framesPage = (port) => `<!doctype html><meta charset="utf-8"><title>Frames</title>
<h1>Frames</h1>
<iframe id="same" src="/inner" width="400" height="300"></iframe>
<iframe id="srcdoc" width="400" height="200" srcdoc="<form><input id=user name=username><input id=pass type=password></form>"></iframe>
<iframe id="cross" src="http://other.test:${port}/inner" width="400" height="300"></iframe>
<iframe id="sandboxed" sandbox="allow-scripts allow-forms" src="/inner" width="400" height="300"></iframe>`;

/** A news front page: text, images, and `ads` ad slots, each another site's frame with a script and a nested frame of a third site. */
const newsPage = (port, ads) => {
  let body = '';
  for (let i = 0; i < ads; i++) {
    body += `<article><h2>Story ${i}</h2><p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12)}</p></article>`;
    body += `<iframe src="http://ad${i}.test:${port}/ad?n=${i}" width="300" height="250" style="border:0"></iframe>`;
  }
  return `<!doctype html><meta charset="utf-8"><title>News</title><style>article { max-width: 700px }</style><h1>The Daily Spike</h1>${body}`;
};
// About 40 KB of script per ad, run at load: what an ad tag's loader does, roughly.
const adScript = `(function(){ var s = 0; for (var i = 0; i < 2e5; i++) s += Math.sqrt(i); var d = document.createElement('div'); d.textContent = 'Ad ' + s.toFixed(0); document.body.appendChild(d); })();\n/*${'x'.repeat(40_000)}*/`;
const adPage = (port, n) => `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#eee"><script src="/ad.js"></script>
<svg width="300" height="200"><rect width="300" height="200" fill="#${(n * 2654435761 % 0xffffff).toString(16).padStart(6, '0')}"/></svg>
<iframe src="http://track${n}.test:${port}/pixel" width="1" height="1" style="border:0"></iframe>`;

export function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const host = String(req.headers.host || '').split(':')[0];
      const { port } = server.address();
      const url = new URL(req.url, `http://${host}`);
      const send = (status, type, body, headers = {}) => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
        res.end(body);
      };
      const html = (body, headers) => send(200, 'text/html; charset=utf-8', body, headers);
      switch (url.pathname) {
        case '/react.js':
          return send(200, 'text/javascript', (reactSource ??= reactBundle()));
        case '/app.js':
          return send(200, 'text/javascript', app);
        case '/login':
          return html(reactLogin('Sign in'));
        case '/csp':
          // A strict page: only its own scripts, no eval, Trusted Types required.
          return html(reactLogin('Strict CSP'), { 'content-security-policy': "default-src 'self'; script-src 'self'; require-trusted-types-for 'script'" });
        case '/inner':
          return html(reactLogin(`Inner on ${host}`));
        case '/frames':
          return html(framesPage(port));
        case '/plain':
          // No sign-in field: what most pages are.
          return html(`<!doctype html><meta charset="utf-8"><title>Plain</title><h1>Plain</h1><p>${'Words. '.repeat(200)}</p><input id="q" type="search" name="q"><p>Newsletter <input id="news" type="email" name="newsletter"></p>`);
        case '/news':
          return html(newsPage(port, Number(url.searchParams.get('ads') ?? 30)));
        case '/ad':
          return html(adPage(port, Number(url.searchParams.get('n') ?? 0)));
        case '/ad.js':
          return send(200, 'text/javascript', adScript);
        case '/pixel':
          return html('<!doctype html><body></body>');
        case '/api/login':
          return send(url.searchParams.has('ok') ? 200 : 401, 'application/json', '{}');
        case '/api/xhr':
          return send(204, 'application/json', '');
        case '/api/cors':
          return send(200, 'application/json', '{}', { 'access-control-allow-origin': '*' });
        case '/api/nocors':
          return send(403, 'application/json', '{}');
        case '/card':
          return html(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;font:14px sans-serif}
            .card{margin:0;background:#fff;border:1px solid #888;border-radius:8px;height:calc(100vh - 2px)} .row{padding:8px 12px} .row.on{background:#cde}</style>
            <div class="card"><div class="row on">ada@example.com</div><div class="row">grace@example.com</div><div class="row">Other passwords…</div></div>
            <script>window.log=[];for(const t of ['mousedown','click','focus','blur'])window.addEventListener(t,(e)=>log.push(t),true);
            window.highlight=(i)=>document.querySelectorAll('.row').forEach((r,j)=>r.classList.toggle('on',i===j));</script>`);
        default:
          return send(404, 'text/plain', 'not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
