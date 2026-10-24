/**
 * Site permissions (ARCHITECTURE.md §9): sensitive requests prompt in the
 * window's popover and the answer is remembered per site; harmless ones are
 * allowed; everything else is denied. A prompt only shows for the tab you're
 * looking at, and a tab's pending prompts are denied if it navigates away or
 * closes. A private window asks the same way, but its answers last only
 * while it's open, and it never sees the ones you saved. In presenting mode
 * websites' notifications are refused, without asking: their permission
 * check is the only place Chord can stop them.
 */
import type { Command, NodeId, PermissionDecision, SitePermission, SitePermissions, State } from '@chord/core';
import type { PermissionPrompt } from '@chord/ipc';
import type { Session, WebContents } from 'electron';

/** Allowed without asking: they can't see or hear anything about you. */
const HARMLESS = new Set(['fullscreen', 'automatic-fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'persistent-storage', 'storage-access']);
/**
 * Let through here because Chord asks elsewhere: sharing the screen goes on
 * to Chord's own picker (screen-share.ts), where nothing is shared until you
 * choose what.
 */
const ASKED_ELSEWHERE = new Set(['display-capture']);

/** What a Chromium permission request asks Chord's user for. Null means deny without asking. */
export function sitePermissionsFor(permission: string, mediaTypes: readonly string[] = []): SitePermission[] | null {
  switch (permission) {
    case 'media': {
      const wanted: SitePermission[] = [];
      if (mediaTypes.length === 0 || mediaTypes.includes('video')) wanted.push('camera');
      if (mediaTypes.length === 0 || mediaTypes.includes('audio')) wanted.push('microphone');
      return wanted;
    }
    case 'geolocation':
    case 'geolocation-approximate':
      return ['location'];
    case 'notifications':
      return ['notifications'];
    case 'clipboard-read':
      return ['clipboard-read'];
    default:
      return null;
  }
}

/** The remembered answer for all of `wanted`: allow only if every one is allowed; block if any is blocked. */
export function rememberedDecision(sites: SitePermissions, origin: string, wanted: readonly SitePermission[]): PermissionDecision | null {
  const site = sites[origin];
  if (!site) return null;
  if (wanted.some((p) => site[p] === 'block')) return 'block';
  return wanted.every((p) => site[p] === 'allow') ? 'allow' : null;
}

function originOf(url: string | undefined): string | null {
  try {
    const origin = url ? new URL(url).origin : 'null';
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

interface Pending extends PermissionPrompt {
  nodeId: NodeId;
  origin: string;
  /** A private window's profile: its answers are kept for the window's life only. */
  scope: string | null;
  answer(granted: boolean): void;
}

export interface PermissionDeps {
  state(): State;
  dispatch(command: Command): void;
  /** The tab a WebContents belongs to (popups and Chord's own UI have none, so they're denied). */
  nodeFor(contents: WebContents): NodeId | undefined;
  /** Something about the prompts changed: refresh every window's popover. */
  onChange(): void;
}

const CAPTURE: readonly SitePermission[] = ['camera', 'microphone'];

export class PermissionBroker {
  private deps: PermissionDeps | null = null;
  private readonly pending: Pending[] = [];
  private nextId = 1;
  /**
   * Tabs whose page was given the camera or microphone. Electron can't say
   * whether a page is still using them, so this holds until the page goes;
   * such tabs are never slept or archived (ARCHITECTURE.md §9).
   */
  private readonly capturing = new Set<NodeId>();
  /** Private windows' answers, by their profile; forgotten when the window closes. */
  private readonly privateAnswers = new Map<string, SitePermissions>();

  /** Called once Browser exists; sessions can be attached before that. */
  connect(deps: PermissionDeps): void {
    this.deps = deps;
  }

  /** `scope`: a private window's profile, whose answers stay in memory and apart from your saved ones. */
  attach(ses: Session, scope: string | null = null): void {
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (HARMLESS.has(permission) || ASKED_ELSEWHERE.has(permission)) return callback(true);
      const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
      const wanted = sitePermissionsFor(permission, mediaTypes);
      const origin = originOf('requestingUrl' in details ? details.requestingUrl : undefined);
      const nodeId = this.deps?.nodeFor(contents);
      if (!wanted || !origin || !nodeId || !this.deps || this.quiet(wanted)) return callback(false);
      const remembered = rememberedDecision(this.answers(scope), origin, wanted);
      if (remembered) {
        if (remembered === 'allow') this.granted(nodeId, wanted);
        return callback(remembered === 'allow');
      }
      this.pending.push({ id: this.nextId++, nodeId, origin, scope, host: new URL(origin).host, permissions: wanted, answer: callback });
      this.deps.onChange();
    });
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      if (HARMLESS.has(permission) || ASKED_ELSEWHERE.has(permission)) return true;
      const mediaTypes = details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : [];
      const wanted = sitePermissionsFor(permission, mediaTypes);
      const origin = originOf(requestingOrigin);
      return Boolean(wanted && origin && this.deps && !this.quiet(wanted) && rememberedDecision(this.answers(scope), origin, wanted) === 'allow');
    });
  }

  /** Presenting mode: notifications are refused (pages see "denied" while it's on), and nothing is remembered. */
  private quiet(wanted: readonly SitePermission[]): boolean {
    return wanted.includes('notifications') && Boolean(this.deps?.state().presenting);
  }

  /** The answers that apply: your saved ones, or a private window's own. */
  private answers(scope: string | null): SitePermissions {
    if (scope) return this.privateAnswers.get(scope) ?? {};
    return this.deps?.state().sitePermissions ?? {};
  }

  /** A private window closed: its answers go with it. */
  forgetScope(scope: string): void {
    this.privateAnswers.delete(scope);
  }

  /** The prompt to show for a tab, oldest first. */
  promptFor(nodeId: NodeId | null): PermissionPrompt | null {
    const next = nodeId ? this.pending.find((p) => p.nodeId === nodeId) : undefined;
    return next ? { id: next.id, host: next.host, permissions: next.permissions } : null;
  }

  /** Allow or block (remembered for the site), or dismiss (denied this time only). */
  respond(id: number, decision: PermissionDecision | 'dismiss'): void {
    const index = this.pending.findIndex((p) => p.id === id);
    if (index < 0) return;
    const [prompt] = this.pending.splice(index, 1);
    if (decision !== 'dismiss' && prompt!.scope) {
      // A private window's answer lasts while it's open, and is never saved.
      const sites = this.privateAnswers.get(prompt!.scope) ?? {};
      const site = (sites[prompt!.origin] ??= {});
      for (const permission of prompt!.permissions) site[permission] = decision;
      this.privateAnswers.set(prompt!.scope, sites);
    } else if (decision !== 'dismiss') {
      this.deps?.dispatch({ t: 'permission.set', origin: prompt!.origin, permissions: prompt!.permissions, decision });
    }
    if (decision === 'allow') this.granted(prompt!.nodeId, prompt!.permissions);
    prompt!.answer(decision === 'allow');
    // Other requests from the same site for the same things are answered too.
    for (const other of this.pending.filter((p) => p.origin === prompt!.origin && p.scope === prompt!.scope && this.deps)) {
      const remembered = rememberedDecision(this.answers(other.scope), other.origin, other.permissions);
      if (remembered) {
        this.pending.splice(this.pending.indexOf(other), 1);
        if (remembered === 'allow') this.granted(other.nodeId, other.permissions);
        other.answer(remembered === 'allow');
      }
    }
    this.deps?.onChange();
  }

  /** Whether the tab's page was given the camera or microphone. */
  isCapturing(nodeId: NodeId): boolean {
    return this.capturing.has(nodeId);
  }

  private granted(nodeId: NodeId, permissions: readonly SitePermission[]): void {
    if (permissions.some((p) => CAPTURE.includes(p))) this.capturing.add(nodeId);
  }

  /** A tab navigated away or closed: whatever it asked for is denied, and whatever it was given ends. */
  forgetTab(nodeId: NodeId): void {
    this.capturing.delete(nodeId);
    let changed = false;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.nodeId !== nodeId) continue;
      this.pending.splice(i, 1)[0]!.answer(false);
      changed = true;
    }
    if (changed) this.deps?.onChange();
  }
}
