// I Love Fonts – Font Finder
// Popup: sends { type: "ACTIVATE_FONT_FINDER" } to content.js.
// Font detection itself is implemented in a later block.

document.addEventListener('DOMContentLoaded', () => {
  const activateBtn = document.getElementById('activateBtn');
  const statusMessage = document.getElementById('statusMessage');
  const lastFont = document.getElementById('lastFont');
  const historyList = document.getElementById('historyList');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');

  let historyCache = [];
  let selectedIndex = 0;

  function formatDateTime(ts) {
    if (!ts) {
      return '';
    }
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (err) {
      return '';
    }
  }

  // Detail box: shows the saved information of the selected history item
  // (or the latest inspection when nothing is selected yet).
  // Google Fonts helpers (mirrors content.js; popup uses the stored
  // verification from detection — no API, no download).
  function cleanGfName(name) {
    return String(name || '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
  }

  function stripGfVariable(name) {
    return String(name || '').replace(/\s+variable$/i, '').replace(/\s+/g, ' ').trim();
  }

  // Split a font-family stack on top-level commas (respects quotes), so
  // values like '"Some, Font", Arial' parse correctly.
  function splitGfStack(stack) {
    const parts = [];
    let current = '';
    let quote = null;
    const s = String(stack || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        current += ch;
        if (ch === quote) {
          quote = null;
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === ',') {
        if (current.trim()) {
          parts.push(current.trim());
        }
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) {
      parts.push(current.trim());
    }
    return parts.filter(Boolean);
  }

  function specimenUrl(family) {
    const clean = stripGfVariable(cleanGfName(family));
    if (!clean) {
      return '';
    }
    return 'https://fonts.google.com/specimen/' + encodeURIComponent(clean).replace(/%20/g, '+');
  }

  function searchUrl(family) {
    const clean = stripGfVariable(cleanGfName(family));
    if (!clean) {
      return 'https://fonts.google.com/';
    }
    return 'https://fonts.google.com/?query=' + encodeURIComponent(clean);
  }

  // Prefer the verification stored by content.js (from actual page sources).
  // Older history entries without it fall back to an unverified search link.
  function resolveGoogleLink(entry) {
    if (!entry) {
      return null;
    }
    if (entry.googleFontsUrl) {
      const verified = Boolean(entry.isGoogleFont);
      return {
        family: entry.googleFamily || entry.detectedFamily || entry.primaryFamily || entry.family || '',
        isVerified: verified,
        label: verified ? 'View Font' : 'Search Font',
        url: entry.googleFontsUrl
      };
    }
    const name =
      entry.detectedFamily || entry.primaryFamily || entry.family || entry.fontFamily || '';
    const first = Array.isArray(name) ? name[0] : (splitGfStack(name)[0] || '');
    const clean = stripGfVariable(cleanGfName(first));
    if (!clean) {
      return null;
    }
    if (entry.isGoogleFont) {
      return { family: clean, isVerified: true, label: 'View Font', url: specimenUrl(clean) };
    }
    return { family: clean, isVerified: false, label: 'Search Font', url: searchUrl(clean) };
  }

  function openGoogleFonts(url) {
    if (!url) {
      return;
    }
    try {
      if (chrome && chrome.tabs && typeof chrome.tabs.create === 'function') {
        chrome.tabs.create({ url });
        return;
      }
    } catch (err) {
      // Fall through to runtime messaging.
    }
    try {
      if (chrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage({ type: 'OPEN_GOOGLE_FONTS', url });
        return;
      }
    } catch (err) {
      // Ignore — popup stays usable.
    }
    try {
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      // Never break the popup.
    }
  }

  function renderLastFont(entry) {
    lastFont.innerHTML = '';
    if (!entry) {
      const empty = document.createElement('p');
      empty.className = 'empty-text';
      empty.textContent = 'No fonts inspected yet.';
      lastFont.appendChild(empty);
      return;
    }
    const primary = entry.primaryFamily || entry.family || entry.fontFamily || 'Unknown font';
    const name = document.createElement('p');
    name.className = 'last-font-name';
    name.textContent = primary;
    lastFont.appendChild(name);

    const details = [];
    if (entry.fontWeight) {
      details.push(`${entry.fontWeight}`);
    }
    if (entry.fontSize) {
      details.push(`${entry.fontSize}`);
    }
    if (details.length > 0) {
      const meta = document.createElement('p');
      meta.className = 'last-font-meta';
      meta.textContent = details.join(' · ');
      lastFont.appendChild(meta);
    }

    const context = [];
    if (entry.hostname) {
      context.push(entry.hostname);
    }
    const when = formatDateTime(entry.inspectedAt);
    if (when) {
      context.push(when);
    }
    if (context.length > 0) {
      const sub = document.createElement('p');
      sub.className = 'last-font-meta';
      sub.textContent = context.join(' · ');
      lastFont.appendChild(sub);
    }

    // Google Fonts row: compact, matches card. Verified → View Font
    // (specimen page); otherwise → Search Font. Opens via chrome.tabs.create().
    const gf = resolveGoogleLink(entry);
    if (gf && gf.url) {
      const gfRow = document.createElement('div');
      gfRow.className = 'gf-row';
      const gfLabel = document.createElement('span');
      gfLabel.className = 'gf-label';
      gfLabel.textContent = 'Google Fonts';
      const gfBtn = document.createElement('button');
      gfBtn.type = 'button';
      gfBtn.className = 'gf-btn' + (gf.isVerified ? ' gf-verified' : ' gf-search');
      gfBtn.textContent = gf.label;
      gfBtn.setAttribute('aria-label', `${gf.label} — ${gf.family} on Google Fonts`);
      gfBtn.setAttribute('title', gf.url);
      gfBtn.addEventListener('click', () => openGoogleFonts(gf.url));
      gfRow.appendChild(gfLabel);
      gfRow.appendChild(gfBtn);
      lastFont.appendChild(gfRow);
    }
  }

  // History list: one lightweight row per item (family, hostname, weight).
  function renderHistory(list) {
    historyCache = Array.isArray(list) ? list : [];
    if (selectedIndex >= historyCache.length) {
      selectedIndex = 0;
    }
    historyList.innerHTML = '';
    if (historyCache.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty-text';
      empty.textContent = 'No history yet.';
      historyList.appendChild(empty);
      return;
    }
    historyCache.forEach((entry, index) => {
      const item = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-item' + (index === selectedIndex ? ' selected' : '');
      btn.setAttribute('aria-label', `Show ${(entry.primaryFamily || entry.family || 'font')} details`);

      const name = document.createElement('span');
      name.className = 'history-name';
      name.textContent = entry.primaryFamily || entry.family || entry.fontFamily || 'Unknown font';

      const site = document.createElement('span');
      site.className = 'history-site';
      site.textContent = entry.hostname || 'Unknown site';

      const weight = document.createElement('span');
      weight.className = 'history-weight';
      weight.textContent = entry.fontWeight || '';

      btn.appendChild(name);
      btn.appendChild(site);
      btn.appendChild(weight);
      btn.addEventListener('click', () => {
        selectedIndex = index;
        renderLastFont(historyCache[selectedIndex]);
        renderHistory(historyCache);
      });
      item.appendChild(btn);
      historyList.appendChild(item);
    });
  }

  function refreshFromStorage() {
    chrome.storage.local.get(['recentFonts'], (result) => {
      const recent = Array.isArray(result.recentFonts) ? result.recentFonts : [];
      renderHistory(recent);
      renderLastFont(recent[selectedIndex] || null);
    });
  }

  refreshFromStorage();

  // Live-update while popup is open (e.g. re-opened after inspecting).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.recentFonts) {
      const list = Array.isArray(changes.recentFonts.newValue)
        ? changes.recentFonts.newValue
        : [];
      selectedIndex = 0;
      renderHistory(list);
      renderLastFont(list[0] || null);
    }
  });

  clearHistoryBtn.addEventListener('click', () => {
    if (historyCache.length === 0) {
      return;
    }
    // Confirmation before destructive clear.
    if (!window.confirm('Clear all font history?')) {
      return;
    }
    chrome.storage.local.set({ recentFonts: [] }, () => {
      selectedIndex = 0;
      renderHistory([]);
      renderLastFont(null);
      setStatus('History cleared.');
    });
  });

  function setStatus(text) {
    statusMessage.textContent = text;
  }

  // Ensure content.js is present, then message it.
  // Needed for pages where the static content_scripts entry hasn't run
  // (e.g. tabs opened before install / reload). Guarded against
  // double-injection by window.__ILF_FONT_FINDER_LOADED in content.js.
  async function ensureContentScript(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
    } catch (err) {
      // Static content_scripts registration usually covers this; a failure
      // here typically means a restricted page (chrome://, web store).
      // Fall through and let sendMessage report the real error.
    }
    // Styling lives in content.css; ensure it is present on tabs where the
    // static content_scripts CSS did not apply (e.g. pre-install tabs).
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content.css']
      });
    } catch (err) {
      // Ignore — page may already have it or may be restricted.
    }
  }

  activateBtn.addEventListener('click', async () => {
    setStatus('Activating Font Finder…');
    activateBtn.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id === undefined) {
        // Keep the popup open so this error stays visible.
        setStatus('No active tab found.');
        return;
      }

      await ensureContentScript(tab.id);

      await chrome.tabs.sendMessage(tab.id, {
        type: 'ACTIVATE_FONT_FINDER'
      });

      // Success: Font Finder now runs as a content-script overlay on the
      // page. The popup's only job is done, so close it immediately — the
      // user stays exactly where they were: no new window, no new tab,
      // no navigation. Detection/hover UI lives entirely in content.js.
      window.close();
    } catch (err) {
      // Restricted pages (chrome://, edge://, Chrome Web Store) block
      // content scripts by design. Keep the popup open to show this.
      setStatus('Cannot activate here (restricted page). Try a regular website.');
    } finally {
      activateBtn.disabled = false;
    }
  });
});
