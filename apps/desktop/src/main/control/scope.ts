/**
 * What a front door gives the control layer (S18 M1a): who the agent is (its
 * gate), the tabs it can see, its refs for them, and its rules for reading.
 * The assistant's is assistant/scope.ts (a chat's scope, its attached tabs and
 * readNeedsApproval); outside agents' comes in M1's later slices (their Agent
 * chord and the tabs shared with them).
 */
import type { ApprovalKind, AssistantFillCard, AssistantFormRead, AssistantToolName, BarDoing, ElementRefs, NodeId, TabNode, TabRefs } from '@chord/core';
import type { ControlAgent } from './gate';

/** A tool's answer to the model. */
export interface ToolOutput {
  text?: string;
  /** Screenshots, for providers that take images through their CLI. */
  image?: { data: string; mimeType: string; width?: number; height?: number };
  isError?: boolean;
}

/** A PDF read for an agent: later ranges reuse it, and the assistant's citations find their page in it. */
export interface PdfRead {
  url: string;
  pages: string[];
  totalPages: number;
  text: string;
}

/** What an agent's tools remember between calls. */
export interface ToolMemory {
  /** PDFs read, per tab, oldest first. */
  pdfs: Map<NodeId, PdfRead>;
  /** The last form read (read_form): its fields by Chord's ids, and the page's token for that read. */
  form: { nodeId: NodeId; token: string; read: AssistantFormRead } | null;
  /** Chord's next field id: ids never repeat, so one from an earlier read is caught, not taken for another field. */
  nextField: number;
  /** Tabs it read: the assistant shows a badge on them in the sidebar. */
  read: Set<NodeId>;
  /** Each tab's element refs (snapshot, M2b): only the latest snapshot's are good. Made with a tab's first snapshot. */
  elements?: Map<NodeId, ElementRefs>;
}

/**
 * Acting on pages (S18 M2c): what a front door that lets its agent act gives the tools. Outside agents' scope has it;
 * the assistant's gets it in M2e. Absent, the acting tools are unknown.
 */
export interface ActHost {
  /** Why this tab can't be acted on (a tab shared with it is read-only), or null. */
  mayAct(node: TabNode): string | null;
  /** The site an address is on (its registrable domain, as sharing's), or null for what isn't a web page. */
  siteOf(url: string): string | null;
  /** The user said *Always on this site* for good (the agent's allowance), so it acts there without asking. */
  siteAllowed(site: string): boolean;
  /** *Always on this site* was answered: keep it with the agent's allowance. */
  keepSite(site: string): void;
  /** What the bar says the agent is doing on the tab (core's barDoing), or null when it's done. */
  doing(nodeId: NodeId, doing: BarDoing | null): void;
}

/** propose_fill's card, which only a front door with a place to show it offers. */
export interface FillProposals {
  /** Why no card can be shown now (one was this turn already), or null. */
  refuse(): string | null;
  show(node: TabNode, card: AssistantFillCard, form: NonNullable<ToolMemory['form']>): Promise<void>;
}

export interface ControlScope {
  /** The agent's gate: its states, grants, cards and Stop. */
  readonly agent: ControlAgent;
  /** M2's tools (core's ACTION_TOOLS: snapshot, then acting) are offered here: a build that has them (agentActions). */
  readonly actions?: boolean;
  readonly refs: TabRefs<NodeId>;
  readonly memory: ToolMemory;
  /** Every tool refused, and why (the assistant reading nothing), or null. */
  off(): string | null;
  /** The tabs it can see (list_tabs), and whether each was given to it (attached, shared). */
  tabs(): { node: TabNode; given: boolean }[];
  /** read_selection's tab when none is named. */
  defaultTab(): TabNode | null;
  /** A tab may be read at all: never a private window, a Chord page or a *Never* site. */
  readable(node: TabNode): boolean;
  /**
   * Whether the tab may be read at this address too (a redirect, the page moving on while it's read); absent, any
   * address `readable` allows. An outside agent's shared tab: only on the site it was shared on.
   */
  siteOk?(node: TabNode, url: string): boolean;
  /** Why `readable` (or `siteOk`) said no, where the scope has its own words (an outside agent's: the user stopped sharing it); absent, the *never* refusal. */
  whyNot?(node: TabNode): string | null;
  /** The *Never* list, for addresses a read ends up at (a PDF's redirects, a frame inside the page). */
  neverSites(): readonly string[];
  /**
   * The card this read needs first, or null (`node` null: list_tabs and searches). The scope
   * decides its kind and its subject, what an *always* answer covers.
   */
  needsCard(tool: AssistantToolName, node: TabNode | null): { kind: ApprovalKind; subject: string } | null;
  /**
   * Whether forms and diagnostics may look at this tab now: null, or the refusal. The assistant
   * allows only the tab on screen where the message came from; outside agents their own and shared tabs.
   */
  mayInspect(node: TabNode, tool: 'read_form' | 'propose_fill' | 'page_diagnostics'): string | null;
  /** How long a call waits on a card before it answers *waiting* (outside agents: CONTROL_WAIT_MS); absent, as long as it takes. */
  readonly cardWaitMs?: number;
  /**
   * How long a Send data card waits (absent: cardWaitMs). Never cut by a call's budget for cards (#143; Neon's review
   * of M2g-1, B2): no answer drops what the page sent, so it always gets its full wait.
   */
  readonly sendWaitMs?: number;
  /** No diff after an action (batch's steps but its last: one diff for the whole batch, M2g-1). */
  readonly noDiff?: boolean;
  /** A line in what the agent did (the assistant's chat). Not called once the call was stopped. */
  activity(tool: string, summary: string, detail: string, ok: boolean): Promise<void>;
  /** search_history and search_archive, already kept to what may be read; absent, they're not offered. */
  search?(tool: 'search_history' | 'search_archive', query: string): Promise<Record<string, string>[]>;
  /** propose_fill; absent, it's not offered. */
  fills?: FillProposals;
  /** Acting on pages (M2c); absent, the acting tools aren't offered. */
  act?: ActHost;
}
