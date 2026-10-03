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

// Google Fonts link opener: content.js and popup.js send
// { type: "OPEN_GOOGLE_FONTS", url } — opened here with chrome.tabs.create()
// so the specimen/search page opens in a new tab. URL is validated to stay
// on fonts.google.com; nothing is downloaded and no API key is used.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'OPEN_GOOGLE_FONTS') {
    return false;
  }
  try {
    const url = String(message.url || '');
    if (!/^https:\/\/fonts\.google\.com\//.test(url)) {
      return false;
    }
    chrome.tabs.create({ url });
  } catch (e) {
    // Invalid URL or tabs failure — ignore, card/popup stays usable.
  }
  return false;
});
