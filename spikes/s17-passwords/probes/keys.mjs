// Spike S17 M0, question 3: what main does with a key while the menu is open, as a pure
// function, so the routing is unit-tested (keys.test.mjs) where Playwright's keys can't reach
// before-input-event. `menu` is null when closed, else { index, rows }.
// Returns { take } (true: preventDefault, the page never sees the key) and the menu's next state.
export function routeKey(menu, input) {
  if (!menu || input.type !== 'keyDown') return { take: false, menu };
  // A shortcut with a modifier is the app's or the page's, never the menu's.
  if (input.control || input.meta || input.alt) return { take: false, menu };
  switch (input.key) {
    case 'ArrowDown':
      return { take: true, menu: { ...menu, index: Math.min(menu.rows - 1, menu.index + 1) } };
    case 'ArrowUp':
      return { take: true, menu: { ...menu, index: Math.max(0, menu.index - 1) } };
    case 'Enter':
      return { take: true, menu: null, choose: menu.index };
    case 'Escape':
      return { take: true, menu: null };
    // Tab moves on in the page and closes the menu; typing goes to the page and leaves it open.
    case 'Tab':
      return { take: false, menu: null };
    default:
      return { take: false, menu };
  }
}
