/** What an action's step is, where it goes and what the page said of it (split from tools.ts, #213). */
import { classifyStep, type RiskAction, type RiskClass, type RiskWhy, type Grant, type RiskElement, type RiskForm, ACT_REFUSALS, ELEMENT_REFUSALS, sensitiveField, quotedName, type ActTool, type PressKey } from '@chord/core';
import type { ActAnswer } from './act';
import type { DeepAnswer } from './deep';
import { CARD_ORIGINS, normalUrl, type Allowed, type SendWatch } from './sends';

/** An address's host, or empty. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** The debugger's no, in words for the agent. */
export function deepRefusal(answer: Extract<DeepAnswer, { ok: false }>): string {
  if (answer.why === 'closed') return ACT_REFUSALS.closed;
  if (answer.why === 'no-check') return ACT_REFUSALS.noCheck;
  return actRefusal(answer as Extract<ActAnswer, { ok: false }>);
}

/** What a step is (core's classifyStep), from what the page said of the element; none said: as a form's submit. */
export function stepOf(tool: ActTool, args: Record<string, unknown>, element: Extract<ActAnswer, { ok: true }>): RiskClass {
  const action: RiskAction =
    tool === 'type' ? { tool, submit: args['submit'] === true } : tool === 'press_key' ? { tool, key: args['key'] as PressKey } : { tool: tool as 'click' | 'hover' | 'select_option' };
  if (tool === 'select_option' || tool === 'hover') return classifyStep(action, emptyRisk);
  const risk = element.risk;
  if (!risk) return { class: 'risky', why: 'submit' };
  const fields = risk.form?.fields ?? [];
  const kinds = fields.map((f) => sensitiveField(f));
  const form: RiskForm | null = risk.form
    ? {
        method: risk.form.method,
        search: risk.form.search,
        searchFields: risk.form.searchFields,
        hidden: risk.form.hidden,
        overflow: risk.form.overflow,
        textFields: fields.filter((f) => f.text).length,
        otherFields: fields.filter((f) => !f.text).length,
        payment: kinds.includes('payment'),
        password: kinds.includes('password') || fields.some((f) => f.type === 'password'),
        labels: fields.map((f) => f.label),
        action: risk.form.action,
      }
    : null;
  return classifyStep(action, { tag: risk.tag, role: element.role, type: risk.type, name: element.name, ...(risk.text ? { text: risk.text } : {}), href: risk.href, ...(risk.hrefUnknown ? { hrefUnknown: true } : {}), editable: element.editable === true, multiline: risk.multiline, submits: risk.submits, form });
}

/**
 * Tries at the pointer's move to the press when the page replaced the element on the way (a re-render: the owner's
 * retest of #117); then it's refused as changed, as before.
 */
export const PRESS_TRIES = 5;

/** How long a key's check waits for its keydown to have been handled in the page (the guard's count), at most. */
export const KEY_SEEN_MS = 500;

/** The element gone or replaced by the page, or a look-alike in its place now (#211's review): the same for a key's checks. */
export const redrawn = (refusal: string | null): boolean => refusal === ACT_REFUSALS.changed || refusal === ACT_REFUSALS.ambiguous || refusal === ACT_REFUSALS.rowChanged || refusal === ACT_REFUSALS.rowEmpty;

/**
 * A look-alike in the element's place once input had reached the page (a key, a press, text, a value, a choice): what
 * went in may have worked, so never "nothing was done" (#211's round 2: a comment box that sends on Enter and redraws).
 */
export const INPUT_REDRAWN = 'The page redrew that element, or changed the row it’s in, after the input went in, so it may or may not have worked. Call snapshot and check before doing it again.';

/** A key whose element the page redrew between its keydown and the rest: maybe nothing happened. */
export const KEY_REDRAWN = 'The page redrew that element while the key went in, so it may not have worked. Call snapshot and check before pressing it again.';

/** A key's retry checks the step again with at most this many tries of its own. */
export const RETRY_CHECKS = 2;

/** How long typing waits for the page to have seen its click, at most. */
export const PRESS_SEEN_MS = 500;

/** Send cards in one action at most (each for sites the ones before didn't name): a page that keeps finding more is stopped. */
const SEND_CARDS = 3;

/**
 * What an action's page held (sends.ts), asked about until the action's done: a card for its sites, or the step a
 * document's address is (a script going to a delete address). Allow lets go what goes to the sites the card named,
 * and only after `halt` (Stop, the user taking the tab, the page gone on); something held for another site meanwhile
 * asks again (#112 review 2: Allow never releases more than the card named), at most SEND_CARDS times. Don't, no
 * answer, Stop or your taking the tab (the watch cancelled) drops it all. Returns why it refused, or null.
 */
export async function askHeld(
  w: SendWatch,
  acting: Promise<unknown>,
  ask: (held: { url: string; why: RiskWhy | null }[], sites: string[], why: RiskWhy | null, takeDown: AbortSignal) => Promise<Grant | 'waiting'>,
  halt: (opened: unknown) => string | null,
  own: string,
  /** Where the page is when a card opens (its document): what `halt` checks Allow against. */
  mark: () => unknown = () => null,
): Promise<string | null> {
  const acted = acting.then(
    () => 'acted' as const,
    () => 'acted' as const,
  );
  let cards = 0;
  for (;;) {
    if (w.cancelled.aborted) return halt(mark());
    const next = await Promise.race([acted, w.nextHeld()]);
    const held = w.held();
    if (!held.length) {
      if (next === 'acted' || w.cancelled.aborted) return w.cancelled.aborted ? halt(mark()) : null;
      continue;
    }
    if (++cards > SEND_CARDS) {
      w.deny();
      return ACT_REFUSALS.sendsTooMany;
    }
    // A step an address is gets a card of its own; otherwise what's held now, by origin (the page's own first), at most
    // CARD_ORIGINS of them (the card lists that many: round 4 of #112), the rest on the next card.
    const step = held.find((h) => h.why);
    const found = w.sitesOf(step ? [step.url] : held.map((h) => h.url));
    const sites = (found.includes(own) ? [own, ...found.filter((s) => s !== own)] : found).slice(0, CARD_ORIGINS);
    // Each card its own: one no one answers comes down (Neon's S11), never left at the head of the queue.
    const down = new AbortController();
    const opened = mark();
    const answer = await ask(held, sites, step?.why ?? null, AbortSignal.any([w.cancelled, down.signal]));
    if (answer === 'waiting') down.abort();
    if (answer === 'once' || answer === 'always') {
      const halted = halt(opened);
      if (halted) {
        w.deny();
        return halted;
      }
      // A step card's yes: that address only. A send card's: those origins (*Allow until done*, its `always`: and after
      // this action too, until the agent's done: sends.ts).
      w.allow(step ? { url: step.url } : { origins: new Set(sites), until: answer === 'always' });
      continue;
    }
    w.deny();
    if (w.cancelled.aborted) return halt(opened);
    // A no that wasn't the user's (the tab taken over, Stop, the page gone: #116) says so.
    const halted = halt(opened);
    if (halted) return halted;
    return answer === 'waiting' ? ACT_REFUSALS.sendsDropped : ACT_REFUSALS.stepDenied;
  }
}

/** Where a risky step's form or link goes, when that's another site than the page's: the card says so. */
export function targetOf(element: Extract<ActAnswer, { ok: true }>, site: string, siteOf: (url: string) => string | null): { to?: string } {
  const url = element.risk?.form?.url || element.risk?.hrefUrl || '';
  const to = url ? (siteOf(url) ?? hostOf(url)) : '';
  return to && to !== site ? { to } : {};
}

/**
 * What a risky step the user allowed lets go (its card named it): its form's address and its link's, exactly. Never an
 * origin: anything else its page sends meanwhile still asks (Claude's review 3 of #112: a POST next to the click's own
 * `location = '/logout'`).
 */
/**
 * Whether a step sends its form (its address is then the step's own): a submit button's click or Space, `type` with
 * `submit`, or Enter in a form's own field, as core's classifyStep has it; never any other key (Neon's final pass).
 */
export function stepSubmits(tool: string, args: Record<string, unknown>, element: { editable?: boolean; risk?: { submits?: boolean; tag?: string } }): boolean {
  if (args['submit'] === true) return true;
  if (tool === 'press_key') {
    const field = element.editable === true || ['input', 'select', 'textarea'].includes(element.risk?.tag ?? '');
    return (args['key'] === 'Enter' && field) || (element.risk?.submits === true && (args['key'] === 'Enter' || args['key'] === 'Space'));
  }
  return tool === 'click' && element.risk?.submits === true;
}

export function allowedBy(element: Extract<ActAnswer, { ok: true }>, submits: boolean): Allowed {
  // Its form's address only when the step submits it (Neon's S9); its link's only as a page going there, each once.
  return {
    urls: new Set(submits && element.risk?.form?.url ? [normalUrl(element.risk.form.url)] : []),
    documents: new Set(element.risk?.hrefUrl ? [normalUrl(element.risk.hrefUrl)] : []),
  };
}



/**
 * The step's element as a card shows it and a late Allow covers it: its name, the items it's in and its place (Neon's
 * round 1 of M2g-1, B-2: refs stay, so the same ref after a rename or a move is another step), then its risk's shape.
 */
export function stepShape(element: Extract<ActAnswer, { ok: true }>): string {
  const risk = element.risk;
  const form = risk?.form;
  return JSON.stringify([element.name, element.items ?? '', element.row ?? '', element.path ?? '', !risk ? null : [risk.tag, risk.type, risk.submits, risk.href, risk.hrefUrl, risk.hrefUnknown === true, risk.text, form ? [form.hidden, form.overflow] : null, form ? [form.method, form.url, form.search, form.fields.map((f) => [f.type, f.autocomplete, f.name, f.label])] : null]]);
}


const emptyRisk: RiskElement = { tag: '', role: '', type: '', name: '', href: '', editable: false, multiline: false, submits: false, form: null };

/** The page's no, in words for the agent. */
export function actRefusal(answer: Extract<ActAnswer, { ok: false }>): string {
  if (answer.why === 'stale') return ELEMENT_REFUSALS.stale;
  // Replaced again and again (the press's tries ran out): changed, as it always was.
  if (answer.why === 'replaced') return ACT_REFUSALS.changed;
  // Two or more alike, redrawn (#211): how to choose, never a guess.
  if (answer.why === 'ambiguous') return ACT_REFUSALS.ambiguous;
  // The same node, its unnamed row saying something else now (#268's review): maybe another row's, never pressed.
  if (answer.why === 'row') return ACT_REFUSALS.rowChanged;
  if (answer.why === 'row-empty') return ACT_REFUSALS.rowEmpty;
  // Inside a same-origin frame (#210, PR 1: read, not acted on yet).
  if (answer.why === 'in-frame') return ACT_REFUSALS.inFrame;
  // In a frame under a transform or a zoom (#347, B7): where the pointer would land can't be told.
  if (answer.why === 'transformed') return ACT_REFUSALS.cantPoint;
  if (answer.why === 'covered') return ACT_REFUSALS.covered(answer.cover ? `${answer.cover.role} ${quotedName(answer.cover.name, answer.cover.role)}` : 'something');
  if (answer.why === 'not-select') return ACT_REFUSALS.notSelect;
  if (answer.why === 'no-answer') return 'The page didn’t answer in time. Call snapshot again, then try once more.';
  if (answer.why === 'no-choice') return ACT_REFUSALS.noChoice;
  if (answer.why === 'two-choices') return ACT_REFUSALS.twoChoices;
  if (answer.why === 'no-move') return ACT_REFUSALS.noMove;
  if (answer.why === 'file') return ACT_REFUSALS.file;
  return ACT_REFUSALS.changed;
}
