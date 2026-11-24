import { describe, expect, it } from 'vitest';
import { addressWhy, classifyStep, pageAddressWhy, riskWordsWhy, stepDanger, stepFields, stepTitle, type RiskAction, type RiskElement, type RiskForm } from '../src/control-risk';

const form = (f: Partial<RiskForm> = {}): RiskForm => ({ method: 'post', search: false, searchFields: 0, hidden: 0, overflow: false, textFields: 2, otherFields: 1, payment: false, password: false, labels: [], action: '', ...f });
const el = (e: Partial<RiskElement> = {}): RiskElement => ({ tag: 'button', role: 'button', type: 'button', name: '', href: '', editable: false, multiline: false, submits: false, form: null, ...e });
const link = (name: string, href = 'shop example items 7') => el({ tag: 'a', role: 'link', type: '', name, href });
const submitIn = (f: RiskForm, name = 'Continue') => el({ type: 'submit', name, submits: true, form: f });
const field = (f: RiskForm | null, multiline = false) => el({ tag: multiline ? 'textarea' : 'input', role: 'textbox', type: multiline ? '' : 'text', name: 'Message', editable: true, multiline, form: f });
const click: RiskAction = { tool: 'click' };

// docs/decisions/S18-agent-mcp.md, "What counts as risky": [the row, the action, the element, what it is].
const rows: [string, RiskAction, RiskElement, string][] = [
  ['a link with no risky word', click, link('Returns policy'), 'act'],
  ['a link named Buy now', click, link('Buy now'), 'risky pay'],
  ['a button named Place order', click, el({ name: 'Place order · $48.20' }), 'risky pay'],
  ['a button named Checkout', click, el({ name: 'Checkout' }), 'risky pay'],
  ['a button named Send', click, el({ name: 'Send' }), 'risky send'],
  ['a button named Submit, in no form', click, el({ name: 'Submit' }), 'risky send'],
  ['a button named Delete', click, el({ name: 'Delete' }), 'risky delete'],
  ['a link named Cancel subscription', click, link('Cancel subscription'), 'risky delete'],
  ['a link named Sign out', click, link('Sign out'), 'risky sign-out'],
  ['a button named Log out', click, el({ name: 'Log out' }), 'risky sign-out'],
  ['a button named Create account', click, el({ name: 'Create account' }), 'risky sign-up'],
  ['a button named I agree', click, el({ name: 'I agree' }), 'risky sign-up'],
  // A submit button: risky whatever it's called (a page's misleading words never lower the bar).
  ['a form’s submit button named Continue (misleading)', click, submitIn(form()), 'risky submit'],
  ['a submit button outside any form', click, el({ type: 'submit', name: 'Go', submits: true }), 'risky submit'],
  ['a form’s submit named Send return request (the mock: Submit this form)', click, submitIn(form(), 'Send return request'), 'risky submit'],
  ['a form’s submit named Delete my account', click, submitIn(form(), 'Delete my account'), 'risky delete'],
  ['a form posting to a delete address', click, submitIn(form({ action: 'account delete' })), 'risky delete'],
  ['a search form (GET, role=search)', click, submitIn(form({ method: 'get', search: true, textFields: 1, otherFields: 0 }), 'Search'), 'act'],
  // Neon's review 2 of #112: role=search exempts one text field and nothing else, never more fields or hidden ones.
  ['a role=search GET form with more fields', click, submitIn(form({ method: 'get', search: true, textFields: 1, otherFields: 2 }), 'Search'), 'risky submit'],
  ['a role=search GET form with a hidden field', click, submitIn(form({ method: 'get', search: true, textFields: 1, otherFields: 0, hidden: 1 }), 'Search'), 'risky submit'],
  ['a role=search GET form with two text fields', click, submitIn(form({ method: 'get', search: true, textFields: 2, otherFields: 0 }), 'Search'), 'risky submit'],
  ['a search form (GET, one visible search field and nothing else)', click, submitIn(form({ method: 'get', searchFields: 1, textFields: 1, otherFields: 0 }), 'Go'), 'act'],
  // #112 review 1: the search downgrade, narrowed.
  ['a GET form with one text field that isn’t a search field', click, submitIn(form({ method: 'get', textFields: 1, otherFields: 0 }), 'Go'), 'risky submit'],
  ['a one-search-field GET form with a hidden field', click, submitIn(form({ method: 'get', searchFields: 1, textFields: 1, otherFields: 0, hidden: 1 }), 'Go'), 'risky submit'],
  ['a role=search form described only in part (past the cap)', click, submitIn(form({ method: 'get', search: true, overflow: true }), 'Search'), 'risky submit'],
  ['a link whose address can’t be read', click, { ...link('Next'), hrefUnknown: true }, 'risky confirm'],
  ['Enter on a box in a form (implicit submission)', { tool: 'press_key', key: 'Enter' }, el({ tag: 'input', role: 'checkbox', type: 'checkbox', form: form() }), 'risky submit'],
  ['a name with a zero-width space (P\u200Bay)', click, el({ name: 'P\u200Bay now' }), 'risky pay'],
  ['a one-field form that POSTs (a newsletter)', click, submitIn(form({ textFields: 1, otherFields: 0 }), 'Go'), 'risky submit'],
  ['a search form with a password field', click, submitIn(form({ method: 'get', search: true, password: true }), 'Search'), 'risky sign-in'],
  ['a form with a payment field', click, submitIn(form({ payment: true })), 'risky pay'],
  ['a form with a password field', click, submitIn(form({ password: true }), 'Continue'), 'risky sign-in'],
  ['a link to a delete address, named innocently', click, link('Item 7', 'items 7 delete'), 'risky delete'],
  ['a link to a logout address', click, link('Me', 'account logout'), 'risky sign-out'],
  ['a link to /checkout (reading until a button there)', click, link('Your cart', 'checkout'), 'act'],
  ['a link to /post/12', click, link('Our news', 'post 12'), 'act'],
  // type with submit: as its form's submit; in no form, a send.
  ['type with submit in a form', { tool: 'type', submit: true }, field(form()), 'risky submit'],
  ['type with submit in a search form', { tool: 'type', submit: true }, field(form({ method: 'get', search: true, textFields: 1, otherFields: 0 })), 'act'],
  ['type with submit in no form', { tool: 'type', submit: true }, field(null), 'risky send'],
  ['type with submit in a text area', { tool: 'type', submit: true }, field(form(), true), 'risky send'],
  ['type without submit', { tool: 'type', submit: false }, field(form()), 'act'],
  // Keys.
  ['Enter in a form’s text field', { tool: 'press_key', key: 'Enter' }, field(form()), 'risky submit'],
  ['Enter in a single-field form that POSTs', { tool: 'press_key', key: 'Enter' }, field(form({ textFields: 1, otherFields: 0 })), 'risky submit'],
  ['Enter in a single-search-field GET form', { tool: 'press_key', key: 'Enter' }, field(form({ method: 'get', searchFields: 1, textFields: 1, otherFields: 0 })), 'act'],
  ['Enter in a text area', { tool: 'press_key', key: 'Enter' }, field(form(), true), 'risky send'],
  ['Enter in a text field in no form', { tool: 'press_key', key: 'Enter' }, field(null), 'risky send'],
  ['Enter on a button named Delete', { tool: 'press_key', key: 'Enter' }, el({ name: 'Delete' }), 'risky delete'],
  ['Space on a link with no risky word', { tool: 'press_key', key: 'Space' }, link('Next page'), 'act'],
  ['Delete outside a field', { tool: 'press_key', key: 'Delete' }, el({ tag: 'li', role: 'option', name: 'Draft 3' }), 'risky delete'],
  ['Backspace outside a field', { tool: 'press_key', key: 'Backspace' }, el({ tag: 'div', role: 'generic', name: 'Photo' }), 'risky delete'],
  ['Backspace in a text field', { tool: 'press_key', key: 'Backspace' }, field(form()), 'act'],
  ['Tab', { tool: 'press_key', key: 'Tab' }, field(form()), 'act'],
  ['select_option', { tool: 'select_option' }, el({ tag: 'select', role: 'combobox', name: 'Delete after' }), 'act'],
  ['hover', { tool: 'hover' }, el({ name: 'Delete' }), 'act'],
  // Words as whole words, in any case.
  ['words inside other words (Repayment, Postcode, Booklet)', click, el({ name: 'Repayment Postcode Booklet' }), 'act'],
  ['a name in capitals', click, el({ name: 'PLACE ORDER' }), 'risky pay'],
  ['camelCase in a name', click, el({ name: 'deleteItem' }), 'risky delete'],
  // #112 review 1: more words, other languages, and what it shows as well as its name.
  ['a button named Confirm', click, el({ name: 'Confirm' }), 'risky confirm'],
  ['a button named Continue, in no form', click, el({ name: 'Continue' }), 'risky confirm'],
  ['a button named Transfer funds', click, el({ name: 'Transfer funds' }), 'risky pay'],
  ['a button named Archive', click, el({ name: 'Archive' }), 'risky delete'],
  ['German: Jetzt kaufen', click, el({ name: 'Jetzt kaufen' }), 'risky pay'],
  ['German: Konto löschen', click, el({ name: 'Konto löschen' }), 'risky delete'],
  ['French: Passer la commande', click, el({ name: 'Passer la commande' }), 'risky pay'],
  ['French: Se déconnecter', click, link('Se déconnecter'), 'risky sign-out'],
  ['Spanish: Eliminar cuenta', click, el({ name: 'Eliminar cuenta' }), 'risky delete'],
  ['Portuguese: Finalizar compra', click, el({ name: 'Finalizar compra' }), 'risky pay'],
  ['Italian: Invia messaggio', click, el({ name: 'Invia messaggio' }), 'risky send'],
  ['Japanese: 購入する (within the text)', click, el({ name: '今すぐ購入する' }), 'risky pay'],
  ['Japanese: ログアウト', click, link('ログアウト'), 'risky sign-out'],
  ['an aria-label that says Save draft on a button that reads Pay $500', click, el({ name: 'Save draft', text: 'Pay $500' }), 'risky pay'],
  ['a form’s submit whose visible text names the costlier why', click, { ...submitIn(form(), 'Save'), text: 'Delete everything' }, 'risky delete'],
  ['Don’t save is not a donation', click, el({ name: 'Don’t save' }), 'act'],
];

describe('classifyStep: the plan’s table', () => {
  it.each(rows)('%s', (_row, action, element, is) => {
    const got = classifyStep(action, element);
    expect(got.class === 'act' ? 'act' : `risky ${got.why}`).toBe(is);
  });
});

describe('the step card’s words', () => {
  it('titles each why, on the site', () => {
    expect(stepTitle('pay', 'shop.example')).toBe('Place the order on shop.example?');
    expect(stepTitle('submit', 'shop.example')).toBe('Submit this form on shop.example?');
    expect(stepTitle('sign-up', 'shop.example')).toBe('Create an account on shop.example?');
  });
  it('Allow is in the danger color for paying and deleting only', () => {
    expect((['pay', 'delete', 'send', 'submit'] as const).map((w) => stepDanger(w))).toEqual([true, true, false, false]);
  });
  it('lists up to 6 fields by label, then how many more, cleaned and cut', () => {
    expect(stepFields(['Name', 'Email', '', 'Address\u200B', 'Phone', 'City', 'Zip', 'Country'])).toEqual({ fields: ['Name', 'Email', 'Address', 'Phone', 'City', 'Zip'], more: 1 });
    expect(stepFields(['x'.repeat(80)]).fields[0]).toHaveLength(60);
  });
  it('words: the costliest wins', () => {
    expect(riskWordsWhy('Pay and delete')).toBe('pay');
    expect(riskWordsWhy('Send or sign out')).toBe('sign-out');
  });
});

describe('addressWhy: an address an agent goes to (navigate, back)', () => {
  it.each([
    ['https://shop.test/account/logout', 'sign-out'],
    ['https://shop.test/items/7/delete', 'delete'],
    ['https://shop.test/x?action=delete', 'delete'],
    ['https://shop.test/checkout', null],
    ['https://shop.test/post/12', null],
    // Unreadable: unknown, so it asks (Neon's review 2 of #112).
    ['not an address', 'confirm'],
    [`https://shop.test/${'x'.repeat(2100)}`, 'confirm'],
    ['https://shop.test/%E0%A4%A', 'confirm'],
  ] as const)('%s', (url, why) => expect(addressWhy(url)).toBe(why));
});

describe('pageAddressWhy: an address a page sends to or goes to itself (the final pass of #112)', () => {
  it.each([
    ['https://shop.test/items/7/delete', 'delete'],
    ['https://shop.test/account/logout', 'sign-out'],
    ['https://shop.test/checkout', null],
    // An archive page isn't a delete; a button that says Archive still is (riskWordsWhy, below).
    ['https://news.test/archive/2024', null],
    // Too long: read up to its first 2,048 characters, never "unknown".
    [`https://ads.test/${'x'.repeat(3000)}`, null],
    [`https://shop.test/items/delete/${'x'.repeat(3000)}`, 'delete'],
    // Can't be decoded: read as written.
    ['https://shop.test/%E0%A4%A/delete', 'delete'],
    ['https://ads.test/%E0%A4%A', null],
    ['not an address', null],
  ] as const)('%s', (url, why) => expect(pageAddressWhy(url)).toBe(why));

  it('archive still counts as a button’s word', () => expect(riskWordsWhy('Archive')).toBe('delete'));
  it('full-width letters read as plain ones (NFKC)', () => {
    expect(riskWordsWhy('ｄｅｌｅｔｅ')).toBe('delete');
    expect(riskWordsWhy('Ｐａｙ now')).toBe('pay');
  });
});
