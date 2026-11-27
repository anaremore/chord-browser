/** The control layer's acting tools (split from tools.ts, #213): click, type, press_key, select_option, hover, navigate and back. */
import { phaseClock } from './phases';
import { createHash, randomBytes } from 'node:crypto';
import { type NodeId, ACT_SENDS_WAITING, addressWhy, BOX_REF, VALUE_TYPES, valueFits, sentLabels, stepFields, type RiskClass, type RiskWhy, CONTROL_REFUSALS, ACT_REFUSALS, actDone, actPhrase, barAddress, wholeAddress, ELEMENT_REFUSALS, sensitiveField, isPressKey, CONTROL_WAIT_MS, NAVIGATE_URL_MAX, pressKeyEvents, TYPE_TEXT_MAX, type ActDescription, type ActTool, type ElementTool, type PressKey, isNeverReadable, toolResult, nodeOf, type TabNode } from '@chord/core';
import type { ActAnswer, ActOp } from './act';
import type { DeepSession } from './deep';
import { normalUrl, type SendWatch } from './sends';
import type { AgentInputEvent } from './input';
import type { ToolOutput } from './scope';
import { PART_REFUSALS } from './tools-read';
import { byDeadline, countAllows, HandedOver, OpenCards } from './handed-over';
import { INPUT_REDRAWN, KEY_REDRAWN, KEY_SEEN_MS, PRESS_SEEN_MS, PRESS_TRIES, RETRY_CHECKS, actRefusal, allowedBy, askHeld, deepRefusal, redrawn, stepOf, stepShape, stepSubmits, targetOf } from './act-steps';
import { type Call, NEVER, blockedAfter, blockedNow, crashedWhy, heldStep, isOutput, loadedPage, notTheirNo, originOf, refuse, resolveTab, unreadable } from './tool-call';
import { emptyDiff, pageChanges, saidOnce, snapshotTool } from './tools-outline';

/* ---------- Acting (S18 M2c) ---------- */

/**
 * An action on one of the agent's own tabs (never a shared one, M2's answer: shared tabs stay read-only). Element tools
 * name a ref from the tab's latest snapshot, on the page it's on now (a stale one is refused), and the element is
 * checked again in the page before anything is sent (control/act.ts). The first action on a site asks the site card:
 * *Allow for now* (the agent's life), *Always on this site* (kept with its allowance), or a no that lasts as long.
 * Every rule is asked again after the card. The bar says what it's doing meanwhile; the result says whether the page
 * went somewhere else (its refs are then stale). navigate and back need no ref and no site card, as open_tab.
 */
export async function actTool(call: Call, tool: ActTool, args: Record<string, unknown>): Promise<ToolOutput> {
  // A tab of yours (the assistant): its lease, begun in actOn once the tab's checked, always ended here.
  const leased: { node: TabNode | null } = { node: null };
  let out: ToolOutput;
  try {
    out = await actOn(call, tool, args, leased);
  } finally {
    if (leased.node) call.scope.act?.lease?.end(leased.node);
  }
  // A look-alike's refusal, for a client whose find can't name a row by its words: never told to (#211's review).
  if (out.isError && !call.scope.findFlat && refusalOf(out) === ACT_REFUSALS.ambiguous) out = refuse(ACT_REFUSALS.ambiguousPlain);
  // With snapshot: true, the page it went to, as snapshot gives it (S18 M2g-2 slice 3a, #204): once the action is over
  // and its hold let go of, by snapshot's own call, every read rule with it.
  if (tool !== 'navigate' || args['snapshot'] !== true || !call.scope.outlineOnGo || out.isError) return out;
  return withOutline(out, 'navigate', () => snapshotTool(call, { tab_id: args['tab_id'] }, true));
}

/** No outline for a page still loading when the action answered: never a second wait (open_tab's limit stands). */
export const STILL_LOADING = 'The page was still loading, so its outline wasn’t taken: call snapshot in a moment.';

/**
 * An action's answer with the page's outline (S18 M2g-2 slice 3a, #204): snapshot's own answer, its envelope untouched,
 * with the action's words under the tool's name (less what the envelope says: the tab, page, address and title; and the
 * note to call snapshot, which the outline answers). No outline (the read refused, or the page still loading): the
 * action's answer as it was, saying why in `no_outline`, in Chord's words (snapshot's refusal), never the page's. The
 * action happened either way: never an error.
 */
export async function withOutline(action: ToolOutput, tool: 'open_tab' | 'navigate', look: () => Promise<ToolOutput>): Promise<ToolOutput> {
  if (action.isError || !action.text) return action;
  const acted = JSON.parse(action.text) as { data: Record<string, unknown> } & Record<string, unknown>;
  const noOutline = (why: string): ToolOutput => ({ text: JSON.stringify({ ...acted, data: { ...acted.data, no_outline: why } }) });
  // #143: what the step sent waits for the user (its sends handed over): no outline, never a wait for one.
  if (typeof acted.data['sending'] === 'string') return action;
  if (acted.data['loading'] === true) return noOutline(STILL_LOADING);
  const snap = await look();
  if (snap.isError || !snap.text) return noOutline(refusalOf(snap));
  // (Its `loading` too: it's false when there's an outline.)
  const { tab_id: _tab, page_id: _page, url: _url, title: _title, note: _note, loading: _loading, ...rest } = acted.data;
  return { text: JSON.stringify({ ...(JSON.parse(snap.text) as Record<string, unknown>), [tool]: rest }) };
}

/**
 * A hold found lost: why. Its page crashed (#115 PR 2): the tab stopped working, and the user's reload is theirs; with
 * nothing gone in yet, nothing was done, else the step may have gone in (#336, Opus's B1: a page that crashes itself
 * right after a click on Buy must never invite the agent to click again). Not crashed: Chord couldn't check the page,
 * which says the step may have gone in, whatever went (the conservative answer, meant).
 */
function lostWhy(call: Call, nodeId: NodeId, page: { crashed?(): boolean }, went: boolean): string {
  return page.crashed?.() ? crashedWhy(call, nodeId, went) : ACT_REFUSALS.noCheck;
}

/** A refusal's sentence: the shared layer's `{data: {refused}}`, or an agent's plain text (toPlain). */
function refusalOf(out: ToolOutput): string {
  try {
    const data = (JSON.parse(out.text ?? '') as { data?: { refused?: unknown; error?: unknown } }).data;
    if (typeof data?.refused === 'string') return data.refused;
    if (typeof data?.error === 'string') return data.error;
  } catch {
    // Plain words already.
  }
  return out.text || 'That page could not be read.';
}

async function actOn(call: Call, tool: ActTool, args: Record<string, unknown>, leased: { node: TabNode | null }): Promise<ToolOutput> {
  const { scope, browser } = call;
  const host = scope.act!;
  const found = resolveTab(call, args['tab_id'], 'No such tab. Use list_tabs for the tabs there are.');
  if (isOutput(found)) return found;
  const node = found;
  if (!scope.readable(node)) return refuse(unreadable(scope, node));
  // #143: its last step's sends still wait on the user's card (that call answered at its deadline): its outcome first.
  if (scope.memory.sendsWaiting?.has(node.id)) return refuse(ACT_REFUSALS.sendsPending);
  const notHere = host.mayAct(node);
  if (notHere) return refuse(notHere);
  if (browser.readers.viewFor(node.id)) return refuse('That tab is in reader view, which hides its page. Ask the user to close reader view first.');
  const page = await loadedPage(browser, node.id, call.signal);
  if (!page) return refuse('That tab could not be loaded.');
  if (page.unsecured()) return refuse(ACT_REFUSALS.unsecured);
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const loaded = blockedNow(call, node.id, page, 'That tab could not be loaded.');
  if (loaded) return refuse(loaded);
  // A tab of yours: its debugger and send hold for this action (control/user-watch.ts), begun only right before its
  // input or its load, once the cards and checks have passed (Neon's B5 on #147); ended by actTool.
  const leaseOn = async (): Promise<string | null> => {
    if (!host.lease || leased.node) return null;
    const no = await host.lease.begin(node);
    if (!no) leased.node = node;
    return no;
  };
  /** Where it may act, asked again at every step (A1: the tab switched away, a split, minimized: Neon's B6 on #147). */
  const notHereNow = () => host.mayAct(node);
  // Your taking the tab over lets go of its cards (S18 M2e-1): one no window shows isn't paused, so the count is how
  // an action hears of it (Claude's review 2 of #116).
  const releasedAtStart = scope.agent.releases(node.id);
  const takenOver = () => (scope.agent.releases(node.id) !== releasedAtStart ? ACT_REFUSALS.takenOver : null);
  const ref = scope.refs.refFor(node.id);
  /**
   * #143: this step's Send data cards, past the call's deadline (byDeadline): handed over (handed-over.ts), its outcome
   * from the cards' own end or what's live (the tab in the live store, Stop, your taking the tab, the page leaving).
   */
  const handOver = (w: SendWatch, allowed: () => number, cards: OpenCards, cardsEnd: AbortController, step: string, sending: Promise<string | null>): HandedOver => {
    const handed = new HandedOver({
      nodeId: node.id,
      tab: ref,
      tool,
      step,
      w,
      allowed,
      cards,
      cardsEnd,
      memory: scope.memory,
      from: scope.callToken,
      live: () => {
        // The live node, never the TabNode taken at the start (Neon's B1).
        const now = nodeOf(browser.store.state, node.id);
        if (now?.kind !== 'tab') return 'closed';
        if (scope.agent.isStopped || call.stopped()) return 'stopped';
        // Yours now: paused, taken, or kept (Keep on one tab: it's no longer the agent's to act on or read).
        if (scope.agent.state(node.id).paused || takenOver() || host.mayAct(now) || !scope.readable(now)) return 'took-over';
        return null;
      },
      onLeave: (fn) => page.onLeave(fn),
    });
    void sending.then(
      (sent) => handed.ended(sent),
      // Handed over, input had gone in: a crash meanwhile is said so (#336, Neon NB1).
      () => handed.ended(lostWhy(call, node.id, page, true)),
    );
    return handed;
  };
  const done = async (navigated: boolean, loading: boolean, what: string, droppedBefore = 0, refoundElement = false, focusTaken = false, pastDeadline = false, sendsWait = false): Promise<ToolOutput> => {
    // After the action: something went in (its input, or its load), so a crash now may have taken it (Neon's NB2).
    const after = blockedAfter(call, node.id, page, 'That page went somewhere that can’t be read.', true);
    if (after) return refuse(after);
    const settledOn = page.id;
    await call.activity(tool, what, page.url());
    const caught = host.caught?.(node) ?? [];
    // What changed since the agent's last snapshot, after an action on an element of a page that didn't go elsewhere
    // (M2g-1: the default; not between a batch's steps).
    // Not past the call's deadline (#143): it holds, and the diff's read can take seconds.
    let changes = !pastDeadline && !navigated && tool !== 'navigate' && tool !== 'back' && !scope.noDiff ? await pageChanges(call, node.id, page) : null;
    // The diff's read can take seconds (round 1 of #252, SF-2): Stop meanwhile stops it, a page that went where it may
    // not be read is refused (nothing of where), and one that went to another document is said to have, its refs
    // forgotten and no diff of the page it left. The answer's page, address and title are then all of where it is now.
    if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
    const late = blockedAfter(call, node.id, page, 'That page went somewhere that can’t be read.', true);
    if (late) return refuse(late);
    if (page.id !== settledOn) {
      navigated = true;
      changes = null;
    }
    if (navigated) scope.memory.elements?.get(node.id)?.forget();
    return {
      text: toolResult({
        tab_id: ref,
        done: what,
        navigated,
        ...(loading ? { loading: true } : {}),
        page_id: page.id,
        url: page.url(),
        title: page.title(),
        ...(navigated ? { note: 'The page changed: call snapshot again before using refs from before.' } : {}),
        // What the page tried to send since the agent's last action here, dropped (the user said no, didn't answer, or
        // took the tab: sends.ts).
        // A ref whose node the page had replaced, found again (the owner's bug #2).
        ...(refoundElement ? { refound: 'The page had redrawn that element; Chord found it again by its role, name, place and target.' } : {}),
        // Enter's keydown went, and the page then moved the focus (its handler did): done, once; never press it again.
        ...(focusTaken ? { focus: 'The page moved the focus away from that field after Enter. Enter was pressed once: call snapshot to see what it did, and don’t press it again.' } : {}),
        // What the page's response was caught doing (a tab of yours): never say done when the page said no.
        ...(caught.length ? { caught } : {}),
        // #143: the call's deadline came while a Send data card for what this step sent was up: it stays up, its
        // outcome with the next result.
        ...(sendsWait ? { sending: ACT_SENDS_WAITING } : {}),
        ...(droppedBefore ? { dropped: 'Since your last action here, the page tried to send data and it wasn’t sent (the user said no, didn’t answer, or took the tab). If something didn’t save, ask the user.' } : {}),
        // Nothing changed: nothing extra (round 2 of #145: a diff costs nothing then).
        ...(changes && !emptyDiff(changes) ? saidOnce(changes, page.url()) : {}),
      }),
    };
  };

  if (tool === 'navigate' || tool === 'back') {
    let target = '';
    let back: { index: number; url: string } | null = null;
    if (tool === 'navigate') {
      target = typeof args['url'] === 'string' ? args['url'].trim() : '';
      if (!/^https?:\/\//i.test(target) || target.length > NAVIGATE_URL_MAX) return refuse(`navigate takes an http or https address of at most ${NAVIGATE_URL_MAX} characters.`);
      if (isNeverReadable(target, scope.neverSites())) return refuse(NEVER);
    } else {
      // Where back goes is checked before going, as navigate's address is: never a site kept private, never a Chord page.
      // And it goes to exactly that entry (goBack could skip it, to one further back).
      back = page.backEntry();
      if (!back) return refuse(ACT_REFUSALS.noBack);
      if (!/^https?:\/\//i.test(back.url) || isNeverReadable(back.url, scope.neverSites())) return refuse(NEVER);
    }
    const goingTo = tool === 'navigate' ? target : (back?.url ?? '');
    const goingSite = host.siteOf(goingTo);
    if (!goingSite) return refuse(ACT_REFUSALS.noSite);
    // Leaving the site (the assistant in a tab of yours): one card, the leaving card with the whole address, below. Going
    // to a page isn't acting on it: never that site's own card, nor its grant; acting on its page later asks it then (the
    // owner's test of the 0.15 preview). An outside agent's own tabs: the site card for where it goes, as before.
    const leavesSite = host.leaving?.(page.url(), goingTo) ?? false;
    // The site it goes to asks first, as any action on a site does (Neon's review of #112): the site card, once.
    const remembered = leavesSite ? null : scope.agent.granted('site', goingSite);
    if (remembered === 'deny') return refuse(ACT_REFUSALS.siteDenied(goingSite));
    if (!leavesSite && !remembered && !host.siteAllowed(goingSite)) {
      const released = scope.agent.releases(node.id);
      const answer = await scope.agent.ask({ kind: 'site', tool, description: `go to ${barAddress(goingTo)}`, target: [page.url()], tab: node.id, subject: goingSite }, call.signal, scope.cardWaitMs);
      if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
      if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.siteDenied(goingSite));
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      scope.agent.keep('site', goingSite, answer);
      if (answer === 'always') host.keepSite(goingSite);
    }
    // An address that deletes or signs out (core's addressWhy, as a link's): the step card first (#112 review 1). Leaving
    // the site, the leaving card names the whole address instead: one card.
    const goingWhy = addressWhy(goingTo);
    if (goingWhy && !leavesSite) {
      const released = scope.agent.releases(node.id);
      const answer = await scope.agent.ask(
        {
          kind: 'step',
          tool,
          description: `go to ${barAddress(goingTo)}`,
          target: [page.url()],
          tab: node.id,
          subject: JSON.stringify([node.id, page.id, tool, goingTo]),
          step: { why: goingWhy, site: goingSite, fields: [], more: 0 },
        },
        call.signal,
        scope.cardWaitMs,
      );
      if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
      if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.stepDenied);
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      // Back must still go to the entry the card named.
      if (tool === 'back' && page.backEntry()?.url !== goingTo) return refuse(ELEMENT_REFUSALS.stale);
    }
    // Leaving the site (the assistant in a tab of yours, M2e-2c, B3): every time, showing the whole address, which can
    // carry data out. In a chat that read elsewhere, any address does, the same site's too (Claude's C-B3 on #151).
    const leaves = leavesSite || (host.typeAsks?.(node, page.url()) ?? false);
    if (leaves) {
      const released = scope.agent.releases(node.id);
      const answer = await scope.agent.ask(
        {
          kind: 'step',
          tool,
          description: `go to ${barAddress(goingTo)}`,
          target: [page.url()],
          tab: node.id,
          subject: JSON.stringify([node.id, page.id, tool, 'leave', goingTo]),
          step: { why: 'leave', site: goingSite, fields: [], more: 0, going: wholeAddress(goingTo) },
        },
        call.signal,
        scope.cardWaitMs,
      );
      if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
      if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.stepDenied);
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      // Back must still go to the entry the card named (a pushState while it was up: Neon's SF2 on #151).
      if (tool === 'back' && page.backEntry()?.url !== goingTo) return refuse(ELEMENT_REFUSALS.stale);
    }
    // The list may have gained its site while a card was up (Neon's review 2 of #112).
    if (isNeverReadable(goingTo, scope.neverSites())) return refuse(NEVER);
    // Its hold on (Neon's final pass): a tab whose hold is lost, or never finished, loads nothing for the agent.
    if (page.unsecured()) return refuse(ACT_REFUSALS.unsecured);
    // An outside agent's tab: its hold tried again. A tab of yours: a loss is its last lease's, and this action's own
    // lease (below) starts clean (round 3 of #147).
    // A crashed page's hold can't come back by trying (#336, Fable's S1): said at once.
    if (page.crashed?.()) return refuse(crashedWhy(call, node.id, false));
    if (!host.lease && page.lost() && !(await page.retryHold())) return refuse(lostWhy(call, node.id, page, false));
    const before = page.id;
    // It runs: a late Allow given on this tab for another step is spent.
    scope.agent.dropLateSteps(node.id);
    host.doing(node.id, tool === 'navigate' ? { tool, to: barAddress(target) } : { tool });
    try {
      // The tab's load can take a while: the user taking the tab, or Stop, meanwhile stops it here.
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      // What its load sends, or a redirect to an address that deletes or signs out, is held as an action's is: only what
      // the card named goes (the address itself, when it asked).
      const notNow = notHereNow() ?? (await leaseOn());
      if (notNow) return refuse(notNow);
      const w = page.watchSends(goingWhy || leaves || host.lease ? { urls: new Set(), documents: new Set([normalUrl(goingTo)]) } : null);
      if (!w) return refuse(lostWhy(call, node.id, page, false));
      // Where it goes: a page there sending the tab on to another site asks too (an open redirect, M2e-2c). Told once
      // the hold is on (Neon's N2 on #151).
      host.lease?.going(node, goingTo);
      let went: { loading: boolean } | null = null;
      let sent: string | null = null;
      /** #143: its Send data cards handed over past the call's deadline: they go on, the outcome comes later. */
      let handed: HandedOver | null = null;
      /** #143: past the call's deadline with nothing held: it answers now, the page still on its way. */
      let past = false;
      const stepWords = tool === 'navigate' ? `Going to ${barAddress(target)}` : 'Going back';
      // The hold lost meanwhile (a detach, the renderer gone) is never a success (Neon's B5, round 2 of #147).
      // Your own taking over reads as yours, before the hold's loss (Neon's S1, round 3). A card's Allow counts only
      // while the page is the document it was when the card opened (#143, Neon's B4: as an action's, below); a no or
      // no answer stays the user's, whatever the page did meanwhile.
      let allowedNow = false;
      /** Its load started (the gate let it go): from then on it may have gone (lostWhy). */
      let started = false;
      const halt = (opened?: unknown) =>
        call.stopped()
          ? CONTROL_REFUSALS.stopped
          : scope.agent.state(node.id).paused
            ? CONTROL_REFUSALS.paused
            : (takenOver() ?? notHereNow() ?? (page.lost() ? lostWhy(call, node.id, page, started) : allowedNow && opened && page.mark.document !== (opened as typeof page.mark).document ? ACT_REFUSALS.movedOn : null));
      try {
        // Its load never starts once anything would refuse the step (Stop, a pause, your hand, the tab not one it may act
        // in, the hold lost), nor once the step has answered a refusal: dropped at once then (Fable's FB1 on #333).
        const refusing = new AbortController();
        const refuseLoad = () => refusing.abort();
        const abandoned = () => refusing.signal.aborted || halt() !== null;
        const how = { abandoned, signal: refusing.signal, onStart: () => void (started = true) };
        const going = tool === 'navigate' ? page.navigate(target, how) : page.back(back!, how);
        const cards = new OpenCards(scope.agent, node.id);
        const cardsEnd = new AbortController();
        // Its Allows counted where they let requests go (round 2 of #266, blocker 2).
        const counted = countAllows(w);
        const sending = askHeld(
          counted.watch,
          going,
          cards.ask(async (held: { url: string; why: RiskWhy | null }[], sites: string[], why: RiskWhy | null, takeDown: AbortSignal) => {
            const answer = await scope.agent.ask(
              {
                kind: 'step',
                tool,
                // A sentence after the agent's name: *Codex is going to …* (round 2 of #266).
                description: tool === 'navigate' ? `is going to ${barAddress(target)}` : 'is going back',
                target: [page.url()],
                tab: node.id,
                subject: JSON.stringify([node.id, tool, 'sends', randomBytes(4).toString('hex')]),
                step: heldStep(held, sites, why, page.url(), barAddress(goingTo)),
                // Its hand-over settled (#143): the card comes down for the user too.
                takeDown: AbortSignal.any([takeDown, cardsEnd.signal]),
              },
              AbortSignal.any([call.signal, w.cancelled, cardsEnd.signal]),
              // It holds the page's live requests: never longer than an outside agent's card (D2), whoever asks; an
              // outside agent's its full wait (M2g-1, B2; round 1, B-5), past the call's deadline too (#143).
              scope.sendWaitMs ?? scope.cardWaitMs ?? CONTROL_WAIT_MS,
            );
            allowedNow = answer === 'once' || answer === 'always';
            return answer;
          }),
          halt,
          originOf(page.url()),
          () => page.mark,
        );
        // No input to wait for: the load's own requests are what's held.
        const settled = await byDeadline(sending, call.deadline, cards, Promise.resolve(), () => w.held().length);
        if ('later' in settled && settled.later) {
          // What an answer would check first (Neon's should-fix 4): Stop, your hand, the hold lost, a page that can't be
          // read. Any of them: nothing waits, its cards come down, and what it sent is dropped (Opus's N2).
          const no = halt() ?? blockedNow(call, node.id, page, 'That page went somewhere that can’t be read.');
          // Its load not started yet (the session not ready): never handed over as *Going to…* for a load that would come
          // after the step's watch ends (Neon's round 3 of #333, as `past` below).
          if (no || !started) {
            cardsEnd.abort();
            w.deny();
            sent = no ?? ACT_REFUSALS.notReady;
            refuseLoad();
          } else handed = handOver(w, counted.allowed, cards, cardsEnd, stepWords, sending);
        } else if ('past' in settled) {
          // Past the deadline with nothing held: the same checks first (Neon's round 3): never a page that can't be read
          // (a redirect to a Never site still loading), nor Stop, your hand or a lost hold, answered as *Going to…*.
          const no = halt() ?? blockedNow(call, node.id, page, 'That page went somewhere that can’t be read.');
          // Its load not started yet (the session not ready): dropped, and said so, never *Going to…* for a load that
          // would come later, outside the step's watch (Fable's FSF2 on #333).
          if (no ?? !started) {
            sent = no ?? ACT_REFUSALS.notReady;
            refuseLoad();
          } else past = true;
        } else {
          sent = settled.sent;
          // Refused already (Stop, a pause, your hand, a card's no): its load, if it hasn't started, never does, and isn't
          // waited for (Neon's NSF1, round 2 of #333; Fable's FB1).
          if (sent) {
            refuseLoad();
            void going.catch(() => undefined);
          } else went = await going;
        }
        if (handed || past) void going.catch(() => undefined);
      } finally {
        if (!handed) w.end();
      }
      // The page may not have gone yet (what's held can be its own document): under way, and waiting on the user. Never
      // an outline with it (withOutline: `sending`).
      if (handed || past) return { text: toolResult({ tab_id: ref, done: stepWords, loading: true, page_id: page.id, url: page.url(), title: page.title(), ...(handed ? { sending: ACT_SENDS_WAITING } : {}) }) };
      if (sent) return refuse(sent);
      // The hold lost while it loaded (a detach, the renderer gone): never reported done (Neon's B5, round 2 of #147).
      // A load that started may have gone (Opus's S1, #336): said so; one that never did, nothing was done.
      if (page.lost()) return refuse(lostWhy(call, node.id, page, started));
      // It never started: the tab closed; or what would refuse the step says why (Stop, a pause, your hand, the tab not one
      // it may act in: Fable's FSF1); else, for back, the tab's history moved while it waited; else it was dropped
      // (Opus's N4, round 1 of #333; Fable's FN1).
      if (!went) {
        if (nodeOf(call.browser.store.state, node.id)?.kind !== 'tab' || page.gone()) return refuse(CONTROL_REFUSALS.closed);
        // Moved: the entry just before isn't the one checked, by place or address (as page.ts' still()).
        const entry = page.backEntry();
        return refuse(halt() ?? (tool === 'back' && (entry?.index !== back!.index || entry?.url !== goingTo) ? ACT_REFUSALS.backMoved : ACT_REFUSALS.overtaken));
      }
      const { loading } = went;
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      // You took the tab while it loaded: it went, but the agent hears it's yours now.
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      return await done(page.id !== before, loading, tool === 'navigate' ? `Went to ${barAddress(target)}` : 'Went back');
    } finally {
      host.doing(node.id, null);
    }
  }

  const refArg = args['ref'];
  // A part's container ref is read-only (#207): refused by every acting tool, at run time as by its pattern.
  if (typeof refArg === 'string' && BOX_REF.test(refArg)) return refuse(PART_REFUSALS.act);
  // An element, by its ref from the tab's latest snapshot, on the page it's on now.
  const tabRefs = scope.memory.elements?.get(node.id);
  const lookup = tabRefs?.resolve(refArg, page.id) ?? { ok: false as const, why: 'unknown' as const };
  if (!lookup.ok) return refuse(lookup.why === 'unknown' ? ELEMENT_REFUSALS.unknown(String(refArg ?? '')) : ELEMENT_REFUSALS.stale);
  // Never one the agent wasn't shown (#208: rule 1): a collapsed row's, one past the range it read, one a find didn't list.
  if (!tabRefs!.wasShown(refArg, page.id)) return refuse(ELEMENT_REFUSALS.notShown(String(refArg)));
  /**
   * One step in the page on the ref's element (act.ts). A ref whose node the page replaced may be found again there
   * (the owner's bug #2): the result says so.
   */
  let refound = false;
  const refToken = lookup.token;
  const refKey = lookup.key;
  const actOn = async (op: ActOp): Promise<ActAnswer> => {
    const answer = await page.act(owner, refToken, refKey, op);
    if (answer.ok && answer.refound) refound = true;
    return answer;
  };
  const owner = scope.agent.id;
  const key = args['key'];
  const text = args['text'];
  const asked = typeof args['option'] === 'string' ? args['option'].slice(0, 500) : '';
  if (tool === 'press_key' && !isPressKey(key)) return refuse(ACT_REFUSALS.key);
  if (tool === 'type' && (typeof text !== 'string' || text.length > TYPE_TEXT_MAX)) return refuse(ACT_REFUSALS.text);
  if (tool === 'select_option' && !asked) return refuse(ACT_REFUSALS.notSelect);
  // The page and its site, before anything is asked of it: everything after is for this page on this site only.
  const pageAtCheck = page.id;
  const site = host.siteOf(page.url());
  if (!site) return refuse(ACT_REFUSALS.noSite);
  // The element as it is now; for select_option, the choice matched against the page's own options before anything is
  // asked, so the card and the bar show the page's label, never the agent's words.
  // Its first look may find a replaced node again (the owner's bug #2); so may the look after a card, the pointer's move
  // and the hit test, never a later one (the review of #117): once it's checked and pointed at, a replacement refuses.
  // Where this action's time goes (phases.ts): its first look, its cards, its pointing, the debugger's session, the
  // checks to the press, the press or the input, and the page settling after.
  const phases = phaseClock(tool);
  const element = await actOn({ op: 'describe', refind: true, ...(tool === 'select_option' ? { option: asked } : {}) });
  phases.lap('look');
  // Stopped while it was described: nothing after it (round 2 of #145).
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  // A look that failed on a page that crashed: the crash, before any input (#336, Neon's SF1).
  if (!element.ok) return refuse(page.crashed?.() ? crashedWhy(call, node.id, false) : actRefusal(element));
  // A field the page turned into a password, code or card field since the snapshot: never acted on (it'd have no ref now).
  if (element.field && sensitiveField(element.field)) return refuse(ACT_REFUSALS.sensitive);
  if (tool === 'type' && !element.editable) return refuse(ACT_REFUSALS.notEditable);
  // A field that isn't text (a time, a date, a month, a week: #112, the owner's hand test) is set, never typed into,
  // and only to a value in its format. (A color or a range field takes no text: refused above, as not editable.)
  const valueType = tool === 'type' && element.risk?.tag === 'input' && VALUE_TYPES.has(element.risk.type) ? element.risk.type : null;
  if (valueType && !valueFits(valueType, text as string)) return refuse(ACT_REFUSALS.badValue(valueType));
  const value = valueType ? (text as string) : null;
  if (tool === 'select_option' && !element.select) return refuse(ACT_REFUSALS.notSelect);
  if (tool !== 'hover' && element.disabled) return refuse(ACT_REFUSALS.disabled);
  const choice = element.choice ?? '';
  const description: ActDescription = { tool: tool as ElementTool, name: element.name, role: element.role, ...(isPressKey(key) ? { key } : {}), ...(tool === 'select_option' ? { choice } : {}) };
  /**
   * Whether input may go now: never after Stop, never while the user has the tab (their key or click pauses the agent
   * there; the card's wait can be long), never on a page that moved on since the element was checked. Asked right
   * before every input and every text put in, and right after the card.
   */
  /** This action has its own checks (deep) and, in a tab of yours, its own lease: a loss from then on is its own. */
  let holds = false;
  /** Input reached the page (a key, a press: typing's click comes first, a value): a look-alike's refusal after it says it may have worked, and so does a crash (lostWhy). */
  let inputWent = false;
  const halt = (): string | null => {
    if (call.stopped()) return CONTROL_REFUSALS.stopped;
    if (scope.agent.state(node.id).paused) return CONTROL_REFUSALS.paused;
    const taken = takenOver() ?? notHereNow();
    if (taken) return taken;
    // The hold lost (a detach, the renderer gone) since this action got its checks: nothing more goes, and nothing is
    // done (Neon's B5, round 2 of #147). Before then, a loss is an earlier one's: the checks (deep) try again or refuse
    // (round 3 of #147).
    if (holds && page.lost()) return lostWhy(call, node.id, page, inputWent);
    // The page went somewhere: input now would land on another page's element.
    if (page.id !== pageAtCheck) return ELEMENT_REFUSALS.stale;
    return null;
  };
  /**
   * The answer's last word on a page that crashed (#336, Neon's round 2, B1 and SF1; Opus's N-a): whatever the step's
   * checks made of a page whose scripts no longer answer (stale, changed, a timeout), it's the crash, with whether its
   * input had gone in. Never the user's or a policy's own refusal: Stop, a pause, the tab taken or closed, a card's
   * no, sends dropped, the page moved on, the tab no longer one it may act in, a Never site.
   */
  const crashAnswer = (refused: string | null): string | null => {
    if (!refused || !page.crashed?.()) return refused;
    const kept = [CONTROL_REFUSALS.stopped, CONTROL_REFUSALS.paused, CONTROL_REFUSALS.closed, ACT_REFUSALS.takenOver, ACT_REFUSALS.stepDenied, ACT_REFUSALS.sendsDropped, ACT_REFUSALS.sendsTooMany, ACT_REFUSALS.movedOn, NEVER, notHereNow()];
    return kept.includes(refused) ? refused : crashedWhy(call, node.id, inputWent);
  };
  /**
   * Text or a key goes where the focus is: only while it's this element's, and it's no field Chord never types in. The
   * page can still move the focus after this answers (a timer); the guard (see below) stops what would land elsewhere.
   */
  const focusOk = async (mark?: string): Promise<string | null> => {
    // Under the guard, the check marks the element for it (agent-guard.ts): input may reach it and nothing else.
    const now = await actOn({ op: 'focused', ...(mark ? { guard: mark } : {}) });
    if (!now.ok) return actRefusal(now);
    if (now.field && sensitiveField(now.field)) return ACT_REFUSALS.sensitive;
    if (!now.focused) return ACT_REFUSALS.focusMoved;
    return halt();
  };

  // The describe was on this page, on this site: one that went elsewhere meanwhile gets no card (it'd show the first
  // page's words for another site).
  if (page.id !== pageAtCheck || host.siteOf(page.url()) !== site) return refuse(ELEMENT_REFUSALS.stale);
  // The first action on a site asks the user; their answer lasts as long as the agent, or for good.
  // What the user said already: a no (for as long as the agent), a yes for now (the gate keeps it), or for good.
  const remembered = scope.agent.granted('site', site);
  if (remembered === 'deny') return refuse(ACT_REFUSALS.siteDenied(site));
  if (!remembered && !host.siteAllowed(site)) {
    const released = scope.agent.releases(node.id);
    const answer = await scope.agent.ask({ kind: 'site', tool, description: actPhrase(description), target: [page.url()], tab: node.id, subject: site }, call.signal, scope.cardWaitMs);
    if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
    if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.siteDenied(site));
    // The card's wait can be long: Stop, the user taking the tab, the page moving on meanwhile, all stop it here.
    const halted = halt();
    if (halted) return refuse(halted);
    const after = blockedNow(call, node.id, page, 'That tab could not be loaded.');
    if (after) return refuse(after);
    if (!scope.memory.elements?.get(node.id)?.resolve(refArg, page.id).ok) return refuse(ELEMENT_REFUSALS.stale);
    // And on another site now, it'd need its own yes.
    if (host.siteOf(page.url()) !== site) return refuse(ELEMENT_REFUSALS.stale);
    // It runs, on the page and site the card named: the yes is kept now (the agent's life; a fresh Always for good).
    scope.agent.keep('site', site, answer);
    if (answer === 'always') host.keepSite(site);
  }

  // The step (S18 M2d): what it is, from the page as it is now (core's classifyStep), never from the agent's words. A
  // risky one asks every time (the step card); an `act` one goes, and if it sends data after all (a page's own script),
  // what it sends is held and the card asks then (control/sends.ts). No description from the page: as a form's submit.
  // A late Allow is for this very step: its tab, page, ref, action, and for type what it types (#112 review 1).
  const typed = tool === 'type' && typeof text === 'string' ? createHash('sha256').update(`${args['replace'] !== false}|${text}`).digest('hex').slice(0, 16) : '';
  // Typing in a chat that read anything but this tab (M2e-2c, B3; the owner's answer 6): the text shown first, every time.
  if (tool === 'type' && typeof text === 'string' && host.typeAsks?.(node, page.url())) {
    const released = scope.agent.releases(node.id);
    const answer = await scope.agent.ask(
      {
        kind: 'step',
        tool,
        description: actPhrase(description),
        target: [page.url()],
        tab: node.id,
        subject: JSON.stringify([node.id, page.id, String(refArg), 'taint', createHash('sha256').update(text).digest('hex').slice(0, 16)]),
        // Every character it will type (at most TYPE_TEXT_MAX, checked above): nothing typed that the card didn't show
        // (Neon's B2 on #151).
        step: { why: 'confirm', site, fields: [], more: 0, typed: text, taint: true },
        show: () => void actOn({ op: 'point', highlight: true }),
      },
      call.signal,
      scope.cardWaitMs,
    );
    if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
    if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.stepDenied);
    const halted = halt();
    if (halted) return refuse(halted);
    // As after the site card (Neon's SF4 on #151): the page as it is now, the element still the one, the same site.
    const after = blockedNow(call, node.id, page, 'That tab could not be loaded.');
    if (after) return refuse(after);
    if (!scope.memory.elements?.get(node.id)?.resolve(refArg, page.id).ok) return refuse(ELEMENT_REFUSALS.stale);
    if (host.siteOf(page.url()) !== site) return refuse(ELEMENT_REFUSALS.stale);
  }
  const step: RiskClass = stepOf(tool, args, element);
  // And what the card showed (Neon's review of #112): why it asks, and the element's shape (its link, its form's
  // address, method and fields). Any of it changed, it's another step: a late Allow never covers it.
  const shown = createHash('sha256').update(`${step.class === 'risky' ? step.why : 'act'}|${stepShape(element)}`).digest('hex').slice(0, 16);
  // As JSON (Neon's review of M2g-1, B4): no value can run into the next.
  const stepKey = JSON.stringify([node.id, page.id, String(refArg), tool, isPressKey(key) ? key : '', args['submit'] === true, typed, shown]);
  if (step.class === 'risky') {
    // Only what the submit sends (the owner's test of 982ce10): the risk checks above still see every field.
    const { fields, more } = stepFields(sentLabels(element.risk?.form?.fields ?? []));
    const released = scope.agent.releases(node.id);
    const answer = await scope.agent.ask(
      {
        kind: 'step',
        tool,
        description: actPhrase(description),
        target: [page.url()],
        tab: node.id,
        subject: stepKey,
        step: { why: step.why, site, fields, more, ...(element.risk?.text ? { shows: element.risk.text } : {}), ...(tool === 'type' && typeof text === 'string' ? { typed: text } : {}), ...targetOf(element, site, host.siteOf) },
        // Show me: the element outlined in its page, the card still up (the service shows the tab in the window).
        show: () => void actOn({ op: 'point', highlight: true }),
      },
      call.signal,
      scope.cardWaitMs,
    );
    if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
    if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.stepDenied);
    // As after the site card: Stop, the user taking the tab, the page moving on or to another site, all stop it here.
    const halted = halt();
    if (halted) return refuse(halted);
    const after = blockedNow(call, node.id, page, 'That tab could not be loaded.');
    if (after) return refuse(after);
    if (!scope.memory.elements?.get(node.id)?.resolve(refArg, page.id).ok) return refuse(ELEMENT_REFUSALS.stale);
    if (host.siteOf(page.url()) !== site) return refuse(ELEMENT_REFUSALS.stale);
    // What the card showed is what goes (#112 review 1): described again, the same step, the same name, the same form
    // (where it goes, how, and its fields). A page that changed any of it while the card was up gets nothing.
    const now = await actOn({ op: 'describe', refind: true, ...(tool === 'select_option' ? { option: asked } : {}) });
    if (!now.ok) return refuse(page.crashed?.() ? crashedWhy(call, node.id, false) : actRefusal(now));
    if (now.field && sensitiveField(now.field)) return refuse(ACT_REFUSALS.sensitive);
    const stepNow = stepOf(tool, args, now);
    if (now.name !== element.name || stepNow.class !== 'risky' || stepNow.why !== step.why || stepShape(now) !== stepShape(element)) return refuse(ACT_REFUSALS.stepChanged);
  }

  /**
   * The step as it is right before its input (Neon's review of #112): after the pointer moved (a page's mouseenter can
   * change a link, a form's address or its fields) and after any card. Not the step that was checked (named the same,
   * shaped the same, no riskier, and for a risky one the same why): nothing goes in.
   */
  const stepNow = async (): Promise<{ refused: string; why?: string } | null> => {
    const now = await actOn({ op: 'describe', ...(tool === 'select_option' ? { option: asked } : {}) });
    // Its why too: a node replaced since (`replaced`) is tried again from the pointer's move (below).
    if (!now.ok) return { refused: actRefusal(now), why: now.why };
    if (now.field && sensitiveField(now.field)) return { refused: ACT_REFUSALS.sensitive };
    if (now.name !== element.name || stepShape(now) !== stepShape(element)) return { refused: ACT_REFUSALS.stepChanged };
    const again = stepOf(tool, args, now);
    if (step.class === 'act' ? again.class !== 'act' : again.class !== 'risky' || again.why !== step.why) return { refused: ACT_REFUSALS.stepChanged };
    return null;
  };
  const sameStep = async (): Promise<string | null> => (await stepNow())?.refused ?? null;

  // It runs: a late Allow given on this tab for another step is spent (Neon's review of M2g-1, B1).
  scope.agent.dropLateSteps(node.id);
  phases.lap('cards');
  host.doing(node.id, description);
  /** The debugger's checks, for what presses or types (deep.ts): opened right before, let go once the page settled. */
  let deep: DeepSession | null = null;
  /** What the action sends, held (sends.ts): watched from before its input until a moment after it. */
  let watch: SendWatch | null = null;
  /** What the page sent after the agent's last action here, dropped: its result says so. */
  const droppedBefore = page.droppedAfter();
  /** #143: its Send data cards, handed over past the call's deadline (byDeadline, HandedOver). */
  let handed: HandedOver | null = null;
  /** #143: past the call's deadline with no card up and nothing held: it answers now (byDeadline's `past`). */
  let past = false;
  try {
    let refused: string | null = null;
    /** The guard's mark while it's up (agent-guard.ts): an event name only main knows. */
    let guardMark = '';
    /**
     * Enter in a one-line field whose keydown handler took the focus elsewhere (a game takes the bet on Enter's keydown,
     * then focuses its table: the owner's retest of #117): the keydown did its work, so it's done, and the result says
     * the page moved the focus. Refused, the agent would press again: a second bet.
     */
    let enterMovedFocus = false;
    /** The key going in is Enter in a one-line field (see enterMovedFocus). */
    let enterOneLine = false;
    /**
     * The last guarded input was refused as the focus moved, and nothing of it reached the page: the focus went before
     * the input, or the guard stopped all of it (the review of #117, round 6: a game that takes the focus to its table
     * on a timer, on a slow machine). Then it's tried again, the element focused again (guardedTries).
     */
    let nothingWent = false;
    /**
     * A keydown sent that the page's guard hadn't seen by KEY_SEEN_MS: late, maybe still coming. Then nothing is ever
     * tried again, as it could land twice (Claude's review 5 of #117).
     */
    let keyUnseen = false;
    /**
     * Under the guard, before each input: the focus the element's (in this document, so not in a frame; the check marks
     * it for the guard, which takes no input until then), its insides all to be seen (no closed shadow root), the
     * file picker hold, Stop and a pause.
     */
    const stillOk = async (): Promise<string | null> => {
      // The tab's file picker hold, still on (it can be lost between steps: the debugger let go).
      if (!deep!.held()) return ACT_REFUSALS.noCheck;
      const focus = await focusOk(guardMark);
      if (focus) return focus;
      const open = await deep!.open();
      if (!open.ok) return deepRefusal(open);
      return halt();
    };
    /**
     * Text or keys in, with the page preload's guard up (the window's first listener; every frame's too), armed with a
     * mark only main knows: it takes no input until stillOk's focus check marks the element, then only for it. `input`
     * sends, and may check again between its events (a key's keydown, then its character); it says why it stopped, if
     * it did. A key or an insertion the page would get anywhere else is stopped there, and the action ends. The guard
     * always comes down.
     */
    const guarded = async (until: 'keyup' | 'beforeinput', input: () => Promise<string | null>, typesNothing = false): Promise<boolean> => {
      guardMark = `chord-guard-${randomBytes(16).toString('hex')}`;
      if (!(await page.guard(until, guardMark))) {
        await page.unguard();
        refused = ACT_REFUSALS.changed;
        return false;
      }
      // Where the page's documents are, right before this input (not before a card: a navigation started and dropped
      // while the card was up never counts as this input's).
      const markAtInput = page.mark;
      let failed: string | null;
      let inputBegan = false;
      // Fresh for this input: what a try before it found never counts (Neon's B2 of round 5).
      nothingWent = false;
      keyUnseen = false;
      enterMovedFocus = false;
      enterOneLine = false;
      try {
        failed = (await stillOk()) ?? ((inputBegan = true), await input());
      } catch {
        // The input itself failed (the page went mid-way): nothing more goes in.
        failed = ACT_REFUSALS.changed;
      }
      // Always down: the input's events are on their way (each its own message), and unguard waits for the last one
      // (none sent: no wait).
      const down = await page.unguard(inputBegan ? undefined : 0);
      if (failed) {
        refused = failed;
        // Nothing reached the page, for sure: nothing was sent, or all of it was seen by the guard, stopped (none went
        // through) and none of it is still on its way (lost: the input's last event never came; a keydown unseen).
        // Or nothing was sent at all, and the element was replaced before it (a page that redraws: the table on Wayland):
        // found again and checked again by the retry (refocus), as for the focus taken.
        nothingWent =
          (failed === ACT_REFUSALS.focusMoved && (!inputBegan || (typeof down === 'object' && down.moved && down.passed === 0 && !down.lost && !keyUnseen))) ||
          (redrawn(failed) && !inputBegan);
        return false;
      }
      // Another document (a submit's Enter, or Enter on a link, navigated the page): its focus went with it, and that's
      // done (no guard there, or the script asked went with the old one). A guard that ran out in the same document,
      // or the same document not answering: a no.
      if (down === 'gone' || down === 'timeout' || down === 'expired') {
        // Done only if the page committed another document since (no guard there, or the script asked went with the
        // old one); else a no. A navigation that started and never committed (a 204, a download) doesn't count, nor
        // does one to an error page (an unreachable server fires no did-navigate): a submit that lands there reads as
        // the focus moved. That fails closed, and the agent's snapshot shows the error page.
        if (await page.committedSince(markAtInput, 2000)) return true;
        refused = ACT_REFUSALS.focusLost;
        return false;
      }
      // Something stopped. Enter in a one-line field whose keydown went through, the rest stopped (the page took the focus
      // after the check: the review of #117, round 5): the keydown did its work, nothing was typed; done, said so.
      // Anything else stopped: a no.
      // Enter that moved the focus is done only when its keydown went through (Neon's B2 of round 5): else as anything.
      if (!down.keydownPassed) enterMovedFocus = false;
      if (down.moved && enterOneLine && down.keydownPassed) enterMovedFocus = true;
      else if (down.moved) {
        refused = ACT_REFUSALS.focusMoved;
        nothingWent = down.passed === 0 && !down.lost && !keyUnseen;
      }
      // A key that types nothing (Tab, an arrow, Escape) may take the focus anywhere, a frame too: its keyup there is
      // that, not text gone astray. So may Enter's keydown in a one-line field (its keyup's all that went after).
      else if (down.lost && !typesNothing && !enterMovedFocus) refused = ACT_REFUSALS.focusLost;
      return !refused;
    };
    /**
     * The step checked right before input that isn't a press (a key, a choice, a value), after `first` (the focus, for a
     * key). A node the page replaced on the way (a re-render) is looked for again from the pointer's move and checked
     * again, at most PRESS_TRIES times, as a press is (the review of #117, round 3); never once input went in.
     */
    const readyAgain = async (first?: () => Promise<ActAnswer>, tries = PRESS_TRIES): Promise<string | null> => {
      for (let attempt = 1; ; attempt++) {
        const halted = halt();
        if (halted) return halted;
        if (attempt > 1) {
          const repointed = await actOn({ op: 'point', highlight: false });
          if (!repointed.ok) return actRefusal(repointed);
          if (repointed.field && sensitiveField(repointed.field)) return ACT_REFUSALS.sensitive;
        }
        if (first) {
          const did = await first();
          if (!did.ok) {
            if (did.why === 'replaced' && attempt < tries) continue;
            return actRefusal(did);
          }
        }
        const changed = await stepNow();
        // Stop, the user taking the tab, the page gone on while the step was checked: nothing goes in (Neon, round 4).
        if (!changed) return halt();
        if (changed.why === 'replaced' && attempt < tries) continue;
        return changed.refused;
      }
    };
    /**
     * Input under the guard, tried again when nothing of it reached the page because the page took the focus first
     * (nothingWent): `again` focuses the element again and checks the step, and it goes once more, at most PRESS_TRIES
     * times. Anything that reached the page, or any other no, is never tried again.
     */
    const guardedTries = async (until: 'keyup' | 'beforeinput', input: () => Promise<string | null>, again: () => Promise<string | null>, typesNothing = false): Promise<boolean> => {
      for (let attempt = 1; ; attempt++) {
        if (await guarded(until, input, typesNothing)) return true;
        if (!nothingWent || attempt >= PRESS_TRIES) return false;
        const back = await again();
        if (back) {
          refused = back;
          return false;
        }
        refused = null;
      }
    };
    /**
     * The element focused again, and the step checked again (guardedTries): its own tries kept to RETRY_CHECKS, so a
     * key's tries and their checks stay at most PRESS_TRIES × RETRY_CHECKS steps (Claude's N3 of round 5).
     */
    const refocus = () => readyAgain(() => actOn({ op: 'focus' }), RETRY_CHECKS);
    /** After text or a value went in: this field changed, or now holds the text; and no other field changed. */
    const typedWhere = async (): Promise<string | null> => {
      const after = await actOn({ op: 'values', mode: 'compare', text: value ?? (text as string) });
      if (!after.ok) return after.why === 'no-values' ? ACT_REFUSALS.notTyped : actRefusal(after);
      if ((after.others ?? 0) > 0) return ACT_REFUSALS.typedElsewhere;
      // Text added to what's there (replace: false) must have changed the field: holding the text already proves nothing.
      if (!after.changed && (args['replace'] === false || !after.has)) return ACT_REFUSALS.notTyped;
      return null;
    };
    /**
     * A key. One that types a character into a field (Enter, Space in a text field): its keydown, then (the page's
     * keydown handlers have run) everything checked again, then the rest of it. Any other key goes in at once: its own
     * keydown may move the focus (Tab, an arrow in a radio group) or go somewhere (Enter on a link), and that's the key
     * working, not the page in its way.
     */
    const typesInto = (pressed: PressKey) => element.editable === true && (pressKeyEvents(pressed) as AgentInputEvent[]).some((e) => e.type === 'char');
    const pressKey = (pressed: PressKey) => async (): Promise<string | null> => {
      const [down, ...rest] = pressKeyEvents(pressed) as AgentInputEvent[];
      if (!typesInto(pressed)) {
        // No character at all (Tab, an arrow): in at once.
        if (!rest.some((e) => e.type === 'char')) {
          inputWent = true;
          page.keys([down!, ...rest]);
          return null;
        }
        // A character, on something that isn't a field (Enter or Space on a button or a link): its keydown, then, if
        // the focus is no longer the element's or a closed root came in (Neon's review 7 of #110), no character, only
        // the key let go of. The keydown did what it does (a link went, a menu opened): that's done.
        const documentAtKey = page.mark.document;
        inputWent = true;
        page.keys([down!]);
        // Its keydown handled first (its handlers have run), then the check: never the check before it.
        if (!(await page.keySeen(1, KEY_SEEN_MS))) keyUnseen = true;
        const again = await stillOk();
        // A menu that moves the focus on its keydown loses Enter's click (the character): harmless, the agent sees the
        // menu open and goes on from there.
        page.keys(again ? rest.filter((e) => e.type === 'keyUp') : rest);
        // The element itself gone, in the same document (a page that redraws it: the table on a slow runner, #117): a
        // button's click comes with the character, so the key may have done nothing. Never said done; never tried again
        // either (its keydown reached the page).
        if (redrawn(again) && page.mark.document === documentAtKey) return KEY_REDRAWN;
        // The hold lost, Stop, or the user taking the tab meanwhile: a no, not done (Neon's review 4), asked of each
        // directly. The focus gone elsewhere, or the page gone on (Enter on a link: its element's checks fail as its
        // document goes): the keydown did its work.
        if (!deep!.held()) return ACT_REFUSALS.noCheck;
        if (call.stopped()) return CONTROL_REFUSALS.stopped;
        if (scope.agent.state(node.id).paused) return CONTROL_REFUSALS.paused;
        return null;
      }
      enterOneLine = pressed === 'Enter' && element.risk?.multiline === false;
      inputWent = true;
      page.keys([down!]);
      // Its keydown handled first (its handlers have run), then the check: never the check before it.
      if (!(await page.keySeen(1, KEY_SEEN_MS))) keyUnseen = true;
      const again = await stillOk();
      // Never the character: the key's let go of, nothing typed.
      if (again) {
        page.keys(rest.filter((e) => e.type === 'keyUp'));
        // Enter in a one-line field, the focus taken elsewhere by its keydown (a game's bet): that's done, as on a button
        // (above), and said so. In a field that takes more lines, or any key that types text, still a no.
        if (pressed === 'Enter' && again === ACT_REFUSALS.focusMoved && element.risk?.multiline === false) {
          if (!deep!.held()) return ACT_REFUSALS.noCheck;
          if (call.stopped()) return CONTROL_REFUSALS.stopped;
          if (scope.agent.state(node.id).paused) return CONTROL_REFUSALS.paused;
          enterMovedFocus = true;
          return null;
        }
        return again;
      }
      page.keys(rest);
      return null;
    };
    /** The card for what an action's page held: its sites, or the step a document's address is (askHeld). */
    const askSendCard = (held: { url: string; why: RiskWhy | null }[], sites: string[], why: RiskWhy | null, w: SendWatch, takeDown: AbortSignal, ended: AbortSignal) =>
      scope.agent.ask(
        {
          kind: 'step',
          tool,
          // What it did (it's done: what it sent waits): `Clicked “Mark as read”`.
          description: actDone(description),
          target: [page.url()],
          tab: node.id,
          // Never late: what was held is dropped when no one answers, so a late Allow would have nothing to send.
          // Subjects as JSON (N-5): no value runs into the next.
          subject: JSON.stringify([stepKey, 'sends', randomBytes(4).toString('hex')]),
          // Exact origins (the owner, 2026-11-23), each by its host, its scheme too where it isn't https or isn't the page's.
          step: heldStep(held, sites, why, page.url()),
          show: () => void actOn({ op: 'point', highlight: true }),
          // Its hand-over settled (#143): the card comes down for the user too, not only for this ask.
          takeDown: AbortSignal.any([takeDown, ended]),
        },
        // `ended`: its hand-over settled (#143: the page moved on, the tab closed): the card comes down.
        AbortSignal.any([call.signal, w.cancelled, ended]),
        // It holds the page's live requests: never longer than an outside agent's card (D2), whoever asks; an outside
        // agent's its full wait, never a call's budget for cards (M2g-1, B2), past the call's deadline too (#143).
        scope.sendWaitMs ?? scope.cardWaitMs ?? CONTROL_WAIT_MS,
      );
    /** Once the watch is on: what's held from then is asked about (below). */
    let watchOn: () => void = () => undefined;
    const watching = new Promise<void>((done) => (watchOn = done));
    /** The page's document when the action began: a send card's Allow counts only while it's still this one. */
    const markAtStart = page.mark;
    /** #143: the step's input done (or the step over): never a hand-over before, whose own refusal could follow. */
    let inputOver: () => void = () => undefined;
    const inputDone = new Promise<void>((over) => (inputOver = over));
    const acting = page.afterActing(async () => {
      const pointed = await actOn({ op: 'point', highlight: true });
      phases.lap('point');
      if (!pointed.ok || pointed.x === undefined || pointed.y === undefined) return void (refused = pointed.ok ? ACT_REFUSALS.changed : actRefusal(pointed));
      // The field as it is now, after any card's wait: never one the page made a password, code or card field.
      if (pointed.field && sensitiveField(pointed.field)) return void (refused = ACT_REFUSALS.sensitive);
      if ((refused = halt())) return;
      // From here input goes in: the debugger's checks (deep.ts), and the watch on what it sends (sends.ts): for an
      // `act` step anything that sends data is held for the card; a step the user allowed sends as it does. Reports
      // (beacons, pings) are dropped either way.
      if ((refused = await leaseOn())) return;
      deep = await page.deep(owner, lookup.token, lookup.key);
      phases.lap('debugger');
      if (!deep) return void (refused = ACT_REFUSALS.noCheck);
      holds = true;
      watch = page.watchSends(step.class === 'risky' ? allowedBy(element, stepSubmits(tool, args, element)) : null);
      if (!watch) return void (refused = ACT_REFUSALS.noCheck);
      watchOn();
      if ((refused = halt())) return;
      // Marked before each input (#336, Neon's NB2): a crash as it goes in may have taken it.
      if (tool === 'hover') {
        inputWent = true;
        return void page.pointer(pointed.x, pointed.y);
      }
      if (tool === 'select_option') {
        if ((refused = await readyAgain())) return;
        if (!deep.held()) return void (refused = ACT_REFUSALS.noCheck);
        // By the page's whole label, as describe matched it (the card showed it clipped).
        inputWent = true;
        const chosen = await actOn({ op: 'choose', option: asked });
        if (!chosen.ok) refused = actRefusal(chosen);
        return;
      }
      if (tool === 'press_key') {
        if ((refused = await refocus())) return;
        return void (await guardedTries('keyup', pressKey(key as PressKey), refocus, !typesInto(key as PressKey)));
      }
      // A field that isn't text: set to its value, never clicked (its own picker would open) nor typed into; what else
      // changed in the page meanwhile is checked as for text.
      if (valueType) {
        if ((refused = await readyAgain())) return;
        // Every field's value, as it is now (a no: the element's gone, and nothing goes in).
        const remembered = await actOn({ op: 'values', mode: 'remember' });
        if (!remembered.ok) return void (refused = actRefusal(remembered));
        if ((refused = halt())) return;
        if (!deep.held()) return void (refused = ACT_REFUSALS.noCheck);
        inputWent = true;
        const set = await actOn({ op: 'setValue', value: value as string });
        if (!set.ok) return void (refused = set.why === 'bad-value' ? ACT_REFUSALS.badValue(valueType) : actRefusal(set));
        if ((refused = await typedWhere())) return;
        if (args['submit'] !== true) return;
        if ((refused = await sameStep())) return;
        const focused = await actOn({ op: 'focus' });
        if (!focused.ok) return void (refused = actRefusal(focused));
        return void (await guardedTries('keyup', pressKey('Enter'), refocus));
      }
      // The pointer there, then a last hit test right before the button goes down, once the page has seen the move (its
      // mouseenter handlers have run): an overlay or a frame put over the point meanwhile gets no press. The page's
      // own test first, then the debugger's, which sees into closed shadow roots. It narrows the race; it can't close
      // it (the page runs between the test and the press too). A page that re-renders (the owner's retest of #117: a
      // game's controls rebuilt every frame) may replace the element anywhere on the way: then it starts over from the
      // pointer's move (which looks for it again), at most PRESS_TRIES times, never once anything's pressed.
      // Typing watches for its click (the page preload's guard counts presses), from before the press's checks: the
      // last check stays right before the press, nothing awaited between (Neon's B3 of round 5).
      const pressMark = tool === 'type' ? await page.watchPress() : null;
      let at = pointed;
      for (let attempt = 1; ; attempt++) {
        const again = (why: string | undefined) => why === 'replaced' && attempt < PRESS_TRIES;
        // Stop, the user taking the tab, the page gone on: never another try, nor another move of the pointer.
        if ((refused = halt())) return;
        if (attempt > 1) {
          const repointed = await actOn({ op: 'point', highlight: false });
          if (!repointed.ok || repointed.x === undefined || repointed.y === undefined) return void (refused = repointed.ok ? ACT_REFUSALS.changed : actRefusal(repointed));
          if (repointed.field && sensitiveField(repointed.field)) return void (refused = ACT_REFUSALS.sensitive);
          at = repointed;
        }
        const x = at.x!;
        const y = at.y!;
        if ((refused = halt())) return;
        page.pointer(x, y);
        let hit = await actOn({ op: 'hit', x, y });
        // The move to the point not seen as the page's last: the pointer was there already (a second click at the point:
        // no move was sent), or another move came after it (Windows sends the real cursor's move when a window changes
        // under it: CI's Windows x64, #112), and the page only keeps the last. One off and back, and the page must see
        // both, as any click's move (its mouseenter and mousemove handlers run before the test). A page that swallows
        // moves still sees neither: no press.
        if (!hit.ok && hit.why === 'no-move') {
          const off = { x: x + 3, y };
          if ((refused = halt())) return;
          page.pointer(off.x, off.y);
          const seen = await actOn({ op: 'hit', ...off, onlyMove: true });
          if (!seen.ok) {
            if (again(seen.why)) continue;
            return void (refused = actRefusal(seen));
          }
          if ((refused = halt())) return;
          page.pointer(x, y);
          hit = await actOn({ op: 'hit', x, y });
        }
        if (!hit.ok) {
          if (again(hit.why)) continue;
          return void (refused = actRefusal(hit));
        }
        const under = await deep.hit(x + (hit.scrollX ?? 0), y + (hit.scrollY ?? 0));
        if (!under.ok) {
          if (again(under.why)) continue;
          return void (refused = deepRefusal(under));
        }
        // Nothing in it hidden in a closed shadow root (the hit test can't see past one to say what's clicked: #112).
        const open = await deep.open();
        if (!open.ok) {
          if (again(open.why)) continue;
          return void (refused = deepRefusal(open));
        }
        const changed = await stepNow();
        if (changed) {
          if (again(changed.why)) continue;
          return void (refused = changed.refused);
        }
        break;
      }
      if ((refused = halt())) return;
      if (!deep.held()) return void (refused = ACT_REFUSALS.noCheck);
      phases.lap('checks');
      inputWent = true;
      page.press(at.x!, at.y!);
      if (tool !== 'type') return;
      // Typing waits for the page to have seen its click (the caret goes where the click put it): only then the select
      // and the text (round 5: under load, 30 typed over 20 made 2030). Not seen: nothing typed.
      if (pressMark === null || !(await page.pressSeen(pressMark, PRESS_SEEN_MS))) return void (refused = ACT_REFUSALS.changed);
      if ((refused = halt())) return;
      if (args['replace'] !== false) {
        const selected = await actOn({ op: 'select' });
        if (!selected.ok) return void (refused = actRefusal(selected));
      }
      const typed = await guardedTries(
        'beforeinput',
        async () => {
          // Every field's value remembered first (in the page), to check where the text went; a no (the element's gone):
          // nothing goes in (the review of #117).
          const remembered = await actOn({ op: 'values', mode: 'remember' });
          if (!remembered.ok) return actRefusal(remembered);
          await page.insertText(text as string);
          return null;
        },
        // Focused and selected again by the select op (Neon's nit 3 of round 5). Text added to what's there is never
        // tried again: the caret could be elsewhere now (Claude's N2).
        async () => (args['replace'] === false ? ACT_REFUSALS.focusMoved : readyAgain(() => actOn({ op: 'select' }), RETRY_CHECKS)),
      );
      if (!typed) return;
      // Where it went: this field changed (or holds the text), and no other did (#112: text that lands in the field
      // that had the focus before is never *done*).
      if ((refused = await typedWhere())) return;
      if (args['submit'] !== true) return;
      // The step again right before Enter (Neon's review 2 of #112): what typing did to the page counts.
      if ((refused = await sameStep())) return;
      await guardedTries('keyup', pressKey('Enter'), refocus);
    },
    // Its input done (phases.ts).
    () => {
      phases.lap('input');
      inputOver();
    });
    void acting.then(inputOver, inputOver);
    // The action sent data after all (an `act` step: a page's own script, a toggle that saves): held, and a card asks
    // for it, naming its sites, before the action is done (it waits on what's held): askHeld.
    if ((await Promise.race([acting.then(() => 'acted' as const), watching.then(() => 'on' as const)])) === 'on' && watch) {
      const w = watch as SendWatch;
      // Allow lets go only if Stop, your taking the tab, or another document since the input (never the action's own
      // pushState, Neon's S16) haven't come between.
      // Its document as it was when the card opened, not when the action began (Claude's final pass: a page the action
      // went to that posts as it loads gets its Allow).
      const sendHalt = (opened: unknown) =>
        call.stopped()
          ? CONTROL_REFUSALS.stopped
          : scope.agent.state(node.id).paused
            ? CONTROL_REFUSALS.paused
            : (takenOver() ?? notHereNow() ?? (page.lost() ? ACT_REFUSALS.noCheck : page.mark.document !== (opened as typeof markAtStart).document ? ELEMENT_REFUSALS.stale : null));
      const cards = new OpenCards(scope.agent, node.id);
      const cardsEnd = new AbortController();
      // Its Allows counted where they let requests go (round 2 of #266, blocker 2).
      const counted = countAllows(w);
      const sending = askHeld(
        counted.watch,
        acting,
        cards.ask((held: { url: string; why: RiskWhy | null }[], sites: string[], why: RiskWhy | null, takeDown: AbortSignal) => askSendCard(held, sites, why, w, takeDown, cardsEnd.signal)),
        sendHalt,
        originOf(page.url()),
        () => page.mark,
      );
      const settled = await byDeadline(sending, call.deadline, cards, inputDone, () => w.held().length);
      if ('past' in settled) past = true;
      else if (!settled.later) refused ??= settled.sent;
      else if (refused || call.stopped()) {
        // The step's own refusal after its input, or Stop: nothing waits on the user, its cards come down and what it
        // sent is dropped (Neon's B3).
        cardsEnd.abort();
        w.deny();
        refused ??= CONTROL_REFUSALS.stopped;
      } else handed = handOver(w, counted.allowed, cards, cardsEnd, actDone(description), sending);
    }
    // The hold lost during the action (a detach, the renderer gone): what it sent wasn't asked about, so never done
    // (Neon's B5, round 2 of #147).
    if (!refused && holds && page.lost()) refused = lostWhy(call, node.id, page, inputWent);
    // Any "couldn't check" on a page that crashed meanwhile is said as the crash (#336, Neon's NB1: render-process-gone
    // cancels the watch, and the checks answer noCheck before lostWhy would): with whether input had gone in.
    if (refused === ACT_REFUSALS.noCheck) refused = lostWhy(call, node.id, page, inputWent);
    if (handed || past) {
      // The deadline holds (Neon's B3, Opus's S4, should-fix 6): never the 10 s wait for the page to load after the step,
      // nor its diff. Past it with nothing held: the watch ends now (finally), and what the page sends after is the
      // tab's, asked between actions.
      void acting.catch(() => undefined);
      phases.lap('settle');
      if (refused) {
        handed?.withdraw();
        return refuse(crashAnswer(refused)!);
      }
      if (call.stopped()) {
        handed?.withdraw();
        return refuse(CONTROL_REFUSALS.stopped);
      }
      const answer = await done(page.mark.document !== markAtStart.document, true, actDone(description), droppedBefore, refound, enterMovedFocus, true, handed !== null);
      // Refused after all (the page went where it can't be read): nothing waits, no armed card behind an error.
      if (answer.isError) handed?.withdraw();
      return answer;
    }
    const { navigated, loading } = await acting;
    phases.lap('settle');
    if (deep) await (deep as DeepSession).close();
    // A look-alike's refusal once input had gone in: it may have worked, never "nothing was done" (#211's round 2).
    if ((refused === ACT_REFUSALS.ambiguous || refused === ACT_REFUSALS.rowChanged || refused === ACT_REFUSALS.rowEmpty) && inputWent) refused = INPUT_REDRAWN;
    // After the action's own end (`await acting` can set its refusal again: Neon's B1): one last word on a crash.
    refused = crashAnswer(refused);
    if (refused) return refuse(refused);
    if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
    return await done(navigated, loading, actDone(description), droppedBefore, refound, enterMovedFocus);
  } finally {
    // What its page still sends from now is the tab's: held, and asked about between actions (sends.ts). Unless its
    // cards were handed over (#143): their settle ends the watch.
    if (!handed) (watch as SendWatch | null)?.end();
    if (deep) await (deep as DeepSession).close();
    host.doing(node.id, null);
  }
}
