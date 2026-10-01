// Background service worker — foundation placeholder.
// Font Finder activation / messaging will be added in a later block.

chrome.runtime.onInstalled.addListener(() => {
  // Initialize storage for future "recently inspected fonts" feature.
  chrome.storage.local.get(['recentFonts'], (result) => {
    if (!Array.isArray(result.recentFonts)) {
      chrome.storage.local.set({ recentFonts: [] });
    }
  });
});
