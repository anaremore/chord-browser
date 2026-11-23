import { describe, expect, it } from 'vitest';
import { classifyStep, riskWordsWhy, stepDanger, stepFields, stepTitle, type RiskAction, type RiskElement, type RiskForm } from '../src/control-risk';

const form = (f: Partial<RiskForm> = {}): RiskForm => ({ method: 'post', search: false, textFields: 2, otherFields: 1, payment: false, password: false, labels: [], action: '', ...f });
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
  ['a search form (GET, role=search)', click, submitIn(form({ method: 'get', search: true, textFields: 1, otherFields: 2 }), 'Search'), 'act'],
  ['a search form (GET, one text field)', click, submitIn(form({ method: 'get', textFields: 1, otherFields: 0 }), 'Go'), 'act'],
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
  ['type with submit in a search form', { tool: 'type', submit: true }, field(form({ method: 'get', search: true })), 'act'],
  ['type with submit in no form', { tool: 'type', submit: true }, field(null), 'risky send'],
  ['type with submit in a text area', { tool: 'type', submit: true }, field(form(), true), 'risky send'],
  ['type without submit', { tool: 'type', submit: false }, field(form()), 'act'],
  // Keys.
  ['Enter in a form’s text field', { tool: 'press_key', key: 'Enter' }, field(form()), 'risky submit'],
  ['Enter in a single-field form that POSTs', { tool: 'press_key', key: 'Enter' }, field(form({ textFields: 1, otherFields: 0 })), 'risky submit'],
  ['Enter in a single-field GET form (a search)', { tool: 'press_key', key: 'Enter' }, field(form({ method: 'get', textFields: 1, otherFields: 0 })), 'act'],
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
