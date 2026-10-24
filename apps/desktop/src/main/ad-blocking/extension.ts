/**
 * Chord's blocker extension (ARCHITECTURE.md §9, §12): the lists as
 * declarativeNetRequest rules, loaded into a chord's session so Chromium
 * matches every request itself, with no JavaScript per request and nothing in
 * the way of other extensions (uBO Lite included, whose rules apply as well).
 *
 * One copy per profile session, in `<userData>/Ad Blocking/Extension/<profile>`:
 * Chromium writes its index of the rules into the extension's folder, and two
 * sessions indexing one folder could race. No key: an unpacked extension's ID
 * comes from its folder, which never moves.
 *
 * Electron skips Chrome's install step, so the rulesets a manifest enables
 * stay off until the extension turns them on (S9). Chord does that, and sets
 * the sites you turned blocking off for, from the extension's control page:
 * an empty page of its own that main runs declarativeNetRequest calls in,
 * opened only for a change and closed after. No preload, no IPC. Chromium
 * keeps both across launches. A list update takes the extension out, rewrites
 * the rules and drops Chromium's index of them, loads it again and turns the
 * rulesets on, which indexes the new rules: about a third of a second without
 * blocking in that profile, every few days. (Turning loaded rulesets off and
 * on instead fails: Chromium checks the new files against the old checksums.
 * docs/decisions/S11-ad-blocking.md.)
 */
import { WebContentsView, type Session } from 'electron';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILTER_LISTS } from './lists';
import { siteOffRule } from './rules';

/** The dynamic rule that holds every site blocking is off for. */
const SITES_RULE_ID = 1;
const CONTROL_TIMEOUT_MS = 20_000;
const RULESETS = FILTER_LISTS.map((l) => l.id);

const MANIFEST = {
  manifest_version: 3,
  name: 'Chord ad blocking',
  description: 'EasyList and EasyPrivacy, built into Chord.',
  version: '1.0.0',
  permissions: ['declarativeNetRequest'],
  declarative_net_request: { rule_resources: FILTER_LISTS.map((l) => ({ id: l.id, enabled: true, path: `rules/${l.id}.json` })) },
};
const CONTROL_PAGE = '<!doctype html><meta charset="utf-8"><title>Chord ad blocking</title>';

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The blocker didn’t answer')), ms).unref?.())]);
}

export class BlockerExtension {
  private extension: Electron.Extension | null = null;

  constructor(
    readonly session: Session,
    /** The extension's own folder for this profile. */
    readonly folder: string,
  ) {}

  get loaded(): boolean {
    return this.extension !== null && this.session.extensions.getExtension(this.extension.id) !== null;
  }

  /** Put a compiled set's rules in the folder, with the manifest and control page, and drop Chromium's index of the old ones. Unloaded first. */
  async write(setDir: string): Promise<void> {
    this.unload();
    await mkdir(join(this.folder, 'rules'), { recursive: true });
    await writeFile(join(this.folder, 'manifest.json'), JSON.stringify(MANIFEST, null, 2));
    await writeFile(join(this.folder, 'control.html'), CONTROL_PAGE);
    for (const id of RULESETS) await cp(join(setDir, 'rules', `${id}.json`), join(this.folder, 'rules', `${id}.json`));
    await rm(join(this.folder, '_metadata'), { recursive: true, force: true });
  }

  /** Load the extension; true if it wasn't loaded. Its rules load a moment later, on Chromium's own threads. */
  async load(): Promise<boolean> {
    if (this.loaded) return false;
    this.extension = await this.session.extensions.loadExtension(this.folder, { allowFileAccess: false });
    return true;
  }

  /** Blocking off in this session at once: Chromium stops applying the rules (and keeps them, and the sites, for next time). */
  unload(): void {
    if (this.extension && this.session.extensions.getExtension(this.extension.id)) this.session.extensions.removeExtension(this.extension.id);
    this.extension = null;
  }

  /**
   * Turn the rulesets on (rules written since are indexed then), and set the
   * sites blocking is off for. Chromium holds these calls until a just-loaded
   * extension's rules are in, so when this resolves they apply.
   */
  async apply(offSites: readonly string[]): Promise<void> {
    const sites = offSites.length ? [siteOffRule(SITES_RULE_ID, offSites)] : [];
    await this.control(
      `await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ${JSON.stringify(RULESETS)} });
       await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [${SITES_RULE_ID}], addRules: ${JSON.stringify(sites)} });`,
    );
  }

  /** What Chromium has: the rulesets on, and the sites blocking is off for. */
  async read(): Promise<{ enabled: string[]; offSites: string[] }> {
    return await this.control(
      `const rules = await chrome.declarativeNetRequest.getDynamicRules();
       return { enabled: await chrome.declarativeNetRequest.getEnabledRulesets(), offSites: rules.find((r) => r.id === ${SITES_RULE_ID})?.condition.topDomains ?? [] };`,
    );
  }

  /** Run `body` (an async function's body) in the control page, which closes afterwards. */
  private async control<T>(body: string): Promise<T> {
    if (!this.extension) throw new Error('The blocker isn’t loaded');
    const view = new WebContentsView({ webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const contents = view.webContents;
    try {
      await within(contents.loadURL(`chrome-extension://${this.extension.id}/control.html`), CONTROL_TIMEOUT_MS);
      return (await within(contents.executeJavaScript(`(async () => { ${body} })()`), CONTROL_TIMEOUT_MS)) as T;
    } finally {
      if (!contents.isDestroyed()) contents.close();
    }
  }
}
