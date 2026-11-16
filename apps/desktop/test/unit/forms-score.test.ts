import { describe, expect, it } from 'vitest';
import { compareBaseline, fieldRight, fileType, scoreCorpus, type CorpusBaseline, type ScoredFile } from '../../test/forms/score';

describe("the corpus's scoring (S17 §13 layer 2; M0 §4)", () => {
  it.each<[string, string, Parameters<typeof fieldRight>[1], boolean]>([
    ['username', 'login', 'username', true],
    ['username', 'login', null, false],
    // Either one: the username, or an email that's nothing without a password. Never a password.
    ['username OR emailAddress', 'login', 'username', true],
    ['username OR emailAddress', 'login', null, true],
    ['username OR emailAddress', 'login', 'current-password', false],
    ['password.current', 'signup', 'current-password', true],
    ['password.current', 'login', 'new-password', false],
    ['password.new', 'login', 'new-password', true],
    ['password.new', 'login', 'confirmation-password', true],
    // A plain password takes the variant its file implies.
    ['password', 'login', 'current-password', true],
    ['password', 'login', 'new-password', false],
    ['password', 'signup', 'confirmation-password', true],
    ['password', 'change', 'current-password', false],
    ['password', 'other', 'current-password', true],
    ['emailAddress', 'login', 'username', true],
    ['emailAddress', 'login', null, true],
    ['emailAddress', 'login', 'current-password', false],
    ['emailAddress', 'newsletter (no credential in the file)', 'username', false],
    ['emailAddress', 'newsletter (no credential in the file)', null, true],
    ['firstName', 'signup', null, true],
    ['firstName', 'signup', 'username', false],
  ])('%s in a %s file as %s: %s', (label, type, role, right) => {
    const credential = !type.includes('no credential');
    expect(fieldRight(label, role, (credential ? type : 'other') as ReturnType<typeof fileType>, credential)).toBe(right);
  });

  it.each([
    ['amazon_login.html', 'login'],
    ['amazon_signup.html', 'signup'],
    ['github_change-password.html', 'change'],
    ['walmart_checkout.html', 'payment'],
    ['cnn_newsletter.html', 'other'],
  ])('%s is a %s file', (html, type) => {
    expect(fileType(html)).toBe(type);
  });

  const files: ScoredFile[] = [
    { html: 'a_login.html', fields: [{ index: 0, label: 'username', field: 'text#u[u]', role: 'username' }, { index: 1, label: 'password', field: 'password#p[p]', role: 'current-password' }], missing: [] },
    { html: 'b_login.html', fields: [{ index: 0, label: 'username OR emailAddress', field: 'email#e[e]', role: null }, { index: 1, label: 'password', field: 'password#p[p]', role: 'new-password' }], missing: [] },
    { html: 'c_newsletter.html', fields: [{ index: 0, label: 'emailAddress', field: 'email#e[e]', role: null }], missing: [] },
    { html: 'd_login.html', fields: [], missing: [{ index: 0, label: 'username' }] },
  ];

  it('counts files with a credential whole, and lists every wrong field by file', () => {
    const score = scoreCorpus(files);
    expect(score).toMatchObject({ scoredFiles: 3, rightFiles: 1, rightFilesStrict: 1, fields: 6, wrongFields: 2 });
    expect(score.failures).toEqual({ 'b_login.html': ['1 password password#p[p] → new-password'], 'd_login.html': ['0 username (not scanned) → none'] });
  });

  it('the ratchet: a field newly wrong regresses, one newly right must be taken into the baseline', () => {
    const score = scoreCorpus(files);
    const baseline: CorpusBaseline = { corpus: 'x', rightFiles: 1, scoredFiles: 3, failures: { 'a_login.html': ['0 username text#u[u] → none'], 'b_login.html': ['1 password password#p[p] → new-password'] } };
    expect(compareBaseline(score, baseline)).toEqual({ regressed: ['d_login.html: 0 username (not scanned) → none'], fixed: ['a_login.html: 0 username text#u[u] → none'] });
    expect(compareBaseline(score, { ...baseline, failures: score.failures })).toEqual({ regressed: [], fixed: [] });
  });
});
