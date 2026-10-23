/**
 * Site permissions (ARCHITECTURE.md §9): sensitive requests prompt in the
 * window's popover and the answer is remembered per site; harmless ones are
 * allowed; everything else is denied. A prompt only shows for the tab you're
 * looking at, and a tab's pending prompts are denied if it navigates away or
 * closes.
 */
import type { Command, NodeId, PermissionDecision, SitePermission, State } from '@chord/core';
import type { PermissionPrompt } from '@chord/ipc';
import type { Session, WebContents } from 'electron';

/** Allowed without asking: they can't see or hear anything about you. */
const HARMLESS = new Set(['fullscreen', 'automatic-fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'persistent-storage', 'storage-access']);

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
export function rememberedDecision(state: State, origin: string, wanted: readonly SitePermission[]): PermissionDecision | null {
  const site = state.sitePermissions[origin];
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

  /** Called once Browser exists; sessions can be attached before that. */
  connect(deps: PermissionDeps): void {
    this.deps = deps;
  }

  attach(ses: Session): void {
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (HARMLESS.has(permission)) return callback(true);
      const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
      const wanted = sitePermissionsFor(permission, mediaTypes);
      const origin = originOf('requestingUrl' in details ? details.requestingUrl : undefined);
      const nodeId = this.deps?.nodeFor(contents);
      if (!wanted || !origin || !nodeId || !this.deps) return callback(false);
      const remembered = rememberedDecision(this.deps.state(), origin, wanted);
      if (remembered) {
        if (remembered === 'allow') this.granted(nodeId, wanted);
        return callback(remembered === 'allow');
      }
      this.pending.push({ id: this.nextId++, nodeId, origin, host: new URL(origin).host, permissions: wanted, answer: callback });
      this.deps.onChange();
    });
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      if (HARMLESS.has(permission)) return true;
      const mediaTypes = details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : [];
      const wanted = sitePermissionsFor(permission, mediaTypes);
      const origin = originOf(requestingOrigin);
      return Boolean(wanted && origin && this.deps && rememberedDecision(this.deps.state(), origin, wanted) === 'allow');
    });
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
    if (decision !== 'dismiss') {
      this.deps?.dispatch({ t: 'permission.set', origin: prompt!.origin, permissions: prompt!.permissions, decision });
    }
    if (decision === 'allow') this.granted(prompt!.nodeId, prompt!.permissions);
    prompt!.answer(decision === 'allow');
    // Other requests from the same site for the same things are answered too.
    for (const other of this.pending.filter((p) => p.origin === prompt!.origin && this.deps)) {
      const remembered = rememberedDecision(this.deps!.state(), other.origin, other.permissions);
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
