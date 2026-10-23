// Chord's test extension popup: shows what the worker recorded and which tab is active.
(async () => {
  const { installs = 0, reason = '', clicked = '' } = await chrome.storage.local.get(['installs', 'reason', 'clicked']);
  document.getElementById('installs').textContent = `Installed ${installs} time(s), reason ${reason}${clicked ? `, clicked “${clicked}”` : ''}`;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  document.getElementById('tab').textContent = `Active tab: ${tab ? tab.title : 'none'}`;
})();
// Closes just after the click, not inside it: closing mid-click races the test's own click bookkeeping.
document.getElementById('close').addEventListener('click', () => setTimeout(() => window.close(), 50));
