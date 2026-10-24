/**
 * EasyList's syntax as declarativeNetRequest rules (main/ad-blocking/rules.ts):
 * each kind of filter the lists use, what has no rule and why, and the merging
 * that keeps the rule count low.
 */
import { describe, expect, it } from 'vitest';
import { compileList, parseFilter, PRIORITY, siteOffRule, type Rule } from '../../src/main/ad-blocking/rules';

const rules = (line: string) => {
  const parsed = parseFilter(line);
  if (!parsed || 'skip' in parsed) throw new Error(`no rule for ${line}: ${parsed ? parsed.skip : 'not a filter'}`);
  return parsed.rules;
};
const one = (line: string) => {
  const [rule, ...rest] = rules(line);
  expect(rest).toHaveLength(0);
  return rule!;
};
const skipped = (line: string) => {
  const parsed = parseFilter(line);
  return parsed && 'skip' in parsed ? parsed.skip : null;
};

describe('filter → rule', () => {
  it('a host filter blocks that host and its subdomains', () => {
    expect(one('||doubleclick.net^')).toEqual({ priority: PRIORITY.block, action: { type: 'block' }, condition: { requestDomains: ['doubleclick.net'] } });
  });

  it('keeps patterns as urlFilters, lowercased unless the filter matches case', () => {
    expect(one('/adserver/*$script').condition).toEqual({ urlFilter: '/adserver/*', resourceTypes: ['script'] });
    expect(one('||example.com/Ads/Banner^').condition).toEqual({ urlFilter: '||example.com/ads/banner^' });
    expect(one('/AdBanner.$match-case').condition).toEqual({ urlFilter: '/AdBanner.', isUrlFilterCaseSensitive: true });
    expect(one('|https://ads.').condition.urlFilter).toBe('|https://ads.');
  });

  it('maps party, domains and types', () => {
    expect(one('||ads.example^$third-party,domain=news.example|~sub.news.example,image,~script').condition).toEqual({
      requestDomains: ['ads.example'],
      domainType: 'thirdParty',
      initiatorDomains: ['news.example'],
      excludedInitiatorDomains: ['sub.news.example'],
      resourceTypes: ['image'],
    });
    expect(one('/track.js$~third-party').condition.domainType).toBe('firstParty');
    expect(one('/pixel.$xhr,subdocument,ping,css').condition.resourceTypes).toEqual(['xmlhttprequest', 'sub_frame', 'ping', 'stylesheet']);
    // Only excluded types: never the page itself.
    expect(one('/ads.$~image').condition.excludedResourceTypes).toEqual(['image', 'main_frame']);
  });

  it('exceptions allow, above blocks; $important blocks above exceptions', () => {
    expect(one('@@||cdn.example^$script')).toMatchObject({ priority: PRIORITY.exception, action: { type: 'allow' } });
    expect(one('||ads.example^$important').priority).toBe(PRIORITY.important);
    expect(PRIORITY.block < PRIORITY.exception && PRIORITY.exception < PRIORITY.important && PRIORITY.important < PRIORITY.siteOff).toBe(true);
  });

  it('a $document exception allows everything on that site’s pages', () => {
    // As an allow rule on the top-level page's site: Electron never applies allowAllRequests to what a page loads.
    expect(one('@@||shop.example^$document')).toEqual({ priority: PRIORITY.exception, action: { type: 'allow' }, condition: { topDomains: ['shop.example'] } });
    expect(one('@@/checkout/*$document')).toEqual({
      priority: PRIORITY.exception,
      action: { type: 'allowAllRequests' },
      condition: { urlFilter: '/checkout/*', resourceTypes: ['main_frame', 'sub_frame'] },
    });
    // A $document block is for the page itself.
    expect(rules('||malware.example^$document').map((r) => r.condition.resourceTypes)).toEqual([['main_frame']]);
  });

  it('regular expressions RE2 can run become regexFilters', () => {
    expect(one('/^https?:\\/\\/[a-z]{8}\\.com\\/[a-z]+\\.js$/$script').condition).toMatchObject({ regexFilter: '^https?:\\/\\/[a-z]{8}\\.com\\/[a-z]+\\.js$' });
    expect(skipped('/(?!foo)bar/')).toBe('regex');
  });

  it('skips what Chromium’s rules can’t express, rather than half-applying it', () => {
    expect(skipped('||popunder.example^$popup')).toBe('popup');
    expect(skipped('@@||site.example^$generichide')).toBe('element hiding');
    expect(skipped('||site.example^$csp=script-src none')).toBe('$csp');
    expect(skipped('||ads.example^$domain=news.*')).toBe('domain wildcard');
    expect(skipped('||ads.example^$genericblock')).toBe('genericblock');
    expect(skipped('$script')).toBe('matches everything');
    expect(skipped('/ads/ünicode')).toBe('not ASCII');
    // Replacement files aren't shipped: those requests are blocked, as the engine blocks them without its resources.
    expect(one('||ads.example/gpt.js$script,rewrite=abp-resource:blank-js').action.type).toBe('block');
  });

  it('isn’t a rule: comments, headers, element hiding', () => {
    for (const line of ['! Title: EasyList', '[Adblock Plus 2.0]', '##.ad-banner', 'example.com##.sponsor', 'example.com#@#.ad', 'example.com#?#div:-abp-has(.ad)', '']) {
      expect(parseFilter(line)).toBeNull();
    }
  });
});

describe('a list → rules', () => {
  it('merges host filters with the same options into one rule', () => {
    const { rules: out, stats } = compileList(['! comment', '||a.example^', '||b.example^', '||c.example^$third-party', '||d.example^$third-party', '/banner/*', '||a.example^'].join('\n'));
    const byDomains = (r: Rule) => r.condition.requestDomains?.join(',');
    expect(out.map(byDomains)).toEqual(['a.example,b.example', 'c.example,d.example', undefined]);
    expect(out.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(stats).toEqual({ filters: 6, rules: 3, skipped: {} });
  });

  it('counts what it skips', () => {
    expect(compileList('||x.example^$popup\n||y.example^$csp=default-src none\n||z.example^').stats.skipped).toEqual({ popup: 1, $csp: 1 });
  });
});

it('sites turned off: everything on their pages is allowed, above every list rule', () => {
  expect(siteOffRule(7, ['nytimes.com', 'bbc.co.uk'])).toEqual({ id: 7, priority: PRIORITY.siteOff, action: { type: 'allow' }, condition: { topDomains: ['nytimes.com', 'bbc.co.uk'] } });
});
