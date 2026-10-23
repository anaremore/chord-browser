/**
 * Safe Browsing's address rules against Google's published examples
 * (developers.google.com/safe-browsing/v4/urls-hashing, read 2026-10-23):
 * every canonicalization vector, the suffix/prefix expression examples, and
 * the hash prefix examples.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalString, expressionsFor, hostSuffixes, parseIPv4, pathPrefixes, urlExpressions } from '../../src/main/safe-browsing/url';

/** Google's vectors, exactly as the page lists them. */
const VECTORS: [string, string][] = [
  ['http://host/%25%32%35', 'http://host/%25'],
  ['http://host/%25%32%35%25%32%35', 'http://host/%25%25'],
  ['http://host/%2525252525252525', 'http://host/%25'],
  ['http://host/asdf%25%32%35asd', 'http://host/asdf%25asd'],
  ['http://host/%%%25%32%35asd%%', 'http://host/%25%25%25asd%25%25'],
  ['http://www.google.com/', 'http://www.google.com/'],
  [
    'http://%31%36%38%2e%31%38%38%2e%39%39%2e%32%36/%2E%73%65%63%75%72%65/%77%77%77%2E%65%62%61%79%2E%63%6F%6D/',
    'http://168.188.99.26/.secure/www.ebay.com/',
  ],
  [
    'http://195.127.0.11/uploads/%20%20%20%20/.verify/.eBaysecure=updateuserdataxplimnbqmn-xplmvalidateinfoswqpcmlx=hgplmcx/',
    'http://195.127.0.11/uploads/%20%20%20%20/.verify/.eBaysecure=updateuserdataxplimnbqmn-xplmvalidateinfoswqpcmlx=hgplmcx/',
  ],
  [
    'http://host%23.com/%257Ea%2521b%2540c%2523d%2524e%25f%255E00%252611%252A22%252833%252944_55%252B',
    'http://host%23.com/~a!b@c%23d$e%25f^00&11*22(33)44_55+',
  ],
  ['http://3279880203/blah', 'http://195.127.0.11/blah'],
  ['http://www.google.com/blah/..', 'http://www.google.com/'],
  ['www.google.com/', 'http://www.google.com/'],
  ['www.google.com', 'http://www.google.com/'],
  ['http://www.evil.com/blah#frag', 'http://www.evil.com/blah'],
  ['http://www.GOOgle.com/', 'http://www.google.com/'],
  ['http://www.google.com.../', 'http://www.google.com/'],
  ['http://www.google.com/foo\tbar\rbaz\n2', 'http://www.google.com/foobarbaz2'],
  ['http://www.google.com/q?', 'http://www.google.com/q?'],
  ['http://www.google.com/q?r?', 'http://www.google.com/q?r?'],
  ['http://www.google.com/q?r?s', 'http://www.google.com/q?r?s'],
  ['http://evil.com/foo#bar#baz', 'http://evil.com/foo'],
  ['http://evil.com/foo;', 'http://evil.com/foo;'],
  ['http://evil.com/foo?bar;', 'http://evil.com/foo?bar;'],
  ['http://\x01\x80.com/', 'http://%01%80.com/'],
  ['http://notrailingslash.com', 'http://notrailingslash.com/'],
  ['http://www.gotaport.com:1234/', 'http://www.gotaport.com/'],
  ['  http://www.google.com/  ', 'http://www.google.com/'],
  ['http:// leadingspace.com/', 'http://%20leadingspace.com/'],
  ['http://%20leadingspace.com/', 'http://%20leadingspace.com/'],
  ['%20leadingspace.com/', 'http://%20leadingspace.com/'],
  ['https://www.securesite.com/', 'https://www.securesite.com/'],
  ['http://host.com/ab%23cd', 'http://host.com/ab%23cd'],
  ['http://host.com//twoslashes?more//slashes', 'http://host.com/twoslashes?more//slashes'],
];

describe('canonicalize', () => {
  it.each(VECTORS)('Canonicalize(%j) = %j', (input, expected) => {
    const c = canonicalize(input);
    expect(c).not.toBeNull();
    expect(canonicalString(c!)).toBe(expected);
  });

  it('drops user info as well as the port', () => {
    expect(canonicalString(canonicalize('https://user:secret@Example.com:8443/a')!)).toBe('https://example.com/a');
  });

  it('turns an internationalized host into Punycode', () => {
    expect(canonicalize('http://bücher.example/')!.host).toBe('xn--bcher-kva.example');
  });

  it('has no answer for an address without a host', () => {
    expect(canonicalize('http:///path')).toBeNull();
    expect(canonicalize('http://.../')).toBeNull();
  });

  it('reads IPv4 addresses in every legal form', () => {
    expect(parseIPv4('3279880203')).toBe('195.127.0.11');
    expect(parseIPv4('0xc37f000b')).toBe('195.127.0.11');
    expect(parseIPv4('0303.0177.0.013')).toBe('195.127.0.11');
    expect(parseIPv4('195.127.11')).toBe('195.127.0.11');
    expect(parseIPv4('195.8323083')).toBe('195.127.0.11');
    expect(parseIPv4('1.2.3.4.5')).toBeNull();
    expect(parseIPv4('256.1.1.1')).toBeNull();
    expect(parseIPv4('08.1.1.1')).toBeNull();
    expect(parseIPv4('example')).toBeNull();
  });
});

describe('suffix/prefix expressions', () => {
  it('http://a.b.c/1/2.html?param=1, as Google lists it', () => {
    expect(expressionsFor(canonicalize('http://a.b.c/1/2.html?param=1')!)).toEqual([
      'a.b.c/1/2.html?param=1',
      'a.b.c/1/2.html',
      'a.b.c/',
      'a.b.c/1/',
      'b.c/1/2.html?param=1',
      'b.c/1/2.html',
      'b.c/',
      'b.c/1/',
    ]);
  });

  it('http://a.b.c.d.e.f.g/1.html: the exact host, then only the last five labels', () => {
    expect(expressionsFor(canonicalize('http://a.b.c.d.e.f.g/1.html')!)).toEqual([
      'a.b.c.d.e.f.g/1.html',
      'a.b.c.d.e.f.g/',
      'c.d.e.f.g/1.html',
      'c.d.e.f.g/',
      'd.e.f.g/1.html',
      'd.e.f.g/',
      'e.f.g/1.html',
      'e.f.g/',
      'f.g/1.html',
      'f.g/',
    ]);
  });

  it('http://1.2.3.4/1/: an IP address has no suffixes', () => {
    expect(expressionsFor(canonicalize('http://1.2.3.4/1/')!)).toEqual(['1.2.3.4/1/', '1.2.3.4/']);
  });

  it('never uses the top-level domain alone, nor more than five hosts', () => {
    expect(hostSuffixes('example.com')).toEqual(['example.com']);
    expect(hostSuffixes('localhost')).toEqual(['localhost']);
    expect(hostSuffixes('a.b.c.d.e.f.g.h')).toHaveLength(5);
  });

  it('takes the root and at most three directories below it, so at most six paths', () => {
    expect(pathPrefixes('/1/2/3/4/5/6.html', 'q=1')).toEqual(['/1/2/3/4/5/6.html?q=1', '/1/2/3/4/5/6.html', '/', '/1/', '/1/2/', '/1/2/3/']);
    expect(pathPrefixes('/', null)).toEqual(['/']);
    expect(pathPrefixes('/1/', null)).toEqual(['/1/', '/']);
  });

  it('makes at most 30 expressions for any address', () => {
    expect(urlExpressions('http://a.b.c.d.e.f.g.h/1/2/3/4/5.html?x=y')).toHaveLength(30);
  });

  it('checks web addresses only', () => {
    expect(urlExpressions('chord://settings/')).toEqual([]);
    expect(urlExpressions('data:text/html,hi')).toEqual([]);
    expect(urlExpressions('about:blank')).toEqual([]);
    expect(urlExpressions('https://example.com/')).toEqual(['example.com/']);
  });
});

describe('hash prefixes', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');

  it('match FIPS-180-2, as Google’s unit test does', () => {
    expect(sha('abc').slice(0, 8)).toBe('ba7816bf');
    expect(sha('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq').slice(0, 12)).toBe('248d6a61d206');
  });

  it('match the Local Database page’s example expressions', () => {
    expect(sha('a.example.com/')).toBe('291bc5421f1cd54d99afcc55d166e2b9fe42447025895bf09dd41b2110a687dc');
    expect(sha('b.example.com/')).toBe('1d32c5084a360e58f1b87109637a6810acad97a861a7769e8f1841410d2a960c');
    expect(sha('y.example.com/')).toBe('f7a502e56e8b01c6dc242b35122683c9d25d07fb1f532d9853eb0ef3ff334f03');
  });
});
