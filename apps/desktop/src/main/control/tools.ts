/**
 * The control layer's tools (S18 M1a): ASSISTANT_TOOLS' handlers, moved from
 * the assistant's service, for any front door. Each call goes through the
 * agent's gate (Stop answers at once), reads pages through the page adapter
 * (page.ts), and asks the scope what this agent may see and when it must ask.
 * The refusals are one sentence each, as the assistant has always said them.
 */
import { phaseClock } from './phases';
import { CONTROL_REFUSALS, controlTool, isActionTool, type ActTool, toolResult } from '@chord/core';
import type { ControlScope, ToolOutput } from './scope';
import { type Call, type ControlBrowser, refuse } from './tool-call';
import { actTool } from './tools-act';
import { snapshotTool, waitForTool } from './tools-outline';
import { diagnosticsTool, formTool, readTool } from './tools-read';

/** A tool call from a model: through the gate, then its handler. */
/**
 * `cancelled`: the client gave up on this call (MCP's notifications/cancelled; Neon's review of M2g-1, B5): as Stop is for
 * it, so a long call (wait_for) ends and takes down what it left in the page.
 */
/**
 * `settled`: a snapshot taken for an action's answer (open_tab's snapshot: true): of the page as the action left it,
 * never waiting for a load (round 1 of #232, SF1).
 */
export async function runControlTool(scope: ControlScope, browser: ControlBrowser, name: string, args: Record<string, unknown>, cancelled?: AbortSignal, settled = false): Promise<ToolOutput> {
  const spec = controlTool(name);
  // M2's tools exist only where the scope offers them (a build that has M2), and acting only where it lets its agent
  // act (outside agents in M2c): elsewhere they're unknown, as they were.
  if (!spec || (isActionTool(spec.name) && (!scope.actions || (spec.level === 'act' && !scope.act)))) return { text: toolResult({ error: `Unknown tool ${name}` }, false), isError: true };
  const off = scope.off();
  if (off) return refuse(off);
  const ref = args['tab_id'];
  const tab = typeof ref === 'string' ? (scope.refs.get(ref) ?? null) : null;
  // The whole call's time, by tool (M2g-1's measurement: phases.ts), from here to its answer.
  const clock = phaseClock(spec.name);
  // #143: when the call answers by, from its start (the scope's; an outside agent's is under every client's timeout).
  const deadline = scope.callDeadlineMs === undefined ? null : Date.now() + scope.callDeadlineMs;
  const answered = scope.agent.call(
    tab,
    async (gateSignal) => {
      const signal = cancelled ? AbortSignal.any([gateSignal, cancelled]) : gateSignal;
      const call: Call = {
        scope,
        browser,
        signal,
        deadline,
        card: async (tool, node, description, target, no) => {
          const needed = scope.needsCard(tool, node);
          if (!needed) return null;
          const answer = await scope.agent.ask({ ...needed, tool, description, target, tab: node?.id ?? null }, signal, scope.cardWaitMs);
          if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
          return answer === 'deny' ? refuse(no) : null;
        },
        stopped: () => signal.aborted,
        activity: async (tool, summary, detail = '', ok = true) => {
          if (!signal.aborted) await scope.activity(tool, summary, detail, ok);
        },
      };
      try {
        if (spec.name === 'read_form' || spec.name === 'propose_fill') return await formTool(call, spec.name, args);
        if (spec.name === 'page_diagnostics') return await diagnosticsTool(call, args);
        if (spec.name === 'snapshot') return await snapshotTool(call, args, settled);
        if (spec.name === 'wait_for') return scope.waits ? await waitForTool(call, args) : refuse('There’s no tool called wait_for.');
        if (spec.level === 'act') return await actTool(call, spec.name as ActTool, args);
        return await readTool(call, spec.name, args);
      } catch (error) {
        return { text: toolResult({ error: error instanceof Error ? error.message : String(error) }, false), isError: true };
      }
    },
    (why) => refuse(CONTROL_REFUSALS[why]),
    cancelled,
  );
  return answered.finally(() => clock.lap('total'));
}

// What tools.ts exported before the split (#213): its importers are unchanged.
export { stepSubmits } from './act-steps';
export { type ControlBrowser, heldStep, pageLoaded } from './tool-call';
export { STILL_LOADING, withOutline } from './tools-act';
export { FIND_NEAREST_NOTE, FIND_NONE_NOTE, ONLY_TEXT } from './tools-outline';
export { PART_REFUSALS } from './tools-read';
