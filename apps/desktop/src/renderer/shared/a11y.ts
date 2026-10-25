/**
 * Keyboard and focus patterns every Chord surface shares (DESIGN.md §10),
 * written once so each widget gets them the same way:
 *
 * - `useRoving`: a composite widget (radio group, tab list, tree, listbox)
 *   is one stop in the Tab order, and arrow keys move within it (WAI-ARIA
 *   APG "roving tabindex"). Radios and tabs follow focus with selection.
 * - `useRestoreFocus`: a popover, menu or picker gives focus back to where it
 *   was when it closes, if focus was inside it or got lost.
 * - `useMenu`: a menu button's menu, with arrow keys, Home/End, Escape and
 *   Tab, focus on its first item when it opens, and back to its button after.
 * - `focusNextAfter`: when the focused control goes away (a ↺ reset that
 *   hides itself), the next one in Tab order takes the focus.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from 'react';

export interface RovingOptions {
  /** The widget's items, e.g. `[role="radio"]`. */
  items: string;
  /** The item that holds the Tab stop when focus is elsewhere, e.g. `[aria-checked="true"]`. */
  current: string;
  orientation?: 'horizontal' | 'vertical' | 'both';
  /** Arrow keys also choose the item they move to: radios and tabs, where selection follows focus. */
  activate?: boolean;
  /**
   * Places the Tab stop just after the next frame is painted rather than as
   * items change: for long lists whose items come and go as they render (the
   * sidebar's trees). Finding which items show then reads a layout the frame
   * has already done; a frame callback runs before the frame's layout, and
   * forced one (2.8 ms of a tab switch with 200 tabs, measured).
   */
  deferred?: boolean;
}

const usable = (el: HTMLElement) => !el.matches(':disabled, [aria-disabled="true"]') && el.getClientRects().length > 0;

/** Every item that can take focus, in order. */
const itemsIn = (root: HTMLElement, items: string) => [...root.querySelectorAll<HTMLElement>(items)].filter(usable);

/**
 * One Tab stop: the focused item, or the current one, or the first. With
 * `follow` (radios, tabs: the chosen one *is* the place), a choice made some
 * other way (a ↺ reset, another window) takes the keyboard along with it.
 */
export function applyRoving(root: HTMLElement, items: string, current: string, follow = false): void {
  const all = [...root.querySelectorAll<HTMLElement>(items)];
  if (all.length === 0) return;
  const enabled = all.filter(usable);
  const chosen = enabled.find((el) => el.matches(current));
  if (follow && chosen && root.contains(document.activeElement) && document.activeElement !== chosen) chosen.focus();
  const holder = enabled.find((el) => el === document.activeElement) ?? chosen ?? enabled[0];
  for (const el of all) {
    // The attribute, not the property: an <li> without one already reads tabIndex -1, yet can't take focus.
    const index = el === holder ? '0' : '-1';
    if (el.getAttribute('tabindex') !== index) el.setAttribute('tabindex', index);
  }
}

/** Arrow keys, Home and End move focus between the widget's items (and choose it, with `activate`). */
export function rovingKeyDown(event: KeyboardEvent<HTMLElement>, { items, orientation = 'both', activate = false }: RovingOptions): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
  const all = itemsIn(event.currentTarget, items);
  const at = all.indexOf(event.target as HTMLElement);
  if (at < 0) return;
  const back = orientation === 'vertical' ? ['ArrowUp'] : orientation === 'horizontal' ? ['ArrowLeft'] : ['ArrowUp', 'ArrowLeft'];
  const forward = orientation === 'vertical' ? ['ArrowDown'] : orientation === 'horizontal' ? ['ArrowRight'] : ['ArrowDown', 'ArrowRight'];
  let to: number;
  if (back.includes(event.key)) to = (at - 1 + all.length) % all.length;
  else if (forward.includes(event.key)) to = (at + 1) % all.length;
  else if (event.key === 'Home') to = 0;
  else if (event.key === 'End') to = all.length - 1;
  else return;
  event.preventDefault();
  const target = all[to]!;
  target.focus();
  if (activate && to !== at) target.click();
}

/**
 * Roving tabindex for a composite widget: spread `ref` and `onKeyDown` on its
 * container. The Tab stop follows the current item as it changes (watched in
 * the DOM, so items can render themselves however they like).
 *
 * What it returns stays the same object while the options do, so a ref that
 * wraps `ref` can be memoized on it: a new ref each render would make React
 * attach it again on every commit, placing the Tab stop (which measures
 * every item) and watching the widget all over again.
 */
export function useRoving<T extends HTMLElement>(options: RovingOptions): { ref: (root: T | null) => (() => void) | undefined; onKeyDown(event: KeyboardEvent<T>): void } {
  const { items, current, orientation, activate = false, deferred = false } = options;
  const ref = useCallback(
    (root: T | null) => {
      if (!root) return undefined;
      const apply = () => applyRoving(root, items, current);
      // A change of choice (or of items) re-places the Tab stop; for radios and tabs, the keyboard too.
      const change = () => applyRoving(root, items, current, activate);
      let frame = 0;
      let after: ReturnType<typeof setTimeout> | undefined;
      const changed = deferred
        ? () => {
            if (frame || after) return;
            frame = requestAnimationFrame(() => {
              frame = 0;
              // The first task after the frame's paint.
              after = setTimeout(() => {
                after = undefined;
                change();
              }, 0);
            });
          }
        : change;
      if (deferred) changed();
      else apply();
      const observer = new MutationObserver(changed);
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked', 'aria-selected', 'aria-current', 'disabled', 'aria-disabled'] });
      root.addEventListener('focusin', apply);
      return () => {
        cancelAnimationFrame(frame);
        clearTimeout(after);
        observer.disconnect();
        root.removeEventListener('focusin', apply);
      };
    },
    [items, current, activate, deferred],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<T>) => rovingKeyDown(event, { items, current, orientation, activate }),
    [items, current, orientation, activate],
  );
  return useMemo(() => ({ ref, onKeyDown }), [ref, onKeyDown]);
}

/** The element that had focus before the one that has it now (a field that focused itself on mount). */
let previousFocus: HTMLElement | null = null;
let currentFocus: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (event) => {
      if (event.target === currentFocus) return;
      previousFocus = currentFocus;
      currentFocus = event.target instanceof HTMLElement ? event.target : null;
    },
    true,
  );
}

/**
 * While `open`, remember what had focus; once closed, give it back, if focus
 * was inside `root` or got lost (a click elsewhere keeps its own focus).
 */
export function useRestoreFocus(open: boolean, root?: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (!open) return;
    const container = root?.current ?? null;
    // A field inside that focused itself as it appeared already has the focus: what had it before is the one.
    const now = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const before = now && container?.contains(now) ? previousFocus : now;
    return () => {
      // After React has removed the popover, focus has fallen to <body> if it was inside. A task later, not a
      // microtask: the key that closed it (↵) still has its keypress to come, which mustn't land on the button.
      setTimeout(() => {
        const now = document.activeElement;
        const lost = !now || now === document.body || (container !== null && container.contains(now));
        if (lost && before?.isConnected) before.focus({ preventScroll: true });
      }, 0);
    };
  }, [open]);
}

const MENU_ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/**
 * A menu button's menu (WAI-ARIA APG): opening focuses the first item (or the
 * checked one), ↑ ↓ Home End move, Escape closes and returns to the button,
 * Tab closes and moves on, and a click outside closes it.
 */
export function useMenu(open: boolean, close: () => void): { ref: RefObject<HTMLUListElement | null>; onKeyDown(event: KeyboardEvent<HTMLElement>): void } {
  const ref = useRef<HTMLUListElement>(null);
  useRestoreFocus(open, ref);
  useEffect(() => {
    if (!open) return;
    const menu = ref.current;
    const items = menu ? itemsIn(menu, MENU_ITEMS) : [];
    (items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      // The menu's own button toggles it.
      const button = menu?.id ? document.querySelector(`[aria-controls="${CSS.escape(menu.id)}"]`) : null;
      if (menu && !menu.contains(target) && !button?.contains(target)) close();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      close();
      return;
    }
    rovingKeyDown(event, { items: MENU_ITEMS, current: '[aria-checked="true"]', orientation: 'vertical' });
  };
  return { ref, onKeyDown };
}

/** Everything a Tab press can reach, in document order. */
function tabbables(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')].filter(
    (el) => el.tabIndex >= 0 && usable(el) && !el.closest('[inert], [aria-hidden="true"]'),
  );
}

/** Focus the first control after `el` in Tab order (for a control that's about to hide itself). */
export function focusNextAfter(el: HTMLElement): void {
  const next = tabbables().find((candidate) => candidate !== el && Boolean(el.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.contains(candidate));
  next?.focus();
}
