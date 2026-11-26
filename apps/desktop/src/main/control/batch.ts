/**
 * batch (S18 M2g-1, the owner's token goal): several element steps on one tab in one call, each through the same layer
 * as its own call (runControlTool: every check, card, the send hold and the guard). Outside agents only (connection.ts).
 *
 * - Every step is checked before any runs: its tool, its shape, and its own arguments as its tool takes them (its ref,
 *   text, key, option: round 1 of #145, SF6). A bad step 3 never leaves steps 1 and 2 done.
 * - A step refused, or not run, is said in the untrusted envelope: what went before it is the page's words (SF6).
 * - The batch's tab is every step's: a step's own `tab_id` is ignored.
 * - Before each step: Stop or the client's cancel, the user pausing the agent here, or the user taking the tab over (its
 *   cards let go of since the batch began: Neon's round 1 of M2g-1, B-7) stops it there.
 * - It stops at the first refusal, or after a step that took the page elsewhere, saying which steps went.
 * - One diff, at the last step (each step's own would repeat what the next changes).
 */
import { ACT_REFUSALS, BATCH_STEPS_MAX, BATCH_TOOLS, CONTROL_REFUSALS, ELEMENT_REFUSALS, isPressKey, TYPE_TEXT_MAX, toolResult, type NodeId, BOX_REF } from '@chord/core';
import { pageOf } from '../view-page';
import { pageIdOf } from './page';
import type { ControlScope, ToolOutput } from './scope';
import { runControlTool, type ControlBrowser, PART_REFUSALS } from './tools';

/** A step's own arguments, as its tool takes them: null, or what's wrong (checked before any step runs: SF6). */
function stepWrong(tool: string, a: Record<string, unknown>): string | null {
  // A part's container ref is read-only (#207): its own words, as each acting tool's.
  if (typeof a['ref'] === 'string' && BOX_REF.test(a['ref'])) return PART_REFUSALS.act;
  if (typeof a['ref'] !== 'string' || !/^e[1-9][0-9]{0,8}$/.test(a['ref'])) return 'ref is an element’s ref from a snapshot (e1, e2…).';
  if (tool === 'type' && (typeof a['text'] !== 'string' || a['text'].length > TYPE_TEXT_MAX)) return `type takes text, at most ${TYPE_TEXT_MAX} characters.`;
  if (tool === 'type' && [a['submit'], a['replace']].some((v) => v !== undefined && typeof v !== 'boolean')) return 'submit and replace are true or false.';
  // press_key's own refusal, which lists the keys (the schema no longer does in batch's steps: M2g-2 slice 2).
  if (tool === 'press_key' && !isPressKey(a['key'])) return ACT_REFUSALS.key;
  if (tool === 'select_option' && (typeof a['option'] !== 'string' || !a['option'] || a['option'].length > 500)) return 'select_option takes option, its label (at most 500 characters).';
  return null;
}

/** What a step's result says that the batch passes on, once each (on every exit). */
const NOTES = ['refound', 'focus', 'dropped', 'note'] as const;

export async function runBatch(scope: ControlScope, browser: ControlBrowser, args: Record<string, unknown>, cancelled: AbortSignal): Promise<ToolOutput> {
  const steps = Array.isArray(args['steps']) ? (args['steps'] as unknown[]) : [];
  if (steps.length < 1 || steps.length > BATCH_STEPS_MAX) return { text: `batch takes 1 to ${BATCH_STEPS_MAX} steps.`, isError: true };
  // Every step checked first (N-2): none runs if one can't.
  const planned: { tool: string; args: Record<string, unknown> }[] = [];
  for (const [i, raw] of steps.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { text: `Step ${i + 1}: each step is an object with its tool and arguments.`, isError: true };
    const { tool, tab_id: _ignored, ...stepArgs } = raw as Record<string, unknown>;
    void _ignored;
    if (typeof tool !== 'string' || !(BATCH_TOOLS as readonly string[]).includes(tool)) return { text: `Step ${i + 1}: batch takes ${BATCH_TOOLS.join(', ')}.`, isError: true };
    const wrong = stepWrong(tool, stepArgs);
    if (wrong) return { text: `Step ${i + 1}: ${wrong}`, isError: true };
    // The batch's tab, whatever the step says.
    planned.push({ tool, args: { ...stepArgs, tab_id: args['tab_id'] } });
  }
  const found = scope.refs.resolve(args['tab_id'], () => true);
  const nodeId: NodeId | null = found.ok ? found.id : null;
  // Each step's ref, before step 1 runs (round 2 of #145): one never given, or from before the page moved on, is
  // refused here, never after the steps before it went. A tab not loaded now is checked for a ref never given only.
  const elements = nodeId !== null ? scope.memory.elements?.get(nodeId) : undefined;
  const contents = nodeId !== null ? pageOf(browser.tabs.get(nodeId)) : undefined;
  const pageId = contents && !contents.isDestroyed() ? pageIdOf(contents) : '';
  for (const [i, { args: a }] of planned.entries()) {
    const lookup = elements?.resolve(a['ref'], pageId) ?? { ok: false as const, why: 'unknown' as const };
    if (nodeId !== null && !lookup.ok && (lookup.why === 'unknown' || pageId)) {
      return { text: `Step ${i + 1}: ${lookup.why === 'unknown' ? ELEMENT_REFUSALS.unknown(String(a['ref'])) : ELEMENT_REFUSALS.stale}`, isError: true };
    }
    // Never one the agent wasn't shown (#208: rule 1), before step 1 runs.
    if (nodeId !== null && lookup.ok && !elements!.wasShown(a['ref'], pageId)) return { text: `Step ${i + 1}: ${ELEMENT_REFUSALS.unknown(String(a['ref']))}`, isError: true };
  }
  // The tab's cards let go of so far: a change means the user took it over (gate.ts' releases).
  const released = nodeId !== null ? scope.agent.releases(nodeId) : 0;
  const done: string[] = [];
  const notes = new Set<string>();
  // What the page was caught doing at any step (#150: a tab of yours): never lost behind a later step's done.
  const caught: string[] = [];
  let changes: unknown;
  let last: Record<string, unknown> = {};
  const withNotes = (o: Record<string, unknown>) => ({ ...o, ...(notes.size ? { notes: [...notes] } : {}), ...(caught.length ? { caught } : {}) });
  // A step that didn't go: Chord's sentence names only the step; why, and what went before it, are in the untrusted
  // envelope (round 1 of #145, SF6: a refusal can carry an element's name, and what went is the page's words).
  const notGone = (i: number, tool: string, verb: 'was refused' | 'didn’t run', why: string): ToolOutput => ({
    text: toolResult(withNotes({ refused: `Step ${i + 1} (${tool}) ${verb}.`, step: i + 1, tool, why, done })),
    isError: true,
  });
  const stoppedAt = (i: number, tool: string, why: string): ToolOutput => notGone(i, tool, 'didn’t run', why);
  for (const [i, { tool, args: stepArgs }] of planned.entries()) {
    if (cancelled.aborted || scope.agent.isStopped) return stoppedAt(i, tool, CONTROL_REFUSALS.stopped);
    if (nodeId !== null && i > 0) {
      if (scope.agent.state(nodeId).paused) return stoppedAt(i, tool, CONTROL_REFUSALS.paused);
      if (scope.agent.releases(nodeId) !== released) return stoppedAt(i, tool, ACT_REFUSALS.takenOver);
    }
    const scopeOfStep: ControlScope = i < planned.length - 1 ? Object.create(scope, { noDiff: { value: true } }) : scope;
    const out = await runControlTool(scopeOfStep, browser, tool, stepArgs, cancelled);
    if (out.isError) {
      const why = (() => {
        try {
          const data = (JSON.parse(out.text ?? '{}') as { data?: { refused?: string; error?: string } }).data;
          return data?.refused ?? data?.error ?? out.text ?? '';
        } catch {
          return out.text ?? '';
        }
      })();
      return notGone(i, tool, 'was refused', why);
    }
    const data = (JSON.parse(out.text ?? '{}') as { data?: Record<string, unknown> }).data ?? {};
    done.push(String(data['done'] ?? tool));
    for (const k of NOTES) if (typeof data[k] === 'string') notes.add(data[k] as string);
    if (Array.isArray(data['caught'])) for (const c of data['caught']) if (typeof c === 'string') caught.push(c);
    last = data;
    if (data['page_changes'] !== undefined) changes = data['page_changes'];
    // A step that took the page elsewhere: the steps after it name refs of the page before.
    if (data['navigated'] === true && i < planned.length - 1) {
      return { text: toolResult(withNotes({ tab_id: args['tab_id'], done, stopped_after: i + 1, why: 'The page changed: call snapshot before the rest.', url: last['url'], title: last['title'], page_id: last['page_id'] })) };
    }
  }
  return { text: toolResult(withNotes({ tab_id: args['tab_id'], done, navigated: last['navigated'] === true, page_id: last['page_id'], url: last['url'], title: last['title'], ...(changes !== undefined ? { page_changes: changes } : {}) })) };
}
