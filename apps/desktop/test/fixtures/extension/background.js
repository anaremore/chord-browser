// Chord's test extension: counts runtime.onInstalled (Chord must send it exactly once per version),
// adds a context-menu item there as Chrome extensions do, and sets a badge.
chrome.runtime.onInstalled.addListener(async (details) => {
  const { installs = 0 } = await chrome.storage.local.get('installs');
  await chrome.storage.local.set({ installs: installs + 1, reason: details.reason });
  chrome.contextMenus.create({ id: 'chord-test', title: 'Chord test: “%s”', contexts: ['selection'] });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  await chrome.storage.local.set({ clicked: info.selectionText ?? '' });
});

chrome.action.setBadgeText({ text: '7' });
