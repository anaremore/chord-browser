/**
 * The scan's cost on a heavy page (scan-cost.spec.ts): the agent's own scan and classifier, and
 * the ways phase 3B and 3C could find what the main tree hides (open shadow roots, same-origin
 * frames), each timed in the page. Nothing here is the agent's code but `scanDocument`.
 */
import { classifyPasswordForm } from '@chord/core';
import { frameDocumentOf, MAX_FRAME_DEPTH, MAX_FRAMES } from '../../src/passwords/agent/frames';
import { formlessScope, framesIn, scanDocument } from '../../src/passwords/agent/scan';

export interface ScanCost {
  readonly elements: number;
  readonly roots: number;
  /** The agent's scan and classifier, walking into open shadow roots (a page's first scan, and every one where it found a root). */
  readonly scanMs: number;
  /** The same without the walk (`deep: false`): what the agent's later scans cost on a page whose first found no root. */
  readonly scanFlatMs: number;
  /** The sentinel's look today: one `querySelector` for a password field in the main tree. */
  readonly lookMs: number;
  /** Every element visited, its `shadowRoot` read, roots inside roots too: what a deep scan pays before reading a field. */
  readonly walkAllMs: number;
  /** The same with a TreeWalker. */
  readonly walkTreeMs: number;
  /** A deep look for a password field: the main tree's `querySelector` first, then each open root's. */
  readonly deepLookMs: number;
  /** `formlessScope` from the page's password field in its own tree: the scan's words and the click rule pay it. */
  readonly scopeMs: number;
  /** Same-origin frames the agent may use (phase 3C), and what finding them and scanning each costs on top of `scanMs`. */
  readonly frames: number;
  readonly framesMs: number;
}

/** The frames' part of a page's scan (phase 3C): finding the frames the agent may use, as frames.ts does, and scanning each. */
function scanFrames(): number {
  let used = 0;
  let seen = 0;
  const walk = (doc: Document, depth: number) => {
    if (depth >= MAX_FRAME_DEPTH) return;
    for (const el of framesIn(doc, MAX_FRAMES)) {
      if (++seen > MAX_FRAMES) return;
      // Cost only: every frame counts as never sandboxed here (the agent asks the sentinel's record).
      const frameDoc = frameDocumentOf(el, location.origin, () => false);
      if (!frameDoc) continue;
      used++;
      for (const f of scanDocument(frameDoc)) classifyPasswordForm(f.record, 'filling');
      walk(frameDoc, depth + 1);
    }
  };
  walk(document, 0);
  return used;
}

/** Every open shadow root under `root`, roots inside roots too, by visiting every element. */
function rootsByAll(root: Document | ShadowRoot, out: ShadowRoot[] = []): ShadowRoot[] {
  for (const el of root.querySelectorAll('*')) {
    const inner = el.shadowRoot;
    if (inner) {
      out.push(inner);
      rootsByAll(inner, out);
    }
  }
  return out;
}

function rootsByWalker(root: Document | ShadowRoot, out: ShadowRoot[] = []): ShadowRoot[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const inner = (n as Element).shadowRoot;
    if (inner) {
      out.push(inner);
      rootsByWalker(inner, out);
    }
  }
  return out;
}

function time(run: () => unknown, times = 5): number {
  const t = performance.now();
  for (let i = 0; i < times; i++) run();
  return (performance.now() - t) / times;
}

function measure(): ScanCost {
  const roots = rootsByAll(document);
  return {
    elements: document.querySelectorAll('*').length + roots.reduce((n, r) => n + r.querySelectorAll('*').length, 0),
    roots: roots.length,
    scanMs: time(() => {
      for (const f of scanDocument(document)) classifyPasswordForm(f.record, 'filling');
    }),
    scanFlatMs: time(() => {
      for (const f of scanDocument(document, { deep: false })) classifyPasswordForm(f.record, 'filling');
    }),
    lookMs: time(() => document.querySelector('input[type=password]')),
    walkAllMs: time(() => rootsByAll(document)),
    walkTreeMs: time(() => rootsByWalker(document)),
    deepLookMs: time(() => document.querySelector('input[type=password]') ?? rootsByWalker(document).find((r) => r.querySelector('input[type=password]'))),
    frames: scanFrames(),
    framesMs: time(scanFrames),
    scopeMs: (() => {
      // In the page's tree, or in a component's root (a lone field's text field).
      const field = document.querySelector('input[type=password]') ?? rootsByWalker(document).map((r) => r.querySelector('input[type=password]')).find((f) => f) ?? null;
      return field ? time(() => formlessScope(field), 20) : 0;
    })(),
  };
}

(globalThis as unknown as { chordScanCost: typeof measure }).chordScanCost = measure;
