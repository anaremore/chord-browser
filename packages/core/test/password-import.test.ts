/**
 * Passwords in and out, the pure parts (docs/decisions/S17-passwords.md §10,
 * §13 layer 4): each manager's header, CSV's corners (quotes, line breaks in
 * notes, a byte-order mark, a file cut anywhere), which rows come in and why
 * the others don't, the diff against the vault, the `login` record, and the
 * export line read back.
 */
import { describe, expect, it } from 'vitest';
import {
  CsvReader,
  csvColumns,
  importChoices,
  csvField,
  importOrigin,
  loginFromRecord,
  loginRecord,
  PASSWORD_CSV_HEADER,
  PASSWORD_IMPORT_LIMITS,
  PasswordCsv,
  passwordCsvLine,
  planPasswordImport,
  uniqueLogins,
  type ImportedLogin,
} from '../src/password-import';

/** A whole file read through PasswordCsv, given in pieces of `step` characters (every boundary a reader can meet). */
function readCsv(text: string, step = text.length || 1) {
  const csv = new PasswordCsv();
  const logins: ImportedLogin[] = [];
  const issues: ReturnType<PasswordCsv['push']>['issues'] = [];
  for (let at = 0; at < text.length; at += step) {
    const got = csv.push(text.slice(at, at + step));
    logins.push(...got.logins);
    issues.push(...got.issues);
  }
  const rest = csv.end();
  logins.push(...rest.logins);
  issues.push(...rest.issues);
  return { logins, issues, counts: csv.counts, problem: csv.problem };
}

const login = (origin: string, username: string, password: string, extra: Partial<ImportedLogin> = {}): ImportedLogin => ({ origin, username, password, note: '', realm: null, changedAt: null, ...extra });

describe('each manager’s file', () => {
  const cases: { from: string; csv: string; want: ImportedLogin[]; otp?: number; issues?: { row: number; kind: string }[] }[] = [
    {
      from: 'Chrome, Edge, Brave',
      csv: 'name,url,username,password,note\nexample.com,https://example.com/login,ada,pw-1,first\nshop.example,https://shop.example/,,pw-2,\n',
      want: [login('https://example.com', 'ada', 'pw-1', { note: 'first' }), login('https://shop.example', '', 'pw-2')],
    },
    {
      from: 'Firefox, with a sign-in box’s realm',
      csv: '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\r\n"https://example.com","ada","pw-1",,"https://example.com","{a}","1","2","3"\r\n"http://router.test:8080","admin","pw-2","Router",,"{b}","1","2","3"\r\n',
      want: [login('https://example.com', 'ada', 'pw-1'), login('http://router.test:8080', 'admin', 'pw-2', { realm: 'Router' })],
    },
    {
      from: 'Safari, Apple Passwords (one-time codes counted, not kept)',
      csv: 'Title,URL,Username,Password,Notes,OTPAuth\nExample,https://example.com/,ada,pw-1,a note,otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP\n',
      want: [login('https://example.com', 'ada', 'pw-1', { note: 'a note' })],
      otp: 1,
    },
    {
      from: 'Bitwarden (a secure note and a card listed as not sign-ins)',
      csv: 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Example,,,0,https://example.com,ada,pw-1,JBSWY3DPEHPK3PXP\nWork,1,note,Wifi,the code,,0,,,,\n,,card,Visa,,,0,,,,\n',
      want: [login('https://example.com', 'ada', 'pw-1')],
      otp: 1,
      issues: [
        { row: 3, kind: 'kind' },
        { row: 4, kind: 'kind' },
      ],
    },
    {
      from: '1Password 8',
      csv: 'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nExample,example.com,ada,pw-1,,false,false,,hi\n',
      want: [login('https://example.com', 'ada', 'pw-1', { note: 'hi' })],
    },
    {
      from: '1Password, older',
      csv: 'title,website,username,password,notes,member number\nExample,https://example.com,ada,pw-1,,\n',
      want: [login('https://example.com', 'ada', 'pw-1')],
    },
    {
      from: 'a manager Chord doesn’t know, columns in another order and case',
      csv: 'PASSWORD,Login URL,E-mail\npw-1,https://example.com/a,ada@example.com\n',
      want: [login('https://example.com', 'ada@example.com', 'pw-1')],
    },
  ];
  for (const c of cases) {
    it(c.from, () => {
      for (const step of [c.csv.length, 7, 1]) {
        const got = readCsv(c.csv, step);
        expect(got.problem).toBeNull();
        expect(got.logins).toEqual(c.want);
        expect(got.counts.otp).toBe(c.otp ?? 0);
        expect(got.issues.map((i) => ({ row: i.row, kind: i.kind }))).toEqual(c.issues ?? []);
      }
    });
  }
});

describe('whose export it is', () => {
  it.each([
    ['name,url,username,password,note', 'chrome'],
    ['url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged', 'firefox'],
    ['Title,URL,Username,Password,Notes,OTPAuth', 'safari'],
    ['folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp', 'bitwarden'],
    ['Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes', '1password'],
    ['title,website,username,password,notes', '1password'],
    ['PASSWORD,Login URL,E-mail', null],
  ])('%s', (header, source) => {
    const csv = new PasswordCsv();
    csv.push(`${header}
`);
    expect(csv.source).toBe(source);
  });
});

describe('CSV’s corners', () => {
  const read = (text: string) => {
    const reader = new CsvReader();
    return [...reader.push(text), ...reader.end()].map((r) => r.fields);
  };
  const cases: { what: string; text: string; rows: string[][] }[] = [
    { what: 'quoted commas', text: 'a,"b,c",d\n', rows: [['a', 'b,c', 'd']] },
    { what: 'a quote doubled inside quotes', text: '"say ""hi""",x\n', rows: [['say "hi"', 'x']] },
    { what: 'a line break in a quoted note', text: 'a,"line 1\nline 2\r\nline 3",z\n', rows: [['a', 'line 1\nline 2\r\nline 3', 'z']] },
    { what: '\\r\\n endings', text: 'a,b\r\nc,d\r\n', rows: [['a', 'b'], ['c', 'd']] },
    { what: 'old Mac \\r endings', text: 'a,b\rc,d', rows: [['a', 'b'], ['c', 'd']] },
    { what: 'no line break at the end', text: 'a,b\nc,d', rows: [['a', 'b'], ['c', 'd']] },
    { what: 'a byte-order mark', text: '﻿name,url\nx,y\n', rows: [['name', 'url'], ['x', 'y']] },
    { what: 'blank lines', text: '\n\na,b\n\n\nc,d\n\n', rows: [['a', 'b'], ['c', 'd']] },
    { what: 'empty fields, and an empty quoted one', text: ',,""\n', rows: [['', '', '']] },
    { what: 'a stray quote inside an unquoted field', text: 'pa"ss,x\n', rows: [['pa"ss', 'x']] },
    { what: 'text after a closing quote joins the field', text: '"ab"cd,x\n', rows: [['abcd', 'x']] },
    { what: 'a quote never closed takes the rest', text: 'a,"b\nc', rows: [['a', 'b\nc']] },
    { what: 'spaces are kept', text: ' a , b \n', rows: [[' a ', ' b ']] },
  ];
  for (const c of cases) {
    it(c.what, () => {
      expect(read(c.text)).toEqual(c.rows);
      // Every place a chunk can end gives the same rows.
      const reader = new CsvReader();
      const rows = [...[...c.text].flatMap((ch) => reader.push(ch)), ...reader.end()].map((r) => r.fields);
      expect(rows).toEqual(c.rows);
    });
  }

  it('a field past the limit isn’t kept, and its row is too long', () => {
    const reader = new CsvReader();
    const rows = [...reader.push(`a,${'x'.repeat(PASSWORD_IMPORT_LIMITS.field + 10)},c\n`), ...reader.end()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.long).toEqual([1]);
    expect(rows[0]!.fields[1]!.length).toBe(PASSWORD_IMPORT_LIMITS.field);
  });
});

describe('columns', () => {
  it('needs an address and a password', () => {
    expect(csvColumns(['name', 'username', 'password'])).toEqual({ problem: 'url' });
    expect(csvColumns(['url', 'username'])).toEqual({ problem: 'password' });
    expect(readCsv('').problem).toBe('empty');
    expect(readCsv('title,notes\nx,y\n').problem).toBe('url');
  });
  it('never takes one column for two', () => {
    const found = csvColumns(['login', 'url', 'password']);
    expect(found).toEqual({ columns: { url: 1, username: 0, password: 2 } });
  });
});

describe('which rows come in', () => {
  const header = 'name,url,username,password,note\n';
  const cases: { what: string; row: string; kind?: string; origin?: string }[] = [
    { what: 'a page’s address', row: 'x,https://example.com/a?b#c,u,p,', origin: 'https://example.com' },
    { what: 'http, a port', row: 'x,http://10.0.0.1:8080/,u,p,', origin: 'http://10.0.0.1:8080' },
    { what: 'a bare host', row: 'x,example.com,u,p,', origin: 'https://example.com' },
    { what: 'a bare host with a port and a path', row: 'x,example.com:8443/login,u,p,', origin: 'https://example.com:8443' },
    { what: 'two addresses in one field: the first that works', row: 'x,"android://abc@com.example, https://example.com",u,p,', origin: 'https://example.com' },
    // Bitwarden joins a sign-in's addresses with a comma, or a line break, and no space: never one host `a.example,https`.
    { what: 'two addresses joined by a comma', row: 'x,"https://a.example,https://b.example",u,p,', origin: 'https://a.example' },
    { what: 'two addresses joined by a line break', row: 'x,"https://a.example\nhttps://b.example",u,p,', origin: 'https://a.example' },
    { what: 'two addresses joined by a semicolon', row: 'x,"https://a.example;https://b.example",u,p,', origin: 'https://a.example' },
    // Only percent-encoding gets a separator past the split into a host: the guard refuses it.
    { what: 'a comma, percent-encoded into the host', row: 'x,https://a%2Cb.example/,u,p,', kind: 'address' },
    { what: 'a semicolon, percent-encoded into the host', row: 'x,https://a%3Bb.example/,u,p,', kind: 'address' },
    { what: 'an app, then a site, joined by a comma', row: 'x,"android://x@com.example,https://b.example",u,p,', origin: 'https://b.example' },
    { what: 'a username with a control character', row: 'x,https://example.com,"ada\u0000",p,', kind: 'text' },
    { what: 'localhost', row: 'x,http://localhost:3000,u,p,', origin: 'http://localhost:3000' },
    { what: 'an Android app', row: 'x,android://hash@com.example.app/,u,p,', kind: 'app' },
    { what: 'an iOS app', row: 'x,ios-app://12345/example.com,u,p,', kind: 'app' },
    { what: 'no address', row: 'x,,u,p,', kind: 'address' },
    { what: 'a browser’s own page', row: 'x,chrome://FirefoxAccounts,u,p,', kind: 'address' },
    { what: 'a file', row: 'x,file:///etc/passwd,u,p,', kind: 'address' },
    { what: 'javascript', row: 'x,javascript:alert(1),u,p,', kind: 'address' },
    { what: 'words, not an address', row: 'x,my bank,u,p,', kind: 'address' },
    { what: 'a user and password in the address', row: 'x,https://me:secret@example.com/,u,p,', kind: 'address' },
    { what: 'no password', row: 'x,https://example.com,u,,', kind: 'password' },
    { what: 'a username past the limit', row: `x,https://example.com,${'u'.repeat(501)},p,`, kind: 'long' },
    { what: 'a password past the limit', row: `x,https://example.com,u,${'p'.repeat(1001)},`, kind: 'long' },
    { what: 'a note past the limit', row: `x,https://example.com,u,p,${'n'.repeat(4001)}`, kind: 'long' },
  ];
  for (const c of cases) {
    it(c.what, () => {
      const got = readCsv(`${header}${c.row}\n`);
      if (c.origin) {
        expect(got.issues).toEqual([]);
        expect(got.logins[0]?.origin).toBe(c.origin);
      } else {
        expect(got.logins).toEqual([]);
        expect(got.issues).toHaveLength(1);
        expect(got.issues[0]!.kind).toBe(c.kind);
        expect(got.issues[0]!.row).toBe(2);
      }
    });
  }

  it('a long field in a column Chord doesn’t read leaves the row as it is', () => {
    const header = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n';
    const got = readCsv(`${header},,login,Example,,${'f'.repeat(PASSWORD_IMPORT_LIMITS.field + 5)},0,https://example.com,ada,pw,\n`);
    expect(got.issues).toEqual([]);
    expect(got.logins).toEqual([login('https://example.com', 'ada', 'pw')]);
    // In a column it reads, the row is too long.
    expect(readCsv(`${header},,login,Example,${'n'.repeat(PASSWORD_IMPORT_LIMITS.field + 5)},,0,https://example.com,ada,pw,\n`).issues[0]?.kind).toBe('long');
  });

  it('a listed row shows what it says, cut, and never its password', () => {
    const got = readCsv(`${header}Bank,${'a'.repeat(300)},ada,Sekrit-123,\n`);
    const issue = got.issues[0]!;
    expect(issue).toMatchObject({ row: 2, kind: 'address', username: 'ada', name: 'Bank' });
    expect(issue.address.length).toBe(PASSWORD_IMPORT_LIMITS.shown);
    expect(JSON.stringify(got.issues)).not.toContain('Sekrit-123');
  });

  it('rows are numbered as the file’s lines, the header being 1', () => {
    const got = readCsv(`${header}a,https://a.example,u,p,\nb,,u,p,\nc,https://c.example,u,p,\nd,android://x,u,p,\n`);
    expect(got.issues.map((i) => i.row)).toEqual([3, 5]);
  });

  it('past the row limit, the rest is counted, and listed rows past theirs only counted', () => {
    const rows = PASSWORD_IMPORT_LIMITS.rows + 5;
    const body = Array.from({ length: rows }, (_, i) => (i % 2 ? `x${i},,u,p,` : `x${i},https://s${i}.example,u,p,`)).join('\n');
    const got = readCsv(`${header}${body}\n`, 1 << 20);
    expect(got.counts.rows).toBe(PASSWORD_IMPORT_LIMITS.rows);
    expect(got.counts.capped).toBe(5);
    expect(got.logins.length).toBe(PASSWORD_IMPORT_LIMITS.rows / 2);
    expect(got.issues.length).toBe(PASSWORD_IMPORT_LIMITS.issues);
    expect(got.counts.issuesMore).toBe(PASSWORD_IMPORT_LIMITS.rows / 2 - PASSWORD_IMPORT_LIMITS.issues);
  });

  it('binary junk reads as a file without the columns, never throws', () => {
    const junk = String.fromCharCode(...Array.from({ length: 4096 }, (_, i) => (i * 7919) % 65536));
    expect(() => readCsv(junk, 100)).not.toThrow();
    expect(readCsv(junk).logins).toEqual([]);
  });
});

describe('importOrigin', () => {
  it.each([
    ['https://EXAMPLE.com/', 'https://example.com'],
    ['  https://example.com  ', 'https://example.com'],
    ['https://example.com:443/', 'https://example.com'],
    ['https://bücher.example/', 'https://xn--bcher-kva.example'],
  ])('%s is %s', (text, origin) => expect(importOrigin(text)).toEqual({ origin }));
});

describe('the same sign-in twice in a file', () => {
  it('is one, the later row’s, and counted', () => {
    const got = uniqueLogins([login('https://a.example', 'ada', '1'), login('https://b.example', 'ada', '2'), login('https://a.example', 'ada', '3'), login('https://a.example', 'ada', '3')]);
    expect(got.logins).toEqual([login('https://a.example', 'ada', '3'), login('https://b.example', 'ada', '2')]);
    expect(got.duplicates).toBe(2);
  });
  it('the key can’t be forged by a separator in a part', () => {
    const got = uniqueLogins([login('https://a.example', 'ada\u0000x', '1'), login('https://a.example', 'ada', '1', { realm: 'x' })]);
    expect(got.logins).toHaveLength(2);
  });
  it('a form’s and the sign-in box’s are two', () => {
    const got = uniqueLogins([login('https://a.example', 'ada', '1'), login('https://a.example', 'ada', '1', { realm: 'Admin' })]);
    expect(got.logins).toHaveLength(2);
  });
});

describe('the file against the vault', () => {
  const here = [
    { id: 'id-1', origin: 'https://a.example', username: 'ada', password: 'same', realm: null, note: 'mine' },
    { id: 'id-2', origin: 'https://b.example', username: 'ada', password: 'old', realm: null, note: '' },
    { id: 'id-3', origin: 'https://c.example', username: 'ada', password: 'x', realm: 'Admin', note: '' },
    // Saved twice by hand: the same when either has the password.
    { id: 'id-4', origin: 'https://d.example', username: 'bo', password: 'one', realm: null, note: '' },
    { id: 'id-5', origin: 'https://d.example', username: 'bo', password: 'two', realm: null, note: '' },
  ];
  const cases: { what: string; file: ImportedLogin; plan: 'added' | 'same' | { id: string; what?: string[] } }[] = [
    { what: 'the same password', file: login('https://a.example', 'ada', 'same'), plan: 'same' },
    { what: 'the same password, no note in the file', file: login('https://a.example', 'ada', 'same'), plan: 'same' },
    { what: 'the same password and note', file: login('https://a.example', 'ada', 'same', { note: 'mine' }), plan: 'same' },
    { what: 'the same password, another note', file: login('https://a.example', 'ada', 'same', { note: 'hi' }), plan: { id: 'id-1', what: ['note'] } },
    { what: 'another password and note', file: login('https://b.example', 'ada', 'new', { note: 'hi' }), plan: { id: 'id-2', what: ['password', 'note'] } },
    { what: 'another password', file: login('https://b.example', 'ada', 'new'), plan: { id: 'id-2' } },
    { what: 'another username', file: login('https://a.example', 'bo', 'same'), plan: 'added' },
    { what: 'another host of the same site', file: login('https://login.a.example', 'ada', 'same'), plan: 'added' },
    { what: 'http where https is saved', file: login('http://a.example', 'ada', 'same'), plan: 'added' },
    { what: 'a form’s where the box’s is saved', file: login('https://c.example', 'ada', 'x'), plan: 'added' },
    { what: 'the box’s, the same realm', file: login('https://c.example', 'ada', 'x', { realm: 'Admin' }), plan: 'same' },
    { what: 'saved twice, one with this password', file: login('https://d.example', 'bo', 'two'), plan: 'same' },
    { what: 'saved twice, neither with it', file: login('https://d.example', 'bo', 'three'), plan: { id: 'id-4' } },
  ];
  for (const c of cases) {
    it(c.what, () => {
      const plan = planPasswordImport([c.file], here);
      if (c.plan === 'added') expect(plan).toEqual({ added: [0], same: [], different: [] });
      else if (c.plan === 'same') expect(plan).toEqual({ added: [], same: [0], different: [] });
      else expect(plan).toEqual({ added: [], same: [], different: [{ at: 0, id: c.plan.id, what: c.plan.what ?? ['password'] }] });
    });
  }
  it('an empty vault: everything is new', () => {
    expect(planPasswordImport([login('https://a.example', 'a', '1'), login('https://b.example', 'b', '2')], []).added).toEqual([0, 1]);
  });
});

describe('the login record', () => {
  const id = '019a3c2e-7b1f-7c3d-9a1e-4f2b6c8d0e1a';
  const saved = { origin: 'https://example.com', username: 'ada', password: 'pw "quoted"\n', note: 'n', realm: null, changedAt: 1_700_000_000_000 };
  it('goes round', () => {
    const record = JSON.parse(JSON.stringify(loginRecord(id, saved, 1_600_000_000_000)));
    expect(record).toEqual({ type: 'login', id, set: { origin: 'https://example.com', username: 'ada', password: 'pw "quoted"\n', note: 'n', realm: null, created: 1_600_000_000_000, changed: 1_700_000_000_000 } });
    expect(loginFromRecord(record)).toEqual({ ...saved, changedAt: 1_700_000_000_000 });
  });
  it('with a realm', () => {
    expect(loginFromRecord(loginRecord(id, { ...saved, origin: 'http://router.test:8080', realm: 'Router' }, 1))?.realm).toBe('Router');
  });
  const bad: [string, Record<string, unknown>, string?][] = [
    ['an id that isn’t a UUID', {}, 'not-an-id'],
    ['no password', { password: undefined }],
    ['an empty password', { password: '' }],
    ['a password that isn’t text', { password: 12 }],
    ['an origin that isn’t one', { origin: 'https://example.com/login' }],
    ['an app’s origin', { origin: 'android://x@com.example' }],
    ['javascript', { origin: 'javascript:alert(1)' }],
    ['a realm that isn’t text', { realm: 4 }],
    ['a username past the limit', { username: 'u'.repeat(501) }],
  ];
  for (const [what, change, badId] of bad) {
    it(`refuses ${what}`, () => {
      const record = loginRecord(badId ?? id, saved, 1);
      record.set = { ...record.set, ...change };
      for (const [k, v] of Object.entries(change)) if (v === undefined) delete record.set[k];
      expect(loginFromRecord(record)).toBeNull();
    });
  }
  it('another type isn’t one', () => expect(loginFromRecord({ type: 'page', id, set: {} })).toBeNull());
  it('no change time reads as unknown', () => {
    const record = loginRecord(id, saved, 1);
    delete record.set['changed'];
    expect(loginFromRecord(record)?.changedAt).toBeNull();
  });
});

describe('CSV export', () => {
  it('quotes only what must be, and changes no value', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField(' padded ')).toBe('" padded "');
    // A spreadsheet's formula characters are left: a password must stay what it is.
    expect(csvField('=1+1')).toBe('=1+1');
  });
  it('reads back as it was written, whatever a value holds', () => {
    const logins = [
      { origin: 'https://www.example.com', username: 'ada', password: 'a,b"c\nd\r\ne', note: ' line 1\nline 2 ' },
      { origin: 'http://10.0.0.1:8080', username: '', password: '=SUM(A1)', note: '' },
    ];
    const text = PASSWORD_CSV_HEADER + logins.map(passwordCsvLine).join('');
    expect(text.startsWith('name,url,username,password,note\nexample.com,https://www.example.com/,ada,')).toBe(true);
    const got = readCsv(text, 3);
    expect(got.logins).toEqual(logins.map((l) => login(l.origin, l.username, l.password, { note: l.note })));
  });
});

describe('what Settings sends for those that differ', () => {
  const listed = [0, 1, 2, 3];
  const cases: { what: string; more: number; ticked: number[]; want: { take: 'yours' | 'file'; except: number[] } }[] = [
    { what: 'none ticked', more: 0, ticked: [], want: { take: 'yours', except: [] } },
    { what: 'one ticked', more: 0, ticked: [2], want: { take: 'yours', except: [2] } },
    { what: 'most ticked: named the shorter way', more: 0, ticked: [0, 1, 3], want: { take: 'file', except: [2] } },
    { what: 'all ticked (the switch on)', more: 0, ticked: [0, 1, 2, 3], want: { take: 'file', except: [] } },
    // More differ than are listed: the unlisted take the file's only with the switch itself on.
    { what: 'more unlisted, most ticked by hand: the unlisted keep yours', more: 20_000, ticked: [0, 1, 3], want: { take: 'yours', except: [0, 1, 3] } },
    { what: 'more unlisted, the switch on', more: 20_000, ticked: [0, 1, 2, 3], want: { take: 'file', except: [] } },
    { what: 'more unlisted, none ticked', more: 20_000, ticked: [], want: { take: 'yours', except: [] } },
  ];
  for (const c of cases) it(c.what, () => expect(importChoices(listed, c.more, new Set(c.ticked))).toEqual(c.want));
});
