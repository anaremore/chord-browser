/**
 * Hover previews (DESIGN.md §7.6): the pointer resting on a pinned tab or
 * folder row asks main for its preview after `delay-hover-intent`. While one is
 * up, moving to another row swaps it at once. Pressing, scrolling, typing,
 * a right-click or leaving the window puts it away. Rows opt in with
 * `data-preview` (pinned tabs and folders).
 */
import { durations } from '@chord/tokens';
import { useEffect, type RefObject } from 'react';
import { api } from './api';

/** Rows touching by a hairline still count as one hover; this covers the gap. */
const LEAVE_GRACE_MS = 120;

export function usePreviewHover(root: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = root.current;
    if (!el || !enabled) return;
    let shown: string | null = null;
    let intent: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const rowOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('[data-preview]') : null);

    const show = (row: HTMLElement) => {
      const id = row.dataset['id'];
      if (!id || !row.isConnected) return;
      const r = row.getBoundingClientRect();
      shown = id;
      void api.preview.hover({ nodeId: id, top: r.top, bottom: r.bottom });
    };
    const hide = () => {
      clearTimeout(intent);
      clearTimeout(grace);
      if (shown === null) return;
      shown = null;
      void api.preview.hover(null);
    };

    const over = (event: PointerEvent) => {
      // A finger or a pen has no hover to rest; and nothing previews mid-drag.
      if (event.pointerType !== 'mouse') return;
      const row = rowOf(event.target);
      if (!row) return;
      clearTimeout(grace);
      if (el.querySelector('[data-dragging]')) return hide();
      if (row.dataset['id'] === shown) return;
      clearTimeout(intent);
      if (shown !== null) show(row);
      else intent = setTimeout(() => show(row), durations.hoverIntent);
    };
    const out = (event: PointerEvent) => {
      if (rowOf(event.relatedTarget)) return; // onto another previewable row: `over` handles it
      clearTimeout(intent);
      clearTimeout(grace);
      grace = setTimeout(hide, LEAVE_GRACE_MS);
    };

    const quit = ['pointerdown', 'wheel', 'keydown', 'contextmenu'] as const;
    el.addEventListener('pointerover', over);
    el.addEventListener('pointerout', out);
    for (const type of quit) el.addEventListener(type, hide, true);
    window.addEventListener('blur', hide);
    return () => {
      el.removeEventListener('pointerover', over);
      el.removeEventListener('pointerout', out);
      for (const type of quit) el.removeEventListener(type, hide, true);
      window.removeEventListener('blur', hide);
      hide();
    };
  }, [root, enabled]);
}
