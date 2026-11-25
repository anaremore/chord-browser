/**
 * batch (S18 M2g-1, the owner's token goal): several element steps on one tab in one call, each through the same layer
 * as its own call (runControlTool: every check, card, the send hold and the guard). Outside agents only (connection.ts).
 *
 * - Every step is checked before any runs (its tool, its shape): a bad step 3 never leaves steps 1 and 2 done.
 * - The batch's tab is every step's: a step's own `tab_id` is ignored.
 * - Before each step: Stop or the client's cancel, the user pausing the agent here, or the user taking the tab over (its
 *   cards let go of since the batch began: Neon's round 1 of M2g-1, B-7) stops it there.
 * - It stops at the first refusal, or after a step that took the page elsewhere, saying which steps went.
 * - One diff, at the last step (each step's own would repeat what the next changes).
 */
import { ACT_REFUSALS, BATCH_STEPS_MAX, BATCH_TOOLS, CONTROL_REFUSALS, toolResult, type NodeId } from '@chord/core';
import type { ControlScope, ToolOutput } from './scope';
import { runControlTool, type ControlBrowser } from './tools';

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
    // The batch's tab, whatever the step says.
    planned.push({ tool, args: { ...stepArgs, tab_id: args['tab_id'] } });
  }
  const found = scope.refs.resolve(args['tab_id'], () => true);
  const nodeId: NodeId | null = found.ok ? found.id : null;
  // The tab's cards let go of so far: a change means the user took it over (gate.ts' releases).
  const released = nodeId !== null ? scope.agent.releases(nodeId) : 0;
  const done: string[] = [];
  const notes = new Set<string>();
  let changes: unknown;
  let last: Record<string, unknown> = {};
  const went = () => (done.length ? ` Steps 1 to ${done.length} went: ${done.join('; ')}.` : ' None before it went.');
  const withNotes = (o: Record<string, unknown>) => ({ ...o, ...(notes.size ? { notes: [...notes] } : {}) });
  const stoppedAt = (i: number, tool: string, why: string): ToolOutput => ({ text: `Step ${i + 1} (${tool}) didn’t run: ${why}${went()}${notes.size ? ` Notes: ${[...notes].join(' ')}` : ''}`, isError: true });
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
      return { text: `Step ${i + 1} (${tool}) was refused: ${why}${went()}${notes.size ? ` Notes: ${[...notes].join(' ')}` : ''}`, isError: true };
    }
    const data = (JSON.parse(out.text ?? '{}') as { data?: Record<string, unknown> }).data ?? {};
    done.push(String(data['done'] ?? tool));
    for (const k of NOTES) if (typeof data[k] === 'string') notes.add(data[k] as string);
    last = data;
    if (data['page_changes'] !== undefined) changes = data['page_changes'];
    // A step that took the page elsewhere: the steps after it name refs of the page before.
    if (data['navigated'] === true && i < planned.length - 1) {
      return { text: toolResult(withNotes({ tab_id: args['tab_id'], done, stopped_after: i + 1, why: 'The page changed: call snapshot before the rest.', url: last['url'], title: last['title'], page_id: last['page_id'] })) };
    }
  }
  return { text: toolResult(withNotes({ tab_id: args['tab_id'], done, navigated: last['navigated'] === true, page_id: last['page_id'], url: last['url'], title: last['title'], ...(changes !== undefined ? { page_changes: changes } : {}) })) };
}
