/**
 * Filter lists to declarativeNetRequest rules (ARCHITECTURE.md §9, decision
 * D5; docs/decisions/S11-ad-blocking.md). EasyList and EasyPrivacy are
 * written in Adblock Plus syntax, whose network filters map almost one to one
 * onto Chromium's rules: `||`, `|`, `*` and `^` mean the same in a urlFilter,
 * `$domain=` is initiatorDomains, `$third-party` is domainType, and `@@` is an
 * allow rule with a higher priority. Chromium then matches them in its own
 * code, with no JavaScript per request.
 *
 * What has no rule: element hiding (that's cosmetic filtering, done from the
 * engine), popups (not a request), `$csp`, `$header` and other options
 * Chromium's rules can't express. A filter with an option this doesn't know
 * is skipped rather than half-applied. `$rewrite` and `$redirect` block
 * instead, as the engine does without its replacement files.
 *
 * Pure and dependency-free: the build script runs it with Node, and the list
 * worker runs it after each refresh.
 */

export type ResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'webtransport'
  | 'webbundle'
  | 'other';

export interface RuleCondition {
  urlFilter?: string;
  regexFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  requestDomains?: string[];
  excludedRequestDomains?: string[];
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  /** The page's own site (the request's outermost frame), whatever frame the request comes from. */
  topDomains?: string[];
  resourceTypes?: ResourceType[];
  excludedResourceTypes?: ResourceType[];
  domainType?: 'firstParty' | 'thirdParty';
  requestMethods?: string[];
  excludedRequestMethods?: string[];
}

export interface Rule {
  id: number;
  priority: number;
  action: { type: 'block' | 'allow' | 'allowAllRequests' };
  condition: RuleCondition;
}

/**
 * Priorities, lowest first: blocks, then the lists' exceptions, then their
 * `$important` blocks, and above everything the sites you turned blocking off
 * for (a dynamic rule, from the blocker's control page).
 */
export const PRIORITY = { block: 1, exception: 2, important: 3, siteOff: 4 } as const;

/** Chromium's limit on regexFilter rules per extension. */
export const MAX_REGEX_RULES = 1000;

export interface CompileStats {
  /** Lines that are network filters (not comments, not element hiding). */
  filters: number;
  /** Rules written, after merging host-only filters. */
  rules: number;
  /** Filters with no rule, by reason. */
  skipped: Record<string, number>;
}

const TYPES: Record<string, ResourceType | 'document' | 'popup' | null> = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  ping: 'ping',
  beacon: 'ping',
  media: 'media',
  font: 'font',
  websocket: 'websocket',
  other: 'other',
  document: 'document',
  doc: 'document',
  popup: 'popup',
  // WebRTC connections aren't requests Chromium's rules see.
  webrtc: null,
};

/** Options that only affect element hiding: an exception with just these has no network rule. */
const COSMETIC_EXCEPTIONS = new Set(['elemhide', 'ehide', 'generichide', 'ghide', 'specifichide', 'shide']);
/** Options that replace a blocked response with a stand-in file; without the files, the request is blocked. */
const REPLACEMENTS = new Set(['rewrite', 'redirect', 'empty', 'mp4']);

const COSMETIC = /#@?[$%?]?#|\$\$|#@?\$\?#/;
const OPTIONS = /\$(~?[\w-]+(?:=[^,]*)?(?:,~?[\w-]+(?:=[^,]*)?)*)$/;
const HOST_ONLY = /^\|\|([a-z0-9-]+(?:\.[a-z0-9-]+)+)\^\|?$/;
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const ASCII = /^[\x20-\x7e]*$/;
/** RE2 (what Chromium's regexFilter uses) has no lookaround and no backreferences. */
const NOT_RE2 = /\(\?<?[=!]|\\[1-9]/;

type Parsed = { skip: string } | { rules: Omit<Rule, 'id'>[] };

function domainList(value: string): { include: string[]; exclude: string[] } | null {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of value.split('|')) {
    const negated = raw.startsWith('~');
    const domain = (negated ? raw.slice(1) : raw).trim().toLowerCase();
    if (!domain) continue;
    // `example.*` (any top-level domain) has no equivalent in Chromium's rules.
    if (!DOMAIN.test(domain)) return null;
    (negated ? exclude : include).push(domain);
  }
  return { include, exclude };
}

/** One filter line: its rules (one, or two for an exception that also covers documents), or why it has none. */
export function parseFilter(line: string): Parsed | null {
  const text = line.trim();
  if (!text || text.startsWith('!') || text.startsWith('[')) return null;
  if (COSMETIC.test(text)) return null;
  const exception = text.startsWith('@@');
  let pattern = exception ? text.slice(2) : text;
  let options: string[] = [];
  const isRegex = pattern.length > 2 && pattern.startsWith('/') && /\/(\$|$)/.test(pattern.slice(1));
  const found = OPTIONS.exec(pattern);
  if (found && !(isRegex && !pattern.slice(0, found.index).endsWith('/'))) {
    options = found[1]!.split(',');
    pattern = pattern.slice(0, found.index);
  }

  const condition: RuleCondition = {};
  const types = new Set<ResourceType | 'document' | 'popup'>();
  const notTypes = new Set<ResourceType | 'document' | 'popup'>();
  let important = false;
  let caseSensitive = false;
  let cosmeticOnly = false;
  for (const option of options) {
    const negated = option.startsWith('~');
    const [rawName = '', value] = (negated ? option.slice(1) : option).split(/=(.*)/s);
    const name = rawName.toLowerCase();
    if (name in TYPES) {
      const type = TYPES[name];
      if (type) (negated ? notTypes : types).add(type);
      continue;
    }
    switch (name) {
      case 'third-party':
      case '3p':
        condition.domainType = negated ? 'firstParty' : 'thirdParty';
        break;
      case 'first-party':
      case '1p':
        condition.domainType = negated ? 'thirdParty' : 'firstParty';
        break;
      case 'domain':
      case 'from': {
        const domains = value ? domainList(value) : null;
        if (!domains) return { skip: 'domain wildcard' };
        if (domains.include.length) condition.initiatorDomains = domains.include;
        if (domains.exclude.length) condition.excludedInitiatorDomains = domains.exclude;
        break;
      }
      case 'to': {
        const domains = value ? domainList(value) : null;
        if (!domains) return { skip: 'domain wildcard' };
        if (domains.include.length) condition.requestDomains = domains.include;
        if (domains.exclude.length) condition.excludedRequestDomains = domains.exclude;
        break;
      }
      case 'denyallow': {
        const domains = value ? domainList(value) : null;
        if (!domains || domains.exclude.length) return { skip: 'domain wildcard' };
        condition.excludedRequestDomains = domains.include;
        break;
      }
      case 'method': {
        const methods = (value ?? '').toLowerCase().split('|');
        const include = methods.filter((m) => m && !m.startsWith('~'));
        const exclude = methods.filter((m) => m.startsWith('~')).map((m) => m.slice(1));
        if (include.length) condition.requestMethods = include;
        if (exclude.length) condition.excludedRequestMethods = exclude;
        break;
      }
      case 'match-case':
        caseSensitive = !negated;
        break;
      case 'important':
        important = true;
        break;
      case 'genericblock':
        return { skip: 'genericblock' };
      default:
        if (COSMETIC_EXCEPTIONS.has(name)) cosmeticOnly = true;
        else if (!REPLACEMENTS.has(name)) return { skip: `$${name}` };
    }
  }

  if (isRegex) {
    const source = pattern.slice(1, -1);
    if (!ASCII.test(source) || NOT_RE2.test(source)) return { skip: 'regex' };
    condition.regexFilter = source;
    if (caseSensitive) condition.isUrlFilterCaseSensitive = true;
  } else {
    let filter = pattern;
    if (filter.startsWith('||*')) filter = filter.slice(2);
    if (!ASCII.test(filter)) return { skip: 'not ASCII' };
    // `|` anchors only at the ends; in the middle Chromium rejects the filter.
    if (filter.slice(filter.startsWith('||') ? 2 : 1, -1).includes('|')) return { skip: 'pattern' };
    if (!caseSensitive) filter = filter.toLowerCase();
    const host = HOST_ONLY.exec(filter);
    if (host) condition.requestDomains = [host[1]!, ...(condition.requestDomains ?? [])];
    else if (filter && filter !== '*' && filter !== '|' && filter !== '||') {
      condition.urlFilter = filter;
      if (caseSensitive) condition.isUrlFilterCaseSensitive = true;
    }
  }
  if (!condition.urlFilter && !condition.regexFilter && !condition.requestDomains && !condition.initiatorDomains) {
    return { skip: cosmeticOnly ? 'element hiding' : 'matches everything' };
  }

  const document = types.has('document');
  types.delete('document');
  const popup = types.delete('popup');
  notTypes.delete('popup');
  const notDocument = notTypes.delete('document');
  if (popup && types.size === 0 && !document) return { skip: 'popup' };
  if (cosmeticOnly && types.size === 0 && !document) return { skip: 'element hiding' };

  const withTypes = (base: RuleCondition): RuleCondition => {
    if (types.size > 0) return { ...base, resourceTypes: [...types] as ResourceType[] };
    if (notTypes.size > 0) {
      // Excluding types alone would include pages themselves; filters never mean that.
      return { ...base, excludedResourceTypes: [...new Set([...(notTypes as Set<ResourceType>), 'main_frame' as const])] };
    }
    return base;
  };

  const rules: Omit<Rule, 'id'>[] = [];
  if (exception) {
    // `@@||site^$document`: everything on that site's pages is allowed, its frames included. Electron
    // never applies allowAllRequests to what a page loads (it doesn't attach Chromium's per-tab DNR
    // helper), so a site is an allow rule on requests whose top-level page is on it.
    if (document && !notDocument) {
      const site = condition.requestDomains?.length === 1 && !condition.urlFilter ? condition.requestDomains[0] : null;
      if (site) {
        const { requestDomains: _, ...rest } = condition;
        rules.push({ priority: PRIORITY.exception, action: { type: 'allow' }, condition: { ...rest, topDomains: [site] } });
      } else {
        rules.push({ priority: PRIORITY.exception, action: { type: 'allowAllRequests' }, condition: { ...condition, resourceTypes: ['main_frame', 'sub_frame'] } });
      }
    }
    if (types.size > 0 || (!document && !cosmeticOnly)) rules.push({ priority: PRIORITY.exception, action: { type: 'allow' }, condition: withTypes(condition) });
  } else {
    const priority = important ? PRIORITY.important : PRIORITY.block;
    if (document) rules.push({ priority, action: { type: 'block' }, condition: { ...condition, resourceTypes: ['main_frame'] } });
    if (types.size > 0 || !document) rules.push({ priority, action: { type: 'block' }, condition: withTypes(condition) });
  }
  return { rules };
}

/**
 * A list's rules. Filters that differ only in their host (`||ads.example^`)
 * merge into one rule with every host in requestDomains, which is how a few
 * thousand rules cover tens of thousands of filters.
 */
export function compileList(text: string): { rules: Rule[]; stats: CompileStats } {
  const stats: CompileStats = { filters: 0, rules: 0, skipped: {} };
  const skip = (reason: string) => (stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1);
  const merged = new Map<string, Omit<Rule, 'id'>>();
  const single: Omit<Rule, 'id'>[] = [];
  let regexes = 0;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseFilter(line);
    if (!parsed) continue;
    stats.filters++;
    if ('skip' in parsed) {
      skip(parsed.skip);
      continue;
    }
    for (const rule of parsed.rules) {
      const { requestDomains, ...rest } = rule.condition;
      if (rest.regexFilter && ++regexes > MAX_REGEX_RULES) {
        skip('regex limit');
        continue;
      }
      if (requestDomains && !rest.urlFilter && !rest.regexFilter && !rest.excludedRequestDomains) {
        const key = JSON.stringify([rule.action.type, rule.priority, rest]);
        const existing = merged.get(key);
        if (existing) existing.condition.requestDomains!.push(...requestDomains);
        else merged.set(key, { ...rule, condition: { ...rule.condition, requestDomains: [...requestDomains] } });
      } else {
        single.push(rule);
      }
    }
  }
  const rules: Rule[] = [];
  for (const rule of [...merged.values(), ...single]) {
    if (rule.condition.requestDomains) rule.condition.requestDomains = [...new Set(rule.condition.requestDomains)].sort();
    rules.push({ id: rules.length + 1, ...rule });
  }
  stats.rules = rules.length;
  return { rules, stats };
}

/**
 * The rule that turns blocking off on some sites (a dynamic rule): their
 * pages, at any subdomain, and everything those pages load, frames included.
 * Their frames inside other sites' pages are still filtered.
 */
export function siteOffRule(id: number, sites: readonly string[]): Rule {
  return { id, priority: PRIORITY.siteOff, action: { type: 'allow' }, condition: { topDomains: [...sites] } };
}
