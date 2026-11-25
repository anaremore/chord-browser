/**
 * S18 M2e-2 spike (not a test to keep): on Electron 45.4.1, in a tab of yours, can Chord hold or refuse a passkey prompt,
 * a page dialog, PaymentRequest, FedCM and window.print() while the assistant acts? Prints what it saw. To run it,
 * copy it to apps/desktop/test/e2e/ (it imports ./a11y-kit) and run `pnpm test:e2e:linux spike.spec.ts`; the findings
 * are "M2e-2 spike" in docs/decisions/S18-agent-mcp.md.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { dispatch, isShell, launch, pageWhere, where } from './a11y-kit';

let server: Server;
let origin = '';
test.beforeAll(async () => {
  server = createServer((req, res) => {
    // A whole FedCM identity provider on this origin, with one account, so a browser that has FedCM's UI would show it.
    const json: Record<string, unknown> = {
      '/.well-known/web-identity': { provider_urls: [`${origin}/fedcm.json`] },
      '/fedcm.json': { accounts_endpoint: '/accounts', client_metadata_endpoint: '/client', id_assertion_endpoint: '/assert', login_url: '/login' },
      '/accounts': { accounts: [{ id: '1', name: 'Spike User', email: 'spike@example.test', given_name: 'Spike' }] },
      '/client': {},
      '/assert': { token: 'spike-token' },
    };
    const path = (req.url ?? '').split('?')[0]!;
    if (path in json) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-login': 'logged-in' });
      res.end(JSON.stringify(json[path]));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<title>Spike</title><p>Spike page.</p>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());

const race = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);

test('M2e-2 spike', async () => {
  test.setTimeout(180_000);
  const app = await launch({});
  const out: Record<string, unknown> = { electron: await app.evaluate(() => process.versions.electron), platform: process.platform };
  try {
    const shell = await pageWhere(app, isShell);
    await dispatch(shell, { t: 'tab.open', windowId: (await where(shell)).windowId, url: `${origin}/` });
    const page: Page = await pageWhere(app, (u) => u.startsWith(origin));
    await page.waitForLoadState('load');
    out['hasFocus'] = await page.evaluate(() => document.hasFocus());

    const attach = () =>
      app.evaluate(({ webContents }, o) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(o))!;
        const g = globalThis as unknown as { spikeWc: Electron.WebContents; spikeEvents: [string, string][] };
        g.spikeWc = wc;
        g.spikeEvents = [];
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        wc.debugger.on('message', (_e, m, p) => g.spikeEvents.push([m, JSON.stringify(p).slice(0, 300)]));
      }, origin);
    const send = (method: string, params: object = {}) =>
      app.evaluate(
        async (_e, [m, p]) => {
          const g = globalThis as unknown as { spikeWc: Electron.WebContents };
          return g.spikeWc.debugger.sendCommand(m as string, p as object).then(
            (r) => ({ ok: true, r: JSON.stringify(r).slice(0, 300) }),
            (e) => ({ ok: false, e: String(e).slice(0, 300) }),
          );
        },
        [method, params] as const,
      );
    const events = () => app.evaluate(() => (globalThis as unknown as { spikeEvents: [string, string][] }).spikeEvents.splice(0));
    const timed = (code: string, ms = 6000) =>
      page.evaluate(
        async ([c, limit]) => {
          const started = performance.now();
          const result = await Promise.race([
            (0, eval)(c as string).then(
              (r: unknown) => `resolved: ${String(r).slice(0, 120)}`,
              (e: Error) => `rejected: ${e.name}: ${e.message.slice(0, 160)}`,
            ),
            new Promise((r) => setTimeout(() => r('timeout'), limit as number)),
          ]);
          return { result, ms: Math.round(performance.now() - started) };
        },
        [code, ms] as const,
      );
    const challenge = 'new Uint8Array(32)';
    const getCred = `navigator.credentials.get({ publicKey: { challenge: ${challenge}, timeout: 4000, rpId: 'localhost', userVerification: 'discouraged', allowCredentials: [] } })`;
    const createCred = `navigator.credentials.create({ publicKey: { challenge: ${challenge}, timeout: 4000, rp: { id: 'localhost', name: 'Spike' }, user: { id: new Uint8Array(8), name: 'u', displayName: 'U' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } })`;

    // 1. WebAuthn with WebAuthn.enable({ enableUI: false }) and no virtual authenticator, then without (last, on a fresh
    // page: a request with no authenticator stays pending, and blocks the next one).
    await attach();
    out['WebAuthn.enable'] = await send('WebAuthn.enable', { enableUI: false });
    out['webauthn.get.enabled'] = await timed(getCred, 8000);
    out['webauthn.create.enabled'] = await timed(createCred, 8000);
    out['webauthn.events'] = await events();
    out['WebAuthn.disable'] = await send('WebAuthn.disable');

    // 2. PaymentRequest.
    out['PaymentRequest.type'] = await page.evaluate(() => typeof (window as unknown as { PaymentRequest?: unknown }).PaymentRequest);
    out['PaymentRequest.show'] = await timed(`new PaymentRequest([{ supportedMethods: 'https://example.test/pay' }], { total: { label: 'x', amount: { currency: 'USD', value: '1' } } }).show()`);
    out['PaymentRequest.canMakePayment'] = await timed(`new PaymentRequest([{ supportedMethods: 'basic-card' }], { total: { label: 'x', amount: { currency: 'USD', value: '1' } } }).canMakePayment()`);

    // 3. FedCM.
    out['IdentityCredential.type'] = await page.evaluate(() => typeof (window as unknown as { IdentityCredential?: unknown }).IdentityCredential);
    out['FedCm.enable'] = await send('FedCm.enable', { disableRejectionDelay: true });
    out['fedcm.get'] = await timed(`navigator.credentials.get({ identity: { providers: [{ configURL: location.origin + '/fedcm.json', clientId: 'x' }] } })`);
    out['fedcm.events'] = await events();

    // 4. A page dialog with the Page domain on: the event, the shell meanwhile, and answering it over CDP.
    out['Page.enable'] = await send('Page.enable');
    await page.evaluate(() => void setTimeout(() => ((window as unknown as { answered: unknown }).answered = confirm('Spike?')), 0));
    await new Promise((r) => setTimeout(r, 1500));
    out['dialog.events'] = await events();
    out['dialog.windows'] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    out['dialog.shellResponds'] = await race(shell.evaluate(() => 1), 2000);
    out['dialog.pageResponds'] = await race(page.evaluate(() => 1), 2000);
    out['Page.handleJavaScriptDialog'] = await send('Page.handleJavaScriptDialog', { accept: false });
    await new Promise((r) => setTimeout(r, 300));
    out['dialog.answered'] = await race(page.evaluate(() => (window as unknown as { answered: unknown }).answered), 2000);

    // 5. window.print(): what main and CDP see, and whether the page and the shell go on.
    await page.evaluate(() => void setTimeout(() => {
      window.print();
      (window as unknown as { printedAt: number }).printedAt = Date.now();
    }, 0));
    await new Promise((r) => setTimeout(r, 1500));
    out['print.events'] = await events();
    out['print.shellResponds'] = await race(shell.evaluate(() => 1), 2000);
    out['print.pageResponds'] = await race(page.evaluate(() => (window as unknown as { printedAt?: number }).printedAt ?? 'not yet'), 2000);
    out['print.windows'] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
    out['print.later'] = await race(page.evaluate(() => (window as unknown as { printedAt?: number }).printedAt ?? 'not yet'), 5000);

    // 6. WebAuthn with nothing in the way, on a fresh page (the print may still hold the old one): what a page gets.
    await app.evaluate(({ webContents }, o) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(o))?.reload(), origin);
    await page.waitForLoadState('load').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1000));
    out['webauthn.get.plain'] = await race(timed(getCred, 6000), 9000);
  } finally {
    console.log(`SPIKE ${JSON.stringify(out, null, 1)}`);
    await app.close().catch(() => undefined);
  }
  expect(out['electron']).toBe('45.4.1');
});
